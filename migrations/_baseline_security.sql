-- ============================================================================
-- Bootstrap de la capa de seguridad (rol + funciones RLS + grants + policies)
-- para una base creada desde `migrations/_baseline.sql`.
--
-- POR QUÉ EXISTE: `_baseline.sql` se genera con drizzle-kit desde schema.ts, y
-- drizzle-kit solo emite tablas/columnas/índices/FKs. Todo el aislamiento
-- multi-tenant (CLAUDE.md §6, D-018/D-021) vivía como SQL escrito a mano dentro
-- de las migraciones incrementales — las viejas de `rumbo/app/drizzle/` (0000-0052)
-- y las de `rumbo-backend/migrations/` (0001-0011). Una base bootstrapeada solo
-- con el baseline queda SIN rol `authenticated`, SIN funciones de claims y SIN
-- policies ⇒ `withAuthedTx` revienta con `role "authenticated" does not exist`.
--
-- QUÉ ES: el ESTADO FINAL de esa capa, no el replay histórico. Las definiciones
-- intermedias (Clerk / auth.session / clerk_org_id / clerk_user_id, tabla
-- `memberships`) se omiten: sus columnas y tablas ya no existen post-D-021.
--
-- ORDEN: rol → funciones → grants → enable RLS → policies. Las policies
-- referencian las funciones, así que las funciones van primero.
--
-- IDEMPOTENTE: se puede correr más de una vez.
--
-- Se aplica DESPUÉS de `_baseline.sql` (ver README.md de esta carpeta):
--
--   node --env-file=../.env scripts/apply-migration.mjs migrations/_baseline_security.sql
-- ============================================================================

-- ── 1. Rol `authenticated` ───────────────────────────────────────────────────
-- withAuthedTx (src/db/client.ts) hace SET LOCAL role = 'authenticated' dentro
-- de la transacción; el owner de la conexión debe poder asumirlo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  EXECUTE format('GRANT authenticated TO %I', current_user);
END
$$;

GRANT USAGE ON SCHEMA public TO authenticated;

-- ── 2. Funciones de claims (estado final: Better Auth, D-021) ────────────────
-- Contrato de claims que publica withAuthedTx en request.jwt.claims:
--   sub  → current_user_id()      (users.id)
--   o.id → current_org_id()       (organizations.id)
--   r    → is_org_admin()         ('owner' ve toda la org)
--   p    → current_producer_id()  (producer_scope)

CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT (
    nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'o' ->> 'id'
  )::uuid
$$;

DROP FUNCTION IF EXISTS current_user_id();
CREATE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT (
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

CREATE OR REPLACE FUNCTION public.current_producer_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT (
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'p'
  )::uuid
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'r',
    ''
  ) = 'owner'
$$;

-- Búsqueda de contactos insensible a acentos (0005 vieja). El baseline no trae
-- ni la extensión ni el índice por expresión.
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path = pg_catalog, public
  AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

CREATE INDEX IF NOT EXISTS "contacts_name_trgm_idx" ON contacts USING gin (
  f_unaccent(
    lower(
      coalesce(first_name, '') || ' ' ||
      coalesce(last_name, '') || ' ' ||
      coalesce(legal_name, '')
    )
  ) gin_trgm_ops
);

-- ── 3. Grants por tabla ──────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON insurers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON policies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON claims TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON claim_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_installments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON communications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_risks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON producers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON producer_codes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_endorsements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_parties TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_relationships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_addresses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_assignees TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON quotes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON quote_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON message_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON producer_intake_links TO authenticated;
-- claim_intakes: INSERT lo agrega el Modo B (NEW/0007) sobre el SELECT/UPDATE
-- que daba NEW/0005.
GRANT SELECT, INSERT, UPDATE ON claim_intakes TO authenticated;
-- Solo lectura: los escribe el cliente owner (sync / catálogos).
GRANT SELECT ON insurer_sync_state TO authenticated;
GRANT SELECT ON insurer_sync_queue TO authenticated;
GRANT SELECT ON insurer_sync_runs TO authenticated;
GRANT SELECT ON insurer_catalogs TO authenticated;

-- ── 4. Habilitar RLS ─────────────────────────────────────────────────────────
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurers ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_risks ENABLE ROW LEVEL SECURITY;
ALTER TABLE producers ENABLE ROW LEVEL SECURITY;
ALTER TABLE producer_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_endorsements ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE producer_intake_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurer_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurer_sync_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurer_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurer_catalogs ENABLE ROW LEVEL SECURITY;
-- Fail-closed total: RLS habilitada SIN policies ni grants (solo cliente owner).
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE two_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE expiry_notifications ENABLE ROW LEVEL SECURITY;

-- ── 5. Policies: tenant_isolation (aislamiento por organización) ─────────────
DROP POLICY IF EXISTS "tenant_isolation" ON organizations;
CREATE POLICY "tenant_isolation" ON organizations
  FOR ALL TO authenticated
  USING (id = current_org_id())
  WITH CHECK (id = current_org_id());

DROP POLICY IF EXISTS "self_isolation" ON users;
CREATE POLICY "self_isolation" ON users
  FOR ALL TO authenticated
  USING (id = current_user_id())
  WITH CHECK (id = current_user_id());

-- Lectura ampliada: ver co-miembros de la propia org (picker de responsables,
-- actor del audit log). Se combina con OR sobre self_isolation.
DROP POLICY IF EXISTS "org_members_visible" ON users;
CREATE POLICY "org_members_visible" ON users
  FOR SELECT TO authenticated
  USING (id IN (SELECT user_id FROM members WHERE org_id = current_org_id()));

DROP POLICY IF EXISTS "tenant_isolation" ON members;
CREATE POLICY "tenant_isolation" ON members
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON audit_log;
CREATE POLICY "tenant_isolation" ON audit_log
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON contacts;
CREATE POLICY "tenant_isolation" ON contacts
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON insurers;
CREATE POLICY "tenant_isolation" ON insurers
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON policies;
CREATE POLICY "tenant_isolation" ON policies
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON claims;
CREATE POLICY "tenant_isolation" ON claims
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON claim_events;
CREATE POLICY "tenant_isolation" ON claim_events
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON policy_installments;
CREATE POLICY "tenant_isolation" ON policy_installments
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON communications;
CREATE POLICY "tenant_isolation" ON communications
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON policy_risks;
CREATE POLICY "tenant_isolation" ON policy_risks
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON producers;
CREATE POLICY "tenant_isolation" ON producers
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON producer_codes;
CREATE POLICY "tenant_isolation" ON producer_codes
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON policy_endorsements;
CREATE POLICY "tenant_isolation" ON policy_endorsements
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON policy_parties;
CREATE POLICY "tenant_isolation" ON policy_parties
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON contact_relationships;
CREATE POLICY "tenant_isolation" ON contact_relationships
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON contact_addresses;
CREATE POLICY "tenant_isolation" ON contact_addresses
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON contact_assignees;
CREATE POLICY "tenant_isolation" ON contact_assignees
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON quotes;
CREATE POLICY "tenant_isolation" ON quotes
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON quote_items;
CREATE POLICY "tenant_isolation" ON quote_items
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON documents;
CREATE POLICY "tenant_isolation" ON documents
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON message_templates;
CREATE POLICY "tenant_isolation" ON message_templates
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON calendar_events;
CREATE POLICY "tenant_isolation" ON calendar_events
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON producer_intake_links;
CREATE POLICY "tenant_isolation" ON producer_intake_links
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON claim_intakes;
CREATE POLICY "tenant_isolation" ON claim_intakes
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON insurer_sync_state;
CREATE POLICY "tenant_isolation" ON insurer_sync_state
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON insurer_sync_queue;
CREATE POLICY "tenant_isolation" ON insurer_sync_queue
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

DROP POLICY IF EXISTS "tenant_isolation" ON insurer_sync_runs;
CREATE POLICY "tenant_isolation" ON insurer_sync_runs
  FOR ALL TO authenticated
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

-- Catálogos de aseguradora: compartidos, lectura para cualquier autenticado.
DROP POLICY IF EXISTS "read_all" ON insurer_catalogs;
CREATE POLICY "read_all" ON insurer_catalogs
  FOR SELECT TO authenticated
  USING (true);

-- ── 6. Policies: producer_scope (RESTRICTIVE, se AND-ea con tenant_isolation) ─
-- El organizador (member role 'owner') ve toda la org; un productor ve solo su
-- cartera. Las tablas hijas usan EXISTS(padre): la RLS del padre se aplica
-- dentro de la subquery, así que heredan su visibilidad sin duplicar la regla.

DROP POLICY IF EXISTS "producer_scope" ON policies;
CREATE POLICY "producer_scope" ON policies
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (is_org_admin() OR producer_id = current_producer_id())
  WITH CHECK (is_org_admin() OR producer_id = current_producer_id());

-- Lectura: dueño del contacto O tiene una póliza suya (asegurado compartido).
-- Escritura: solo el dueño.
DROP POLICY IF EXISTS "producer_scope" ON contacts;
CREATE POLICY "producer_scope" ON contacts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    is_org_admin()
    OR producer_id = current_producer_id()
    OR EXISTS (
      SELECT 1 FROM policies po
      WHERE po.contact_id = contacts.id
        AND po.producer_id = current_producer_id()
    )
  )
  WITH CHECK (is_org_admin() OR producer_id = current_producer_id());

DROP POLICY IF EXISTS "producer_scope" ON claims;
CREATE POLICY "producer_scope" ON claims
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM policies po WHERE po.id = claims.policy_id))
  WITH CHECK (EXISTS (SELECT 1 FROM policies po WHERE po.id = claims.policy_id));

DROP POLICY IF EXISTS "producer_scope" ON claim_events;
CREATE POLICY "producer_scope" ON claim_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM claims c WHERE c.id = claim_events.claim_id))
  WITH CHECK (EXISTS (SELECT 1 FROM claims c WHERE c.id = claim_events.claim_id));

DROP POLICY IF EXISTS "producer_scope" ON policy_installments;
CREATE POLICY "producer_scope" ON policy_installments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM policies po WHERE po.id = policy_installments.policy_id))
  WITH CHECK (EXISTS (SELECT 1 FROM policies po WHERE po.id = policy_installments.policy_id));

DROP POLICY IF EXISTS "producer_scope" ON policy_endorsements;
CREATE POLICY "producer_scope" ON policy_endorsements
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM policies po WHERE po.id = policy_endorsements.policy_id))
  WITH CHECK (EXISTS (SELECT 1 FROM policies po WHERE po.id = policy_endorsements.policy_id));

DROP POLICY IF EXISTS "producer_scope" ON policy_parties;
CREATE POLICY "producer_scope" ON policy_parties
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM policies po WHERE po.id = policy_parties.policy_id))
  WITH CHECK (EXISTS (SELECT 1 FROM policies po WHERE po.id = policy_parties.policy_id));

DROP POLICY IF EXISTS "producer_scope" ON policy_risks;
CREATE POLICY "producer_scope" ON policy_risks
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM policies po WHERE po.id = policy_risks.policy_id))
  WITH CHECK (EXISTS (SELECT 1 FROM policies po WHERE po.id = policy_risks.policy_id));

DROP POLICY IF EXISTS "producer_scope" ON communications;
CREATE POLICY "producer_scope" ON communications
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM contacts c WHERE c.id = communications.contact_id))
  WITH CHECK (EXISTS (SELECT 1 FROM contacts c WHERE c.id = communications.contact_id));

DROP POLICY IF EXISTS "producer_scope" ON contact_addresses;
CREATE POLICY "producer_scope" ON contact_addresses
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_addresses.contact_id))
  WITH CHECK (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_addresses.contact_id));

DROP POLICY IF EXISTS "producer_scope" ON contact_relationships;
CREATE POLICY "producer_scope" ON contact_relationships
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_relationships.contact_id))
  WITH CHECK (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_relationships.contact_id));

DROP POLICY IF EXISTS "producer_scope" ON contact_assignees;
CREATE POLICY "producer_scope" ON contact_assignees
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_assignees.contact_id))
  WITH CHECK (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_assignees.contact_id));

-- Documentos: polimórfica (póliza XOR contacto).
DROP POLICY IF EXISTS "producer_scope" ON documents;
CREATE POLICY "producer_scope" ON documents
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    (documents.policy_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM policies po WHERE po.id = documents.policy_id))
    OR (documents.contact_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = documents.contact_id))
  )
  WITH CHECK (
    (documents.policy_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM policies po WHERE po.id = documents.policy_id))
    OR (documents.contact_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = documents.contact_id))
  );

DROP POLICY IF EXISTS "producer_scope" ON quotes;
CREATE POLICY "producer_scope" ON quotes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (is_org_admin() OR producer_id = current_producer_id())
  WITH CHECK (is_org_admin() OR producer_id = current_producer_id());

DROP POLICY IF EXISTS "producer_scope" ON quote_items;
CREATE POLICY "producer_scope" ON quote_items
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_items.quote_id))
  WITH CHECK (EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_items.quote_id));

-- Actividad: el productor ve solo lo que hizo él; el organizador, todo.
DROP POLICY IF EXISTS "producer_scope" ON audit_log;
CREATE POLICY "producer_scope" ON audit_log
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (is_org_admin() OR user_id = current_user_id())
  WITH CHECK (is_org_admin() OR user_id = current_user_id());

DROP POLICY IF EXISTS "producer_scope" ON calendar_events;
CREATE POLICY "producer_scope" ON calendar_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (is_org_admin() OR producer_id = current_producer_id())
  WITH CHECK (is_org_admin() OR producer_id = current_producer_id());

DROP POLICY IF EXISTS "producer_scope" ON producer_intake_links;
CREATE POLICY "producer_scope" ON producer_intake_links
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (is_org_admin() OR producer_id = current_producer_id())
  WITH CHECK (is_org_admin() OR producer_id = current_producer_id());

DROP POLICY IF EXISTS "producer_scope" ON claim_intakes;
CREATE POLICY "producer_scope" ON claim_intakes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (is_org_admin() OR producer_id = current_producer_id())
  WITH CHECK (is_org_admin() OR producer_id = current_producer_id());
