-- 0008_claim_assignee — Responsable operativo del siniestro
--
-- Quién gestiona el siniestro ante la aseguradora (Rocío gestiona los suyos;
-- Pablo, organizador, ve/gestiona los propios y los de los PAS bajo su ala).
-- Es asignación OPERATIVA, ortogonal al scoping por productor (RLS vía póliza):
-- no toca ninguna policy. Mismo concepto que `contact_assignees` (un miembro
-- del org), acá como columna directa del siniestro.
--
-- `assigned_user_id` → users. Nullable: lo setea la conversión de una
-- pre-denuncia (default = quien convierte) o la asignación manual; los que
-- entran por sync/alta manual pueden quedar sin responsable. ON DELETE set null:
-- si se elimina el usuario, el siniestro queda sin responsable (no se pierde).
--
-- Se aplica a mano contra la branch de Neon (no hay runner):
--
--   node --env-file=.env scripts/apply-migration.mjs migrations/0008_claim_assignee.sql
--
-- Idempotente: se puede correr más de una vez.

ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "assigned_user_id" uuid;

DO $$ BEGIN
  ALTER TABLE "claims" ADD CONSTRAINT "claims_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "claims_assigned_user_idx" ON "claims" USING btree ("assigned_user_id");
