-- 0011_vehicle_catalog — catálogo de marcas y modelos, de datos abiertos
--
-- **El problema que resuelve.** El selector de vehículo salía de la cartera ya
-- sincronizada: solo ofrecía autos que el productor YA asegura. Para cotizarle a
-- alguien que trae un auto nuevo —la mitad del trabajo— no había catálogo.
--
-- **De dónde salen los datos.** DNRPA, datos abiertos (datos.jus.gob.ar):
-- inscripciones iniciales + transferencias. Licencia abierta citando la fuente.
-- Dos meses dan ~580 marcas y ~15.400 marca+modelo, con años de 1925 a 2027.
--
-- **Estos códigos NO cotizan.** Son de la DNRPA, no de Infoauto. El padrón de
-- Infoauto es un producto licenciado al que no tenemos acceso, y la API de las
-- aseguradoras pide ese código y ningún otro. Esta tabla sirve para identificar
-- y buscar el vehículo; el precio se carga a mano.
--
-- Sin `org_id`: dato público de referencia, igual para todas las orgs. RLS de
-- lectura para todo autenticado, escritura solo del cargador (corre como owner).
--
-- Se aplica a mano contra la branch de Neon (no hay runner):
--
--   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
--     scripts/apply-migration.mjs migrations/0011_vehicle_catalog.sql
--
-- Idempotente: se puede correr más de una vez.

CREATE TABLE IF NOT EXISTS "vehicle_catalog" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "marca_codigo" text,
  "marca" text NOT NULL,
  "modelo_codigo" text,
  "modelo" text NOT NULL,
  "tipo" text,
  "anio_desde" integer,
  "anio_hasta" integer,
  "frecuencia" integer DEFAULT 0 NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- El upsert del cargador entra por acá.
CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_catalog_value_idx"
  ON "vehicle_catalog" USING btree ("provider","marca","modelo");
-- Cascada: modelos de una marca.
CREATE INDEX IF NOT EXISTS "vehicle_catalog_marca_idx"
  ON "vehicle_catalog" USING btree ("provider","marca");
-- Búsqueda por texto suelto ("corolla xei"). pg_trgm ya está instalado (0002).
CREATE INDEX IF NOT EXISTS "vehicle_catalog_trgm_idx"
  ON "vehicle_catalog" USING gin ((marca || ' ' || modelo) gin_trgm_ops);

GRANT SELECT ON vehicle_catalog TO authenticated;
ALTER TABLE "vehicle_catalog" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_all" ON vehicle_catalog;
CREATE POLICY "read_all" ON vehicle_catalog
  FOR SELECT TO authenticated
  USING (true);
