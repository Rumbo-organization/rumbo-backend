// Ficha del asegurado — relaciones, direcciones adicionales y responsables
// (Slice 4 de paridad; portado de contact-relationships / contact-addresses /
// contact-assignees del monolito viejo). withAuthedTx (RLS) + audit.
// Las LECTURAS viajan dentro de GET /contacts/:id; acá viven las mutaciones
// y el listado de usuarios de la org para el selector de responsables.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { and, asc, eq, or } from 'drizzle-orm';

import { withAuthedTx, schema } from '../db/client.js';
import { writeAuditLogTx } from '../audit.js';

const { contacts, contactRelationships, contactAddresses, contactAssignees, members, users } = schema;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const RELATION_TYPES = ['conyuge', 'conviviente', 'hijo', 'padre_madre', 'hermano', 'socio', 'empleado', 'empleador', 'familiar', 'otro'];
const ASSIGNEE_ROLES = ['responsable', 'comercial', 'cobranzas', 'siniestros'];

export const contactExtras = Router();

type H = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const wrap = (fn: H): H => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };

// ── Relaciones persona↔persona ────────────────────────────────────────────────

// Alta. Valida ambos asegurados (RLS) y que el par no esté vinculado en NINGÚN
// sentido (la relación es simétrica; el inverso se deriva al leer).
contactExtras.post('/contacts/:id/relationships', wrap(async (req, res) => {
  const contactId = req.params.id;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const relatedContactId = String(b.relatedContactId ?? '');
  const type = String(b.type ?? '');
  if (!isUuid(contactId) || !isUuid(relatedContactId)) { res.status(400).json({ error: 'Asegurado inválido.' }); return; }
  if (contactId === relatedContactId) { res.status(400).json({ error: 'No se puede relacionar un asegurado consigo mismo.' }); return; }
  if (!RELATION_TYPES.includes(type)) { res.status(400).json({ error: 'Tipo de relación inválido.' }); return; }
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) || null : null;
  const ctx = req.authCtx!;
  const out = await withAuthedTx(ctx, async (tx) => {
    const found = await tx.select({ id: contacts.id }).from(contacts)
      .where(or(eq(contacts.id, contactId), eq(contacts.id, relatedContactId)));
    if (found.length < 2) return 'not-found';
    const [existing] = await tx.select({ id: contactRelationships.id }).from(contactRelationships)
      .where(or(
        and(eq(contactRelationships.contactId, contactId), eq(contactRelationships.relatedContactId, relatedContactId)),
        and(eq(contactRelationships.contactId, relatedContactId), eq(contactRelationships.relatedContactId, contactId)),
      ))
      .limit(1);
    if (existing) return 'exists';
    const [row] = await tx.insert(contactRelationships).values({
      orgId: ctx.orgId, contactId, relatedContactId,
      type: type as (typeof contactRelationships.$inferInsert)['type'],
      note, source: 'manual' as const,
    }).returning({ id: contactRelationships.id, type: contactRelationships.type });
    await writeAuditLogTx(tx, {
      orgId: ctx.orgId, userId: ctx.userId, action: 'create_contact_relationship', entityType: 'contact_relationship', entityId: row!.id,
      payload: { contactId, type: row!.type },
    });
    return row;
  });
  if (out === 'not-found') { res.status(404).json({ error: 'Asegurado no encontrado.' }); return; }
  if (out === 'exists') { res.status(409).json({ error: 'Ya existe una relación entre estas personas.' }); return; }
  res.status(201).json(out);
}));

contactExtras.delete('/relationships/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) { res.status(400).json({ error: 'Id inválido.' }); return; }
  const ctx = req.authCtx!;
  const out = await withAuthedTx(ctx, async (tx) => {
    const [row] = await tx.delete(contactRelationships).where(eq(contactRelationships.id, id)).returning({ id: contactRelationships.id });
    if (!row) return null;
    await writeAuditLogTx(tx, {
      orgId: ctx.orgId, userId: ctx.userId, action: 'delete_contact_relationship', entityType: 'contact_relationship', entityId: row.id,
    });
    return row;
  });
  if (!out) { res.status(404).json({ error: 'Relación no encontrada.' }); return; }
  res.json({ ok: true });
}));

// ── Direcciones adicionales ───────────────────────────────────────────────────

contactExtras.post('/contacts/:id/addresses', wrap(async (req, res) => {
  const contactId = req.params.id;
  if (!isUuid(contactId)) { res.status(400).json({ error: 'Id inválido.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const s = (k: string, max = 120) => (typeof b[k] === 'string' ? (b[k] as string).trim().slice(0, max) || null : null);
  const street = s('street');
  if (!street) { res.status(400).json({ error: 'Falta la calle.' }); return; }
  const ctx = req.authCtx!;
  const out = await withAuthedTx(ctx, async (tx) => {
    const [contact] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
    if (!contact) return null;
    const [row] = await tx.insert(contactAddresses).values({
      orgId: ctx.orgId, contactId,
      label: s('label', 60), street, number: s('number', 20), floor: s('floor', 20), apartment: s('apartment', 20),
      city: s('city'), province: s('province'), postalCode: s('postalCode', 20),
      source: 'manual' as const,
    }).returning({ id: contactAddresses.id });
    await writeAuditLogTx(tx, {
      orgId: ctx.orgId, userId: ctx.userId, action: 'create_contact_address', entityType: 'contact_address', entityId: row!.id,
      payload: { contactId },
    });
    return row;
  });
  if (!out) { res.status(404).json({ error: 'Asegurado no encontrado.' }); return; }
  res.status(201).json(out);
}));

contactExtras.delete('/addresses/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) { res.status(400).json({ error: 'Id inválido.' }); return; }
  const ctx = req.authCtx!;
  const out = await withAuthedTx(ctx, async (tx) => {
    const [row] = await tx.delete(contactAddresses).where(eq(contactAddresses.id, id)).returning({ id: contactAddresses.id });
    if (!row) return null;
    await writeAuditLogTx(tx, {
      orgId: ctx.orgId, userId: ctx.userId, action: 'delete_contact_address', entityType: 'contact_address', entityId: row.id,
    });
    return row;
  });
  if (!out) { res.status(404).json({ error: 'Dirección no encontrada.' }); return; }
  res.json({ ok: true });
}));

// ── Responsables asignados ────────────────────────────────────────────────────

// Usuarios de la org (para el selector). members está RLS-scopeado a la org.
contactExtras.get('/org/users', wrap(async (req, res) => {
  const data = await withAuthedTx(req.authCtx!, (tx) =>
    tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .orderBy(asc(users.name)),
  );
  res.json({ data });
}));

contactExtras.post('/contacts/:id/assignees', wrap(async (req, res) => {
  const contactId = req.params.id;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const userId = String(b.userId ?? '');
  const role = ASSIGNEE_ROLES.includes(String(b.role)) ? String(b.role) : 'responsable';
  if (!isUuid(contactId) || !isUuid(userId)) { res.status(400).json({ error: 'Datos inválidos.' }); return; }
  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async (tx) => {
      const [contact] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
      if (!contact) return 'no-contact';
      const [member] = await tx.select({ id: members.id }).from(members).where(eq(members.userId, userId)).limit(1);
      if (!member) return 'no-member';
      const [row] = await tx.insert(contactAssignees).values({
        orgId: ctx.orgId, contactId, userId,
        role: role as (typeof contactAssignees.$inferInsert)['role'],
      }).returning({ id: contactAssignees.id, role: contactAssignees.role });
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId, userId: ctx.userId, action: 'create_contact_assignee', entityType: 'contact_assignee', entityId: row!.id,
        payload: { contactId, role: row!.role },
      });
      return row;
    });
    if (out === 'no-contact') { res.status(404).json({ error: 'Asegurado no encontrado.' }); return; }
    if (out === 'no-member') { res.status(400).json({ error: 'El usuario no pertenece a la organización.' }); return; }
    res.status(201).json(out);
  } catch (e) {
    if (e instanceof Error && /contact_assignees_unique_idx|duplicate key/.test(e.message + ' ' + String((e as { cause?: unknown }).cause ?? ''))) {
      res.status(409).json({ error: 'Ese usuario ya está asignado con ese rol.' }); return;
    }
    throw e;
  }
}));

contactExtras.delete('/assignees/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) { res.status(400).json({ error: 'Id inválido.' }); return; }
  const ctx = req.authCtx!;
  const out = await withAuthedTx(ctx, async (tx) => {
    const [row] = await tx.delete(contactAssignees).where(eq(contactAssignees.id, id)).returning({ id: contactAssignees.id });
    if (!row) return null;
    await writeAuditLogTx(tx, {
      orgId: ctx.orgId, userId: ctx.userId, action: 'delete_contact_assignee', entityType: 'contact_assignee', entityId: row.id,
    });
    return row;
  });
  if (!out) { res.status(404).json({ error: 'Asignación no encontrada.' }); return; }
  res.json({ ok: true });
}));
