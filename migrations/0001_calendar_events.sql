-- 0001_calendar_events — Calendario (jul-2026)
--
-- Portado de la migración drizzle 0052 de la app v0.1. El backend Express no
-- tiene runner de migraciones (schema.ts se declara contra la DB existente de
-- Neon); esta DDL se aplica a mano UNA vez contra la branch de Neon:
--
--   psql "$DATABASE_URL" -f migrations/0001_calendar_events.sql
--
-- Las funciones RLS (current_org_id(), is_org_admin(), current_producer_id())
-- YA existen en la DB (las usan el resto de las tablas). Idempotente: se puede
-- correr más de una vez sin romper.

DO $$ BEGIN
  CREATE TYPE "public"."calendar_event_kind" AS ENUM('llamada', 'reunion', 'tramite', 'otro');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "calendar_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "producer_id" uuid,
  "created_by_user_id" uuid,
  "kind" "calendar_event_kind" DEFAULT 'otro' NOT NULL,
  "title" text NOT NULL,
  "notes" text,
  "date" date NOT NULL,
  "time" time,
  "contact_id" uuid,
  "policy_id" uuid,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "calendar_events_org_date_idx" ON "calendar_events" USING btree ("org_id","date");

-- Grants + RLS (patrón 0004/0049: las tablas nuevas no los traen solas).
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events TO authenticated;
ALTER TABLE "calendar_events" ENABLE ROW LEVEL SECURITY;

-- tenant_isolation: la agenda solo es visible/escribible dentro de la org.
DROP POLICY IF EXISTS "tenant_isolation" ON calendar_events;
CREATE POLICY "tenant_isolation" ON calendar_events
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

-- producer_scope: el organizador ve toda la agenda de la org; un productor,
-- solo la suya. Fail-closed sin claims (como el resto de producer_scope).
DROP POLICY IF EXISTS "producer_scope" ON calendar_events;
CREATE POLICY "producer_scope" ON calendar_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (is_org_admin() OR producer_id = current_producer_id())
  WITH CHECK (is_org_admin() OR producer_id = current_producer_id());
