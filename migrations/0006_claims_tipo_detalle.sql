-- 0006_claims_tipo_detalle — Pre-denuncias, Slice 2 (docs/rumbo/17-pre-denuncias.md)
--
-- Columna aditiva: el tipo específico del catálogo de pre-denuncias
-- ("Accidente in itinere", "Granizo con pérdida total") que la conversión
-- persiste en el siniestro. `tipo` sigue siendo el bucket grueso (enum
-- claim_type) para filtros/analytics.
--
-- Se aplica a mano contra la branch de Neon (no hay runner):
--
--   psql "$DATABASE_URL" -f migrations/0006_claims_tipo_detalle.sql
--
-- Idempotente: se puede correr más de una vez.

ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "tipo_detalle" text;
