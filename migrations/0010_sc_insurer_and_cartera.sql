-- 0010_sc_insurer_and_cartera — Sync San Cristóbal (docs/rumbo/18-api-b2b-sancristobal.md)
--
-- Ajustes de esquema tras el primer sync real con SC (UAT, jul-2026):
--
--  1. insurers.key — clave canónica estable ('san_cristobal'). La sync resolvía
--     la aseguradora por `name` (frágil a typos/tildes); pasa a resolver por key.
--  2. insurers.organizer_code — código de Organizador de la org EN esa
--     aseguradora ('04-005954'). Es por-aseguradora, NO global (por eso va acá y
--     no en organizations). Lo devuelve SC en la cartera (OrganizerCode) y lo
--     persiste la sync.
--  3. policies.sync_batch_id — se DROPEA: era del modelo de import por lotes; la
--     sync por API (movements-by-date) no usa lotes. 0 referencias en el código.
--
-- (suma_asegurada NO va acá: la columna ya existe; lo que faltaba era mapearla,
--  y eso es cambio de código en src/lib/sc/map.ts, no de esquema.)
--
-- Se aplica a mano contra la branch de Neon (no hay runner):
--
--   psql "$DATABASE_URL" -f migrations/0010_sc_insurer_and_cartera.sql
--
-- Idempotente: se puede correr más de una vez.

ALTER TABLE "insurers" ADD COLUMN IF NOT EXISTS "key" text;
ALTER TABLE "insurers" ADD COLUMN IF NOT EXISTS "organizer_code" text;

-- Backfill de la key para las filas de San Cristóbal ya existentes.
UPDATE "insurers" SET "key" = 'san_cristobal'
 WHERE "key" IS NULL AND lower("name") LIKE 'san crist%';

-- Una key canónica por org (parcial: las aseguradoras sin key no chocan).
CREATE UNIQUE INDEX IF NOT EXISTS "insurers_org_key_idx"
    ON "insurers" ("org_id", "key") WHERE "key" IS NOT NULL;

ALTER TABLE "policies" DROP COLUMN IF EXISTS "sync_batch_id";
