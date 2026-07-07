import { Router } from 'express';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { requireAuthedOrg } from '../middleware/authed.js';
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

  const riskRows = await tx.select().from(policyRisks).limit(2000);
  const risksByPolicy = new Map<string, string>();
  for (const r of riskRows) {
    if (!risksByPolicy.has(r.policyId)) {
      const label = [r.descripcion, r.patente].filter(Boolean).join(' · ');
      if (label) risksByPolicy.set(r.policyId, label);
    }
  }

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

  const claimEventRows = await tx
    .select({ e: claimEvents, authorName: users.name })
    .from(claimEvents)
    .leftJoin(users, eq(users.id, claimEvents.authorUserId))
    .orderBy(desc(claimEvents.createdAt))
    .limit(500);

  const quoteRows = await tx
    .select({ q: quotes })
    .from(quotes)
    .orderBy(desc(quotes.createdAt))
    .limit(200);

  const quoteItemRows = await tx.select().from(quoteItems).limit(1000);

  const producerRows = await tx.select().from(producers).orderBy(asc(producers.name));

  const auditRows = await tx
    .select({ a: auditLog, userName: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .orderBy(desc(auditLog.createdAt))
    .limit(40);

  // Totales reales por tabla (bajo RLS = solo esta org). Sirven para avisar en el
  // frontend cuando una lista viene capada por LIMIT (ver roadmap/PLAN-ESCALABILIDAD.md).
  // Secuenciales: la tx usa una sola conexión (no Promise.all).
  const totalContacts = (await tx.select({ n: sql<number>`count(*)::int` }).from(contacts))[0]?.n ?? 0;
  const totalPolicies = (await tx.select({ n: sql<number>`count(*)::int` }).from(policies))[0]?.n ?? 0;
  const totalClaims = (await tx.select({ n: sql<number>`count(*)::int` }).from(claims))[0]?.n ?? 0;

  // ---- contactos ----
  const contactById = new Map(contactRows.map((c) => [c.id, c]));
  const CONTACTS = contactRows.map((c) => {
    const name = displayName(c);
    return {
      id: c.id,
      name,
      kind: c.kind === 'PERSONA_JURIDICA' ? 'Empresa' : 'Persona',
      city: c.addressCity ?? '—',
      initials: initialsOf(name),
      phone: firstPhone(c.contactMethods),
      // Documento para la búsqueda de la tabla (nombre o DNI/CUIT).
      document: c.dni ? `DNI ${c.dni}` : c.cuit ? `CUIT ${c.cuit}` : null,
      since: String(c.createdAt.getFullYear()),
      tags:
        c.status === 'prospecto'
          ? ['Prospecto']
          : c.status === 'exasegurado'
            ? ['Ex asegurado']
            : ['Asegurado'],
    };
  });

  // ---- pólizas ----
  const clientOf = (contactId: string | null): string => {
    const c = contactId ? contactById.get(contactId) : undefined;
    return c ? displayName(c) : '—';
  };

  const installmentsByPolicy = new Map<string, number>();
  for (const { i } of installmentRows) {
    installmentsByPolicy.set(i.policyId, (installmentsByPolicy.get(i.policyId) ?? 0) + 1);
  }
  const freqOf = (policyId: string): string => {
    const n = installmentsByPolicy.get(policyId) ?? 0;
    if (n >= 10) return 'Mensual';
    if (n >= 4) return 'Trimestral';
    if (n >= 2) return 'Semestral';
    return 'Anual';
  };

  const POLICIES = policyRows.map(({ p }) => ({
    id: p.id,
    num: p.policyNumber ?? '—',
    contactId: p.contactId,
    client: clientOf(p.contactId),
    insurer: (p.insurerId && insurerName.get(p.insurerId)) ?? '—',
    ramo: ramoLabel(p.ramo),
    detail: risksByPolicy.get(p.id) ?? p.notes ?? ramoLabel(p.ramo),
    prima: num(p.prima),
    freq: freqOf(p.id),
    status: POLICY_STATUS_LABEL[p.status] ?? p.status,
    start: p.startDate,
    renew: p.endDate,
    coverage: p.notes ?? '—',
    paymentMethod: paymentLabel(p.paymentMethod),
    sumaAseg: p.sumaAsegurada == null ? null : num(p.sumaAsegurada),
  }));
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
  const CROSS_RULES = [
    { have: 'automotor', lack: 'hogar', suggest: 'Hogar', reason: 'Tiene Automotor, sin cobertura de vivienda', score: 'Alta' },
    { have: 'automotor', lack: 'vida', suggest: 'Vida', reason: 'Tiene Automotor, sin seguro de vida', score: 'Media' },
    { have: 'hogar', lack: 'automotor', suggest: 'Automotor', reason: 'Tiene Hogar, sin cobertura de vehículo', score: 'Media' },
    { have: 'comercio', lack: 'automotor', suggest: 'Automotor', reason: 'Tiene Comercio, sin flota asegurada', score: 'Media' },
    { have: 'art', lack: 'incendio', suggest: 'Integral', reason: 'Tiene ART, planta sin cobertura de incendio', score: 'Alta' },
  ];
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

  // ---- actividad por póliza (eventos de siniestros) ----
  const ACTIVITY: Record<string, object[]> = {};
  for (const { e, authorName } of claimEventRows) {
    const claim = claimRows.find((c) => c.c.id === e.claimId)?.c;
    if (!claim?.policyId) continue;
    (ACTIVITY[claim.policyId] ??= []).push({
      when: relativeSince(e.createdAt, now),
      who: authorName ?? 'Sistema',
      text:
        e.kind === 'status_change'
          ? `Siniestro ${claim.claimNumber ?? ''} → ${CLAIM_STATUS_LABEL[e.newStatus ?? ''] ?? e.newStatus}`
          : (e.body ?? 'Comentario'),
      kind: e.kind === 'status_change' ? 'event' : 'note',
    });
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

  // ---- productores ----
  const PRODUCTORES = producerRows.map((pr) => {
    const own = policyRows.filter(({ p }) => p.producerId === pr.id && p.status === 'vigente');
    const ownIds = new Set(own.map(({ p }) => p.id));
    return {
      id: pr.id,
      name: pr.name,
      role: pr.isSelf ? 'Titular' : 'Productor',
      initials: initialsOf(pr.name),
      polizas: own.length,
      prima: own.reduce((a, { p }) => a + num(p.prima), 0),
      conversion: 0,
      siniestros: claimRows.filter(({ c }) => c.policyId && ownIds.has(c.policyId)).length,
    };
  });

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

  // ---- agregados del BOOK ----
  const vigentes = policyRows.filter(({ p }) => p.status === 'vigente');
  const vence30 = VENCIMIENTOS.filter((v) => v.days <= 30).length;
  const openClaims = claimRows.filter(({ c }) => c.status !== 'cerrado');
  const staleClaims = openClaims.filter(({ stale }) => stale >= 10).length;
  const cuotasMonto = CUOTAS.reduce((a, c) => a + c.amount, 0);
  const health = Math.max(
    40,
    Math.min(99, 100 - staleClaims * 8 - CUOTAS.length * 5 - VENCIMIENTOS.filter((v) => v.days <= 7).length * 3),
  );

  const BOOK = {
    primaTotal: vigentes.reduce((a, { p }) => a + num(p.prima), 0),
    vigentes: vigentes.length,
    contactos: CONTACTS.filter((c) => c.tags.includes('Asegurado')).length,
    vence30,
    siniestros: openClaims.length,
    cuotasVencidas: CUOTAS.length,
    cuotasMonto,
    health,
  };

  return {
    TODAY: now.toISOString().slice(0, 10),
    CONTACTS,
    INSURERS: insurerRows.map((i) => i.name),
    POLICIES,
    VENCIMIENTOS,
    SINIESTROS,
    CUOTAS,
    CROSSSELL,
    ACTIVITY,
    BOOK,
    PROSPECTOS,
    COTIZACIONES,
    PRODUCTORES,
    AUDIT,
    // Totales reales vs lo que viaja en el payload (capado por LIMIT). El frontend
    // avisa "mostrando X de N" cuando shown < total. Ver roadmap/PLAN-ESCALABILIDAD.md.
    COUNTS: {
      contacts: { shown: CONTACTS.length, total: totalContacts },
      policies: { shown: POLICIES.length, total: totalPolicies },
      claims: { shown: SINIESTROS.length, total: totalClaims },
    },
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
  return {
    ...cockpit,
    ORG: org,
    ME: { role: ctx.role, roleLabel: ROLE_LABEL[ctx.role] ?? 'Productor', producerId: ctx.producerId },
  };
}));

// ── Endpoints REST individuales (misma forma que las arrays del cockpit) ──────
// Base de la API pública (D-026). Cada uno devuelve { data: [...] }.

const section = (key: string) =>
  handle(async (tx) => ({ data: (await assembleCockpit(tx, new Date()))[key as keyof Awaited<ReturnType<typeof assembleCockpit>>] }));

v1.get('/contacts', section('CONTACTS'));
v1.get('/vencimientos', section('VENCIMIENTOS'));
v1.get('/siniestros', section('SINIESTROS'));
v1.get('/cuotas', section('CUOTAS'));
v1.get('/crossselling', section('CROSSSELL'));
v1.get('/prospectos', section('PROSPECTOS'));
v1.get('/cotizaciones', section('COTIZACIONES'));
v1.get('/productores', section('PRODUCTORES'));
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
        .select({
          p: policies,
          insurerName: insurers.name,
          cKind: contacts.kind,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          legalName: contacts.legalName,
          instCount: sql<number>`(select count(*)::int from ${policyInstallments} pi where pi.policy_id = ${policies.id})`,
          riskLabel: sql<string | null>`(select (r.descripcion || case when r.patente is not null then ' · ' || r.patente else '' end) from ${policyRisks} r where r.policy_id = ${policies.id} limit 1)`,
        })
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

      const data = rows.map((r) => {
        const p = r.p;
        const name = displayName({ kind: r.cKind ?? 'PERSONA_FISICA', firstName: r.firstName, lastName: r.lastName, legalName: r.legalName });
        return {
          id: p.id,
          num: p.policyNumber ?? '—',
          contactId: p.contactId,
          client: name,
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
      });
      return { data, total, limit, offset };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// Póliza individual (misma forma que un item de POLICIES; 404 si no es de la org).
v1.get('/policies/:id', async (req, res, next) => {
  try {
    const p = await withAuthedTx(req.authCtx!, async (tx) => {
      const cockpit = await assembleCockpit(tx, new Date());
      return (cockpit.POLICIES as Array<{ id: string }>).find((x) => x.id === req.params.id) ?? null;
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

      const cockpit = await assembleCockpit(tx, new Date());
      const polizas = (cockpit.POLICIES as Array<{ id: string; contactId: string | null; prima: number; freq: string }>).filter(
        (p) => p.contactId === c.id,
      );
      const polIds = new Set(polizas.map((p) => p.id));
      const siniestros = (cockpit.SINIESTROS as Array<{ policyId: string | null }>).filter(
        (s) => s.policyId != null && polIds.has(s.policyId),
      );
      const crosssell = (cockpit.CROSSSELL as Array<{ contactId?: string }>).filter((x) => x.contactId === c.id);

      const name = displayName(c);
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
v1.patch('/policies/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!isUuidV1(id)) { res.status(400).json({ error: 'Id inválido.' }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  if (notes.length > 4000) { res.status(400).json({ error: 'Observaciones demasiado largas.' }); return; }
  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async (tx) => {
      const [row] = await tx
        .update(policies)
        .set({ notes: notes || null, updatedAt: new Date() })
        .where(eq(policies.id, id))
        .returning({ id: policies.id, notes: policies.notes });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId, userId: ctx.userId, action: 'update_policy_notes', entityType: 'policy', entityId: id,
      });
      return row;
    });
    if (!out) { res.status(404).json({ error: 'Póliza no encontrada.' }); return; }
    res.json({ id: out.id, notes: out.notes });
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
