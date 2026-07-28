// Sync de cartera con San Cristóbal (docs/rumbo/18-api-b2b-sancristobal.md).
//
// Job de SISTEMA: sin sesión, corre con el cliente owner (bypassea RLS) y
// scopea por org en el código — mismo contrato que `expiry-job.ts`.
//
// ── Cómo funciona ────────────────────────────────────────────────────────────
//
// SC no expone "dame todo lo que cambió con su detalle". Expone feeds livianos
// (solo nº de póliza) y un detalle caro y limitado a 3 req/s. La metodología es
// la que la propia WIKI de SC recomienda (§9): feed → cola → detalle.
//
//   backfill     · portfolio-by-producer-code (solo VIGENTES) ─┐
//   incremental  · movements-by-date (cartera, por día)        ├→ cola → detalle
//                · ConsultaMovimientosCobranzaPorDia (pagos)   │
//                · Claims/News (siniestros, por día)          ─┘
//
// La cola se persiste (`insurer_sync_queue`) porque una invocación serverless
// tiene decenas de segundos de presupuesto y el detalle no entra ahí: cada
// corrida drena lo que puede y la siguiente sigue. También es el mecanismo de
// reintento — un timeout no se reintenta en el momento (cuesta otros 45 s),
// queda pendiente para la próxima.
//
// ── Reglas de escritura ──────────────────────────────────────────────────────
//
//  · **Nunca se pisa lo que el usuario editó a mano.** La sync completa nulos y
//    actualiza lo que ella misma escribió (`source = 'sync'`). Un contacto o
//    una póliza cargados a mano se enriquecen, no se sobreescriben.
//  · **Idempotencia por índice único**, no por lógica: (org, aseguradora,
//    external_ref) en pólizas, (org, external_ref) en siniestros, (org, póliza,
//    nº) en endosos. Correr el backfill dos veces no duplica nada.
//  · **`Invoice`/`Payments` en null no es "no tiene".** Es "SC todavía no lo
//    calculó" (§12 del doc) → no se borran cuotas ya escritas.
//
// Límite conocido: SC solo devuelve la cartera VIGENTE y 30 días de
// movimientos. El histórico completo sigue viniendo del export XLSX
// (docs/rumbo/15-import-cartera.md) — los dos caminos son complementarios.

import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';

import { db, schema } from './db/client.js';
import {
  isBlocked,
  isNotEnabled,
  isTransient,
  resetBreaker,
  scClaimDetail,
  scClaimNews,
  scMovementsByDate,
  scPaymentsByDay,
  scPortfolio,
  scProducers,
  trippedEndpoints,
  type ScProducerRef,
} from './lib/sc/client.js';
import {
  mapClaim,
  mapContact,
  mapEndorsements,
  mapInstallments,
  mapPolicy,
  mapPortfolioContact,
  mapRisks,
  primaryContact,
  type MappedContact,
} from './lib/sc/map.js';
import { fetchDetailByRamo, refineRamo } from './lib/sc/ramos.js';

const {
  claims,
  contacts,
  insurerSyncQueue,
  insurerSyncRuns,
  insurerSyncState,
  insurers,
  policies,
  policyEndorsements,
  policyInstallments,
  policyRisks,
  producerCodes,
  producers,
} = schema;

/** Nombre canónico de la aseguradora en el catálogo de la org. */
export const SC_INSURER_NAME = 'San Cristóbal';

/** SC solo deja mirar 30 días atrás; arrancamos justo adentro de la ventana. */
const FEED_WINDOW_DAYS = 30;
/** Máximo de días de feed que se recuperan en una sola corrida. */
const MAX_FEED_DAYS_PER_RUN = 30;
/** Un ítem que falló tantas veces deja de reintentarse (queda con last_error). */
const MAX_ATTEMPTS = 5;
/**
 * Sin latido por este tiempo, la corrida se da por abandonada (proceso muerto).
 * Se mide contra `heartbeat_at`, no contra `started_at`: un backfill legítimo
 * puede durar horas y no debe reaparse mientras avanza. Pasó de verdad — un
 * corte de conexión de Neon mató un backfill y dejó la fila en `running`.
 */
const STALE_RUN_MINUTES = 15;

export type SyncMode = 'backfill' | 'incremental';

export interface SyncOptions {
  mode: SyncMode;
  /** Org destino. Por defecto `SC_SYNC_ORG_ID`. */
  orgId?: string;
  /** Presupuesto de tiempo. El cron pasa ~50 s; el CLI, horas. */
  budgetMs?: number;
  /** Limitar a estos códigos de productor (debug). */
  onlyCodes?: string[];
  /** Lee de SC y reporta, pero no escribe en la DB. */
  dryRun?: boolean;
  /** Tope de ítems de cola a drenar (debug). */
  limit?: number;
}

export interface SyncResult {
  runId: string | null;
  mode: SyncMode;
  orgId: string;
  counters: Record<string, number>;
  tripped: string[];
  notes: string[];
}

// ── Utilidades de fecha ──────────────────────────────────────────────────────

function todayAr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' });
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Días de feed pendientes: desde el siguiente al último procesado hasta AYER
 * (los feeds de SC se consultan a día vencido). Si el cursor está vacío o quedó
 * fuera de la ventana de 30 días, arranca en el borde — lo que no entró en la
 * ventana se perdió y no hay forma de recuperarlo por la API.
 */
export function pendingFeedDays(cursor: string | null, today = todayAr()): string[] {
  const yesterday = addDays(today, -1);
  const windowStart = addDays(today, -FEED_WINDOW_DAYS);
  let from = cursor ? addDays(cursor, 1) : windowStart;
  if (from < windowStart) from = windowStart;

  const days: string[] = [];
  for (let d = from; d <= yesterday && days.length < MAX_FEED_DAYS_PER_RUN; d = addDays(d, 1)) days.push(d);
  return days;
}

// ── Contexto de la corrida ───────────────────────────────────────────────────

interface Ctx {
  orgId: string;
  insurerId: string;
  deadline: number;
  dryRun: boolean;
  counters: Record<string, number>;
  notes: string[];
  /** producerCode → producers.id, para atribuir cada póliza a su PAS. */
  producerByCode: Map<string, string>;
  /** Cola en memoria del dry-run (no se toca la tabla, pero se drena igual). */
  dryQueue: EnqueueItem[];
  /** Fila de `insurer_sync_runs` de esta corrida (null en dry-run). */
  runId: string | null;
}

/** Marca que la corrida sigue viva, para que el reaper no la dé por colgada. */
async function heartbeat(ctx: Ctx): Promise<void> {
  if (!ctx.runId) return;
  await db.update(insurerSyncRuns).set({ heartbeatAt: new Date() }).where(eq(insurerSyncRuns.id, ctx.runId));
}

function bump(ctx: Ctx, key: string, n = 1): void {
  ctx.counters[key] = (ctx.counters[key] ?? 0) + n;
}

function outOfTime(ctx: Ctx): boolean {
  return Date.now() >= ctx.deadline;
}

// ── Resolución de org / aseguradora / productores ────────────────────────────

async function resolveInsurerId(orgId: string): Promise<string> {
  const [row] = await db
    .select({ id: insurers.id })
    .from(insurers)
    .where(and(eq(insurers.orgId, orgId), eq(insurers.name, SC_INSURER_NAME)))
    .limit(1);
  if (!row) {
    throw new Error(
      `La org ${orgId} no tiene la aseguradora "${SC_INSURER_NAME}". Corré scripts/sc-bootstrap-org.ts primero.`,
    );
  }
  return row.id;
}

async function loadProducerByCode(orgId: string, insurerId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ code: producerCodes.code, producerId: producers.id })
    .from(producerCodes)
    .innerJoin(producers, eq(producers.id, producerCodes.producerId))
    .where(and(eq(producerCodes.orgId, orgId), eq(producerCodes.insurerId, insurerId)));
  return new Map(rows.map(r => [r.code, r.producerId]));
}

// ── Cola ─────────────────────────────────────────────────────────────────────

interface EnqueueItem {
  kind: 'policy' | 'claim';
  externalRef: string;
  reason: string;
  producerCode?: string | null;
  feedDate?: string | null;
}

/**
 * Encola sin duplicar: el índice único parcial sobre los PENDIENTES hace que un
 * nº que aparece en dos feeds del mismo día entre una sola vez. Un ítem ya
 * procesado (done_at seteado) sí puede volver a encolarse — es lo que queremos
 * cuando la póliza vuelve a moverse.
 */
async function enqueue(ctx: Ctx, items: EnqueueItem[]): Promise<void> {
  if (items.length === 0) return;
  if (ctx.dryRun) {
    // El dry-run igual encola (en memoria) para poder drenar y ejercitar el
    // mapeo del detalle: un dry-run que solo cuenta filas de cartera no prueba
    // nada de lo que suele romperse.
    ctx.dryQueue.push(...items);
    bump(ctx, 'enqueued', items.length);
    return;
  }
  const inserted = await db
    .insert(insurerSyncQueue)
    .values(
      items.map(i => ({
        orgId: ctx.orgId,
        insurerId: ctx.insurerId,
        kind: i.kind,
        externalRef: i.externalRef,
        producerCode: i.producerCode ?? null,
        reason: i.reason,
        feedDate: i.feedDate ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: insurerSyncQueue.id });
  bump(ctx, 'enqueued', inserted.length);
}

// ── Escritura: contacto ──────────────────────────────────────────────────────

/**
 * Encuentra el contacto por documento (la identidad fuerte) y si no hay
 * documento cae al nombre. Es el mismo criterio de deduplicación que usó el
 * import de cartera: sin él, cada sync crearía un contacto nuevo por póliza.
 */
async function findContactId(orgId: string, mapped: MappedContact): Promise<string | null> {
  const clauses = [];
  if (mapped.cuit) clauses.push(eq(contacts.cuit, mapped.cuit));
  if (mapped.dni) clauses.push(eq(contacts.dni, mapped.dni));
  if (clauses.length > 0) {
    const [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), sql`(${sql.join(clauses, sql` OR `)})`))
      .limit(1);
    if (row) return row.id;
  }
  const name = mapped.legalName ?? [mapped.lastName, mapped.firstName].filter(Boolean).join(', ');
  if (!name) return null;
  const [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.orgId, orgId),
        mapped.legalName
          ? sql`lower(${contacts.legalName}) = lower(${name})`
          : sql`lower(coalesce(${contacts.lastName}, '') || ', ' || coalesce(${contacts.firstName}, '')) = lower(${name})`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Sobreescribe solo si el valor actual está vacío (regla de no-destrucción). */
function fillIfEmpty<T>(current: T | null | undefined, incoming: T | null): T | null | undefined {
  return current === null || current === undefined || current === '' ? incoming : current;
}

async function upsertContact(ctx: Ctx, mapped: MappedContact, producerId: string | null): Promise<string | null> {
  if (ctx.dryRun) {
    bump(ctx, 'contacts');
    return null;
  }
  const existingId = await findContactId(ctx.orgId, mapped);

  if (!existingId) {
    const [row] = await db
      .insert(contacts)
      .values({
        orgId: ctx.orgId,
        kind: mapped.kind,
        firstName: mapped.firstName,
        lastName: mapped.lastName,
        legalName: mapped.legalName,
        dni: mapped.dni,
        cuit: mapped.cuit,
        status: 'asegurado',
        producerId,
        source: 'sync',
        contactMethods: mapped.contactMethods,
        addressStreet: mapped.addressStreet,
        addressNumber: mapped.addressNumber,
        addressCity: mapped.addressCity,
        addressProvince: mapped.addressProvince,
        addressPostalCode: mapped.addressPostalCode,
      })
      .returning({ id: contacts.id });
    bump(ctx, 'contacts_created');
    return row?.id ?? null;
  }

  const [current] = await db.select().from(contacts).where(eq(contacts.id, existingId)).limit(1);
  if (!current) return existingId;

  // Los medios de contacto se FUSIONAN por valor: si el PAS agregó un celular a
  // mano, la sync no se lo borra; si SC trae uno nuevo, se suma.
  const known = new Set(current.contactMethods.map(m => m.value));
  const mergedMethods = [...current.contactMethods, ...mapped.contactMethods.filter(m => !known.has(m.value))];

  await db
    .update(contacts)
    .set({
      dni: fillIfEmpty(current.dni, mapped.dni),
      cuit: fillIfEmpty(current.cuit, mapped.cuit),
      producerId: current.producerId ?? producerId,
      contactMethods: mergedMethods,
      addressStreet: fillIfEmpty(current.addressStreet, mapped.addressStreet),
      addressNumber: fillIfEmpty(current.addressNumber, mapped.addressNumber),
      addressCity: fillIfEmpty(current.addressCity, mapped.addressCity),
      addressProvince: fillIfEmpty(current.addressProvince, mapped.addressProvince),
      addressPostalCode: fillIfEmpty(current.addressPostalCode, mapped.addressPostalCode),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, existingId));
  bump(ctx, 'contacts_updated');
  return existingId;
}

// ── Escritura: póliza + hijos ────────────────────────────────────────────────

/**
 * Trae el detalle de una póliza y escribe todo lo que cuelga de ella. Devuelve
 * `false` cuando el ítem debe reintentarse (fallo transitorio de SC).
 */
async function syncPolicy(ctx: Ctx, policyNumber: string, producerCodeHint: string | null): Promise<void> {
  const { detail, ramo } = await fetchDetailByRamo(policyNumber);
  const policyType =
    (detail.Ext_PolicyType as { Code?: string } | undefined)?.Code ?? (detail.PolicyType as string | undefined);
  const mapped = mapPolicy(detail, refineRamo(ramo, policyType ?? null));
  const producerCode = mapped.producerCode ?? producerCodeHint;
  const producerId = producerCode ? (ctx.producerByCode.get(producerCode) ?? null) : null;

  const scContact = primaryContact(detail);
  const contactId = scContact ? await upsertContact(ctx, mapContact(scContact), producerId) : null;

  if (ctx.dryRun) {
    bump(ctx, 'policies');
    bump(ctx, 'installments', mapInstallments(detail).length);
    bump(ctx, 'endorsements', mapEndorsements(detail).length);
    bump(ctx, 'risks', mapRisks(detail).length);
    return;
  }
  if (!contactId) {
    // Sin titular no hay dónde colgar la póliza (contact_id es NOT NULL).
    throw new Error(`Póliza ${policyNumber}: SC no devolvió contacto titular.`);
  }

  const now = new Date();
  const [existing] = await db
    .select({ id: policies.id, source: policies.source })
    .from(policies)
    .where(
      and(
        eq(policies.orgId, ctx.orgId),
        eq(policies.insurerId, ctx.insurerId),
        eq(policies.externalRef, mapped.policyNumber),
      ),
    )
    .limit(1);

  const values = {
    orgId: ctx.orgId,
    contactId,
    insurerId: ctx.insurerId,
    producerId,
    ramo: mapped.ramo,
    policyNumber: mapped.policyNumber,
    status: mapped.status,
    startDate: mapped.startDate,
    endDate: mapped.endDate,
    prima: mapped.prima,
    premio: mapped.premio,
    currency: mapped.currency,
    canceledAt: mapped.canceledAt,
    cancelReason: mapped.cancelReason,
    paymentMethod: mapped.paymentMethod,
    source: 'sync' as const,
    externalRef: mapped.policyNumber,
    externalRaw: detail,
    lastReadAt: now,
    lastChangedAt: now,
    updatedAt: now,
  };

  let policyId: string;
  if (existing) {
    await db.update(policies).set(values).where(eq(policies.id, existing.id));
    policyId = existing.id;
    bump(ctx, 'policies_updated');
  } else {
    const [row] = await db.insert(policies).values(values).returning({ id: policies.id });
    policyId = row!.id;
    bump(ctx, 'policies_created');
  }

  await syncInstallments(ctx, policyId, detail);
  await syncEndorsements(ctx, policyId, detail);
  await syncRisks(ctx, policyId, detail);
}

/**
 * Cuotas. `Invoice: null` = SC todavía no calculó la info financiera → se deja
 * lo que había. Con cuotas, se reemplaza el cronograma completo: SC es la
 * fuente de verdad del plan de pagos y un endoso lo puede reescribir entero.
 */
async function syncInstallments(ctx: Ctx, policyId: string, detail: Record<string, unknown>): Promise<void> {
  const rows = mapInstallments(detail);
  if (rows.length === 0) {
    if (detail.Invoice == null) ctx.notes.push(`Sin info financiera aún: ${String(detail.PolicyNumber)}`);
    return;
  }
  await db
    .delete(policyInstallments)
    .where(and(eq(policyInstallments.orgId, ctx.orgId), eq(policyInstallments.policyId, policyId)));
  await db.insert(policyInstallments).values(
    rows.map(r => ({
      orgId: ctx.orgId,
      policyId,
      number: r.number,
      dueDate: r.dueDate,
      amount: r.amount,
      paidAt: r.paidAt,
      source: 'sync' as const,
      externalRef: r.externalRef,
    })),
  );
  bump(ctx, 'installments', rows.length);
}

async function syncEndorsements(ctx: Ctx, policyId: string, detail: Record<string, unknown>): Promise<void> {
  const rows = mapEndorsements(detail);
  if (rows.length === 0) return;
  // Único (org, póliza, nº): un movimiento ya escrito se actualiza, no se duplica.
  await db
    .insert(policyEndorsements)
    .values(
      rows.map(r => ({
        orgId: ctx.orgId,
        policyId,
        number: r.number,
        type: r.type,
        issuedAt: r.issuedAt,
        startDate: r.startDate,
        endDate: r.endDate,
        prima: r.prima,
        premio: r.premio,
        description: r.description,
        source: 'sync' as const,
        externalRef: r.externalRef,
        externalRaw: r.raw,
      })),
    )
    .onConflictDoUpdate({
      target: [policyEndorsements.orgId, policyEndorsements.policyId, policyEndorsements.number],
      set: {
        type: sql`excluded.type`,
        issuedAt: sql`excluded.issued_at`,
        startDate: sql`excluded.start_date`,
        endDate: sql`excluded.end_date`,
        prima: sql`excluded.prima`,
        premio: sql`excluded.premio`,
        description: sql`excluded.description`,
        externalRaw: sql`excluded.external_raw`,
        updatedAt: sql`now()`,
      },
    });
  bump(ctx, 'endorsements', rows.length);
}

/** Bienes: se reemplazan los de la sync; los cargados a mano quedan intactos. */
async function syncRisks(ctx: Ctx, policyId: string, detail: Record<string, unknown>): Promise<void> {
  const rows = mapRisks(detail);
  if (rows.length === 0) return;
  await db
    .delete(policyRisks)
    .where(and(eq(policyRisks.orgId, ctx.orgId), eq(policyRisks.policyId, policyId), eq(policyRisks.source, 'sync')));
  await db.insert(policyRisks).values(
    rows.map(r => ({
      orgId: ctx.orgId,
      policyId,
      patente: r.patente,
      descripcion: r.descripcion,
      data: r.data,
      source: 'sync' as const,
      externalRef: r.externalRef,
    })),
  );
  bump(ctx, 'risks', rows.length);
}

// ── Escritura: siniestro ─────────────────────────────────────────────────────

async function syncClaim(ctx: Ctx, claimNumber: string): Promise<void> {
  const raw = await scClaimDetail(claimNumber);
  if (!raw) throw new Error(`Siniestro ${claimNumber}: SC no devolvió detalle.`);
  const mapped = mapClaim(raw);
  if (!mapped) throw new Error(`Siniestro ${claimNumber}: sin nº o sin fecha de hecho.`);

  if (ctx.dryRun) {
    bump(ctx, 'claims');
    return;
  }

  // El siniestro cuelga de la póliza (FK NOT NULL). Si todavía no la trajimos,
  // se encola y este ítem se reintenta en la próxima corrida.
  if (!mapped.policyNumber) throw new Error(`Siniestro ${claimNumber}: SC no informó nº de póliza.`);
  const [policy] = await db
    .select({ id: policies.id })
    .from(policies)
    .where(
      and(
        eq(policies.orgId, ctx.orgId),
        eq(policies.insurerId, ctx.insurerId),
        eq(policies.externalRef, mapped.policyNumber),
      ),
    )
    .limit(1);
  if (!policy) {
    await enqueue(ctx, [
      { kind: 'policy', externalRef: mapped.policyNumber, reason: 'claim_needs_policy', producerCode: null },
    ]);
    throw new Error(`Siniestro ${claimNumber}: falta la póliza ${mapped.policyNumber} (encolada).`);
  }

  const values = {
    orgId: ctx.orgId,
    policyId: policy.id,
    tipo: mapped.tipo,
    tipoDetalle: mapped.tipoDetalle,
    status: mapped.status,
    occurredAt: mapped.occurredAt,
    reportedBy: mapped.reportedBy,
    claimNumber: mapped.claimNumber,
    location: mapped.location,
    description: mapped.description,
    source: 'sync' as const,
    externalRef: mapped.claimNumber,
    lastActivityAt: new Date(),
    updatedAt: new Date(),
  };

  const [existing] = await db
    .select({ id: claims.id, status: claims.status })
    .from(claims)
    .where(and(eq(claims.orgId, ctx.orgId), eq(claims.externalRef, mapped.claimNumber)))
    .limit(1);

  if (!existing) {
    await db.insert(claims).values(values);
    bump(ctx, 'claims_created');
    return;
  }

  await db.update(claims).set(values).where(eq(claims.id, existing.id));
  bump(ctx, 'claims_updated');

  // **G5** — timeline: cada cambio de estado informado por SC queda como evento.
  // Es lo único que la sync puede aportar al timeline; los comentarios del PAS
  // los escribe la app.
  if (existing.status !== mapped.status) {
    await db.insert(schema.claimEvents).values({
      orgId: ctx.orgId,
      claimId: existing.id,
      kind: 'status_change',
      newStatus: mapped.status,
      body: `Estado informado por ${SC_INSURER_NAME}.`,
    });
    bump(ctx, 'claim_events');
  }
}

// ── Feeds ────────────────────────────────────────────────────────────────────

/** Backfill: cartera VIGENTE de cada código. El histórico no lo da la API. */
async function feedPortfolio(ctx: Ctx, refs: ScProducerRef[]): Promise<void> {
  for (const ref of refs) {
    if (outOfTime(ctx)) return;
    await heartbeat(ctx);
    const rows = await scPortfolio(ref.Code);
    bump(ctx, 'portfolio_rows', rows.length);

    // El alta liviana del contacto adelanta identidad (nombre + documento) para
    // que la cartera se vea completa aunque el detalle todavía esté en la cola.
    for (const row of rows) {
      if (row.InsuredDocument) {
        await upsertContact(
          ctx,
          mapPortfolioContact(row.InsuredName, row.InsuredDocumentType, row.InsuredDocument),
          ctx.producerByCode.get(row.ProducerCode) ?? null,
        );
      }
    }

    await enqueue(
      ctx,
      rows.map(r => ({
        kind: 'policy' as const,
        externalRef: r.PolicyNumber,
        reason: 'portfolio',
        producerCode: r.ProducerCode,
      })),
    );

    if (!ctx.dryRun) {
      await db
        .update(insurerSyncState)
        .set({ lastPortfolioAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(insurerSyncState.orgId, ctx.orgId),
            eq(insurerSyncState.insurerId, ctx.insurerId),
            eq(insurerSyncState.producerCode, ref.Code),
          ),
        );
    }
  }
}

type CursorField = 'lastMovementDate' | 'lastPaymentDate' | 'lastClaimsNewsDate';

/**
 * Recorre día a día los tres feeds diarios y encola lo que cambió. El cursor
 * avanza por día procesado, así que una caída de N días se recupera sola
 * (mientras N ≤ 30, que es lo que SC deja mirar hacia atrás).
 */
async function feedIncremental(ctx: Ctx, refs: ScProducerRef[]): Promise<void> {
  const states = await db
    .select()
    .from(insurerSyncState)
    .where(and(eq(insurerSyncState.orgId, ctx.orgId), eq(insurerSyncState.insurerId, ctx.insurerId)));
  const byCode = new Map(states.map(s => [s.producerCode, s]));

  for (const ref of refs) {
    const state = byCode.get(ref.Code);
    if (!state) continue;

    for (const [field, feed] of [
      ['lastMovementDate', 'movements'],
      ['lastPaymentDate', 'payments'],
      ['lastClaimsNewsDate', 'claim_news'],
    ] as Array<[CursorField, string]>) {
      for (const day of pendingFeedDays(state[field])) {
        if (outOfTime(ctx)) return;
        await heartbeat(ctx);
        try {
          await runFeedDay(ctx, ref, feed, day);
        } catch (err) {
          // Un servicio deshabilitado no es un fallo recuperable: se anota una
          // vez y se sigue con los demás feeds (no queremos frenar la corrida).
          const message = err instanceof Error ? err.message : String(err);
          ctx.notes.push(`${feed} ${ref.Code} ${day}: ${message}`);
          bump(ctx, `${feed}_errors`);
          if (!isNotEnabled(err)) return;
          break;
        }
        if (!ctx.dryRun) {
          await db
            .update(insurerSyncState)
            .set({ [field]: day, updatedAt: new Date() })
            .where(eq(insurerSyncState.id, state.id));
        }
      }
    }
  }
}

async function runFeedDay(ctx: Ctx, ref: ScProducerRef, feed: string, day: string): Promise<void> {
  if (feed === 'movements') {
    const numbers = await scMovementsByDate(ref.TaxId, ref.Code, day);
    await enqueue(
      ctx,
      numbers.map(n => ({
        kind: 'policy' as const,
        externalRef: n,
        reason: 'movement',
        producerCode: ref.Code,
        feedDate: day,
      })),
    );
    return;
  }
  if (feed === 'payments') {
    const movements = await scPaymentsByDay(ref.TaxId, day);
    await enqueue(
      ctx,
      movements
        .filter(m => m.Poliza)
        .map(m => ({
          kind: 'policy' as const,
          externalRef: m.Poliza,
          reason: 'payment',
          producerCode: ref.Code,
          feedDate: day,
        })),
    );
    return;
  }
  const numbers = await scClaimNews(ref.Code, day);
  await enqueue(
    ctx,
    numbers.map(n => ({
      kind: 'claim' as const,
      externalRef: n,
      reason: 'claim_news',
      producerCode: ref.Code,
      feedDate: day,
    })),
  );
}

// ── Drenado de la cola ───────────────────────────────────────────────────────

async function drainQueue(ctx: Ctx, limit?: number): Promise<void> {
  let processed = 0;

  if (ctx.dryRun) {
    for (const item of ctx.dryQueue) {
      if (outOfTime(ctx) || (limit !== undefined && processed >= limit)) return;
      processed++;
      try {
        if (item.kind === 'policy') await syncPolicy(ctx, item.externalRef, item.producerCode ?? null);
        else await syncClaim(ctx, item.externalRef);
        bump(ctx, 'processed');
      } catch (err) {
        bump(ctx, 'failed');
        ctx.notes.push(`${item.kind} ${item.externalRef}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return;
  }

  // Un ítem que falló NO se vuelve a intentar en esta misma corrida. Sin esto,
  // el select lo reelige enseguida (ordena por `attempts` ascendente) y le quema
  // los 5 intentos de un saque: si la causa es sistémica —un token vencido, SC
  // caído— la corrida entera se va en reintentos inútiles y la cola queda
  // agotada. El reintento de verdad es la próxima corrida.
  const triedThisRun = new Set<string>();

  for (;;) {
    if (outOfTime(ctx)) return;
    if (limit !== undefined && processed >= limit) return;

    const batch = await db
      .select()
      .from(insurerSyncQueue)
      .where(
        and(
          eq(insurerSyncQueue.orgId, ctx.orgId),
          eq(insurerSyncQueue.insurerId, ctx.insurerId),
          isNull(insurerSyncQueue.doneAt),
          sql`${insurerSyncQueue.attempts} < ${MAX_ATTEMPTS}`,
          triedThisRun.size > 0 ? notInArray(insurerSyncQueue.id, [...triedThisRun]) : undefined,
        ),
      )
      .orderBy(asc(insurerSyncQueue.attempts), asc(insurerSyncQueue.enqueuedAt))
      .limit(20);
    if (batch.length === 0) return;

    const done: string[] = [];
    for (const item of batch) {
      if (outOfTime(ctx)) break;
      if (limit !== undefined && processed >= limit) break;
      processed++;
      triedThisRun.add(item.id);
      // Latido por ítem, no por tanda: a ~30 s la póliza, una tanda de 20 tarda
      // más que el margen del reaper y la corrida se declararía muerta sola.
      await heartbeat(ctx);
      try {
        if (item.kind === 'policy') await syncPolicy(ctx, item.externalRef, item.producerCode);
        else await syncClaim(ctx, item.externalRef);
        done.push(item.id);
        bump(ctx, 'processed');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Si el que falló fue SC (su backend caído, un timeout), el ítem NO
        // gasta un intento: no hay nada malo con esta póliza y volver mañana
        // alcanza. Los intentos se reservan para fallas del dato — sin esta
        // distinción, una caída de SC marca la cola entera como irrecuperable.
        // Acotado igual: `triedThisRun` deja como mucho un fallo por corrida.
        const transient = isTransient(err) || isBlocked(err);
        bump(ctx, transient ? 'failed_sc' : 'failed');
        await db
          .update(insurerSyncQueue)
          .set({ attempts: transient ? item.attempts : item.attempts + 1, lastError: message.slice(0, 500) })
          .where(eq(insurerSyncQueue.id, item.id));

        // 403 de borde: no es este ítem, es que SC nos cerró la puerta. Seguir
        // pidiendo solo profundiza el bloqueo → se corta la corrida acá.
        if (isBlocked(err)) {
          ctx.notes.push(`SC bloqueó el acceso (403 RBAC). Corrida abortada; avisar a la Mesa de Servicios B2B.`);
          bump(ctx, 'aborted_blocked');
          if (done.length > 0) {
            await db.update(insurerSyncQueue).set({ doneAt: new Date() }).where(inArray(insurerSyncQueue.id, done));
          }
          return;
        }
      }
    }
    if (done.length > 0) {
      await db.update(insurerSyncQueue).set({ doneAt: new Date() }).where(inArray(insurerSyncQueue.id, done));
    }
  }
}

// ── Estado por código ────────────────────────────────────────────────────────

/** Crea la fila de cursor de cada código asociado al usuario B2B. */
async function ensureState(ctx: Ctx, refs: ScProducerRef[]): Promise<void> {
  if (ctx.dryRun || refs.length === 0) return;
  await db
    .insert(insurerSyncState)
    .values(
      refs.map(r => ({
        orgId: ctx.orgId,
        insurerId: ctx.insurerId,
        producerCode: r.Code,
        taxId: r.TaxId,
      })),
    )
    .onConflictDoUpdate({
      target: [insurerSyncState.orgId, insurerSyncState.insurerId, insurerSyncState.producerCode],
      set: { taxId: sql`excluded.tax_id`, updatedAt: sql`now()` },
    });
}

// ── Entrada ──────────────────────────────────────────────────────────────────

/**
 * Corrida completa.
 *
 * **Exclusión mutua:** la fila de `insurer_sync_runs` en estado `running` ES el
 * candado — hay un índice único parcial por (org, aseguradora), así que el
 * segundo INSERT no entra y esa corrida se va sin hacer nada. Sin esto, el cron
 * y una corrida manual se pisan y duplican requests contra el rate limit de SC.
 *
 * ⚠️ No se usa `pg_try_advisory_lock`: la app se conecta al endpoint **pooled**
 * de Neon (PgBouncer, transaction pooling), donde los locks de sesión no aíslan
 * nada — verificado en dev, con el backfill corriendo el cron se llevó el lock
 * igual y arrancó en paralelo.
 */
export async function runScSync(options: SyncOptions): Promise<SyncResult> {
  const orgId = options.orgId ?? process.env.SC_SYNC_ORG_ID;
  if (!orgId) throw new Error('SC_SYNC_ORG_ID sin configurar (org destino de la sync).');

  const budgetMs = options.budgetMs ?? 50_000;
  const insurerId = await resolveInsurerId(orgId);
  const ctx: Ctx = {
    orgId,
    insurerId,
    deadline: Date.now() + budgetMs,
    dryRun: options.dryRun ?? false,
    counters: {},
    notes: [],
    producerByCode: await loadProducerByCode(orgId, insurerId),
    dryQueue: [],
    runId: null,
  };

  resetBreaker();

  let runId: string | null = null;
  if (!ctx.dryRun) {
    // Una corrida que quedó colgada (proceso muerto) bloquearía para siempre:
    // se da por abandonada pasado el margen y libera el candado.
    await db.execute(sql`
      UPDATE insurer_sync_runs
         SET status = 'error', finished_at = now(),
             notes = coalesce(notes || E'\n', '') || 'Corrida abandonada (sin latido en ' || ${STALE_RUN_MINUTES} || ' min).'
       WHERE org_id = ${orgId} AND status = 'running'
         AND heartbeat_at < now() - (${STALE_RUN_MINUTES} || ' minutes')::interval`);

    const claimed = await db.execute<{ id: string }>(sql`
      INSERT INTO insurer_sync_runs (org_id, insurer_id, mode)
      VALUES (${orgId}, ${insurerId}, ${options.mode})
      ON CONFLICT (org_id, insurer_id) WHERE status = 'running' DO NOTHING
      RETURNING id`);
    runId = claimed.rows[0]?.id ?? null;
    if (!runId) {
      return { runId: null, mode: options.mode, orgId, counters: { skipped_locked: 1 }, tripped: [], notes: [] };
    }
    ctx.runId = runId;
  }

  try {
    const all = await scProducers();
    const refs = options.onlyCodes?.length ? all.filter(r => options.onlyCodes!.includes(r.Code)) : all;
    bump(ctx, 'producer_codes', refs.length);
    await ensureState(ctx, refs);

    if (options.mode === 'backfill') await feedPortfolio(ctx, refs);
    else await feedIncremental(ctx, refs);

    await drainQueue(ctx, options.limit);

    const tripped = trippedEndpoints();
    if (!ctx.dryRun && runId) {
      await db
        .update(insurerSyncRuns)
        .set({
          status: 'ok',
          counters: ctx.counters,
          notes: summarize(ctx.notes, tripped),
          finishedAt: new Date(),
        })
        .where(eq(insurerSyncRuns.id, runId));
    }
    return { runId, mode: options.mode, orgId, counters: ctx.counters, tripped, notes: ctx.notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (runId) {
      await db
        .update(insurerSyncRuns)
        .set({ status: 'error', counters: ctx.counters, notes: message.slice(0, 2000), finishedAt: new Date() })
        .where(eq(insurerSyncRuns.id, runId));
    }
    throw err;
  }
}

function summarize(notes: string[], tripped: string[]): string | null {
  const parts = [
    ...(tripped.length ? [`Breaker abierto: ${tripped.join(', ')}`] : []),
    ...notes.slice(0, 40),
    ...(notes.length > 40 ? [`… y ${notes.length - 40} más`] : []),
  ];
  return parts.length ? parts.join('\n').slice(0, 4000) : null;
}
