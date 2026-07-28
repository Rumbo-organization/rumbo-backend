-- 0008_sc_sync — Infraestructura de la sync con aseguradoras (docs/rumbo/18-api-b2b-sancristobal.md)
--
-- Primera implementación real de la costura `source='sync'` de D-019: el
-- gateway B2B de San Cristóbal (solo lectura). Estas tres tablas son del JOB,
-- no del negocio — la cartera sincronizada aterriza en `policies`, `contacts`,
-- `policy_installments`, `policy_endorsements`, `policy_risks` y `claims`, que
-- ya existen con sus columnas de sync y sus índices de idempotencia.
--
--   · insurer_sync_state — cursor por (org, aseguradora, código de productor).
--   · insurer_sync_queue — nº de póliza/siniestro pendientes de traer detalle.
--   · insurer_sync_runs  — bitácora de corridas.
--
-- La cola existe porque el detalle de SC está limitado a 3 req/s y una
-- invocación serverless tiene segundos de presupuesto: cada corrida drena lo
-- que puede y la siguiente sigue donde quedó.
--
-- RLS: las tres son org-scoped y de SOLO LECTURA para `authenticated` (el
-- cockpit puede mostrar el estado de la sync; nadie la edita desde la app).
-- Escribe únicamente el job, que corre con el cliente owner y bypassea RLS.
-- Sin `producer_scope`: el estado de la sync es de la organización, no de un
-- productor — y sin policy RESTRICTIVE propia, la de tenant alcanza.
--
-- Se aplica a mano contra la branch de Neon (no hay runner):
--
--   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config -e "…" \
--     con migrations/0008_sc_sync.sql
--
-- Idempotente: se puede correr más de una vez.

-- ── enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "sync_queue_kind" AS ENUM ('policy', 'claim');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "sync_run_mode" AS ENUM ('backfill', 'incremental');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "sync_run_status" AS ENUM ('running', 'ok', 'error');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── insurer_sync_state ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "insurer_sync_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "insurer_id" uuid NOT NULL,
  "producer_code" text NOT NULL,
  "tax_id" text,
  "last_movement_date" date,
  "last_payment_date" date,
  "last_claims_news_date" date,
  "last_portfolio_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "insurer_sync_state" ADD CONSTRAINT "insurer_sync_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "insurer_sync_state" ADD CONSTRAINT "insurer_sync_state_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "insurer_sync_state_org_idx" ON "insurer_sync_state" USING btree ("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "insurer_sync_state_code_idx" ON "insurer_sync_state" USING btree ("org_id","insurer_id","producer_code");

GRANT SELECT ON insurer_sync_state TO authenticated;
ALTER TABLE "insurer_sync_state" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON insurer_sync_state;
CREATE POLICY "tenant_isolation" ON insurer_sync_state
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

-- ── insurer_sync_queue ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "insurer_sync_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "insurer_id" uuid NOT NULL,
  "kind" "sync_queue_kind" NOT NULL,
  "external_ref" text NOT NULL,
  "producer_code" text,
  "reason" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "feed_date" date,
  "enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "done_at" timestamp with time zone
);

DO $$ BEGIN
  ALTER TABLE "insurer_sync_queue" ADD CONSTRAINT "insurer_sync_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "insurer_sync_queue" ADD CONSTRAINT "insurer_sync_queue_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "insurer_sync_queue_org_idx" ON "insurer_sync_queue" USING btree ("org_id");
CREATE INDEX IF NOT EXISTS "insurer_sync_queue_pending_idx" ON "insurer_sync_queue" USING btree ("org_id","done_at","attempts");
-- Un pendiente por (org, aseguradora, tipo, ref): el mismo nº de póliza puede
-- aparecer en varios feeds del mismo día y no se procesa dos veces. Parcial
-- sobre los pendientes: el histórico de procesados sí puede repetir la ref.
CREATE UNIQUE INDEX IF NOT EXISTS "insurer_sync_queue_pending_ref_idx" ON "insurer_sync_queue" USING btree ("org_id","insurer_id","kind","external_ref") WHERE done_at IS NULL;

GRANT SELECT ON insurer_sync_queue TO authenticated;
ALTER TABLE "insurer_sync_queue" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON insurer_sync_queue;
CREATE POLICY "tenant_isolation" ON insurer_sync_queue
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

-- ── insurer_sync_runs ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "insurer_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "insurer_id" uuid NOT NULL,
  "mode" "sync_run_mode" NOT NULL,
  "status" "sync_run_status" DEFAULT 'running' NOT NULL,
  "counters" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "notes" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Latido de la corrida: lo bumpea el job cada tanda de trabajo. El reaper mira
  -- ESTO y no `started_at`, porque un backfill legítimo puede durar más de una
  -- hora y no debe darse por abandonado mientras avanza.
  "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);

ALTER TABLE "insurer_sync_runs" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL;

DO $$ BEGIN
  ALTER TABLE "insurer_sync_runs" ADD CONSTRAINT "insurer_sync_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "insurer_sync_runs" ADD CONSTRAINT "insurer_sync_runs_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "insurer_sync_runs_org_idx" ON "insurer_sync_runs" USING btree ("org_id","started_at");

-- Mutex de la sync: UNA corrida en vuelo por (org, aseguradora). El índice
-- parcial ES el candado — el segundo INSERT choca y no entra.
--
-- ⚠️ Por qué no un advisory lock: la app se conecta al endpoint **pooled** de
-- Neon (PgBouncer en transaction pooling). Ahí `pg_try_advisory_lock` es
-- inservible — el lock queda en la conexión de servidor que PgBouncer reasigna,
-- así que otra sesión lo toma igual. Verificado: con el backfill corriendo, una
-- llamada al cron se llevó el lock y arrancó en paralelo.
CREATE UNIQUE INDEX IF NOT EXISTS "insurer_sync_runs_one_running_idx" ON "insurer_sync_runs" USING btree ("org_id","insurer_id") WHERE status = 'running';

GRANT SELECT ON insurer_sync_runs TO authenticated;
ALTER TABLE "insurer_sync_runs" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON insurer_sync_runs;
CREATE POLICY "tenant_isolation" ON insurer_sync_runs
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());
