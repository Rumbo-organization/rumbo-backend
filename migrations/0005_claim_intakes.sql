-- 0005_claim_intakes — Pre-denuncias, Slice 1 (docs/rumbo/17-pre-denuncias.md)
--
-- Dos tablas: `producer_intake_links` (link público permanente por productor,
-- slug rotable) y `claim_intakes` (la pre-denuncia declarada por el asegurado
-- o un tercero desde el formulario público, sin sesión).
--
-- Se aplica a mano contra la branch de Neon (no hay runner):
--
--   psql "$DATABASE_URL" -f migrations/0005_claim_intakes.sql
--
-- Las funciones RLS (current_org_id(), is_org_admin(), current_producer_id())
-- YA existen en la DB. Idempotente: se puede correr más de una vez.
--
-- Modelo de acceso:
--   · El endpoint público escribe con el cliente OWNER (bypass RLS) scopeado
--     por slug — por eso authenticated NO tiene INSERT sobre claim_intakes.
--   · La app autenticada lee (y en Slice 2 resuelve: UPDATE) vía RLS:
--     tenant_isolation + producer_scope (el organizador ve todo, el productor
--     solo su cartera; producer_id NULL queda solo para el admin).

DO $$ BEGIN
  CREATE TYPE "public"."claim_intake_status" AS ENUM('pendiente', 'convertida', 'rechazada', 'vencida');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."claim_intake_mode" AS ENUM('producer_link', 'policy_link');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ── producer_intake_links ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "producer_intake_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "producer_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "rotated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "producer_intake_links_slug_unique" UNIQUE("slug")
);

DO $$ BEGIN
  ALTER TABLE "producer_intake_links" ADD CONSTRAINT "producer_intake_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "producer_intake_links" ADD CONSTRAINT "producer_intake_links_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "producer_intake_links_org_idx" ON "producer_intake_links" USING btree ("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "producer_intake_links_producer_idx" ON "producer_intake_links" USING btree ("producer_id");

GRANT SELECT, INSERT, UPDATE ON producer_intake_links TO authenticated;
ALTER TABLE "producer_intake_links" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON producer_intake_links;
CREATE POLICY "tenant_isolation" ON producer_intake_links
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

-- El organizador gestiona los links de todos sus productores; un usuario-
-- productor, solo el suyo. Fail-closed sin claims.
DROP POLICY IF EXISTS "producer_scope" ON producer_intake_links;
CREATE POLICY "producer_scope" ON producer_intake_links
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (is_org_admin() OR producer_id = current_producer_id())
  WITH CHECK (is_org_admin() OR producer_id = current_producer_id());

-- ── claim_intakes ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "claim_intakes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "producer_id" uuid,
  "mode" "claim_intake_mode" DEFAULT 'producer_link' NOT NULL,
  "number" integer NOT NULL,
  "status" "claim_intake_status" DEFAULT 'pendiente' NOT NULL,
  "declarante" jsonb NOT NULL,
  "asegurado_declarado" jsonb NOT NULL,
  "incidente" jsonb NOT NULL,
  "matched_contact_id" uuid,
  "matched_policy_id" uuid,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "policy_id" uuid,
  "token_hash" text,
  "expires_at" timestamp with time zone,
  "consent_at" timestamp with time zone NOT NULL,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "converted_claim_id" uuid,
  "reject_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_matched_contact_id_contacts_id_fk" FOREIGN KEY ("matched_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_matched_policy_id_policies_id_fk" FOREIGN KEY ("matched_policy_id") REFERENCES "public"."policies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_converted_claim_id_claims_id_fk" FOREIGN KEY ("converted_claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "claim_intakes_org_idx" ON "claim_intakes" USING btree ("org_id");
CREATE INDEX IF NOT EXISTS "claim_intakes_org_status_idx" ON "claim_intakes" USING btree ("org_id","status");
CREATE INDEX IF NOT EXISTS "claim_intakes_producer_idx" ON "claim_intakes" USING btree ("producer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "claim_intakes_org_number_idx" ON "claim_intakes" USING btree ("org_id","number");

-- Sin INSERT para authenticated: la pre-denuncia entra solo por el endpoint
-- público (cliente owner). UPDATE habilita convertir/rechazar (Slice 2).
GRANT SELECT, UPDATE ON claim_intakes TO authenticated;
ALTER TABLE "claim_intakes" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON claim_intakes;
CREATE POLICY "tenant_isolation" ON claim_intakes
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "producer_scope" ON claim_intakes;
CREATE POLICY "producer_scope" ON claim_intakes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (is_org_admin() OR producer_id = current_producer_id())
  WITH CHECK (is_org_admin() OR producer_id = current_producer_id());
