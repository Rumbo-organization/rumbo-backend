// Router de Siniestros — gestión (jul-2026).
//
// Segundo dominio de escritura del backend. Las LISTAS siguen viniendo del BFF
// (assembleCockpit → SINIESTROS); acá vive la gestión AR del siniestro:
//   POST   /claims                 alta real de la denuncia (denunciante, nº, tipo, prioridad)
//   GET    /claims/:id             ficha del siniestro + timeline de eventos
//   PATCH  /claims/:id/status      cambio de estado (Abierto/En curso/Cerrado)
//   PATCH  /claims/:id/importance  prioridad del PAS (alta/media/baja | null)
//   POST   /claims/:id/comments    comentario al timeline (registro de gestión)
//
// Todo bajo withAuthedTx (RLS org + cartera) con audit transaccional. Sin
// migración: claims / claim_events y sus policies ya existen en la DB.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { asc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { withAuthedTx, schema, type AuthedTx } from '../db/client.js';
import { writeAuditLogTx } from '../audit.js';

const { claims, claimEvents, contacts, documents, insurers, members, policies, users } = schema;
// Alias de `users` para el join del responsable: `users` ya se usa para el autor
// de los eventos del timeline, así que la ficha necesita una referencia aparte.
const assignee = alias(users, 'assignee');

// ── Etiquetas (mismo criterio que routes/v1.ts) ──────────────────────────────
const CLAIM_TYPES = [
  'robo',
  'choque',
  'incendio',
  'danos_agua',
  'granizo',
  'cristales',
  'resp_civil',
  'otros',
] as const;
type ClaimType = (typeof CLAIM_TYPES)[number];
const CLAIM_TYPE_LABEL: Record<string, string> = {
  robo: 'Robo',
  choque: 'Choque',
  incendio: 'Incendio',
  danos_agua: 'Daños por agua',
  granizo: 'Granizo',
  cristales: 'Cristales',
  resp_civil: 'Resp. civil',
  otros: 'Otro',
};
const CLAIM_STATUS_LABEL: Record<string, string> = { abierto: 'Abierto', en_curso: 'En curso', cerrado: 'Cerrado' };
const CLAIM_STATUS = ['abierto', 'en_curso', 'cerrado'] as const;
type ClaimStatus = (typeof CLAIM_STATUS)[number];
const CLAIM_IMPORTANCES = ['alta', 'media', 'baja'] as const;
type ClaimImportance = (typeof CLAIM_IMPORTANCES)[number];
const CLAIM_IMPORTANCE_LABEL: Record<string, string> = { alta: 'Alta', media: 'Media', baja: 'Baja' };

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const contactNameFields = {
  contactKind: contacts.kind,
  contactFirstName: contacts.firstName,
  contactLastName: contacts.lastName,
  contactLegalName: contacts.legalName,
};
function displayName(c: {
  contactKind: string;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactLegalName: string | null;
}): string {
  if (c.contactKind === 'PERSONA_JURIDICA') return c.contactLegalName ?? '—';
  if (c.contactLastName && c.contactFirstName) return `${c.contactLastName}, ${c.contactFirstName}`;
  return c.contactLastName ?? c.contactFirstName ?? '—';
}
function relativeSince(d: Date, now: Date): string {
  const days = Math.max(0, Math.round((now.getTime() - d.getTime()) / 86400000));
  if (days === 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  if (days < 30) return `hace ${Math.round(days / 7)} sem.`;
  return `hace ${Math.round(days / 30)} meses`;
}

export const claimsRouter = Router();

// Verifica pertenencia de la póliza bajo RLS (SELECT solo ve lo propio).
async function policyOwned(tx: AuthedTx, policyId: string): Promise<boolean> {
  const [p] = await tx.select({ id: policies.id }).from(policies).where(eq(policies.id, policyId)).limit(1);
  return Boolean(p);
}

// POST /claims — alta de la denuncia. Campos AR: póliza, tipo, fecha+hora del
// hecho, denunciante (obligatorio), y opcionales nº de siniestro, lugar,
// descripción, prioridad. Devuelve { id } (el frontend re-hidrata el board).
claimsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!isUuid(b.policyId)) {
    res.status(400).json({ error: 'Póliza inválida.' });
    return;
  }
  if (!(CLAIM_TYPES as readonly string[]).includes(b.tipo as string)) {
    res.status(400).json({ error: 'Tipo inválido.' });
    return;
  }
  const reportedBy = typeof b.reportedBy === 'string' ? b.reportedBy.trim() : '';
  if (reportedBy.length < 1) {
    res.status(400).json({ error: 'El denunciante es obligatorio.' });
    return;
  }
  const when = typeof b.occurredAt === 'string' ? new Date(b.occurredAt) : new Date(NaN);
  if (Number.isNaN(when.getTime())) {
    res.status(400).json({ error: 'Fecha y hora del hecho inválidas.' });
    return;
  }
  let importance: ClaimImportance | null = null;
  if (b.importance != null && b.importance !== '') {
    if (!(CLAIM_IMPORTANCES as readonly string[]).includes(b.importance as string)) {
      res.status(400).json({ error: 'Prioridad inválida.' });
      return;
    }
    importance = b.importance as ClaimImportance;
  }
  const opt = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async tx => {
      if (!(await policyOwned(tx, b.policyId as string))) return null;
      const [row] = await tx
        .insert(claims)
        .values({
          orgId: ctx.orgId,
          policyId: b.policyId as string,
          tipo: b.tipo as ClaimType,
          occurredAt: when,
          reportedBy,
          importance,
          claimNumber: opt(b.claimNumber),
          location: opt(b.location),
          description: opt(b.description),
        })
        .returning({ id: claims.id });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'create_claim',
        entityType: 'claim',
        entityId: row.id,
        payload: { tipo: b.tipo, policyId: b.policyId },
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Póliza no encontrada.' });
      return;
    }
    res.status(201).json({ id: out.id });
  } catch (err) {
    next(err);
  }
});

// GET /claims/:id — ficha del siniestro + timeline (comentarios + cambios de estado).
claimsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Id inválido.' });
    return;
  }
  try {
    const data = await withAuthedTx(req.authCtx!, async tx => {
      const now = new Date();
      const [row] = await tx
        .select({
          c: claims,
          ramo: policies.ramo,
          policyNumber: policies.policyNumber,
          insurerName: insurers.name,
          assigneeName: assignee.name,
          ...contactNameFields,
        })
        .from(claims)
        .innerJoin(policies, eq(policies.id, claims.policyId))
        .innerJoin(contacts, eq(contacts.id, policies.contactId))
        .leftJoin(insurers, eq(insurers.id, policies.insurerId))
        .leftJoin(assignee, eq(assignee.id, claims.assignedUserId))
        .where(eq(claims.id, id))
        .limit(1);
      if (!row) return null;

      const evRows = await tx
        .select({ e: claimEvents, who: users.name })
        .from(claimEvents)
        .leftJoin(users, eq(users.id, claimEvents.authorUserId))
        .where(eq(claimEvents.claimId, id))
        .orderBy(asc(claimEvents.createdAt));

      // Adjuntos del siniestro (Slice 3 de pre-denuncias): los promueve la
      // conversión del intake; se descargan por /api/v1/documents/:id.
      const docRows = await tx
        .select({ id: documents.id, fileName: documents.fileName, sizeBytes: documents.sizeBytes })
        .from(documents)
        .where(eq(documents.claimId, id))
        .orderBy(asc(documents.createdAt));

      const c = row.c;
      const staleDays = Math.max(0, Math.round((now.getTime() - c.lastActivityAt.getTime()) / 86400000));
      return {
        id: c.id,
        num: c.claimNumber ?? '—',
        tipo: CLAIM_TYPE_LABEL[c.tipo] ?? c.tipo,
        tipoDetalle: c.tipoDetalle,
        status: CLAIM_STATUS_LABEL[c.status] ?? c.status,
        importance: c.importance ? (CLAIM_IMPORTANCE_LABEL[c.importance] ?? c.importance) : null,
        client: displayName(row),
        insurer: row.insurerName ?? '—',
        policyId: c.policyId,
        policyNumber: row.policyNumber ?? '—',
        opened: c.occurredAt.toISOString().slice(0, 10),
        reportedBy: c.reportedBy,
        assigneeId: c.assignedUserId,
        assigneeName: row.assigneeName ?? null,
        location: c.location,
        description: c.description,
        stale: staleDays,
        documentos: docRows,
        events: evRows.map(({ e, who }) => ({
          id: e.id,
          when: relativeSince(e.createdAt, now),
          who: who ?? 'Sistema',
          kind: e.kind,
          text:
            e.kind === 'status_change'
              ? `Estado → ${CLAIM_STATUS_LABEL[e.newStatus ?? ''] ?? e.newStatus ?? '—'}`
              : (e.body ?? 'Comentario'),
        })),
      };
    });
    if (!data) {
      res.status(404).json({ error: 'Siniestro no encontrado.' });
      return;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// PATCH /claims/:id/status — cambia el estado + evento de timeline + audit.
claimsRouter.patch('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Id inválido.' });
    return;
  }
  const status = (req.body ?? {}).status as unknown;
  if (!(CLAIM_STATUS as readonly string[]).includes(status as string)) {
    res.status(400).json({ error: 'Estado inválido.' });
    return;
  }
  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async tx => {
      const now = new Date();
      const [row] = await tx
        .update(claims)
        .set({ status: status as ClaimStatus, lastActivityAt: now, updatedAt: now })
        .where(eq(claims.id, id))
        .returning({ id: claims.id, status: claims.status });
      if (!row) return null;
      await tx.insert(claimEvents).values({
        orgId: ctx.orgId,
        claimId: id,
        kind: 'status_change',
        newStatus: status as ClaimStatus,
        authorUserId: ctx.userId,
      });
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'update_claim_status',
        entityType: 'claim',
        entityId: id,
        payload: { status },
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Siniestro no encontrado.' });
      return;
    }
    res.json({ id: out.id, status: CLAIM_STATUS_LABEL[out.status] ?? out.status, stale: 0 });
  } catch (err) {
    next(err);
  }
});

// PATCH /claims/:id/importance — prioridad del PAS (alta/media/baja | null). No
// es "movimiento" del siniestro (no bumpea lastActivity): es triage.
claimsRouter.patch('/:id/importance', async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Id inválido.' });
    return;
  }
  const raw = (req.body ?? {}).importance as unknown;
  let importance: ClaimImportance | null = null;
  if (raw != null && raw !== '') {
    if (!(CLAIM_IMPORTANCES as readonly string[]).includes(raw as string)) {
      res.status(400).json({ error: 'Prioridad inválida.' });
      return;
    }
    importance = raw as ClaimImportance;
  }
  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async tx => {
      const [row] = await tx
        .update(claims)
        .set({ importance, updatedAt: new Date() })
        .where(eq(claims.id, id))
        .returning({ id: claims.id, importance: claims.importance });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'update_claim_importance',
        entityType: 'claim',
        entityId: id,
        payload: { importance },
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Siniestro no encontrado.' });
      return;
    }
    res.json({
      id: out.id,
      importance: out.importance ? (CLAIM_IMPORTANCE_LABEL[out.importance] ?? out.importance) : null,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /claims/:id/assignee — responsable operativo (miembro del org | null).
// Como importance, es gestión y no "movimiento" (no bumpea lastActivity). El
// responsable elegido debe ser miembro de la org; '' o null lo desasigna.
claimsRouter.patch('/:id/assignee', async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Id inválido.' });
    return;
  }
  const raw = (req.body ?? {}).assignedUserId as unknown;
  let assignedUserId: string | null;
  if (raw == null || raw === '') {
    assignedUserId = null;
  } else if (isUuid(raw)) {
    assignedUserId = raw;
  } else {
    res.status(400).json({ error: 'Responsable inválido.' });
    return;
  }
  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async tx => {
      let assigneeName: string | null = null;
      if (assignedUserId) {
        const [m] = await tx
          .select({ name: users.name })
          .from(members)
          .innerJoin(users, eq(users.id, members.userId))
          .where(eq(members.userId, assignedUserId))
          .limit(1);
        if (!m) return { badMember: true as const };
        assigneeName = m.name;
      }
      const [row] = await tx
        .update(claims)
        .set({ assignedUserId, updatedAt: new Date() })
        .where(eq(claims.id, id))
        .returning({ id: claims.id });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'update_claim_assignee',
        entityType: 'claim',
        entityId: id,
        payload: { assignedUserId },
      });
      return { id: row.id, assigneeName };
    });
    if (out && 'badMember' in out) {
      res.status(400).json({ error: 'Ese usuario no pertenece a tu organización.' });
      return;
    }
    if (!out) {
      res.status(404).json({ error: 'Siniestro no encontrado.' });
      return;
    }
    res.json({ id: out.id, assigneeId: assignedUserId, assigneeName: out.assigneeName });
  } catch (err) {
    next(err);
  }
});

// POST /claims/:id/comments — comentario al timeline + bump de last_activity.
claimsRouter.post('/:id/comments', async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Id inválido.' });
    return;
  }
  const body = typeof (req.body ?? {}).body === 'string' ? (req.body.body as string).trim() : '';
  if (body.length < 1) {
    res.status(400).json({ error: 'El comentario está vacío.' });
    return;
  }
  if (body.length > 2000) {
    res.status(400).json({ error: 'El comentario es demasiado largo.' });
    return;
  }
  const ctx = req.authCtx!;
  try {
    const out = await withAuthedTx(ctx, async tx => {
      const now = new Date();
      // El siniestro debe ser visible (RLS) para comentar: chequeo + bump.
      const [claim] = await tx
        .update(claims)
        .set({ lastActivityAt: now, updatedAt: now })
        .where(eq(claims.id, id))
        .returning({ id: claims.id });
      if (!claim) return null;
      const [ev] = await tx
        .insert(claimEvents)
        .values({ orgId: ctx.orgId, claimId: id, kind: 'comment', body, authorUserId: ctx.userId })
        .returning({ id: claimEvents.id });
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'comment_claim',
        entityType: 'claim',
        entityId: id,
      });
      return ev ?? { id: '' };
    });
    if (!out) {
      res.status(404).json({ error: 'Siniestro no encontrado.' });
      return;
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
