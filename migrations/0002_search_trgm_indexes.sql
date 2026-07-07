-- 0002_search_trgm_indexes — Búsqueda por substring a escala (Fase 1 escalabilidad)
--
-- El endpoint paginado GET /api/v1/policies busca con ILIKE '%q%' (comodín inicial)
-- sobre nº de póliza, notas, nombre del contacto y aseguradora. Un índice btree no
-- sirve para el comodín inicial → seq scan. pg_trgm + GIN indexa trigramas y hace
-- que ese ILIKE use índice. A ~10k filas el seq scan es tolerable; esto lo prepara
-- para 100k+ (cliente organizador). Ver roadmap/PLAN-ESCALABILIDAD.md.
--
-- Los índices de orden/filtro/paginación (org_id, end_date, status, contact_id,
-- insurer_id) y los policy_id de las subconsultas (claims, installments, risks) YA
-- existen en el schema; esta migración agrega SOLO los de búsqueda.
--
-- Aplicar a mano contra la branch de Neon (el backend no corre migraciones):
--
--   psql "$DATABASE_URL" -f migrations/0002_search_trgm_indexes.sql
--
-- Idempotente: CREATE ... IF NOT EXISTS, se puede correr más de una vez.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Pólizas: nº y notas (nota: también acelera el filtro "flota" sobre notes).
CREATE INDEX IF NOT EXISTS "policies_policy_number_trgm"
  ON "policies" USING gin ("policy_number" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "policies_notes_trgm"
  ON "policies" USING gin ("notes" gin_trgm_ops);

-- Contacto (join de búsqueda por nombre del titular).
CREATE INDEX IF NOT EXISTS "contacts_first_name_trgm"
  ON "contacts" USING gin ("first_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "contacts_last_name_trgm"
  ON "contacts" USING gin ("last_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "contacts_legal_name_trgm"
  ON "contacts" USING gin ("legal_name" gin_trgm_ops);

-- Aseguradora (join de búsqueda por nombre).
CREATE INDEX IF NOT EXISTS "insurers_name_trgm"
  ON "insurers" USING gin ("name" gin_trgm_ops);

-- Filtro "flota": descripción del riesgo.
CREATE INDEX IF NOT EXISTS "policy_risks_descripcion_trgm"
  ON "policy_risks" USING gin ("descripcion" gin_trgm_ops);
