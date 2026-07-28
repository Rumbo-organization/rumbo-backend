// CLI de la sync con San Cristóbal — el mismo job que corre el cron, pero sin
// el techo de tiempo de una función serverless.
//
// Sirve para dos cosas que el cron no puede hacer:
//   · el **backfill inicial** (la cartera vigente entera: a 2 req/s son minutos,
//     no segundos);
//   · **forzar una pasada** cuando se quiere ver el resultado en el momento.
//
// Uso:
//   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
//     scripts/sc-sync.ts [--mode backfill|incremental] [--org <uuid>]
//                        [--codes 04-006223,04-006164] [--limit 10]
//                        [--budget-min 30] [--dry-run]
//
// `--dry-run` lee de SC y cuenta lo que haría, sin escribir una sola fila.

import { runScSync, type SyncMode } from '../src/sc-sync-job.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = (arg('mode') ?? 'backfill') as SyncMode;
if (mode !== 'backfill' && mode !== 'incremental') throw new Error(`--mode inválido: ${mode}`);

const budgetMin = Number(arg('budget-min') ?? 30);
const limit = arg('limit') ? Number(arg('limit')) : undefined;
const codes = arg('codes')
  ?.split(',')
  .map(c => c.trim())
  .filter(Boolean);
const dryRun = process.argv.includes('--dry-run');

console.log(`Sync SC · modo=${mode} · presupuesto=${budgetMin}min${dryRun ? ' · DRY RUN' : ''}`);
if (codes) console.log(`Códigos: ${codes.join(', ')}`);

const started = Date.now();
const result = await runScSync({
  mode,
  orgId: arg('org'),
  budgetMs: budgetMin * 60_000,
  onlyCodes: codes,
  limit,
  dryRun,
});

console.log(`\nCorrida ${result.runId ?? '(dry-run)'} — ${Math.round((Date.now() - started) / 1000)}s`);
console.log('Contadores:', result.counters);
if (result.tripped.length) console.log('Breaker abierto en:', result.tripped.join(', '));
if (result.notes.length) {
  console.log(`Notas (${result.notes.length}):`);
  for (const n of result.notes.slice(0, 20)) console.log('  ·', n);
  if (result.notes.length > 20) console.log(`  … y ${result.notes.length - 20} más`);
}
process.exit(0);
