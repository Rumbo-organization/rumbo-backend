# migrations/

Cómo evoluciona el esquema de la base (Postgres / Neon). `src/db/schema.ts` es la
**fuente de verdad**; acá vive el SQL que se aplica a mano (no hay runner de drizzle-kit).

## Dos caminos según el estado de la base

**Base existente (ya tiene el esquema):** los archivos numerados `0001_*.sql … 00NN_*.sql`
son **cambios incrementales**, aplicados en orden. Son idempotentes (`ADD ... IF NOT EXISTS`,
`DO/EXCEPTION` para constraints), así que reaplicarlos no rompe nada.

    node --env-file=../.env scripts/apply-migration.mjs migrations/00NN_nombre.sql

**Base vacía desde cero (branch de Neon nueva):** los numerados NO alcanzan — arrancan en
una feature (`0001_calendar_events`), no crean las tablas base. Para eso están los **DOS**
archivos `_baseline*`, que se aplican **en este orden**:

    node --env-file=../.env scripts/apply-migration.mjs migrations/_baseline.sql
    node --env-file=../.env scripts/apply-migration.mjs migrations/_baseline_security.sql

1. **`_baseline.sql`** — el esquema COMPLETO (36 tablas + índices + FKs + la extensión
   `pg_trgm`) materializado desde `schema.ts`.
2. **`_baseline_security.sql`** — el rol `authenticated`, las funciones de claims
   (`current_org_id()`, `current_user_id()`, `is_org_admin()`, `current_producer_id()`),
   los GRANTs, el `ENABLE ROW LEVEL SECURITY` y todas las policies.

> ⚠️ **Los dos son obligatorios.** `_baseline.sql` lo genera `drizzle-kit`, que sólo emite
> tablas/columnas/índices/FKs: **no puede representar roles, RLS, policies ni funciones SQL**.
> Toda la capa de aislamiento multi-tenant (CLAUDE.md §6, D-018/D-021) siempre vivió como SQL
> escrito a mano dentro de las migraciones incrementales. Una base bootstrapeada sólo con
> `_baseline.sql` queda con las tablas pero **sin nada de seguridad**, y `withAuthedTx` revienta
> en cada request autenticado con `role "authenticated" does not exist` (le pasó a la base de
> producción el 31/07/2026: la app quedó caída para todo usuario logueado).

## Regenerar `_baseline.sql` cuando cambie `schema.ts`

El proyecto no tiene drizzle-kit como dependencia. Se corre puntualmente en un dir aislado
(para no ensuciar el árbol del backend; `schema.ts` es autocontenido: solo importa `drizzle-orm`):

1. Copiar `src/db/schema.ts` a un dir temporal, junto con `drizzle.config.ts`.
2. Ahí: `npm install drizzle-kit@0.31.10 drizzle-orm@0.45.2` (par `latest`/`latest`).
3. `./node_modules/.bin/drizzle-kit generate --name init` → DDL en `out/0000_init.sql`.
4. Prependerle `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (drizzle no emite extensiones) y
   guardarlo como `migrations/_baseline.sql`.

Contrastar contra `schema.ts` con `scripts/schema-drift.ts` para confirmar que no quedó drift.

## Mantener `_baseline_security.sql`

No se autogenera: es SQL a mano. Cada vez que una migración incremental agregue una tabla
nueva con RLS, sumar ahí su GRANT + `ENABLE ROW LEVEL SECURITY` + policies, para que una base
creada desde cero quede igual que una que aplicó todos los incrementos. El archivo refleja el
**estado final**, no el histórico: las definiciones de la era Clerk (`clerk_org_id`,
`clerk_user_id`, tabla `memberships`) quedaron fuera a propósito — esas columnas y tablas
dejaron de existir en el cutover a Better Auth (D-021).
