// Reejecuta la escritura de la sync con los payloads YA guardados en
// `policies.external_raw`, sin pegarle a San Cristóbal.
//
// Para qué: la propiedad que más importa de la sync es que **correrla dos veces
// no cambie nada**. Verificarlo con la API de por medio es lento (~30 s por
// póliza) y depende de que SC esté disponible — cuando nos bloquearon el gateway
// quedó sin poder probarse. Como el payload crudo se persiste (O-64), la
// escritura se puede replayear offline: mismos datos de entrada, mismo código,
// y se comparan los conteos antes y después.
//
// No reemplaza a la verificación end-to-end: no ejercita el cliente HTTP, el
// ruteo por ramo ni los feeds. Cubre exactamente el mapeo y los upserts.
//
// Uso:
//   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
//     scripts/sc-replay.ts [--org <uuid>]

import { and, eq, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/client.js';
import { replayStoredPolicies } from '../src/sc-sync-job.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const orgId = arg('org') ?? process.env.SC_SYNC_ORG_ID;
if (!orgId) throw new Error('Falta la org: pasá --org <uuid> o seteá SC_SYNC_ORG_ID.');

const TABLES = ['contacts', 'policies', 'policy_installments', 'policy_endorsements', 'policy_risks'] as const;

async function snapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await db.execute<{ n: string }>(
      sql.raw(`select count(*)::text as n from ${t} where org_id = '${orgId}'`),
    );
    out[t] = Number(r.rows[0]!.n);
  }
  return out;
}

// Huella del contenido, no solo del conteo: un replay podría mantener la
// cantidad de filas y aun así reescribir valores. Se excluyen las columnas que
// SÍ deben moverse en cada corrida (`last_read_at`, `updated_at`).
async function fingerprint(): Promise<string> {
  const r = await db.execute<{ h: string }>(sql`
    SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
      SELECT concat_ws(':', policy_number, status, ramo, prima, premio, start_date, end_date,
                       cancel_reason, payment_method) AS x
        FROM policies WHERE org_id = ${orgId}
      UNION ALL
      SELECT concat_ws(':', pi.policy_id::text, pi.number::text, pi.due_date::text, pi.amount)
        FROM policy_installments pi WHERE pi.org_id = ${orgId}
      UNION ALL
      SELECT concat_ws(':', pe.policy_id::text, pe.number::text, pe.type::text, pe.prima, pe.premio)
        FROM policy_endorsements pe WHERE pe.org_id = ${orgId}
    ) s`);
  return r.rows[0]?.h ?? '(vacío)';
}

const before = await snapshot();
const hashBefore = await fingerprint();
console.log('Antes: ', JSON.stringify(before));

const stored = await db
  .select({ raw: schema.policies.externalRaw, number: schema.policies.policyNumber })
  .from(schema.policies)
  .where(and(eq(schema.policies.orgId, orgId), eq(schema.policies.source, 'sync')));
console.log(`Replayeando ${stored.length} pólizas guardadas…`);

const result = await replayStoredPolicies(orgId, stored.map(s => s.raw as Record<string, unknown>).filter(Boolean));

const after = await snapshot();
const hashAfter = await fingerprint();
console.log('Después:', JSON.stringify(after));
console.log('Contadores:', result.counters);

const drift = TABLES.filter(t => before[t] !== after[t]).map(t => `${t}: ${before[t]} → ${after[t]}`);
const sameHash = hashBefore === hashAfter;

if (drift.length === 0 && sameHash) {
  console.log('\n✅ IDEMPOTENTE: ni los conteos ni el contenido se movieron.');
} else {
  if (drift.length) console.log('\n❌ Cambiaron conteos:', drift.join(' · '));
  if (!sameHash) console.log('❌ Cambió el contenido (huella distinta).');
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
