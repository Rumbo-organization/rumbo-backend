// Router de Siniestros — escrituras (jul-2026).
//
// Segundo camino de escritura del backend (después del Calendario). Las lecturas
// de siniestros siguen viniendo del BFF (assembleCockpit → SINIESTROS); acá vive
// la gestión: por ahora el cambio de estado (Abierto → En curso → Cerrado).
//
// Cada cambio: update del claim + bump de last_activity_at (apaga la alerta de
// "sin movimiento") + un evento de timeline `status_change` + audit, todo en la
// misma tx bajo RLS (org + cartera). No hay migración: claims / claim_events y
// sus policies ya existen en la DB.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';

import { withAuthedTx, schema } from '../db/client.js';
import { writeAuditLogTx } from '../audit.js';

const { claims, claimEvents } = schema;

const CLAIM_STATUS = ['abierto', 'en_curso', 'cerrado'] as const;
type ClaimStatus = (typeof CLAIM_STATUS)[number];
const STATUS_LABEL: Record<string, string> = {
  abierto: 'Abierto',
  en_curso: 'En curso',
  cerrado: 'Cerrado',
};

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const claimsRouter = Router();

// PATCH /claims/:id/status — cambia el estado del siniestro. RLS oculta lo
// ajeno → 404. Devuelve el estado ya como label + stale reseteado (el frontend
// mergea sobre su SINIESTROS local sin re-hidratar todo el cockpit).
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
    const out = await withAuthedTx(ctx, async (tx) => {
      const now = new Date();
      const [row] = await tx
        .update(claims)
        .set({ status: status as ClaimStatus, lastActivityAt: now, updatedAt: now })
        .where(eq(claims.id, id))
        .returning({ id: claims.id, status: claims.status });
      if (!row) return null; // RLS: no visible / no existe

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
    res.json({ id: out.id, status: STATUS_LABEL[out.status] ?? out.status, stale: 0 });
  } catch (err) {
    next(err);
  }
});
