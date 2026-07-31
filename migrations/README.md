# migrations/

Cómo evoluciona el esquema de la base (Postgres / Neon). `src/db/schema.ts` es la
**fuente de verdad**; acá vive el SQL que se aplica a mano (no hay runner de drizzle-kit).

## Dos caminos según el estado de la base

**Base existente (ya tiene el esquema):** los archivos numerados `0001_*.sql … 00NN_*.sql`
son **cambios incrementales**, aplicados en orden. Son idempotentes (`ADD ... IF NOT EXISTS`,
`DO/EXCEPTION` para constraints), así que reaplicarlos no rompe nada.

    node --env-file=../.env scripts/apply-migration.mjs migrations/00NN_nombre.sql

**Base vacía desde cero (branch de Neon nueva):** los numerados NO alcanzan — arrancan en
una feature (`0001_calendar_events`), no crean las tablas base. Para eso está **`_baseline.sql`**:
el esquema COMPLETO (36 tablas + índices + FKs + la extensión `pg_trgm`) materializado desde
`schema.ts`. Equivale a aplicar 0001→00NN sobre una base vacía.

    node --env-file=../.env scripts/apply-migration.mjs migrations/_baseline.sql

## Regenerar `_baseline.sql` cuando cambie `schema.ts`

El proyecto no tiene drizzle-kit como dependencia. Se corre puntualmente en un dir aislado
(para no ensuciar el árbol del backend; `schema.ts` es autocontenido: solo importa `drizzle-orm`):

1. Copiar `src/db/schema.ts` a un dir temporal, junto con `drizzle.config.ts`.
2. Ahí: `npm install drizzle-kit@0.31.10 drizzle-orm@0.45.2` (par `latest`/`latest`).
3. `./node_modules/.bin/drizzle-kit generate --name init` → DDL en `out/0000_init.sql`.
4. Prependerle `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (drizzle no emite extensiones) y
   guardarlo como `migrations/_baseline.sql`.

Contrastar contra `schema.ts` con `scripts/schema-drift.ts` para confirmar que no quedó drift.
