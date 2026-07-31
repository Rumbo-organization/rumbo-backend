-- _baseline.sql — esquema COMPLETO generado desde src/db/schema.ts con drizzle-kit generate.
-- Uso: crear una branch de Neon vacía desde cero (ver migrations/README.md).
--   node --env-file=../.env scripts/apply-migration.mjs migrations/_baseline.sql
-- Regenerar cuando cambie schema.ts. NO integra la secuencia incremental 0001+.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TYPE "public"."calendar_event_kind" AS ENUM('llamada', 'reunion', 'tramite', 'otro');--> statement-breakpoint
CREATE TYPE "public"."claim_event_kind" AS ENUM('comment', 'status_change');--> statement-breakpoint
CREATE TYPE "public"."claim_importance" AS ENUM('alta', 'media', 'baja');--> statement-breakpoint
CREATE TYPE "public"."claim_intake_mode" AS ENUM('producer_link', 'policy_link');--> statement-breakpoint
CREATE TYPE "public"."claim_intake_status" AS ENUM('pendiente', 'convertida', 'rechazada', 'vencida', 'borrador');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('abierto', 'en_curso', 'cerrado');--> statement-breakpoint
CREATE TYPE "public"."claim_type" AS ENUM('robo', 'choque', 'incendio', 'danos_agua', 'granizo', 'cristales', 'resp_civil', 'otros');--> statement-breakpoint
CREATE TYPE "public"."communication_channel" AS ENUM('whatsapp', 'email', 'llamada', 'otro');--> statement-breakpoint
CREATE TYPE "public"."contact_assignee_role" AS ENUM('responsable', 'comercial', 'cobranzas', 'siniestros');--> statement-breakpoint
CREATE TYPE "public"."contact_kind" AS ENUM('PERSONA_FISICA', 'PERSONA_JURIDICA');--> statement-breakpoint
CREATE TYPE "public"."contact_relation_type" AS ENUM('conyuge', 'conviviente', 'hijo', 'padre_madre', 'hermano', 'socio', 'empleado', 'empleador', 'familiar', 'otro');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('prospecto', 'asegurado', 'exasegurado');--> statement-breakpoint
CREATE TYPE "public"."endorsement_type" AS ENUM('emision', 'refacturacion', 'endoso', 'anulacion');--> statement-breakpoint
CREATE TYPE "public"."expiry_notification_window" AS ENUM('30d', '7d');--> statement-breakpoint
CREATE TYPE "public"."normalized_coverage" AS ENUM('incendio_robo_garage', 'rc', 'rc_grua', 'rc_robo_incendio', 'terceros_completo', 'terceros_completo_full', 'todo_riesgo_franquicia', 'todo_riesgo_sin_franquicia');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cupon', 'debito_bancario', 'tarjeta_credito');--> statement-breakpoint
CREATE TYPE "public"."policy_party_role" AS ENUM('asegurado', 'tomador', 'beneficiario', 'conductor', 'acreedor_prendario', 'otro');--> statement-breakpoint
CREATE TYPE "public"."policy_ramo" AS ENUM('automotor', 'hogar', 'vida', 'art', 'comercio', 'accidentes_personales', 'otros', 'motovehiculo', 'incendio', 'responsabilidad_civil', 'consorcio', 'seguro_tecnico', 'transporte', 'embarcaciones');--> statement-breakpoint
CREATE TYPE "public"."policy_status" AS ENUM('propuesta', 'vigente', 'vencida', 'anulada', 'renovada');--> statement-breakpoint
CREATE TYPE "public"."prospect_stage" AS ENUM('nuevo', 'contactado', 'cotizado', 'negociacion');--> statement-breakpoint
CREATE TYPE "public"."record_source" AS ENUM('manual', 'import_csv', 'sync');--> statement-breakpoint
CREATE TYPE "public"."sync_queue_kind" AS ENUM('policy', 'claim');--> statement-breakpoint
CREATE TYPE "public"."sync_run_mode" AS ENUM('backfill', 'incremental');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'ok', 'error');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
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
--> statement-breakpoint
CREATE TABLE "claim_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"kind" "claim_event_kind" NOT NULL,
	"body" text,
	"new_status" "claim_status",
	"author_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_intakes" (
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
	"consent_at" timestamp with time zone,
	"upload_token_hash" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"converted_claim_id" uuid,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"tipo" "claim_type" NOT NULL,
	"tipo_detalle" text,
	"status" "claim_status" DEFAULT 'abierto' NOT NULL,
	"importance" "claim_importance",
	"assigned_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"reported_by" text NOT NULL,
	"claim_number" text,
	"location" text,
	"description" text,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"policy_id" uuid,
	"channel" "communication_channel" DEFAULT 'whatsapp' NOT NULL,
	"template_id" text,
	"body" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"label" text,
	"street" text,
	"number" text,
	"floor" text,
	"apartment" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_assignees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "contact_assignee_role" DEFAULT 'responsable' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"related_contact_id" uuid NOT NULL,
	"type" "contact_relation_type" NOT NULL,
	"note" text,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "contact_kind" NOT NULL,
	"first_name" text,
	"last_name" text,
	"legal_name" text,
	"dni" text,
	"cuit" text,
	"status" "contact_status" DEFAULT 'prospecto' NOT NULL,
	"pipeline_stage" "prospect_stage",
	"notes" text,
	"producer_id" uuid,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"address_street" text,
	"address_number" text,
	"address_floor" text,
	"address_apartment" text,
	"address_city" text,
	"address_province" text,
	"address_postal_code" text,
	"contact_methods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_quality_score" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid,
	"contact_id" uuid,
	"claim_id" uuid,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_target_chk" CHECK ((("documents"."policy_id" IS NOT NULL)::int + ("documents"."contact_id" IS NOT NULL)::int + ("documents"."claim_id" IS NOT NULL)::int) = 1)
);
--> statement-breakpoint
CREATE TABLE "expiry_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"window" "expiry_notification_window" NOT NULL,
	"contact_email" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurer_sync_queue" (
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
--> statement-breakpoint
CREATE TABLE "insurer_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"insurer_id" uuid NOT NULL,
	"mode" "sync_run_mode" NOT NULL,
	"status" "sync_run_status" DEFAULT 'running' NOT NULL,
	"counters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "insurer_sync_state" (
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
--> statement-breakpoint
CREATE TABLE "insurers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key" text,
	"organizer_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"cuit" text,
	"ssn_matricula" text,
	"fiscal_condition" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"insurer_id" uuid NOT NULL,
	"producer_id" uuid,
	"ramo" "policy_ramo" NOT NULL,
	"policy_number" text,
	"status" "policy_status" DEFAULT 'vigente' NOT NULL,
	"start_date" date,
	"end_date" date,
	"prima" numeric(14, 2),
	"premio" numeric(14, 2),
	"suma_asegurada" numeric(14, 2),
	"currency" text DEFAULT 'ARS' NOT NULL,
	"canceled_at" date,
	"cancel_reason" text,
	"renewed_from_policy_id" uuid,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"external_raw" jsonb,
	"last_read_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"notes" text,
	"payment_method" "payment_method",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_endorsements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"type" "endorsement_type" DEFAULT 'endoso' NOT NULL,
	"issued_at" date,
	"start_date" date,
	"end_date" date,
	"prima" numeric(14, 2),
	"premio" numeric(14, 2),
	"description" text,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"external_raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"due_date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"paid_at" timestamp with time zone,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" "policy_party_role" NOT NULL,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"patente" text,
	"descripcion" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"external_raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "producer_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"producer_id" uuid NOT NULL,
	"insurer_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "producer_intake_links" (
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
--> statement-breakpoint
CREATE TABLE "producers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ssn_matricula" text,
	"is_self" boolean DEFAULT false NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"insurer_id" uuid NOT NULL,
	"coverage" "normalized_coverage",
	"native_code" text,
	"suma_asegurada" numeric(14, 2),
	"cuota" numeric(14, 2),
	"currency" text DEFAULT 'ARS' NOT NULL,
	"prima" numeric(14, 2),
	"premio" numeric(14, 2),
	"deductible" text,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid,
	"ramo" "policy_ramo" DEFAULT 'automotor' NOT NULL,
	"reference" text,
	"vehicle_marca" text,
	"vehicle_modelo" text,
	"vehicle_anio" text,
	"vehicle_version" text,
	"notes" text,
	"producer_id" uuid,
	"details" jsonb,
	"source" "record_source" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"active_organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"terms_accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_matched_contact_id_contacts_id_fk" FOREIGN KEY ("matched_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_matched_policy_id_policies_id_fk" FOREIGN KEY ("matched_policy_id") REFERENCES "public"."policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_converted_claim_id_claims_id_fk" FOREIGN KEY ("converted_claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_addresses" ADD CONSTRAINT "contact_addresses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_addresses" ADD CONSTRAINT "contact_addresses_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_assignees" ADD CONSTRAINT "contact_assignees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_assignees" ADD CONSTRAINT "contact_assignees_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_assignees" ADD CONSTRAINT "contact_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_relationships" ADD CONSTRAINT "contact_relationships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_relationships" ADD CONSTRAINT "contact_relationships_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_relationships" ADD CONSTRAINT "contact_relationships_related_contact_id_contacts_id_fk" FOREIGN KEY ("related_contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expiry_notifications" ADD CONSTRAINT "expiry_notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expiry_notifications" ADD CONSTRAINT "expiry_notifications_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurer_sync_queue" ADD CONSTRAINT "insurer_sync_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurer_sync_queue" ADD CONSTRAINT "insurer_sync_queue_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurer_sync_runs" ADD CONSTRAINT "insurer_sync_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurer_sync_runs" ADD CONSTRAINT "insurer_sync_runs_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurer_sync_state" ADD CONSTRAINT "insurer_sync_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurer_sync_state" ADD CONSTRAINT "insurer_sync_state_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurers" ADD CONSTRAINT "insurers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_renewed_from_policy_id_policies_id_fk" FOREIGN KEY ("renewed_from_policy_id") REFERENCES "public"."policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_endorsements" ADD CONSTRAINT "policy_endorsements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_endorsements" ADD CONSTRAINT "policy_endorsements_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_installments" ADD CONSTRAINT "policy_installments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_installments" ADD CONSTRAINT "policy_installments_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_parties" ADD CONSTRAINT "policy_parties_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_parties" ADD CONSTRAINT "policy_parties_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_parties" ADD CONSTRAINT "policy_parties_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_risks" ADD CONSTRAINT "policy_risks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_risks" ADD CONSTRAINT "policy_risks_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_codes" ADD CONSTRAINT "producer_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_codes" ADD CONSTRAINT "producer_codes_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_codes" ADD CONSTRAINT "producer_codes_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_intake_links" ADD CONSTRAINT "producer_intake_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_intake_links" ADD CONSTRAINT "producer_intake_links_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producers" ADD CONSTRAINT "producers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producers" ADD CONSTRAINT "producers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_insurer_id_insurers_id_fk" FOREIGN KEY ("insurer_id") REFERENCES "public"."insurers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "calendar_events_org_date_idx" ON "calendar_events" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "claim_events_org_idx" ON "claim_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "claim_events_claim_idx" ON "claim_events" USING btree ("claim_id","created_at");--> statement-breakpoint
CREATE INDEX "claim_intakes_org_idx" ON "claim_intakes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "claim_intakes_org_status_idx" ON "claim_intakes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "claim_intakes_producer_idx" ON "claim_intakes" USING btree ("producer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_intakes_org_number_idx" ON "claim_intakes" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "claims_org_idx" ON "claims" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "claims_org_status_idx" ON "claims" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "claims_policy_idx" ON "claims" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "claims_assigned_user_idx" ON "claims" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_external_ref_idx" ON "claims" USING btree ("org_id","external_ref") WHERE "claims"."external_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "communications_org_idx" ON "communications" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "communications_contact_idx" ON "communications" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "contact_addresses_org_idx" ON "contact_addresses" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contact_addresses_contact_idx" ON "contact_addresses" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_assignees_org_idx" ON "contact_assignees" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contact_assignees_contact_idx" ON "contact_assignees" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_assignees_user_idx" ON "contact_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_assignees_unique_idx" ON "contact_assignees" USING btree ("org_id","contact_id","user_id","role");--> statement-breakpoint
CREATE INDEX "contact_relationships_org_idx" ON "contact_relationships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contact_relationships_contact_idx" ON "contact_relationships" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_relationships_related_idx" ON "contact_relationships" USING btree ("related_contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_relationships_pair_idx" ON "contact_relationships" USING btree ("org_id","contact_id","related_contact_id");--> statement-breakpoint
CREATE INDEX "contacts_org_idx" ON "contacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contacts_org_status_idx" ON "contacts" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "contacts_dni_idx" ON "contacts" USING btree ("dni");--> statement-breakpoint
CREATE INDEX "contacts_cuit_idx" ON "contacts" USING btree ("cuit");--> statement-breakpoint
CREATE INDEX "contacts_first_name_trgm" ON "contacts" USING gin ("first_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_last_name_trgm" ON "contacts" USING gin ("last_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_legal_name_trgm" ON "contacts" USING gin ("legal_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "documents_org_idx" ON "documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "documents_policy_idx" ON "documents" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "documents_contact_idx" ON "documents" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "documents_claim_idx" ON "documents" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expiry_notifications_policy_window_idx" ON "expiry_notifications" USING btree ("policy_id","window");--> statement-breakpoint
CREATE INDEX "expiry_notifications_org_idx" ON "expiry_notifications" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "insurer_sync_queue_org_idx" ON "insurer_sync_queue" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "insurer_sync_queue_pending_idx" ON "insurer_sync_queue" USING btree ("org_id","done_at","attempts");--> statement-breakpoint
CREATE UNIQUE INDEX "insurer_sync_queue_pending_ref_idx" ON "insurer_sync_queue" USING btree ("org_id","insurer_id","kind","external_ref") WHERE done_at IS NULL;--> statement-breakpoint
CREATE INDEX "insurer_sync_runs_org_idx" ON "insurer_sync_runs" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "insurer_sync_runs_one_running_idx" ON "insurer_sync_runs" USING btree ("org_id","insurer_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "insurer_sync_state_org_idx" ON "insurer_sync_state" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "insurer_sync_state_code_idx" ON "insurer_sync_state" USING btree ("org_id","insurer_id","producer_code");--> statement-breakpoint
CREATE INDEX "insurers_org_idx" ON "insurers" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "insurers_org_name_idx" ON "insurers" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "insurers_org_key_idx" ON "insurers" USING btree ("org_id","key") WHERE "insurers"."key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "insurers_name_trgm" ON "insurers" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_org_user_idx" ON "members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "members_user_idx" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_templates_org_idx" ON "message_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "policies_org_idx" ON "policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "policies_org_status_idx" ON "policies" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "policies_contact_idx" ON "policies" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "policies_insurer_idx" ON "policies" USING btree ("insurer_id");--> statement-breakpoint
CREATE INDEX "policies_org_enddate_idx" ON "policies" USING btree ("org_id","end_date");--> statement-breakpoint
CREATE INDEX "policies_policy_number_trgm" ON "policies" USING gin ("policy_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "policies_notes_trgm" ON "policies" USING gin ("notes" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "policies_external_ref_idx" ON "policies" USING btree ("org_id","insurer_id","external_ref") WHERE "policies"."external_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "policy_endorsements_org_idx" ON "policy_endorsements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "policy_endorsements_policy_idx" ON "policy_endorsements" USING btree ("policy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_endorsements_policy_number_idx" ON "policy_endorsements" USING btree ("org_id","policy_id","number");--> statement-breakpoint
CREATE INDEX "policy_installments_org_idx" ON "policy_installments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "policy_installments_policy_idx" ON "policy_installments" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "policy_installments_org_due_idx" ON "policy_installments" USING btree ("org_id","due_date");--> statement-breakpoint
CREATE INDEX "policy_parties_org_idx" ON "policy_parties" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "policy_parties_policy_idx" ON "policy_parties" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "policy_parties_contact_idx" ON "policy_parties" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_parties_unique_idx" ON "policy_parties" USING btree ("org_id","policy_id","contact_id","role");--> statement-breakpoint
CREATE INDEX "policy_risks_org_idx" ON "policy_risks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "policy_risks_policy_idx" ON "policy_risks" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "policy_risks_org_patente_idx" ON "policy_risks" USING btree ("org_id","patente");--> statement-breakpoint
CREATE INDEX "policy_risks_descripcion_trgm" ON "policy_risks" USING gin ("descripcion" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "producer_codes_org_idx" ON "producer_codes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "producer_codes_producer_idx" ON "producer_codes" USING btree ("producer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "producer_codes_org_insurer_code_idx" ON "producer_codes" USING btree ("org_id","insurer_id","code");--> statement-breakpoint
CREATE INDEX "producer_intake_links_org_idx" ON "producer_intake_links" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "producer_intake_links_producer_idx" ON "producer_intake_links" USING btree ("producer_id");--> statement-breakpoint
CREATE INDEX "producers_org_idx" ON "producers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "quote_items_org_idx" ON "quote_items" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "quote_items_quote_idx" ON "quote_items" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "quotes_org_idx" ON "quotes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "quotes_org_created_idx" ON "quotes" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "quotes_contact_idx" ON "quotes" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factors_user_idx" ON "two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");