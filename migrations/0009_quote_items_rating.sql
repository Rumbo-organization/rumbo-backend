-- 0009_quote_items_rating — cotización en vivo contra la aseguradora (E3)
--
-- `quote_items` se diseñó para carga MANUAL: el PAS cotizaba en el portal de
-- cada compañía y transcribía la cuota. Con el rating por API (San Cristóbal,
-- `Quoted/QuoteCA7`) llegan dos cosas que esa forma no contempla:
--
--  · **prima y premio por separado.** La carga manual usa solo `cuota`, que es
--    lo que se compara; la API distingue el riesgo puro del total con impuestos.
--
--  · **la franquicia como parte de la IDENTIDAD de la opción.** San Cristóbal
--    devuelve CUATRO filas de Todo Riesgo para el mismo `ProductCode`, que solo
--    se diferencian por la franquicia (2,5% / 3,5% / 5,0% / 7,5%) y tienen
--    precios distintos. Sin esta columna, las cuatro se ven iguales en la matriz
--    de comparación y no hay forma de elegir.
--
-- Aditiva y nullable: no toca la carga manual ni las filas existentes.
--
-- Se aplica a mano contra la branch de Neon (no hay runner):
--
--   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
--     scripts/apply-migration.mjs migrations/0009_quote_items_rating.sql
--
-- Idempotente: se puede correr más de una vez.

ALTER TABLE "quote_items" ADD COLUMN IF NOT EXISTS "prima" numeric(14, 2);
ALTER TABLE "quote_items" ADD COLUMN IF NOT EXISTS "premio" numeric(14, 2);
ALTER TABLE "quote_items" ADD COLUMN IF NOT EXISTS "deductible" text;

-- Sin cambios de RLS: `quote_items` ya tiene su policy de aislamiento por org
-- desde la migración que la creó. Agregar columnas no la altera.
