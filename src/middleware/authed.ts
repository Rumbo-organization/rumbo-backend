import type { NextFunction, Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq } from 'drizzle-orm';

import { auth } from '../auth.js';
import { db, schema, type AuthContext } from '../db/client.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authCtx?: AuthContext;
    }
  }
}

// Middleware de aislamiento multi-tenant (CLAUDE.md §6): resuelve la sesión de
// Better Auth y deja {userId, orgId} en req.authCtx. Toda ruta /api/v1 pasa por
// acá; las queries después corren dentro de withAuthedTx (RLS) con ese contexto.
export async function requireAuthedOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const s = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!s) {
      res.status(401).json({ error: 'No autenticado' });
      return;
    }

    // Org activa de la sesión; fallback a la primera membership para sesiones
    // creadas antes del hook (o si el plugin la limpió).
    const activeOrg = (s.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;

    // Membership del usuario en la org activa (o la primera si no hay activa).
    // Aporta el `role` que gobierna is_org_admin() en las policies RLS.
    const memberWhere = (orgFilter: string | null) =>
      orgFilter
        ? and(eq(schema.members.userId, s.user.id), eq(schema.members.organizationId, orgFilter))
        : eq(schema.members.userId, s.user.id);
    let [member] = await db
      .select({
        orgId: schema.members.organizationId,
        role: schema.members.role,
      })
      .from(schema.members)
      .where(memberWhere(activeOrg))
      .limit(1);

    // Sesión con una org donde YA no es miembro (lo eliminaron con la sesión
    // viva): caer a su primera membership real. NUNCA usar activeOrg sin
    // membership que lo respalde — ese fallback dejaba a un miembro expulsado
    // leyendo datos org-wide de la org que lo echó hasta expirar la sesión.
    if (!member && activeOrg) {
      [member] = await db
        .select({
          orgId: schema.members.organizationId,
          role: schema.members.role,
        })
        .from(schema.members)
        .where(memberWhere(null))
        .limit(1);
    }

    const orgId = member?.orgId ?? null;
    if (!orgId) {
      res.status(403).json({ error: 'Sin organización activa' });
      return;
    }

    // producers.id del usuario en esta org (producer_scope RLS). Puede no
    // existir: un miembro sin ficha de productor solo verá lo que su rol
    // `owner` le permita (toda la org) o nada.
    const [producer] = await db
      .select({ id: schema.producers.id })
      .from(schema.producers)
      .where(and(eq(schema.producers.userId, s.user.id), eq(schema.producers.orgId, orgId)))
      .limit(1);

    req.authCtx = {
      userId: s.user.id,
      orgId,
      role: member?.role ?? 'member',
      producerId: producer?.id ?? null,
    };
    next();
  } catch (err) {
    next(err);
  }
}

// Gate de organizador (equivalente del organizadorProcedure del viejo): solo
// members role='owner'. Corre DESPUÉS de requireAuthedOrg (necesita authCtx).
// RLS ya limita los datos, pero las secciones/acciones de organizador
// (analytics cross-productor, datos del PAS, borrado de cuenta) se niegan
// enteras para productores.
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (req.authCtx?.role !== 'owner') {
    res.status(403).json({ error: 'Sección del organizador.' });
    return;
  }
  next();
}
