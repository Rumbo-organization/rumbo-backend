-- 0011_insurer_catalogs — catálogos de la aseguradora, cacheados de nuestro lado
--
-- **El problema que resuelve.** El formulario de cotización necesita los códigos
-- con los que habla la compañía (la provincia viaja como `AR_13`, el uso como
-- `Personal`). Hasta ahora se los pedía a San Cristóbal EN VIVO, en cada
-- apertura del formulario: dos llamadas antes de que el productor tipeara nada.
-- Eso ata abrir un formulario a que la API de un tercero esté arriba — y la de
-- SC tarda decenas de segundos, tiene cuota y ya nos bloqueó el acceso una vez
-- (doc 18 §6.1.1). Cacheados, el formulario abre aunque SC esté caído.
--
-- **Por qué no lleva `org_id`.** Es dato de referencia de la INTEGRACIÓN, no del
-- inquilino: el catálogo de San Cristóbal es el mismo para todas las orgs. Por
-- eso la clave es `provider` y no `insurer_id` — `insurers` es una tabla por-org
-- (cada organización tiene su propia fila "San Cristóbal") y colgar de ahí
-- duplicaría ~700 valores por organización sin ninguna razón.
--
-- La RLS lo refleja: **lectura para todos los autenticados, escritura para
-- nadie**. El refresco corre como owner (`db` sin `set_config('role',…)`), que
-- no pasa por las policies. No hay superficie de escritura desde la API.
--
-- Se aplica a mano contra la branch de Neon (no hay runner):
--
--   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
--     scripts/apply-migration.mjs migrations/0011_insurer_catalogs.sql
--
-- Idempotente: se puede correr más de una vez.

CREATE TABLE IF NOT EXISTS "insurer_catalogs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "kind" text NOT NULL,
  "code" text NOT NULL,
  "label" text NOT NULL,
  "sort" integer DEFAULT 0 NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- El upsert del refresco entra por acá: (integración, catálogo, código).
CREATE UNIQUE INDEX IF NOT EXISTS "insurer_catalogs_value_idx"
  ON "insurer_catalogs" USING btree ("provider","kind","code");
-- Lectura del formulario: un catálogo entero, en el orden que lo dio la compañía.
CREATE INDEX IF NOT EXISTS "insurer_catalogs_kind_idx"
  ON "insurer_catalogs" USING btree ("provider","kind","sort");

-- Solo SELECT: `authenticated` no tiene por dónde escribir un catálogo.
GRANT SELECT ON insurer_catalogs TO authenticated;
ALTER TABLE "insurer_catalogs" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_all" ON insurer_catalogs;
CREATE POLICY "read_all" ON insurer_catalogs
  FOR SELECT TO authenticated
  USING (true);
