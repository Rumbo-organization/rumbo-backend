-- 0007_intake_adjuntos_modo_b — Pre-denuncias, Slices 3+4 (docs/rumbo/17-pre-denuncias.md)
--
-- Slice 3 (adjuntos): token de subida en el intake + tercer target de
-- `documents` (el siniestro) para la promoción al convertir.
-- Slice 4 (Modo B): estado `borrador` para el link puntual por póliza — la
-- fila del intake se crea al generar el link y el submit del asegurado la
-- completa; `consent_at` pasa a nullable porque el borrador aún no lo tiene.
--
-- Se aplica a mano contra la branch de Neon (no hay runner):
--
--   psql "$DATABASE_URL" -f migrations/0007_intake_adjuntos_modo_b.sql
--
-- Idempotente: se puede correr más de una vez.

-- ── claim_intakes ────────────────────────────────────────────────────────────

ALTER TYPE "claim_intake_status" ADD VALUE IF NOT EXISTS 'borrador';

ALTER TABLE "claim_intakes" ALTER COLUMN "consent_at" DROP NOT NULL;
ALTER TABLE "claim_intakes" ADD COLUMN IF NOT EXISTS "upload_token_hash" text;

-- El Modo B crea el borrador desde la app autenticada (RLS lo scopea a la
-- org/cartera); 0005 solo daba SELECT/UPDATE.
GRANT INSERT ON claim_intakes TO authenticated;

-- ── documents: tercer target (siniestro) ─────────────────────────────────────

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "claim_id" uuid;
DO $$ BEGIN
  ALTER TABLE "documents" ADD CONSTRAINT "documents_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "documents_claim_idx" ON "documents" USING btree ("claim_id");

-- Check "cuelga de exactamente uno": póliza XOR contacto XOR siniestro.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_target_chk";
ALTER TABLE "documents" ADD CONSTRAINT "documents_target_chk" CHECK (
  ((("policy_id" IS NOT NULL))::int + (("contact_id" IS NOT NULL))::int + (("claim_id" IS NOT NULL))::int) = 1
);
