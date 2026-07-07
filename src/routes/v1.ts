import { Router } from 'express';
import { asc, desc, eq, sql } from 'drizzle-orm';

import { requireAuthedOrg } from '../middleware/authed.js';
import { withAuthedTx, schema, type AuthedTx } from '../db/client.js';

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
      since: String(c.createdAt.getFullYear()),
      tags:
        c.status === 'prospecto'
          ? ['Prospecto']
          : c.status === 'exasegurado'
            ? ['Ex cliente']
            : ['Cliente'],
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
    contactos: CONTACTS.filter((c) => c.tags.includes('Cliente')).length,
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
v1.get('/policies', section('POLICIES'));
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

// Organización activa y usuario de la sesión (para el chrome del cockpit).
v1.get('/org', handle(async (tx) => (await loadOrg(tx)) ?? {}));
v1.get('/me', handle(async (_tx, ctx) => ({
  userId: ctx.userId,
  orgId: ctx.orgId,
  role: ctx.role,
  roleLabel: ROLE_LABEL[ctx.role] ?? 'Productor',
})));
