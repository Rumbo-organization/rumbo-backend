import { Router } from 'express';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { requireAuthedOrg, requireOwner } from '../middleware/authed.js';
import { withAuthedTx, schema, type AuthedTx } from '../db/client.js';
import { calendar } from './calendar.js';
import { claimsRouter } from './claims.js';
import { writeAuditLogTx } from '../audit.js';

const isUuidV1 = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const {
  auditLog,
  claimEvents,
  claims,
  contacts,
  insurers,
  organizations,
  policies,
  policyInstallments,
  policyRisks,
  producers,
  quoteItems,
  quotes,
  users,
} = schema;

// ── Mapeos dominio → etiquetas del cockpit ──────────────────────────────────
// El BFF devuelve el payload en la forma exacta que consume window.RUMBO_DATA
// (rumbo-frontend/src/data.jsx): acá vive la traducción enum → display.

const RAMO_LABEL: Record<string, string> = {
  automotor: 'Automotor',
  hogar: 'Hogar',
  vida: 'Vida',
  art: 'ART',
  comercio: 'Comercio',
  accidentes_personales: 'Accidentes',
  motovehiculo: 'Automotor',
  incendio: 'Integral',
  responsabilidad_civil: 'Integral',
  consorcio: 'Integral',
  seguro_tecnico: 'Integral',
  transporte: 'Integral',
  embarcaciones: 'Integral',
  otros: 'Integral',
};
const ramoLabel = (r: string | null): string => (r ? RAMO_LABEL[r] ?? 'Integral' : 'Integral');

const CLAIM_TIPO_LABEL: Record<string, string> = {
  robo: 'Robo',
  choque: 'Choque',
  incendio: 'Incendio',
  danos_agua: 'Daños por agua',
  granizo: 'Granizo',
  cristales: 'Cristales',
  resp_civil: 'Resp. civil',
  otros: 'Otro',
};

const CLAIM_STATUS_LABEL: Record<string, string> = {
  abierto: 'Abierto',
  en_curso: 'En curso',
  cerrado: 'Cerrado',
};

const CLAIM_IMPORTANCE_LABEL: Record<string, string> = {
  alta: 'Alta',
  media: 'Media',
  baja: 'Baja',
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cupon: 'Cupón',
  debito_bancario: 'Débito bancario',
  tarjeta_credito: 'Tarjeta de crédito',
};
const paymentLabel = (m: string | null): string | null => (m ? PAYMENT_METHOD_LABEL[m] ?? m : null);

const POLICY_STATUS_LABEL: Record<string, string> = {
  propuesta: 'Propuesta',
  vigente: 'Vigente',
  vencida: 'Vencida',
  anulada: 'Anulada',
  renovada: 'Renovada',
};

function displayName(c: {
  kind: string;
  firstName: string | null;
  lastName: string | null;
  legalName: string | null;
}): string {
  if (c.kind === 'PERSONA_JURIDICA') return c.legalName ?? '—';
  if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
  return c.lastName ?? c.firstName ?? '—';
}

function initialsOf(name: string): string {
  const words = name.replace(/,/g, '').split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toUpperCase();
}

function firstPhone(methods: unknown): string {
  if (!Array.isArray(methods)) return '';
  const m =
    (methods as { type?: string; value?: string; primary?: boolean }[]).find((x) => x.primary) ??
    (methods as { type?: string; value?: string }[]).find((x) =>
      ['celular', 'telefono', 'whatsapp'].includes(x.type ?? ''),
    );
  return m?.value ?? '';
}

const MONTHS_AR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function relativeWhen(d: Date, now: Date): string {
  const hm = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Cordoba' });
  const day = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' });
  const dayDiff = Math.round((Date.parse(day(now)) - Date.parse(day(d))) / 86400000);
  if (dayDiff <= 0) return `Hoy ${hm}`;
  if (dayDiff === 1) return `Ayer ${hm}`;
  return `${d.getDate()} ${MONTHS_AR[d.getMonth()]} ${hm}`;
}

function relativeSince(d: Date, now: Date): string {
  const days = Math.max(0, Math.round((now.getTime() - d.getTime()) / 86400000));
  if (days === 0) return 'hoy';
  if (days === 1) return 'hace 1 día';
  if (days < 7) return `hace ${days} días`;
  const weeks = Math.round(days / 7);
  if (days < 30) return `hace ${weeks} sem.`;
  return `hace ${Math.round(days / 30)} meses`;
}

const num = (x: unknown): number => (x == null ? 0 : Number(x));

// ── Ensamblado del cockpit ──────────────────────────────────────────────────
// assembleCockpit arma TODAS las secciones en la forma de window.RUMBO_DATA.
// /bootstrap devuelve todo junto; cada endpoint REST individual devuelve su
// slice. Todo corre dentro de withAuthedTx → RLS por organización.

async function assembleCockpit(tx: AuthedTx, now: Date) {
  // La tx usa una sola conexión: queries secuenciales, no Promise.all.
  const contactRows = await tx
    .select()
    .from(contacts)
    .orderBy(asc(contacts.createdAt))
    .limit(500);

  const insurerRows = await tx.select().from(insurers).orderBy(asc(insurers.name));
  const insurerName = new Map(insurerRows.map((i) => [i.id, i.name]));

  const policyRows = await tx
    .select({
      p: policies,
      daysToEnd: sql<number>`(${policies.endDate} - current_date)::int`,
    })
    .from(policies)
    .orderBy(asc(policies.endDate))
    .limit(1000);

  const installmentRows = await tx
    .select({
      i: policyInstallments,
      daysOverdue: sql<number>`(current_date - ${policyInstallments.dueDate})::int`,
    })
    .from(policyInstallments)
    .orderBy(asc(policyInstallments.dueDate))
    .limit(3000);

  const claimRows = await tx
    .select({
      c: claims,
      stale: sql<number>`floor(extract(epoch from (now() - ${claims.lastActivityAt})) / 86400)::int`,
    })
    .from(claims)
    .orderBy(desc(claims.lastActivityAt))
    .limit(500);

  const quoteRows = await tx
    .select({ q: quotes })
    .from(quotes)
    .orderBy(desc(quotes.createdAt))
    .limit(200);

  const quoteItemRows = await tx.select().from(quoteItems).limit(1000);

  // Productores con agregados SQL uncapped (Fase 3 escalabilidad): pólizas,
  // prima y siniestros por productor salen de COUNT/SUM directos, NO de la
  // array capada de policies (a 10k+ los números daban truncados).
  const producerRows = await tx
    .select({
      pr: producers,
      // OJO: producers.id va literal — en un select de tabla única drizzle
      // renderiza ${producers.id} sin calificar ("id") y adentro de la
      // subquery con alias p queda ambiguo.
      polizas: sql<number>`(select count(*)::int from ${policies} p where p.producer_id = producers.id and p.status = 'vigente')`,
      prima: sql<number>`(select coalesce(sum(p.prima), 0)::float from ${policies} p where p.producer_id = producers.id and p.status = 'vigente')`,
      siniestros: sql<number>`(select count(*)::int from ${claims} cl join ${policies} p on p.id = cl.policy_id where p.producer_id = producers.id and p.status = 'vigente')`,
    })
    .from(producers)
    .orderBy(asc(producers.name));

  const auditRows = await tx
    .select({ a: auditLog, userName: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .orderBy(desc(auditLog.createdAt))
    .limit(40);

  // ---- contactos (solo lookup interno: la array CONTACTS ya no viaja) ----
  const contactById = new Map(contactRows.map((c) => [c.id, c]));

  // ---- pólizas ----
  const clientOf = (contactId: string | null): string => {
    const c = contactId ? contactById.get(contactId) : undefined;
    return c ? displayName(c) : '—';
  };

  // La array POLICIES ya no viaja en el bootstrap (Fase 3): el listado es
  // paginado (/policies) y el detalle directo (/policies/:id[/detail]).
  const policyById = new Map(policyRows.map(({ p }) => [p.id, p]));

  // ---- vencimientos: vigentes que renuevan en ≤45 días (incluye vencidas recientes) ----
  const VENCIMIENTOS = policyRows
    .filter(({ p, daysToEnd }) => p.status === 'vigente' && p.endDate != null && daysToEnd <= 45)
    .map(({ p, daysToEnd }) => ({
      id: `v-${p.id}`,
      policyId: p.id,
      client: clientOf(p.contactId),
      insurer: (p.insurerId && insurerName.get(p.insurerId)) ?? '—',
      ramo: ramoLabel(p.ramo),
      date: p.endDate,
      prima: num(p.prima),
      days: daysToEnd,
    }))
    .sort((a, b) => a.days - b.days);

  // ---- siniestros ----
  const SINIESTROS = claimRows.map(({ c, stale }) => {
    const p = c.policyId ? policyById.get(c.policyId) : undefined;
    return {
      id: c.id,
      tipo: CLAIM_TIPO_LABEL[c.tipo] ?? c.tipo,
      client: clientOf(p?.contactId ?? null),
      policyId: c.policyId,
      num: c.claimNumber ?? '—',
      status: CLAIM_STATUS_LABEL[c.status] ?? c.status,
      importance: c.importance ? CLAIM_IMPORTANCE_LABEL[c.importance] ?? c.importance : null,
      reportedBy: c.reportedBy,
      stale: Math.max(0, stale),
      opened: c.occurredAt.toISOString().slice(0, 10),
      insurer: (p?.insurerId && insurerName.get(p.insurerId)) || '—',
      ramo: p ? ramoLabel(p.ramo) : '—',
    };
  });

  // ---- cuotas vencidas (impagas con vencimiento pasado) ----
  const CUOTAS = installmentRows
    .filter(({ i, daysOverdue }) => i.paidAt == null && daysOverdue > 0)
    .map(({ i, daysOverdue }) => {
      const p = policyById.get(i.policyId);
      return {
        id: i.id,
        client: clientOf(p?.contactId ?? null),
        policyId: i.policyId,
        cuota: i.number,
        due: i.dueDate,
        amount: num(i.amount),
        days: -daysOverdue, // el cockpit espera días relativos (negativo = vencida)
      };
    });

  // ---- cross-selling (reglas v0.1 de la app: auto sin hogar, etc.) ----
  const ramosByContact = new Map<string, Set<string>>();
  for (const { p } of policyRows) {
    if (p.status !== 'vigente' || !p.contactId || !p.ramo) continue;
    const set = ramosByContact.get(p.contactId) ?? new Set<string>();
    set.add(p.ramo);
    ramosByContact.set(p.contactId, set);
  }
  // CROSS_RULES: módulo-level (compartidas con la ficha del contacto).
  const CROSSSELL: object[] = [];
  for (const [contactId, ramos] of ramosByContact) {
    for (const rule of CROSS_RULES) {
      if (ramos.has(rule.have) && !ramos.has(rule.lack)) {
        CROSSSELL.push({
          id: `x-${contactId}-${rule.suggest}`,
          client: clientOf(contactId),
          contactId,
          has: [...ramos].map(ramoLabel),
          suggest: rule.suggest,
          reason: rule.reason,
          score: rule.score,
        });
        break; // una oportunidad por cliente (la primera regla que matchea)
      }
    }
  }

  // ---- prospectos (contactos en pipeline) ----
  const latestQuoteByContact = new Map<string, (typeof quoteRows)[number]['q']>();
  for (const { q } of quoteRows) {
    if (q.contactId && !latestQuoteByContact.has(q.contactId)) latestQuoteByContact.set(q.contactId, q);
  }
  const PROSPECTOS = contactRows
    .filter((c) => c.status === 'prospecto')
    .map((c) => {
      const name = displayName(c);
      const q = latestQuoteByContact.get(c.id);
      return {
        id: c.id,
        name,
        stage: c.pipelineStage ?? 'nuevo',
        ramo: q ? ramoLabel(q.ramo) : '—',
        city: c.addressCity ?? '—',
        estim: 0,
        since: relativeSince(c.updatedAt, now),
        initials: initialsOf(name),
        note: c.notes ?? '',
      };
    });

  // ---- cotizaciones ----
  const itemsByQuote = new Map<string, typeof quoteItemRows>();
  for (const it of quoteItemRows) {
    (itemsByQuote.get(it.quoteId) ?? itemsByQuote.set(it.quoteId, []).get(it.quoteId)!).push(it);
  }
  const COTIZACIONES = quoteRows.map(({ q }) => {
    const items = itemsByQuote.get(q.id) ?? [];
    const best = items.reduce<(typeof items)[number] | null>(
      (acc, it) => (acc == null || num(it.cuota) < num(acc.cuota) ? it : acc),
      null,
    );
    const ageDays = Math.round((now.getTime() - q.createdAt.getTime()) / 86400000);
    const valid = 15 - ageDays;
    return {
      id: q.id,
      // La DB no tiene número de cotización: derivamos un código estable y
      // mono-aspecto del año + sufijo del uuid. `reference` (texto libre, suele
      // ser el nombre del cliente) va aparte en `client`.
      num: `COT-${q.createdAt.getFullYear()}-${q.id.replace(/-/g, '').slice(-4).toUpperCase()}`,
      client: clientOf(q.contactId) !== '—' ? clientOf(q.contactId) : (q.reference ?? '—'),
      ramo: ramoLabel(q.ramo),
      status: valid < 0 ? 'Vencida' : items.length > 0 ? 'Enviada' : 'Borrador',
      best: (best?.insurerId && insurerName.get(best.insurerId)) ?? '—',
      monthly: best ? num(best.cuota) : 0,
      options: items.length,
      date: q.createdAt.toISOString().slice(0, 10),
      valid,
    };
  });

  // ---- productores (agregados SQL de producerRows, no las arrays capadas) ----
  const PRODUCTORES = producerRows.map(({ pr, polizas, prima, siniestros }) => ({
    id: pr.id,
    name: pr.name,
    role: pr.isSelf ? 'Titular' : 'Productor',
    initials: initialsOf(pr.name),
    polizas: polizas ?? 0,
    prima: prima ?? 0,
    conversion: 0,
    siniestros: siniestros ?? 0,
  }));

  // ---- auditoría ----
  const AUDIT = auditRows.map(({ a, userName }) => {
    const payload = (a.payload ?? {}) as Record<string, unknown>;
    return {
      id: a.id,
      when: relativeWhen(a.createdAt, now),
      action: a.action,
      entity: String(payload.entity ?? a.entityType ?? '—'),
      detail: String(payload.detail ?? ''),
      user: userName ?? 'Sistema',
      kind: 'event',
    };
  });

  // ---- agregados del BOOK: SQL directo (uncapped), NO las arrays capadas ----
  // (Fase 3 escalabilidad: el dashboard debe contar toda la cartera, no las
  // primeras 1000/500 filas del bootstrap.) Bajo RLS = solo esta org.
  const [polAgg] = (await tx.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (where status = 'vigente')::int as vigentes,
      coalesce(sum(prima) filter (where status = 'vigente'), 0)::float8 as prima_vigente,
      count(*) filter (where status = 'vigente' and end_date is not null and (end_date - current_date) <= 30)::int as vence30,
      count(*) filter (where status = 'vigente' and end_date is not null and (end_date - current_date) <= 7)::int as vence7
    from policies
  `)).rows as unknown as Array<{ total: number; vigentes: number; prima_vigente: number; vence30: number; vence7: number }>;

  const [primaAnualRow] = (await tx.execute(sql`
    select coalesce(sum(p.prima * (case when ic.n >= 10 then 12 when ic.n >= 4 then 4 when ic.n >= 2 then 2 else 1 end)), 0)::float8 as prima_anual
    from policies p
    left join (select policy_id, count(*)::int as n from policy_installments group by policy_id) ic on ic.policy_id = p.id
  `)).rows as unknown as Array<{ prima_anual: number }>;

  const [contactAgg] = (await tx.execute(sql`
    select count(*) filter (where status = 'asegurado')::int as asegurados from contacts
  `)).rows as unknown as Array<{ asegurados: number }>;

  const [claimAgg] = (await tx.execute(sql`
    select
      count(*) filter (where status <> 'cerrado')::int as abiertos,
      count(*) filter (where status <> 'cerrado' and last_activity_at <= now() - interval '10 days')::int as stale
    from claims
  `)).rows as unknown as Array<{ abiertos: number; stale: number }>;

  const [cuotaAgg] = (await tx.execute(sql`
    select count(*)::int as vencidas, coalesce(sum(amount), 0)::float8 as monto
    from policy_installments
    where paid_at is null and due_date < current_date
  `)).rows as unknown as Array<{ vencidas: number; monto: number }>;

  const health = Math.max(
    40,
    Math.min(99, 100 - (claimAgg?.stale ?? 0) * 8 - (cuotaAgg?.vencidas ?? 0) * 5 - (polAgg?.vence7 ?? 0) * 3),
  );

  const BOOK = {
    primaTotal: polAgg?.prima_vigente ?? 0,
    primaAnual: primaAnualRow?.prima_anual ?? 0,
    polizas: polAgg?.total ?? 0,
    vigentes: polAgg?.vigentes ?? 0,
    contactos: contactAgg?.asegurados ?? 0,
    vence30: polAgg?.vence30 ?? 0,
    siniestros: claimAgg?.abiertos ?? 0,
    cuotasVencidas: cuotaAgg?.vencidas ?? 0,
    cuotasMonto: cuotaAgg?.monto ?? 0,
    health,
  };

  // Fase 3 (escalabilidad): CONTACTS, POLICIES, ACTIVITY y COUNTS ya NO viajan.
  // Todos sus consumidores migraron a endpoints dedicados (listados paginados,
  // /policies/:id/detail, pickers, /crosssell). El bootstrap queda para los
  // agregados y secciones chicas del dashboard.
  return {
    TODAY: now.toISOString().slice(0, 10),
    INSURERS: insurerRows.map((i) => i.name),
    VENCIMIENTOS,
    SINIESTROS,
    CUOTAS,
    CROSSSELL,
    BOOK,
    PROSPECTOS,
    COTIZACIONES,
    PRODUCTORES,
    AUDIT,
  };
}

// Organización activa (RLS → tenant_isolation devuelve solo la org de la sesión).
async function loadOrg(tx: AuthedTx) {
  const [org] = await tx.select().from(organizations).limit(1);
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    matricula: org.ssnMatricula ?? null,
    cuit: org.cuit ?? null,
    fiscalCondition: org.fiscalCondition ?? null,
  };
}

// Rol legible del usuario en la org (para el chrome: "Titular" / "Productor").
const ROLE_LABEL: Record<string, string> = {
  owner: 'Titular',
  admin: 'Administrador',
  member: 'Productor',
};

// ── Router REST v1 ───────────────────────────────────────────────────────────

export const v1 = Router();
v1.use(requireAuthedOrg);

// Calendario (jul-2026): month view (4 fuentes derivadas) + CRUD de la agenda.
// Primer camino de escritura del backend. Hereda requireAuthedOrg de este router.
v1.use('/calendar', calendar);

// Siniestros — escrituras (gestión). PATCH /claims/:id/status. La lectura de la
// lista sigue en v1.get('/claims') (alias del cockpit) más abajo; este router no
// define GET '/', así que esa ruta cae al handler de lectura.
v1.use('/claims', claimsRouter);

// Corre fn dentro de withAuthedTx y responde JSON; centraliza el try/catch.
function handle<T>(fn: (tx: AuthedTx, ctx: NonNullable<import('../db/client.js').AuthContext>) => Promise<T>) {
  return async (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    try {
      const data = await withAuthedTx(req.authCtx!, (tx) => fn(tx, req.authCtx!));
      res.json(data);
    } catch (err) {
      next(err);
    }
  };
}

// BFF del cockpit: todo lo que la SPA necesita para hidratar window.RUMBO_DATA,
// en un solo request (secciones + organización + usuario de la sesión).
v1.get('/bootstrap', handle(async (tx, ctx) => {
  const now = new Date();
  const [cockpit, org] = [await assembleCockpit(tx, now), await loadOrg(tx)];
  // termsAcceptedAt: gatea el modal de legales de única vez en el frontend
  // (cuentas creadas antes del checkbox del registro). RLS self_isolation.
  const [me] = await tx
    .select({ termsAcceptedAt: users.termsAcceptedAt })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);
  return {
    ...cockpit,
    ORG: org,
    ME: {
      role: ctx.role,
      roleLabel: ROLE_LABEL[ctx.role] ?? 'Productor',
      producerId: ctx.producerId,
      termsAcceptedAt: me?.termsAcceptedAt?.toISOString() ?? null,
    },
  };
}));

// ── Endpoints REST individuales (misma forma que las arrays del cockpit) ──────
// Base de la API pública (D-026). Cada uno devuelve { data: [...] }.

const section = (key: string) =>
  handle(async (tx) => ({ data: (await assembleCockpit(tx, new Date()))[key as keyof Awaited<ReturnType<typeof assembleCockpit>>] }));

// Asegurados/contactos paginado server-side (Fase 2 escalabilidad,
// roadmap/PLAN-ESCALABILIDAD.md): búsqueda (nombre/DNI/CUIT/ciudad), filtro por
// segmento (asegurado/prospecto/empresa), orden y paginación en SQL. Agrega por
// contacto el nº de pólizas y los días al próximo vencimiento (para la lista). El
// resumen/ficha se pide aparte por /contacts/:id. RLS por org.
v1.get('/contacts', async (req, res, next) => {
  const qStr = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const seg = typeof req.query.seg === 'string' ? req.query.seg : 'todos';
  const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  try {
    const out = await withAuthedTx(req.authCtx!, async (tx) => {
      const conds = [];
      if (qStr) {
        const like = `%${qStr}%`;
        conds.push(sql`(
          ${contacts.firstName} ilike ${like}
          or ${contacts.lastName} ilike ${like}
          or ${contacts.legalName} ilike ${like}
          or ${contacts.dni} ilike ${like}
          or ${contacts.cuit} ilike ${like}
          or ${contacts.addressCity} ilike ${like}
        )`);
      }
      if (seg === 'clientes') conds.push(eq(contacts.status, 'asegurado'));
      else if (seg === 'prospectos') conds.push(eq(contacts.status, 'prospecto'));
      else if (seg === 'empresas') conds.push(eq(contacts.kind, 'PERSONA_JURIDICA'));
      const where = conds.length ? and(...conds) : undefined;

      const orderExpr = sql`coalesce(${contacts.legalName}, ${contacts.lastName}, ${contacts.firstName})`;

      const rows = await tx
        .select({
          c: contacts,
          polCount: sql<number>`(select count(*)::int from ${policies} p where p.contact_id = ${contacts.id})`,
          nextRenewDays: sql<number | null>`(select min(p.end_date - current_date)::int from ${policies} p where p.contact_id = ${contacts.id} and p.end_date is not null)`,
        })
        .from(contacts)
        .where(where)
        .orderBy(dir === 'desc' ? desc(orderExpr) : asc(orderExpr))
        .limit(limit)
        .offset(offset);

      const total = (await tx.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where))[0]?.n ?? 0;

      const data = rows.map(({ c, polCount, nextRenewDays }) => {
        const name = displayName(c);
        return {
          id: c.id,
          name,
          initials: initialsOf(name),
          kind: c.kind === 'PERSONA_JURIDICA' ? 'Empresa' : 'Persona',
          city: c.addressCity ?? '—',
          phone: firstPhone(c.contactMethods),
          document: c.dni ? `DNI ${c.dni}` : c.cuit ? `CUIT ${c.cuit}` : null,
          since: String(c.createdAt.getFullYear()),
          tags: c.status === 'prospecto' ? ['Prospecto'] : c.status === 'exasegurado' ? ['Ex asegurado'] : ['Asegurado'],
          polCount: polCount ?? 0,
          nextRenewDays: nextRenewDays,
        };
      });
      return { data, total, limit, offset };
    });
    res.json(out);
  } catch (err) { next(err); }
});
// Vencimientos paginado server-side (Fase 4 escalabilidad): pólizas con fecha de
// fin, ordenadas por renovación, filtradas por ventana (30/90/todo) y forma de
// pago. Devuelve { data, total, totalPrima, counts, limit, offset }. Misma forma
// de fila que POLICIES; el frontend calcula los días y agrupa por mes. RLS por org.
v1.get('/vencimientos', async (req, res, next) => {
  const windowDays = req.query.window === '30' ? 30 : req.query.window === '90' ? 90 : null;
  const pay = typeof req.query.pay === 'string' ? req.query.pay : '';
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  try {
    const out = await withAuthedTx(req.authCtx!, async (tx) => {
      const conds = [sql`${policies.endDate} is not null`];
      if (windowDays) conds.push(sql`(${policies.endDate} - current_date) <= ${windowDays}`);
      if (pay === '__none__') conds.push(sql`${policies.paymentMethod} is null`);
      else if (pay && PAYMENT_METHOD_LABEL[pay]) conds.push(sql`${policies.paymentMethod} = ${pay}`);
      const where = and(...conds);

      const rows = await tx
        .select(policyRowSelect)
        .from(policies)
        .leftJoin(insurers, eq(insurers.id, policies.insurerId))
        .leftJoin(contacts, eq(contacts.id, policies.contactId))
        .where(where)
        .orderBy(asc(policies.endDate))
        .limit(limit)
        .offset(offset);

      const agg = (await tx
        .select({ total: sql<number>`count(*)::int`, totalPrima: sql<number>`coalesce(sum(${policies.prima}), 0)::float8` })
        .from(policies)
        .where(where))[0];

      // Conteos por ventana (ignoran el filtro de pago, como los chips actuales).
      const counts = (await tx.execute(sql`
        select
          count(*) filter (where (end_date - current_date) <= 30)::int as d30,
          count(*) filter (where (end_date - current_date) <= 90)::int as d90,
          count(*)::int as all_count
        from policies where end_date is not null
      `)).rows[0] as unknown as { d30: number; d90: number; all_count: number };

      return {
        data: rows.map(mapPolicyRow),
        total: agg?.total ?? 0,
        totalPrima: agg?.totalPrima ?? 0,
        counts: { d30: counts?.d30 ?? 0, d90: counts?.d90 ?? 0, all: counts?.all_count ?? 0 },
        limit,
        offset,
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});
v1.get('/siniestros', section('SINIESTROS'));
v1.get('/cuotas', section('CUOTAS'));
v1.get('/crossselling', section('CROSSSELL'));
v1.get('/prospectos', section('PROSPECTOS'));
v1.get('/cotizaciones', section('COTIZACIONES'));
v1.get('/productores', requireOwner, section('PRODUCTORES'));
v1.get('/actividad', section('AUDIT'));
v1.get('/insurers', handle(async (tx) => ({ data: (await assembleCockpit(tx, new Date())).INSURERS })));

// Alias en inglés (compatibilidad con la primera versión del cliente).
v1.get('/claims', section('SINIESTROS'));
v1.get('/quotes', section('COTIZACIONES'));

// KPIs agregados del dashboard.
v1.get('/book', handle(async (tx) => (await assembleCockpit(tx, new Date())).BOOK));

// Pólizas paginado server-side (Fase 1 escalabilidad, roadmap/PLAN-ESCALABILIDAD.md):
// búsqueda, filtro por segmento/forma de pago, orden y paginación en SQL. Misma
// forma de fila que un item de POLICIES del cockpit. RLS por org. Devuelve
// { data, total, limit, offset } para que el frontend pagine sin traer todo.
const POLICY_SORT_COL: Record<string, unknown> = {
  num: policies.policyNumber,
  ramo: policies.ramo,
  prima: policies.prima,
  renew: policies.endDate,
  status: policies.status,
};
const freqFromCount = (n: number): string =>
  n >= 10 ? 'Mensual' : n >= 4 ? 'Trimestral' : n >= 2 ? 'Semestral' : 'Anual';

// Select + mapper de una fila de póliza — compartido por el listado paginado de
// pólizas y por la ficha del contacto (para no traer la lista completa ni pasar
// por assembleCockpit). Subconsultas correlacionadas: freq (nº de cuotas) y el
// detalle del riesgo. Se lee con leftJoin a insurers + contacts.
const policyRowSelect = {
  p: policies,
  insurerName: insurers.name,
  cKind: contacts.kind,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  legalName: contacts.legalName,
  instCount: sql<number>`(select count(*)::int from ${policyInstallments} pi where pi.policy_id = ${policies.id})`,
  riskLabel: sql<string | null>`(select (r.descripcion || case when r.patente is not null then ' · ' || r.patente else '' end) from ${policyRisks} r where r.policy_id = ${policies.id} limit 1)`,
};
type PolicyRowRaw = {
  p: typeof policies.$inferSelect;
  insurerName: string | null; cKind: string | null;
  firstName: string | null; lastName: string | null; legalName: string | null;
  instCount: number | null; riskLabel: string | null;
};
function mapPolicyRow(r: PolicyRowRaw) {
  const p = r.p;
  const client = displayName({ kind: r.cKind ?? 'PERSONA_FISICA', firstName: r.firstName, lastName: r.lastName, legalName: r.legalName });
  return {
    id: p.id,
    num: p.policyNumber ?? '—',
    contactId: p.contactId,
    client,
    insurer: r.insurerName ?? '—',
    ramo: ramoLabel(p.ramo),
    detail: r.riskLabel ?? p.notes ?? ramoLabel(p.ramo),
    prima: num(p.prima),
    freq: freqFromCount(r.instCount ?? 0),
    status: POLICY_STATUS_LABEL[p.status] ?? p.status,
    start: p.startDate,
    renew: p.endDate,
    coverage: p.notes ?? '—',
    paymentMethod: paymentLabel(p.paymentMethod),
    sumaAseg: p.sumaAsegurada == null ? null : num(p.sumaAsegurada),
  };
}

// Reglas de cross-sell (ramo que tiene → ramo que le falta). Módulo-level para
// reusarlas en el cockpit y en la ficha del contacto.
const CROSS_RULES = [
  { have: 'automotor', lack: 'hogar', suggest: 'Hogar', reason: 'Tiene Automotor, sin cobertura de vivienda', score: 'Alta' },
  { have: 'automotor', lack: 'vida', suggest: 'Vida', reason: 'Tiene Automotor, sin seguro de vida', score: 'Media' },
  { have: 'hogar', lack: 'automotor', suggest: 'Automotor', reason: 'Tiene Hogar, sin cobertura de vehículo', score: 'Media' },
  { have: 'comercio', lack: 'automotor', suggest: 'Automotor', reason: 'Tiene Comercio, sin flota asegurada', score: 'Media' },
  { have: 'art', lack: 'incendio', suggest: 'Integral', reason: 'Tiene ART, planta sin cobertura de incendio', score: 'Alta' },
];

v1.get('/policies', async (req, res, next) => {
  const qStr = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const seg = typeof req.query.seg === 'string' ? req.query.seg : 'todas';
  const pay = typeof req.query.pay === 'string' ? req.query.pay : '';
  const sortKey = typeof req.query.sort === 'string' ? req.query.sort : 'renew';
  const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  try {
    const out = await withAuthedTx(req.authCtx!, async (tx) => {
      const conds = [];
      if (qStr) {
        const like = `%${qStr}%`;
        conds.push(sql`(
          ${policies.policyNumber} ilike ${like}
          or ${policies.ramo}::text ilike ${like}
          or ${policies.notes} ilike ${like}
          or ${insurers.name} ilike ${like}
          or ${contacts.firstName} ilike ${like}
          or ${contacts.lastName} ilike ${like}
          or ${contacts.legalName} ilike ${like}
        )`);
      }
      if (seg === 'porvencer') conds.push(sql`(${policies.endDate} - current_date) <= 30`);
      else if (seg === 'siniestro') conds.push(sql`exists (select 1 from ${claims} cl where cl.policy_id = ${policies.id})`);
      else if (seg === 'flota') conds.push(sql`(${policies.notes} ilike '%flota%' or exists (select 1 from ${policyRisks} r where r.policy_id = ${policies.id} and r.descripcion ilike '%flota%'))`);
      if (pay && PAYMENT_METHOD_LABEL[pay]) conds.push(sql`${policies.paymentMethod} = ${pay}`);
      const where = conds.length ? and(...conds) : undefined;

      const orderExpr =
        sortKey === 'client' ? sql`coalesce(${contacts.legalName}, ${contacts.lastName}, ${contacts.firstName})`
        : sortKey === 'insurer' ? insurers.name
        : (POLICY_SORT_COL[sortKey] ?? policies.endDate);

      const rows = await tx
        .select(policyRowSelect)
        .from(policies)
        .leftJoin(insurers, eq(insurers.id, policies.insurerId))
        .leftJoin(contacts, eq(contacts.id, policies.contactId))
        .where(where)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .orderBy(dir === 'desc' ? desc(orderExpr as any) : asc(orderExpr as any))
        .limit(limit)
        .offset(offset);

      const total = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(policies)
        .leftJoin(insurers, eq(insurers.id, policies.insurerId))
        .leftJoin(contacts, eq(contacts.id, policies.contactId))
        .where(where))[0]?.n ?? 0;

      const data = rows.map(mapPolicyRow);
      return { data, total, limit, offset };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// Picker liviano de pólizas (Fase 3): filas mínimas para dropdowns/typeahead
// (denuncia de siniestro, palette). Búsqueda ILIKE server-side, límite corto.
// Registrado ANTES de /policies/:id para que "picker" no matchee como id.
v1.get('/policies/picker', async (req, res, next) => {
  const qStr = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 50);
  try {
    const out = await withAuthedTx(req.authCtx!, async (tx) => {
      const conds = [];
      if (qStr) {
        const like = `%${qStr}%`;
        conds.push(sql`(
          ${policies.policyNumber} ilike ${like}
          or ${policies.ramo}::text ilike ${like}
          or ${insurers.name} ilike ${like}
          or ${contacts.firstName} ilike ${like}
          or ${contacts.lastName} ilike ${like}
          or ${contacts.legalName} ilike ${like}
        )`);
      }
      const rows = await tx
        .select(policyRowSelect)
        .from(policies)
        .leftJoin(insurers, eq(insurers.id, policies.insurerId))
        .leftJoin(contacts, eq(contacts.id, policies.contactId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(policies.endDate))
        .limit(limit);
      return {
        data: rows.map(mapPolicyRow).map((p) => ({
          id: p.id, num: p.num, client: p.client, ramo: p.ramo,
          insurer: p.insurer, detail: p.detail,
        })),
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// Picker liviano de contactos (Fase 3): id + nombre para dropdowns/typeahead
// (cotizador, calendario, palette). Registrado ANTES de /contacts/:id.
v1.get('/contacts/picker', async (req, res, next) => {
  const qStr = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 50);
  try {
    const out = await withAuthedTx(req.authCtx!, async (tx) => {
      const conds = [];
      if (qStr) {
        const like = `%${qStr}%`;
        conds.push(sql`(
          ${contacts.firstName} ilike ${like}
          or ${contacts.lastName} ilike ${like}
          or ${contacts.legalName} ilike ${like}
          or ${contacts.dni} ilike ${like}
          or ${contacts.cuit} ilike ${like}
          or ${contacts.addressCity} ilike ${like}
        )`);
      }
      const rows = await tx
        .select()
        .from(contacts)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(asc(sql`coalesce(${contacts.legalName}, ${contacts.lastName}, ${contacts.firstName})`))
        .limit(limit);
      return {
        data: rows.map((c) => {
          const name = displayName(c);
          return {
            id: c.id, name, initials: initialsOf(name),
            kind: c.kind === 'PERSONA_JURIDICA' ? 'Empresa' : 'Persona',
            city: c.addressCity ?? '—',
          };
        }),
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// Cross-selling server-side (Fase 3): oportunidades + mapa de cobertura sobre
// agregados por contacto (array_agg de ramos vigentes) — sin las arrays capadas
// del bootstrap. ops paginadas (Alta primero); matriz limitada a 40 filas
// (contactos con oportunidad primero). counts.bySuggest permite estimar prima
// potencial total en el frontend sin bajar todas las ops.
v1.get('/crosssell', async (req, res, next) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
  try {
    const out = await withAuthedTx(req.authCtx!, async (tx) => {
      const rows = await tx
        .select({
          id: contacts.id,
          kind: contacts.kind,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          legalName: contacts.legalName,
          // ::text — node-postgres no parsea arrays de enum (OID custom) y
          // devolvería el literal '{...}' como string; text[] sí se parsea.
          ramos: sql<string[]>`array_agg(distinct ${policies.ramo}::text)`,
        })
        .from(contacts)
        .innerJoin(policies, and(eq(policies.contactId, contacts.id), eq(policies.status, 'vigente')))
        .groupBy(contacts.id)
        .orderBy(asc(sql`coalesce(${contacts.legalName}, ${contacts.lastName}, ${contacts.firstName})`));

      const all = rows.map((r) => {
        const name = displayName(r);
        const ramos = new Set<string>(r.ramos ?? []);
        const rule = CROSS_RULES.find((cr) => ramos.has(cr.have) && !ramos.has(cr.lack)) ?? null;
        return { r, name, ramos, rule };
      });

      const opsAll = all.filter((x) => x.rule);
      opsAll.sort((a, b) =>
        ((b.rule!.score === 'Alta' ? 1 : 0) - (a.rule!.score === 'Alta' ? 1 : 0)) || a.name.localeCompare(b.name));
      const ops = opsAll.slice(offset, offset + limit).map(({ r, name, ramos, rule }) => ({
        id: `x-${r.id}-${rule!.suggest}`,
        contactId: r.id,
        client: name,
        initials: initialsOf(name),
        has: [...ramos].map(ramoLabel),
        suggest: rule!.suggest,
        reason: rule!.reason,
        score: rule!.score,
      }));

      const bySuggest: Record<string, number> = {};
      for (const o of opsAll) bySuggest[o.rule!.suggest] = (bySuggest[o.rule!.suggest] ?? 0) + 1;

      const matrix = [...opsAll, ...all.filter((x) => !x.rule)].slice(0, 40).map(({ r, name, ramos, rule }) => ({
        id: r.id,
        name,
        ramos: [...ramos].map(ramoLabel),
        suggest: rule ? rule.suggest : null,
      }));

      return {
        ops, total: opsAll.length, limit, offset,
        counts: { altas: opsAll.filter((x) => x.rule!.score === 'Alta').length, bySuggest },
        matrix, matrixTotal: all.length,
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// Póliza individual (misma forma que un item de POLICIES; 404 si no es de la org).
// Consulta directa (sin assembleCockpit → no capa por LIMIT ni rearma el cockpit).
v1.get('/policies/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!isUuidV1(id)) { res.status(400).json({ error: 'Id inválido.' }); return; }
  try {
    const p = await withAuthedTx(req.authCtx!, async (tx) => {
      const [row] = await tx
        .select(policyRowSelect)
        .from(policies)
        .leftJoin(insurers, eq(insurers.id, policies.insurerId))
        .leftJoin(contacts, eq(contacts.id, policies.contactId))
        .where(eq(policies.id, id))
        .limit(1);
      return row ? mapPolicyRow(row) : null;
    });
    if (!p) {
      res.status(404).json({ error: 'Póliza no encontrada' });
      return;
    }
    res.json(p);
  } catch (err) {
    next(err);
  }
});

// Detalle 360° de una póliza (para screen-detail): la póliza + resumen del
// contacto + sus siniestros + actividad (eventos) + cross-sell. Consulta directa
// (sin assembleCockpit → no capa). RLS: id ajeno → 404.
v1.get('/policies/:id/detail', async (req, res, next) => {
  const id = req.params.id;
  if (!isUuidV1(id)) { res.status(400).json({ error: 'Id inválido.' }); return; }
  try {
    const out = await withAuthedTx(req.authCtx!, async (tx) => {
      const [prow] = await tx
        .select(policyRowSelect)
        .from(policies)
        .leftJoin(insurers, eq(insurers.id, policies.insurerId))
        .leftJoin(contacts, eq(contacts.id, policies.contactId))
        .where(eq(policies.id, id))
        .limit(1);
      if (!prow) return null;
      const policy = mapPolicyRow(prow);

      let contact = null;
      if (policy.contactId) {
        const [c] = await tx.select().from(contacts).where(eq(contacts.id, policy.contactId)).limit(1);
        if (c) {
          const name = displayName(c);
          contact = {
            id: c.id, name, initials: initialsOf(name),
            kind: c.kind === 'PERSONA_JURIDICA' ? 'Empresa' : 'Persona',
            since: String(c.createdAt.getFullYear()),
            phone: firstPhone(c.contactMethods),
            city: c.addressCity ?? '—',
          };
        }
      }

      const claimRowsP = await tx
        .select({ cl: claims, stale: sql<number>`floor(extract(epoch from (now() - ${claims.lastActivityAt})) / 86400)::int` })
        .from(claims)
        .where(eq(claims.policyId, id))
        .orderBy(desc(claims.lastActivityAt));
      const siniestros = claimRowsP.map(({ cl, stale }) => ({
        id: cl.id,
        tipo: CLAIM_TIPO_LABEL[cl.tipo] ?? cl.tipo,
        client: policy.client,
        policyId: cl.policyId,
        num: cl.claimNumber ?? '—',
        status: CLAIM_STATUS_LABEL[cl.status] ?? cl.status,
        importance: cl.importance ? CLAIM_IMPORTANCE_LABEL[cl.importance] ?? cl.importance : null,
        reportedBy: cl.reportedBy,
        stale: Math.max(0, stale),
        opened: cl.occurredAt.toISOString().slice(0, 10),
        insurer: policy.insurer,
        ramo: policy.ramo,
      }));

      const evRows = await tx
        .select({ e: claimEvents, authorName: users.name, claimNumber: claims.claimNumber })
        .from(claimEvents)
        .leftJoin(claims, eq(claims.id, claimEvents.claimId))
        .leftJoin(users, eq(users.id, claimEvents.authorUserId))
        .where(eq(claims.policyId, id))
        .orderBy(desc(claimEvents.createdAt));
      const now = new Date();
      const activity = evRows.map(({ e, authorName, claimNumber }) => ({
        when: relativeSince(e.createdAt, now),
        who: authorName ?? 'Sistema',
        text: e.kind === 'status_change'
          ? `Siniestro ${claimNumber ?? ''} → ${CLAIM_STATUS_LABEL[e.newStatus ?? ''] ?? e.newStatus}`
          : (e.body ?? 'Comentario'),
        kind: e.kind === 'status_change' ? 'event' : 'note',
      }));

      const crosssell: object[] = [];
      if (policy.contactId) {
        const ramoRows = await tx.select({ ramo: policies.ramo }).from(policies).where(eq(policies.contactId, policy.contactId));
        const ramos = new Set<string>(ramoRows.map((r) => r.ramo));
        for (const rule of CROSS_RULES) {
          if (ramos.has(rule.have) && !ramos.has(rule.lack)) {
            crosssell.push({ id: `x-${policy.contactId}-${rule.suggest}`, client: policy.client, contactId: policy.contactId, has: [...ramos].map(ramoLabel), suggest: rule.suggest, reason: rule.reason, score: rule.score });
            break;
          }
        }
      }

      // Plan de pagos REAL (policy_installments). Antes el frontend proyectaba
      // cuotas desde prima/frecuencia — números inventados con datos reales.
      const instRows = await tx
        .select({
          i: policyInstallments,
          daysFromDue: sql<number>`(current_date - ${policyInstallments.dueDate})::int`,
        })
        .from(policyInstallments)
        .where(eq(policyInstallments.policyId, id))
        .orderBy(asc(policyInstallments.number));
      const installments = instRows.map(({ i, daysFromDue }) => ({
        cuota: i.number,
        date: i.dueDate,
        amount: i.amount == null ? 0 : Number(i.amount),
        status: i.paidAt != null ? 'Pagada' : daysFromDue > 0 ? 'Vencida' : daysFromDue >= -8 ? 'Por vencer' : 'Programada',
      }));

      return { policy, contact, siniestros, crosssell, activity, installments };
    });
    if (!out) { res.status(404).json({ error: 'Póliza no encontrada' }); return; }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// Ficha 360° del asegurado (F-011 del legacy): datos propios del contacto +
// derivados (pólizas, siniestros, cross-sell). RLS: un id que no sea de la
// org/cartera de la sesión no devuelve fila → 404. Así la ficha SOLO expone
// datos propios; el id de la URL nunca alcanza para ver ajeno.
const CONTACT_STATUS_LABEL: Record<string, string> = {
  prospecto: 'Prospecto',
  asegurado: 'Asegurado',
  exasegurado: 'Ex asegurado',
};
const METHOD_TYPE_LABEL: Record<string, string> = {
  telefono: 'Teléfono',
  celular: 'Celular',
  email: 'Email',
  whatsapp: 'WhatsApp',
};
const FREQ_MULT: Record<string, number> = { Mensual: 12, Trimestral: 4, Semestral: 2, Anual: 1 };

v1.get('/contacts/:id', async (req, res, next) => {
  try {
    const data = await withAuthedTx(req.authCtx!, async (tx) => {
      const [c] = await tx.select().from(contacts).where(eq(contacts.id, req.params.id)).limit(1);
      if (!c) return null;

      const name = displayName(c);

      // Pólizas del contacto — consulta directa (sin assembleCockpit → no capa por
      // LIMIT y no rearma todo el cockpit). Misma forma de fila que POLICIES.
      const polRows = await tx
        .select(policyRowSelect)
        .from(policies)
        .leftJoin(insurers, eq(insurers.id, policies.insurerId))
        .leftJoin(contacts, eq(contacts.id, policies.contactId))
        .where(eq(policies.contactId, c.id))
        .orderBy(asc(policies.endDate));
      const polizas = polRows.map(mapPolicyRow);
      const polIds = polizas.map((p) => p.id);

      // Siniestros de esas pólizas (misma forma que SINIESTROS del cockpit).
      const claimRows = polIds.length
        ? await tx
            .select({
              cl: claims,
              stale: sql<number>`floor(extract(epoch from (now() - ${claims.lastActivityAt})) / 86400)::int`,
              insurerName: insurers.name,
            })
            .from(claims)
            .leftJoin(policies, eq(policies.id, claims.policyId))
            .leftJoin(insurers, eq(insurers.id, policies.insurerId))
            .where(inArray(claims.policyId, polIds))
            .orderBy(desc(claims.lastActivityAt))
        : [];
      const siniestros = claimRows.map(({ cl, stale, insurerName }) => ({
        id: cl.id,
        tipo: CLAIM_TIPO_LABEL[cl.tipo] ?? cl.tipo,
        client: name,
        policyId: cl.policyId,
        num: cl.claimNumber ?? '—',
        status: CLAIM_STATUS_LABEL[cl.status] ?? cl.status,
        importance: cl.importance ? CLAIM_IMPORTANCE_LABEL[cl.importance] ?? cl.importance : null,
        reportedBy: cl.reportedBy,
        stale: Math.max(0, stale),
        opened: cl.occurredAt.toISOString().slice(0, 10),
        insurer: insurerName ?? '—',
      }));

      // Cross-sell: reglas sobre los ramos (crudos) que tiene el contacto.
      const ramos = new Set<string>(polRows.map((r) => r.p.ramo));
      const crosssell: object[] = [];
      for (const rule of CROSS_RULES) {
        if (ramos.has(rule.have) && !ramos.has(rule.lack)) {
          crosssell.push({
            id: `x-${c.id}-${rule.suggest}`,
            client: name,
            contactId: c.id,
            has: [...ramos].map(ramoLabel),
            suggest: rule.suggest,
            reason: rule.reason,
            score: rule.score,
          });
          break;
        }
      }
      const addressLine = [
        [c.addressStreet, c.addressNumber].filter(Boolean).join(' '),
        [c.addressFloor, c.addressApartment].filter(Boolean).join(' '),
        c.addressCity,
        c.addressProvince,
        c.addressPostalCode,
      ]
        .filter(Boolean)
        .join(', ');
      const methods = Array.isArray(c.contactMethods)
        ? (c.contactMethods as Array<{ type?: string; value?: string; primary?: boolean }>).map((m) => ({
            type: METHOD_TYPE_LABEL[m.type ?? ''] ?? (m.type ?? '—'),
            value: m.value ?? '',
            primary: Boolean(m.primary),
          }))
        : [];
      const primaAnual = polizas.reduce((a, p) => a + (Number(p.prima) || 0) * (FREQ_MULT[p.freq] ?? 1), 0);

      return {
        id: c.id,
        name,
        initials: initialsOf(name),
        kind: c.kind === 'PERSONA_JURIDICA' ? 'Empresa' : 'Persona',
        status: CONTACT_STATUS_LABEL[c.status] ?? c.status,
        document: c.dni ? `DNI ${c.dni}` : c.cuit ? `CUIT ${c.cuit}` : '—',
        address: addressLine || null,
        city: c.addressCity ?? '—',
        notes: c.notes ?? null,
        since: String(c.createdAt.getFullYear()),
        phone: firstPhone(c.contactMethods),
        contactMethods: methods,
        tags:
          c.status === 'prospecto' ? ['Prospecto'] : c.status === 'exasegurado' ? ['Ex asegurado'] : ['Asegurado'],
        polizas,
        siniestros,
        crosssell,
        stats: { primaAnual, polizas: polizas.length, siniestros: siniestros.length },
        // Valores crudos para el formulario de edición (la vista de arriba usa
        // shapes de display: status con label, address concatenada, tipos de
        // método traducidos). El form necesita los valores editables sin formato.
        form: {
          kind: c.kind,
          firstName: c.firstName,
          lastName: c.lastName,
          legalName: c.legalName,
          dni: c.dni,
          cuit: c.cuit,
          notes: c.notes,
          addressStreet: c.addressStreet,
          addressNumber: c.addressNumber,
          addressFloor: c.addressFloor,
          addressApartment: c.addressApartment,
          addressCity: c.addressCity,
          addressProvince: c.addressProvince,
          addressPostalCode: c.addressPostalCode,
          contactMethods: Array.isArray(c.contactMethods) ? c.contactMethods : [],
        },
      };
    });
    if (!data) {
      res.status(404).json({ error: 'Asegurado no encontrado' });
      return;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Alta de contacto (regla de negocio del founder): nace SIEMPRE como prospecto
// — no hay selector de estado. Pasa a cliente cuando se importa su primera
// póliza. RLS + audit; producerId estampado server-side (producer_scope).
v1.post('/contacts', async (req, res, next) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const kind = b.kind === 'PERSONA_JURIDICA' ? 'PERSONA_JURIDICA' : 'PERSONA_FISICA';
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const digits = (v: unknown): string | null => (typeof v === 'string' ? v.replace(/\D/g, '') : '') || null;
  const firstName = str(b.firstName);
  const lastName = str(b.lastName);
  const legalName = str(b.legalName);
  if (kind === 'PERSONA_JURIDICA') {
    if (!legalName) { res.status(400).json({ error: 'La razón social es obligatoria.' }); return; }
  } else if (!firstName && !lastName) {
    res.status(400).json({ error: 'Nombre o apellido es obligatorio.' }); return;
  }
  const phone = str(b.phone);
  const contactMethods = phone ? [{ type: 'celular' as const, value: phone, primary: true }] : [];
  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async (tx) => {
      const [row] = await tx
        .insert(contacts)
        .values({
          orgId: ctx.orgId,
          kind,
          firstName,
          lastName,
          legalName,
          dni: kind === 'PERSONA_FISICA' ? digits(b.dni) : null,
          cuit: digits(b.cuit),
          status: 'prospecto', // forzado
          addressCity: str(b.city),
          notes: str(b.notes),
          contactMethods,
          producerId: ctx.producerId,
        })
        .returning({ id: contacts.id });
      if (!row) throw new Error('alta contacto: el insert no devolvió fila');
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId, userId: ctx.userId, action: 'create_contact', entityType: 'contact', entityId: row.id, payload: { kind },
      });
      return row;
    });
    res.status(201).json({ id: out.id });
  } catch (err) { next(err); }
});

// Edición del asegurado/contacto (F-010 medios múltiples · F-020 domicilio):
// datos, domicilio y medios de contacto. Update parcial — solo toca las claves
// presentes en el body. El `status` NO se edita acá (lo gobierna la regla de
// pólizas). RLS oculta lo ajeno → el update no matchea fila → 404.
const METHOD_TYPES = new Set(['telefono', 'celular', 'email', 'whatsapp']);
type MethodType = 'telefono' | 'celular' | 'email' | 'whatsapp';

v1.patch('/contacts/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!isUuidV1(id)) { res.status(400).json({ error: 'Id inválido.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const digits = (v: unknown): string | null => (typeof v === 'string' ? v.replace(/\D/g, '') : '') || null;

  const set: Partial<typeof contacts.$inferInsert> = { updatedAt: new Date() };
  if ('firstName' in b) set.firstName = str(b.firstName);
  if ('lastName' in b) set.lastName = str(b.lastName);
  if ('legalName' in b) set.legalName = str(b.legalName);
  if ('dni' in b) set.dni = digits(b.dni);
  if ('cuit' in b) set.cuit = digits(b.cuit);
  if ('notes' in b) set.notes = str(b.notes);
  if ('addressStreet' in b) set.addressStreet = str(b.addressStreet);
  if ('addressNumber' in b) set.addressNumber = str(b.addressNumber);
  if ('addressFloor' in b) set.addressFloor = str(b.addressFloor);
  if ('addressApartment' in b) set.addressApartment = str(b.addressApartment);
  if ('addressCity' in b) set.addressCity = str(b.addressCity);
  if ('addressProvince' in b) set.addressProvince = str(b.addressProvince);
  if ('addressPostalCode' in b) set.addressPostalCode = str(b.addressPostalCode);

  if ('contactMethods' in b) {
    if (!Array.isArray(b.contactMethods)) { res.status(400).json({ error: 'contactMethods debe ser una lista.' }); return; }
    if (b.contactMethods.length > 20) { res.status(400).json({ error: 'Demasiados medios de contacto (máx. 20).' }); return; }
    const cleaned: Array<{ type: MethodType; value: string; primary: boolean }> = [];
    for (const raw of b.contactMethods as unknown[]) {
      const m = (raw ?? {}) as Record<string, unknown>;
      const type = typeof m.type === 'string' ? m.type : '';
      const value = typeof m.value === 'string' ? m.value.trim() : '';
      if (!METHOD_TYPES.has(type)) { res.status(400).json({ error: `Tipo de contacto inválido: ${type || '—'}.` }); return; }
      if (!value) continue; // descarta filas vacías
      cleaned.push({ type: type as MethodType, value, primary: Boolean(m.primary) });
    }
    // Exactamente un principal: el primero marcado; si ninguno, el primero de la lista.
    let seenPrimary = false;
    for (const m of cleaned) {
      if (m.primary && !seenPrimary) seenPrimary = true;
      else m.primary = false;
    }
    if (!seenPrimary && cleaned.length > 0) cleaned[0]!.primary = true;
    set.contactMethods = cleaned;
  }

  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async (tx) => {
      const [row] = await tx
        .update(contacts)
        .set(set)
        .where(eq(contacts.id, id))
        .returning({ id: contacts.id });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId, userId: ctx.userId, action: 'update_contact', entityType: 'contact', entityId: id,
      });
      return row;
    });
    if (!out) { res.status(404).json({ error: 'Asegurado no encontrado.' }); return; }
    res.json({ id: out.id });
  } catch (err) { next(err); }
});

// Edición de póliza: SOLO observaciones (regla del founder — las pólizas se
// importan de las aseguradoras; el resto es read-only). RLS oculta lo ajeno → 404.
// Lo único editable de una póliza (read-only por decisión de producto): las
// observaciones y la forma de pago. Cada campo audita su propia acción (paridad
// con update_policy_notes / update_policy_payment_method del viejo).
v1.patch('/policies/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!isUuidV1(id)) { res.status(400).json({ error: 'Id inválido.' }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const hasNotes = typeof body.notes === 'string';
  const notes = hasNotes ? (body.notes as string).trim() : '';
  if (notes.length > 4000) { res.status(400).json({ error: 'Observaciones demasiado largas.' }); return; }
  const hasPayment = 'paymentMethod' in body;
  const paymentRaw = body.paymentMethod;
  const payment = paymentRaw == null || paymentRaw === '' ? null : String(paymentRaw);
  if (hasPayment && payment !== null && !PAYMENT_METHOD_LABEL[payment]) {
    res.status(400).json({ error: 'Forma de pago inválida.' }); return;
  }
  if (!hasNotes && !hasPayment) { res.status(400).json({ error: 'Nada para actualizar.' }); return; }
  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async (tx) => {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (hasNotes) set.notes = notes || null;
      if (hasPayment) set.paymentMethod = payment;
      const [row] = await tx
        .update(policies)
        .set(set)
        .where(eq(policies.id, id))
        .returning({ id: policies.id, notes: policies.notes, paymentMethod: policies.paymentMethod });
      if (!row) return null;
      if (hasNotes) {
        await writeAuditLogTx(tx, {
          orgId: ctx.orgId, userId: ctx.userId, action: 'update_policy_notes', entityType: 'policy', entityId: id,
        });
      }
      if (hasPayment) {
        await writeAuditLogTx(tx, {
          orgId: ctx.orgId, userId: ctx.userId, action: 'update_policy_payment_method', entityType: 'policy', entityId: id,
          payload: { paymentMethod: payment },
        });
      }
      return row;
    });
    if (!out) { res.status(404).json({ error: 'Póliza no encontrada.' }); return; }
    res.json({ id: out.id, notes: out.notes, paymentMethod: paymentLabel(out.paymentMethod) });
  } catch (err) { next(err); }
});

// Aceptación de Términos y Privacidad (Ley 25.326): la marca el propio usuario
// (checkbox del registro o modal única vez al iniciar sesión). Idempotente: si
// ya aceptó, no pisa la fecha original. RLS self_isolation limita a la fila propia.
v1.post('/me/accept-terms', async (req, res, next) => {
  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async (tx) => {
      const [row] = await tx
        .update(users)
        .set({ termsAcceptedAt: sql`coalesce(${users.termsAcceptedAt}, now())`, updatedAt: new Date() })
        .where(eq(users.id, ctx.userId))
        .returning({ termsAcceptedAt: users.termsAcceptedAt });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId, userId: ctx.userId, action: 'accept_terms', entityType: 'user', entityId: ctx.userId,
      });
      return row;
    });
    if (!out) { res.status(404).json({ error: 'Usuario no encontrado.' }); return; }
    res.json({ termsAcceptedAt: out.termsAcceptedAt?.toISOString() ?? null });
  } catch (err) { next(err); }
});

// Organización activa y usuario de la sesión (para el chrome del cockpit).
v1.get('/org', handle(async (tx) => (await loadOrg(tx)) ?? {}));
v1.get('/me', handle(async (_tx, ctx) => ({
  userId: ctx.userId,
  orgId: ctx.orgId,
  role: ctx.role,
  roleLabel: ROLE_LABEL[ctx.role] ?? 'Productor',
})));
