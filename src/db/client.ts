import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import { pool } from '../db.js';
import * as schema from './schema.js';

// Drizzle sobre el mismo Pool de pg que usa Better Auth (src/db.ts).
// A diferencia de la app v0.1 (neon-http + neon-serverless), acá corremos en
// Node/Express: node-postgres alcanza para local, Docker y Vercel serverless.
export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

export type AuthedTx = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0];

export interface AuthContext {
  /** users.id (uuid) de la sesión de Better Auth. */
  userId: string;
  /** organizations.id (uuid) — la org activa de la sesión. */
  orgId: string;
  /** rol de la membership en la org activa. `owner` ⇒ is_org_admin() = true. */
  role: string;
  /** producers.id del usuario en esta org (o null si no es productor). Las
   *  policies RESTRICTIVE producer_scope scopean a `current_producer_id()`. */
  producerId: string | null;
}

// Aislamiento multi-tenant vía RLS (CLAUDE.md §6): cada query corre dentro de
// una transacción que baja el rol a `authenticated` y publica los claims que
// las policies de Postgres leen. El contrato de claims lo fijan las funciones
// SQL del schema:
//   sub    → current_user_id()      (users.id)
//   o.id   → current_org_id()       (organizations.id — tenant_isolation)
//   r      → is_org_admin()         ('owner' ve toda la org)
//   p      → current_producer_id()  (producer_scope: no-admin ve solo lo suyo)
// La conexión owner bypassea RLS, por eso el set_config es obligatorio.
export async function withAuthedTx<T>(authCtx: AuthContext, fn: (tx: AuthedTx) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({
    sub: authCtx.userId,
    o: { id: authCtx.orgId },
    r: authCtx.role,
    p: authCtx.producerId,
  });
  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT set_config('role', 'authenticated', true), set_config('request.jwt.claims', ${claims}, true)`,
    );
    return fn(tx);
  });
}

export { schema };
