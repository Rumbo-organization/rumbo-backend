// writeAuditLogTx: registra una operación de negocio en audit_log (D-015.15.2)
// dentro de la MISMA transacción withAuthedTx que la operación (RLS activo). Si
// el insert de audit falla, la operación entera revierte. El WITH CHECK de
// audit_log (org_id = current_org_id()) se cumple dentro de la tx.
//
// Primera pieza del camino de escritura del backend Express (antes solo lecturas
// del BFF). Portado de app/src/server/audit.ts de la app v0.1.

import type { AuthedTx } from './db/client.js';
import { schema } from './db/client.js';

export interface WriteAuditLogInput {
  orgId: string;
  userId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}

export async function writeAuditLogTx(tx: AuthedTx, input: WriteAuditLogInput): Promise<void> {
  await tx.insert(schema.auditLog).values({
    orgId: input.orgId,
    userId: input.userId,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    payload: input.payload ?? null,
  });
}
