// Chequeo de drift schema.ts ↔ DB real (information_schema). Uso:
//   pnpm tsx scripts/schema-drift.ts
import { getTableConfig } from 'drizzle-orm/pg-core';

import { pool } from '../src/db.js';
import * as schema from '../src/db/schema.js';

const tables = Object.values(schema).filter(
  (v): v is Parameters<typeof getTableConfig>[0] =>
    typeof v === 'object' && v != null && Symbol.for('drizzle:IsDrizzleTable') in v,
);

const { rows } = await pool.query<{ table_name: string; column_name: string }>(
  `select table_name, column_name from information_schema.columns where table_schema='public'`,
);
const dbCols = new Map<string, Set<string>>();
for (const r of rows) {
  (dbCols.get(r.table_name) ?? dbCols.set(r.table_name, new Set()).get(r.table_name)!).add(r.column_name);
}

let drift = 0;
for (const t of tables) {
  const cfg = getTableConfig(t);
  const inDb = dbCols.get(cfg.name);
  if (!inDb) {
    console.log(`TABLE MISSING in DB: ${cfg.name}`);
    drift++;
    continue;
  }
  const inSchema = new Set(cfg.columns.map((c) => c.name));
  for (const c of inSchema) if (!inDb.has(c)) { console.log(`${cfg.name}: schema-only column '${c}' (DB no la tiene)`); drift++; }
  for (const c of inDb) if (!inSchema.has(c)) { console.log(`${cfg.name}: db-only column '${c}' (schema no la tiene)`); drift++; }
}
console.log(drift === 0 ? 'OK sin drift' : `${drift} drifts`);
await pool.end();
