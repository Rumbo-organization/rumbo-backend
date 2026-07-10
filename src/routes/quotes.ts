// Multicotizador (Slice 5 de paridad; portado del router quotes del monolito).
// El rating en vivo está gated por integración: las opciones se cargan a mano
// (addItem) y la matriz comparativa consume byId. withAuthedTx (RLS) + audit.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { asc, desc, eq, sql } from 'drizzle-orm';

import { withAuthedTx, schema } from '../db/client.js';
import { writeAuditLogTx } from '../audit.js';

const { contacts, insurers, quoteItems, quotes } = schema;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const POLICY_RAMOS = [
  'automotor',
  'motovehiculo',
  'hogar',
  'vida',
  'art',
  'comercio',
  'accidentes_personales',
  'incendio',
  'responsabilidad_civil',
  'consorcio',
  'seguro_tecnico',
  'transporte',
  'embarcaciones',
  'otros',
];
export const NORMALIZED_COVERAGE_LABELS: Record<string, string> = {
  rc: 'Responsabilidad civil',
  rc_grua: 'RC con grúa',
  rc_robo_incendio: 'RC + robo + incendio total',
  incendio_robo_garage: 'Incendio y robo en garage',
  terceros_completo: 'Tercero completo',
  terceros_completo_full: 'Tercero completo full',
  todo_riesgo_franquicia: 'Todo riesgo con franquicia',
  todo_riesgo_sin_franquicia: 'Todo riesgo sin franquicia',
};

function displayName(c: {
  kind: string | null;
  firstName: string | null;
  lastName: string | null;
  legalName: string | null;
}): string {
  if (c.kind === 'PERSONA_JURIDICA') return c.legalName ?? '—';
  if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
  return c.lastName ?? c.firstName ?? '—';
}
const RAMO_LABELS: Record<string, string> = {
  automotor: 'Automotor',
  motovehiculo: 'Motovehículo',
  hogar: 'Hogar',
  vida: 'Vida',
  art: 'ART',
  comercio: 'Comercio',
  accidentes_personales: 'Accidentes personales',
  incendio: 'Incendio',
  responsabilidad_civil: 'Responsabilidad civil',
  consorcio: 'Consorcio',
  seguro_tecnico: 'Seguro técnico',
  transporte: 'Transporte',
  embarcaciones: 'Embarcaciones',
  otros: 'Otros',
};
const optionalText = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);
// Código estable y mono-aspecto (misma derivación que el BFF): año + sufijo uuid.
const quoteNum = (id: string, createdAt: Date) =>
  `COT-${createdAt.getFullYear()}-${id.replace(/-/g, '').slice(-4).toUpperCase()}`;

export const quotesRouter = Router();

type H = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const wrap =
  (fn: H): H =>
  async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (e) {
      next(e);
    }
  };

// Historial (más recientes primero) — misma forma de fila que la array
// COTIZACIONES del cockpit + total para paginar. Uncapped por página.
quotesRouter.get(
  '/cotizaciones',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 100);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const out = await withAuthedTx(req.authCtx!, async tx => {
      const rows = await tx
        .select({
          q: quotes,
          cKind: contacts.kind,
          cFirst: contacts.firstName,
          cLast: contacts.lastName,
          cLegal: contacts.legalName,
          itemCount: sql<number>`(select count(*)::int from ${quoteItems} where ${quoteItems.quoteId} = ${quotes.id})`,
          bestCuota: sql<
            string | null
          >`(select ${quoteItems.cuota} from ${quoteItems} where ${quoteItems.quoteId} = ${quotes.id} and ${quoteItems.cuota} is not null order by ${quoteItems.cuota} asc limit 1)`,
          bestInsurer: sql<
            string | null
          >`(select ${insurers.name} from ${quoteItems} join ${insurers} on ${insurers.id} = ${quoteItems.insurerId} where ${quoteItems.quoteId} = ${quotes.id} and ${quoteItems.cuota} is not null order by ${quoteItems.cuota} asc limit 1)`,
        })
        .from(quotes)
        .leftJoin(contacts, eq(contacts.id, quotes.contactId))
        .orderBy(desc(quotes.createdAt))
        .limit(limit)
        .offset(offset);
      const [agg] = await tx.select({ n: sql<number>`count(*)::int` }).from(quotes);
      const now = Date.now();
      const data = rows.map(({ q, cKind, cFirst, cLast, cLegal, itemCount, bestCuota, bestInsurer }) => {
        const client = displayName({ kind: cKind, firstName: cFirst, lastName: cLast, legalName: cLegal });
        const ageDays = Math.round((now - q.createdAt.getTime()) / 86400000);
        const valid = 15 - ageDays;
        return {
          id: q.id,
          num: quoteNum(q.id, q.createdAt),
          client: client !== '—' ? client : (q.reference ?? '—'),
          ramo: RAMO_LABELS[q.ramo] ?? q.ramo,
          status: valid < 0 ? 'Vencida' : (itemCount ?? 0) > 0 ? 'Enviada' : 'Borrador',
          best: bestInsurer ?? '—',
          monthly: bestCuota == null ? 0 : Number(bestCuota),
          options: itemCount ?? 0,
          date: q.createdAt.toISOString().slice(0, 10),
          valid,
        };
      });
      return { data, total: agg?.n ?? 0, limit, offset };
    });
    res.json(out);
  }),
);

// Detalle con items (matriz comparativa: coverage normalizada + labels).
quotesRouter.get(
  '/quotes/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const out = await withAuthedTx(req.authCtx!, async tx => {
      const [row] = await tx
        .select({
          q: quotes,
          cKind: contacts.kind,
          cFirst: contacts.firstName,
          cLast: contacts.lastName,
          cLegal: contacts.legalName,
        })
        .from(quotes)
        .leftJoin(contacts, eq(contacts.id, quotes.contactId))
        .where(eq(quotes.id, id))
        .limit(1);
      if (!row) return null;
      const { q } = row;
      const items = await tx
        .select({ it: quoteItems, insurerName: insurers.name })
        .from(quoteItems)
        .innerJoin(insurers, eq(insurers.id, quoteItems.insurerId))
        .where(eq(quoteItems.quoteId, id))
        .orderBy(asc(quoteItems.createdAt));
      const client = displayName({
        kind: row.cKind,
        firstName: row.cFirst,
        lastName: row.cLast,
        legalName: row.cLegal,
      });
      return {
        id: q.id,
        num: quoteNum(q.id, q.createdAt),
        contactId: q.contactId,
        client: client !== '—' ? client : (q.reference ?? '—'),
        ramo: RAMO_LABELS[q.ramo] ?? q.ramo,
        reference: q.reference,
        vehicle: [q.vehicleMarca, q.vehicleModelo, q.vehicleVersion, q.vehicleAnio].filter(Boolean).join(' ') || null,
        notes: q.notes,
        date: q.createdAt.toISOString().slice(0, 10),
        items: items.map(({ it, insurerName }) => ({
          id: it.id,
          insurerId: it.insurerId,
          insurer: insurerName,
          coverage: it.coverage,
          coverageLabel: it.coverage ? (NORMALIZED_COVERAGE_LABELS[it.coverage] ?? it.coverage) : null,
          sumaAsegurada: it.sumaAsegurada == null ? null : Number(it.sumaAsegurada),
          cuota: it.cuota == null ? null : Number(it.cuota),
          currency: it.currency,
        })),
      };
    });
    if (!out) {
      res.status(404).json({ error: 'Cotización no encontrada.' });
      return;
    }
    res.json(out);
  }),
);

quotesRouter.post(
  '/quotes',
  wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const contactId = b.contactId != null && b.contactId !== '' ? String(b.contactId) : null;
    if (contactId !== null && !isUuid(contactId)) {
      res.status(400).json({ error: 'Asegurado inválido.' });
      return;
    }
    const ramo = POLICY_RAMOS.includes(String(b.ramo)) ? String(b.ramo) : 'automotor';
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      if (contactId) {
        const [c] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
        if (!c) return null;
      }
      const [row] = await tx
        .insert(quotes)
        .values({
          orgId: ctx.orgId,
          // La cotización nace en la cartera del productor que la crea.
          producerId: ctx.producerId,
          contactId,
          ramo: ramo as (typeof quotes.$inferInsert)['ramo'],
          reference: optionalText(b.reference, 120),
          vehicleMarca: optionalText(b.vehicleMarca, 80),
          vehicleModelo: optionalText(b.vehicleModelo, 80),
          vehicleAnio: optionalText(b.vehicleAnio, 8),
          vehicleVersion: optionalText(b.vehicleVersion, 120),
          notes: optionalText(b.notes, 500),
          source: 'manual' as const,
        })
        .returning({ id: quotes.id });
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'create_quote',
        entityType: 'quote',
        entityId: row!.id,
        payload: { ramo },
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Asegurado no encontrado.' });
      return;
    }
    res.status(201).json(out);
  }),
);

quotesRouter.delete(
  '/quotes/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [row] = await tx.delete(quotes).where(eq(quotes.id, id)).returning({ id: quotes.id });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'delete_quote',
        entityType: 'quote',
        entityId: row.id,
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Cotización no encontrada.' });
      return;
    }
    res.json({ ok: true });
  }),
);

// Una opción: aseguradora × cobertura → suma + cuota. Se exige cuota o suma.
quotesRouter.post(
  '/quotes/:id/items',
  wrap(async (req, res) => {
    const quoteId = req.params.id;
    if (!isUuid(quoteId)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const insurerId = String(b.insurerId ?? '');
    if (!isUuid(insurerId)) {
      res.status(400).json({ error: 'Elegí una aseguradora.' });
      return;
    }
    const coverage = typeof b.coverage === 'string' && NORMALIZED_COVERAGE_LABELS[b.coverage] ? b.coverage : null;
    const suma = b.sumaAsegurada != null && b.sumaAsegurada !== '' ? Number(b.sumaAsegurada) : null;
    const cuota = b.cuota != null && b.cuota !== '' ? Number(b.cuota) : null;
    if ((suma == null || !Number.isFinite(suma)) && (cuota == null || !Number.isFinite(cuota))) {
      res.status(400).json({ error: 'Cargá al menos la cuota o la suma asegurada.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [q] = await tx.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, quoteId)).limit(1);
      if (!q) return 'no-quote';
      const [ins] = await tx.select({ id: insurers.id }).from(insurers).where(eq(insurers.id, insurerId)).limit(1);
      if (!ins) return 'no-insurer';
      const [row] = await tx
        .insert(quoteItems)
        .values({
          orgId: ctx.orgId,
          quoteId,
          insurerId,
          coverage: coverage as (typeof quoteItems.$inferInsert)['coverage'],
          sumaAsegurada: suma != null && Number.isFinite(suma) ? String(suma) : null,
          cuota: cuota != null && Number.isFinite(cuota) ? String(cuota) : null,
          currency: b.currency === 'USD' ? 'USD' : 'ARS',
          source: 'manual' as const,
        })
        .returning({ id: quoteItems.id, coverage: quoteItems.coverage });
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'add_quote_item',
        entityType: 'quote',
        entityId: quoteId,
        payload: { insurerId, coverage: row!.coverage },
      });
      return row;
    });
    if (out === 'no-quote') {
      res.status(404).json({ error: 'Cotización no encontrada.' });
      return;
    }
    if (out === 'no-insurer') {
      res.status(404).json({ error: 'Aseguradora no encontrada.' });
      return;
    }
    res.status(201).json(out);
  }),
);

quotesRouter.delete(
  '/quote-items/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [row] = await tx
        .delete(quoteItems)
        .where(eq(quoteItems.id, id))
        .returning({ id: quoteItems.id, quoteId: quoteItems.quoteId });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'delete_quote_item',
        entityType: 'quote',
        entityId: row.quoteId,
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Opción no encontrada.' });
      return;
    }
    res.json({ ok: true });
  }),
);

// Aseguradoras: picker con id (el /insurers del cockpit devuelve solo nombres)
// + alta con upsert por (org, name) — paridad insurers.create.
quotesRouter.get(
  '/insurers/picker',
  wrap(async (req, res) => {
    const data = await withAuthedTx(req.authCtx!, tx =>
      tx.select({ id: insurers.id, name: insurers.name }).from(insurers).orderBy(asc(insurers.name)),
    );
    res.json({ data });
  }),
);

quotesRouter.post(
  '/insurers',
  wrap(async (req, res) => {
    const name = optionalText((req.body ?? {}).name, 120);
    if (!name) {
      res.status(400).json({ error: 'Falta el nombre.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [existing] = await tx
        .select({ id: insurers.id })
        .from(insurers)
        .where(sql`lower(${insurers.name}) = lower(${name})`)
        .limit(1);
      if (existing) return existing;
      const [row] = await tx.insert(insurers).values({ orgId: ctx.orgId, name }).returning({ id: insurers.id });
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'create_insurer',
        entityType: 'insurer',
        entityId: row!.id,
        payload: { name },
      });
      return row;
    });
    res.status(201).json(out);
  }),
);
