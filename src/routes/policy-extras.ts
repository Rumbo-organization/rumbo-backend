// Detalle de póliza — plan de pagos (CRUD), endosos y personas (Slice 4 de
// paridad; portado de los routers installments/endorsements/policy-parties del
// monolito viejo). Mismo stack: withAuthedTx (RLS) + audit transaccional.
// Las LECTURAS viajan dentro de GET /policies/:id/detail; acá viven las
// mutaciones (y el GET de refetch liviano de cada panel).

import { Router, type Request, type Response, type NextFunction } from 'express';
import { asc, eq } from 'drizzle-orm';

import { withAuthedTx, schema } from '../db/client.js';
import { writeAuditLogTx } from '../audit.js';

const { policies, policyInstallments, policyEndorsements, policyParties, contacts } = schema;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// AAAA-MM-DD + n meses (aritmética UTC, sin sorpresas de TZ). Igual al viejo.
function addMonths(ymd: string, n: number): string {
  const [y = 0, m = 1, d = 1] = ymd.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, last));
  return base.toISOString().slice(0, 10);
}

// Reparte un total en N cuotas mensuales (centavos exactos; el resto va a la última).
function buildInstallments(count: number, firstDueDate: string, totalAmount: number) {
  const totalCents = Math.round(totalAmount * 100);
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    dueDate: addMonths(firstDueDate, i),
    amount: ((base + (i === count - 1 ? remainder : 0)) / 100).toFixed(2),
  }));
}

const ENDORSEMENT_TYPES = ['emision', 'refacturacion', 'endoso', 'anulacion'];
const PARTY_ROLES = ['asegurado', 'tomador', 'beneficiario', 'conductor', 'acreedor_prendario', 'otro'];

export const policyExtras = Router();

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

// ── Plan de pagos ─────────────────────────────────────────────────────────────

// Genera N cuotas mensuales repartiendo un total (F-026). Falla si ya hay plan.
policyExtras.post(
  '/policies/:id/installments',
  wrap(async (req, res) => {
    const policyId = req.params.id;
    if (!isUuid(policyId)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const count = Number(b.count);
    const totalAmount = Number(b.totalAmount);
    if (!Number.isInteger(count) || count < 1 || count > 60) {
      res.status(400).json({ error: 'Cantidad de cuotas inválida (1 a 60).' });
      return;
    }
    if (!isYmd(b.firstDueDate)) {
      res.status(400).json({ error: 'Primera fecha inválida (AAAA-MM-DD).' });
      return;
    }
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      res.status(400).json({ error: 'Importe total inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [policy] = await tx.select({ id: policies.id }).from(policies).where(eq(policies.id, policyId)).limit(1);
      if (!policy) return 'not-found';
      const [existing] = await tx
        .select({ id: policyInstallments.id })
        .from(policyInstallments)
        .where(eq(policyInstallments.policyId, policyId))
        .limit(1);
      if (existing) return 'exists';
      await tx.insert(policyInstallments).values(
        buildInstallments(count, b.firstDueDate as string, totalAmount).map(p => ({
          orgId: ctx.orgId,
          policyId,
          number: p.number,
          dueDate: p.dueDate,
          amount: p.amount,
          source: 'manual' as const,
        })),
      );
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'generate_installments',
        entityType: 'policy',
        entityId: policyId,
        payload: { count },
      });
      return 'ok';
    });
    if (out === 'not-found') {
      res.status(404).json({ error: 'Póliza no encontrada.' });
      return;
    }
    if (out === 'exists') {
      res.status(409).json({ error: 'La póliza ya tiene plan de pagos. Rehacelo borrándolo primero.' });
      return;
    }
    res.status(201).json({ ok: true });
  }),
);

// Marca/desmarca una cuota como pagada.
policyExtras.patch(
  '/installments/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const paid = Boolean((req.body ?? {}).paid);
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [row] = await tx
        .update(policyInstallments)
        .set({ paidAt: paid ? new Date() : null, updatedAt: new Date() })
        .where(eq(policyInstallments.id, id))
        .returning({ id: policyInstallments.id });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'set_installment_paid',
        entityType: 'installment',
        entityId: row.id,
        payload: { paid },
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Cuota no encontrada.' });
      return;
    }
    res.json({ ok: true });
  }),
);

// Borra el plan entero (para rehacerlo).
policyExtras.delete(
  '/policies/:id/installments',
  wrap(async (req, res) => {
    const policyId = req.params.id;
    if (!isUuid(policyId)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    await withAuthedTx(ctx, async tx => {
      await tx.delete(policyInstallments).where(eq(policyInstallments.policyId, policyId));
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'clear_installments',
        entityType: 'policy',
        entityId: policyId,
      });
    });
    res.json({ ok: true });
  }),
);

// ── Endosos / movimientos ─────────────────────────────────────────────────────

policyExtras.get(
  '/policies/:id/endorsements',
  wrap(async (req, res) => {
    const policyId = req.params.id;
    if (!isUuid(policyId)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const data = await withAuthedTx(req.authCtx!, tx =>
      tx
        .select({
          id: policyEndorsements.id,
          number: policyEndorsements.number,
          type: policyEndorsements.type,
          issuedAt: policyEndorsements.issuedAt,
          startDate: policyEndorsements.startDate,
          endDate: policyEndorsements.endDate,
          prima: policyEndorsements.prima,
          premio: policyEndorsements.premio,
          description: policyEndorsements.description,
        })
        .from(policyEndorsements)
        .where(eq(policyEndorsements.policyId, policyId))
        .orderBy(asc(policyEndorsements.number)),
    );
    res.json({ data });
  }),
);

policyExtras.post(
  '/policies/:id/endorsements',
  wrap(async (req, res) => {
    const policyId = req.params.id;
    if (!isUuid(policyId)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const number = Number(b.number);
    const type = String(b.type ?? '');
    if (!Number.isInteger(number) || number < 0) {
      res.status(400).json({ error: 'Número de movimiento inválido.' });
      return;
    }
    if (!ENDORSEMENT_TYPES.includes(type)) {
      res.status(400).json({ error: 'Tipo de movimiento inválido.' });
      return;
    }
    if (b.issuedAt != null && b.issuedAt !== '' && !isYmd(b.issuedAt)) {
      res.status(400).json({ error: 'Fecha de emisión inválida.' });
      return;
    }
    const prima = b.prima != null && b.prima !== '' ? Number(b.prima) : null;
    const premio = b.premio != null && b.premio !== '' ? Number(b.premio) : null;
    const ctx = req.authCtx!;
    try {
      const out = await withAuthedTx(ctx, async tx => {
        const [policy] = await tx.select({ id: policies.id }).from(policies).where(eq(policies.id, policyId)).limit(1);
        if (!policy) return null;
        const [row] = await tx
          .insert(policyEndorsements)
          .values({
            orgId: ctx.orgId,
            policyId,
            number,
            type: type as (typeof policyEndorsements.$inferInsert)['type'],
            issuedAt: (b.issuedAt as string) || null,
            startDate: isYmd(b.startDate) ? (b.startDate as string) : null,
            endDate: isYmd(b.endDate) ? (b.endDate as string) : null,
            prima: prima != null && Number.isFinite(prima) ? String(prima) : null,
            premio: premio != null && Number.isFinite(premio) ? String(premio) : null,
            description: typeof b.description === 'string' ? b.description.trim().slice(0, 2000) || null : null,
            source: 'manual' as const,
          })
          .returning({ id: policyEndorsements.id, number: policyEndorsements.number, type: policyEndorsements.type });
        await writeAuditLogTx(tx, {
          orgId: ctx.orgId,
          userId: ctx.userId,
          action: 'create_endorsement',
          entityType: 'policy_endorsement',
          entityId: row!.id,
          payload: { policyId, number: row!.number, type: row!.type },
        });
        return row;
      });
      if (!out) {
        res.status(404).json({ error: 'Póliza no encontrada.' });
        return;
      }
      res.status(201).json(out);
    } catch (e) {
      if (
        e instanceof Error &&
        /duplicate key/.test(e.message + ' ' + String((e as { cause?: unknown }).cause ?? ''))
      ) {
        res.status(409).json({ error: 'Ya existe un movimiento con ese número en la póliza.' });
        return;
      }
      throw e;
    }
  }),
);

policyExtras.delete(
  '/endorsements/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [row] = await tx
        .delete(policyEndorsements)
        .where(eq(policyEndorsements.id, id))
        .returning({ id: policyEndorsements.id });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'delete_endorsement',
        entityType: 'policy_endorsement',
        entityId: row.id,
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Movimiento no encontrado.' });
      return;
    }
    res.json({ ok: true });
  }),
);

// ── Personas de la póliza ─────────────────────────────────────────────────────

policyExtras.get(
  '/policies/:id/parties',
  wrap(async (req, res) => {
    const policyId = req.params.id;
    if (!isUuid(policyId)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const rows = await withAuthedTx(req.authCtx!, tx =>
      tx
        .select({
          id: policyParties.id,
          role: policyParties.role,
          contactId: policyParties.contactId,
          kind: contacts.kind,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          legalName: contacts.legalName,
          dni: contacts.dni,
          cuit: contacts.cuit,
        })
        .from(policyParties)
        .innerJoin(contacts, eq(contacts.id, policyParties.contactId))
        .where(eq(policyParties.policyId, policyId))
        .orderBy(asc(policyParties.createdAt)),
    );
    res.json({ data: rows });
  }),
);

policyExtras.post(
  '/policies/:id/parties',
  wrap(async (req, res) => {
    const policyId = req.params.id;
    if (!isUuid(policyId)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const contactId = String(b.contactId ?? '');
    const role = String(b.role ?? '');
    if (!isUuid(contactId)) {
      res.status(400).json({ error: 'Asegurado inválido.' });
      return;
    }
    if (!PARTY_ROLES.includes(role)) {
      res.status(400).json({ error: 'Rol inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    try {
      const out = await withAuthedTx(ctx, async tx => {
        const [policy] = await tx.select({ id: policies.id }).from(policies).where(eq(policies.id, policyId)).limit(1);
        if (!policy) return 'no-policy';
        const [contact] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(eq(contacts.id, contactId))
          .limit(1);
        if (!contact) return 'no-contact';
        const [row] = await tx
          .insert(policyParties)
          .values({
            orgId: ctx.orgId,
            policyId,
            contactId,
            role: role as (typeof policyParties.$inferInsert)['role'],
            source: 'manual' as const,
          })
          .returning({ id: policyParties.id, role: policyParties.role });
        await writeAuditLogTx(tx, {
          orgId: ctx.orgId,
          userId: ctx.userId,
          action: 'create_policy_party',
          entityType: 'policy_party',
          entityId: row!.id,
          payload: { policyId, role: row!.role },
        });
        return row;
      });
      if (out === 'no-policy') {
        res.status(404).json({ error: 'Póliza no encontrada.' });
        return;
      }
      if (out === 'no-contact') {
        res.status(404).json({ error: 'Asegurado no encontrado.' });
        return;
      }
      res.status(201).json(out);
    } catch (e) {
      if (
        e instanceof Error &&
        /policy_parties_unique_idx|duplicate key/.test(e.message + ' ' + String((e as { cause?: unknown }).cause ?? ''))
      ) {
        res.status(409).json({ error: 'Esa persona ya figura con ese rol en la póliza.' });
        return;
      }
      throw e;
    }
  }),
);

policyExtras.delete(
  '/parties/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [row] = await tx.delete(policyParties).where(eq(policyParties.id, id)).returning({ id: policyParties.id });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'delete_policy_party',
        entityType: 'policy_party',
        entityId: row.id,
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Persona no encontrada.' });
      return;
    }
    res.json({ ok: true });
  }),
);
