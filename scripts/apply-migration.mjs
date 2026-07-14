// apply-migration.mjs — aplica un archivo .sql contra la DB (branch de Neon).
//
//   node --env-file=../.env scripts/apply-migration.mjs migrations/000X_nombre.sql
//
// Las migraciones del repo son idempotentes (ADD ... IF NOT EXISTS, DO/EXCEPTION
// para constraints), así que se pueden reaplicar sin efectos. Corre el archivo
// entero (varios statements DDL separados por ';') en una sola llamada.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const file = process.argv[2];
if (!file) {
  console.error('Uso: node --env-file=../.env scripts/apply-migration.mjs <archivo.sql>');
  process.exit(1);
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Falta DATABASE_URL en el entorno (pasá --env-file=../.env).');
  process.exit(1);
}

const sql = readFileSync(file, 'utf8');
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query(sql);
  console.log(`✓ aplicada: ${file}`);
} catch (err) {
  console.error(`✗ error aplicando ${file}:`, err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
