// Encola pólizas YA CONOCIDAS para que la sync les traiga el detalle de SC.
//
// ── Para qué ─────────────────────────────────────────────────────────────────
//
// La API de SC tiene un límite de DESCUBRIMIENTO, no de RECUPERACIÓN:
//
//   · `portfolio-by-producer-code` devuelve **solo pólizas vigentes**.
//   · `movements-by-date` no acepta fechas de más de 30 días atrás — probado, y
//     el gateway responde: "La fecha de consulta no puede superar los 30 días
//     hacia atrás". Ningún escalonado lo esquiva.
//
// Pero el detalle por nº de póliza **funciona para cualquier póliza**, sin
// importar su estado ni su antigüedad (verificado sobre una anulada que no
// figura en la cartera: devolvió sus 49 campos igual).
//
// Y los números ya los tenemos: el import del export XLSX guarda el N° DE
// PÓLIZA en `external_ref`, en el mismo formato canónico que usa la API
// (`99-99-99-99999999`). Así que el histórico se recupera encolando esos
// números — la cartera y la API son complementarias: **el XLSX descubre, la API
// enriquece**.
//
// ── Costo ────────────────────────────────────────────────────────────────────
//
// SC permite **1 consulta de detalle cada 30 s**, así que esto es lento por
// definición: ~112 pólizas por hora. De ahí que el script vaya por lotes y
// muestre el tiempo estimado antes de encolar nada.
//
// ── Uso ──────────────────────────────────────────────────────────────────────
//
//   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
//     scripts/sc-encolar-historico.ts [--org <uuid>] [--limit 200]
//        [--ramo automotor] [--estado anulada] [--desde 2024-01-01] [--hasta 2025-12-31]
//        [--refrescar-dias 30] [--dry-run]
//
// Por defecto NO encola nada: hay que pasar `--confirmar`. El drenado después
// es el de siempre: `scripts/sc-sync.ts --drain`.

import { and, eq, gte, isNotNull, lte, ne, or, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/client.js';
import { SC_INSURER_NAME } from '../src/sc-sync-job.js';

const { insurerSyncQueue, insurers, policies } = schema;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const orgId = arg('org') ?? process.env.SC_SYNC_ORG_ID;
if (!orgId) throw new Error('Falta la org: --org <uuid> o SC_SYNC_ORG_ID.');

const limit = Number(arg('limit') ?? 200);
/** No re-pedir el detalle de una póliza leída hace menos de N días. */
const refrescarDias = Number(arg('refrescar-dias') ?? 30);
const confirmar = has('confirmar');

const [insurer] = await db
  .select({ id: insurers.id })
  .from(insurers)
  .where(and(eq(insurers.orgId, orgId), eq(insurers.name, SC_INSURER_NAME)))
  .limit(1);
if (!insurer) throw new Error(`La org ${orgId} no tiene la aseguradora "${SC_INSURER_NAME}".`);

// Candidatas: pólizas de SC con nº externo conocido, que no se hayan leído
// hace poco. `last_read_at` null = nunca la trajo la sync (típico del import).
const filtros = [
  eq(policies.orgId, orgId),
  eq(policies.insurerId, insurer.id),
  isNotNull(policies.externalRef),
  or(
    sql`${policies.lastReadAt} IS NULL`,
    lte(policies.lastReadAt, sql`now() - (${refrescarDias} || ' days')::interval`),
  )!,
];
const ramo = arg('ramo');
if (ramo) filtros.push(sql`${policies.ramo}::text = ${ramo}`);
const estado = arg('estado');
if (estado) filtros.push(sql`${policies.status}::text = ${estado}`);
const desde = arg('desde');
if (desde) filtros.push(gte(policies.endDate, desde));
const hasta = arg('hasta');
if (hasta) filtros.push(lte(policies.endDate, hasta));
// Nunca encolar algo que ya está pendiente: el índice único parcial lo
// rechazaría igual, pero así el conteo que se reporta es el real.
filtros.push(
  sql`NOT EXISTS (SELECT 1 FROM insurer_sync_queue q
        WHERE q.org_id = ${orgId} AND q.insurer_id = ${insurer.id}
          AND q.kind = 'policy' AND q.external_ref = ${policies.externalRef}
          AND q.done_at IS NULL)`,
);

// Las más recientes primero: son las que el PAS mira. Lo viejo puede esperar.
const candidatas = await db
  .select({ ref: policies.externalRef, ramo: policies.ramo, estado: policies.status, fin: policies.endDate })
  .from(policies)
  .where(and(...filtros))
  .orderBy(sql`${policies.endDate} DESC NULLS LAST`)
  .limit(limit);

const totalSinLimite = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(policies)
  .where(and(...filtros));

const horas = (candidatas.length * 32) / 3600;
console.log(`Org ${orgId} · aseguradora ${SC_INSURER_NAME}`);
console.log(`Candidatas totales (sin --limit): ${totalSinLimite[0]!.n}`);
console.log(`Este lote: ${candidatas.length} pólizas · ~${horas.toFixed(1)} h de drenado a 1 cada 30 s`);

if (candidatas.length === 0) {
  console.log('Nada para encolar.');
  process.exit(0);
}

const porRamo = new Map<string, number>();
for (const c of candidatas) porRamo.set(c.ramo, (porRamo.get(c.ramo) ?? 0) + 1);
console.log('Por ramo:', [...porRamo].map(([r, n]) => `${r}:${n}`).join('  '));
console.log(`Rango de vencimiento: ${candidatas.at(-1)?.fin ?? '?'} … ${candidatas[0]?.fin ?? '?'}`);

// El formato del nº importa: si no es el canónico de SC, el ruteo por ramo no
// puede leer el ramo (3er segmento) y el detalle falla póliza por póliza.
const raros = candidatas.filter(c => !/^\d{2}-\d{2}-\d{2}-\d+/.test(c.ref ?? ''));
if (raros.length) {
  console.log(`\n⚠️  ${raros.length} con nº fuera del formato 99-99-99-99999999 — el ruteo por ramo va a fallar:`);
  for (const r of raros.slice(0, 5)) console.log(`     ${r.ref}`);
}

if (!confirmar) {
  console.log('\n(simulación) Nada encolado. Agregá --confirmar para hacerlo.');
  process.exit(0);
}

const insertadas = await db
  .insert(insurerSyncQueue)
  .values(
    candidatas.map(c => ({
      orgId,
      insurerId: insurer.id,
      kind: 'policy' as const,
      externalRef: c.ref!,
      reason: 'historico',
    })),
  )
  .onConflictDoNothing()
  .returning({ id: insurerSyncQueue.id });

const pendientes = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(insurerSyncQueue)
  .where(
    and(
      eq(insurerSyncQueue.orgId, orgId),
      eq(insurerSyncQueue.insurerId, insurer.id),
      sql`${insurerSyncQueue.doneAt} IS NULL`,
    ),
  );

console.log(`\n✅ Encoladas ${insertadas.length}. Cola pendiente: ${pendientes[0]!.n}`);
console.log('Drenar con: scripts/sc-sync.ts --mode backfill --drain --budget-min 45');
process.exit(0);
