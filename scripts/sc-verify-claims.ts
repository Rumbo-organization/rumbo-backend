// Ejercita el camino de siniestros de la sync (G4–G7) con payloads de
// laboratorio, sin pegarle a San Cristóbal.
//
// **Por qué existe.** En toda la integración con UAT, `Claims/News` no devolvió
// ni una sola novedad: `syncClaim`, `mapClaim` y la escritura de `claim_events`
// nunca se ejecutaron contra un payload real. Decir que G4–G7 están cubiertos
// sin haber corrido ese código sería optimista.
//
// **Qué prueba y qué NO.** Prueba el mapeo y la escritura: tipificación,
// centinela de fecha de cierre, estados, timeline al cambiar de estado,
// idempotencia. NO prueba que SC mande exactamente esta forma — los payloads
// salen de la documentación (doc 18 §14), no de una respuesta real. Cuando
// aparezca un siniestro de verdad hay que contrastarlo.
//
// Limpia lo que crea. Uso:
//   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
//     scripts/sc-verify-claims.ts [--org <uuid>]

import { and, eq, inArray } from 'drizzle-orm';

import { db, schema } from '../src/db/client.js';
import { mapClaim, mapClaimType } from '../src/lib/sc/map.js';
import { writeClaimFromPayload } from '../src/sc-sync-job.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const orgId = arg('org') ?? process.env.SC_SYNC_ORG_ID;
if (!orgId) throw new Error('Falta la org: --org <uuid> o SC_SYNC_ORG_ID.');

let fallos = 0;
const check = (ok: boolean, label: string, extra = '') => {
  if (!ok) fallos++;
  console.log(`  ${ok ? 'ok   ' : 'FALLA'} ${label}${extra ? ` — ${extra}` : ''}`);
};

// ── 1. Tipificación (G6) ─────────────────────────────────────────────────────
console.log('Tipo de siniestro (G6): SC lo informa en castellano y sin taxonomía fija.');
for (const [texto, esperado] of [
  ['Robo total del vehículo', 'robo'],
  ['Daños por granizo', 'granizo'],
  ['Rotura de cristales', 'cristales'],
  ['Incendio de la unidad', 'incendio'],
  ['Daños por agua', 'danos_agua'],
  ['Responsabilidad Civil a terceros', 'resp_civil'],
  ['Colisión con otro rodado', 'choque'],
  ['Accidente in itinere', 'choque'],
  ['Algo que SC no nombró nunca', 'otros'],
  [null, 'otros'],
] as Array<[string | null, string]>) {
  const got = mapClaimType(texto);
  check(got === esperado, `"${texto ?? '(vacío)'}" → ${got}`, got === esperado ? '' : `esperado ${esperado}`);
}

// ── 2. Fecha de cierre (G7) y estados ────────────────────────────────────────
console.log('\nCierre (G7) y estados:');
const base = (over: Record<string, unknown> = {}) => ({
  ClaimNumber: '99-99-99999999',
  PolicyNumber: '01-04-17-00000000',
  LossDate: '2026-07-10T00:00:00-03:00',
  ReportedDate: '2026-07-11T00:00:00-03:00',
  State: 'open',
  CloseDate: '0001-01-01T00:00:00',
  HowReported: { Code: 'phone', Description: 'Telefónico' },
  Insured: { Name: 'PRUEBA, LABORATORIO' },
  Exposures: [{ CoverageSubType: { Description: 'Robo total del vehículo' }, ExposureStage: 'Análisis Inicial' }],
  ...over,
});

const abierto = mapClaim(base())!;
check(abierto.closedAt === null, 'centinela 0001-01-01 no se toma como fecha de cierre');
check(abierto.status === 'abierto', '"Análisis Inicial" → abierto');
check(abierto.tipo === 'robo', 'tipo tomado de Exposures[].CoverageSubType');

const enCurso = mapClaim(
  base({ Exposures: [{ CoverageSubType: { Description: 'Robo' }, ExposureStage: 'Peritaje' }] }),
)!;
check(enCurso.status === 'en_curso', 'etapa distinta de inicial → en_curso');

const cerrado = mapClaim(base({ CloseDate: '2026-07-20T10:00:00-03:00' }))!;
check(cerrado.closedAt === '2026-07-20', 'CloseDate real → G7 poblado');
check(cerrado.status === 'cerrado', 'con cierre → cerrado');

check(mapClaim(base({ ClaimNumber: null })) === null, 'sin nº de siniestro → descartado');
check(mapClaim(base({ LossDate: null, ReportedDate: null })) === null, 'sin fecha del hecho → descartado');

// ── 3. Escritura real contra dev ─────────────────────────────────────────────
console.log('\nEscritura contra la DB (usa una póliza sincronizada real):');
const [poliza] = await db
  .select({ id: schema.policies.id, num: schema.policies.policyNumber })
  .from(schema.policies)
  .where(and(eq(schema.policies.orgId, orgId), eq(schema.policies.source, 'sync')))
  .limit(1);
if (!poliza?.num) throw new Error('No hay pólizas sincronizadas para colgar el siniestro de prueba.');

const NRO = '99-99-90000001';
const payload = (over: Record<string, unknown> = {}) => base({ ClaimNumber: NRO, PolicyNumber: poliza.num, ...over });

const r1 = await writeClaimFromPayload(orgId, payload());
check(r1.counters.claims_created === 1, 'alta del siniestro');

const [c1] = await db.select().from(schema.claims).where(eq(schema.claims.externalRef, NRO));
check(c1?.tipo === 'robo' && c1?.status === 'abierto', 'fila escrita con tipo y estado correctos');
check(c1?.policyId === poliza.id, 'colgado de la póliza correcta');

// Misma corrida otra vez: no duplica.
const r2 = await writeClaimFromPayload(orgId, payload());
check(r2.counters.claims_updated === 1 && !r2.counters.claims_created, 'segunda pasada actualiza, no duplica');
const todos = await db.select().from(schema.claims).where(eq(schema.claims.externalRef, NRO));
check(todos.length === 1, 'sigue habiendo un solo siniestro');

// Cambio de estado → evento de timeline (G5).
const r3 = await writeClaimFromPayload(orgId, payload({ CloseDate: '2026-07-25T09:00:00-03:00' }));
check(r3.counters.claim_events === 1, 'el cambio de estado genera un evento de timeline (G5)');
const [c2] = await db.select().from(schema.claims).where(eq(schema.claims.externalRef, NRO));
check(c2?.status === 'cerrado', 'estado actualizado a cerrado');
const evs = await db.select().from(schema.claimEvents).where(eq(schema.claimEvents.claimId, c2!.id));
check(evs.length === 1 && evs[0]!.newStatus === 'cerrado', 'evento con el estado destino');

// Sin cambio de estado: no genera evento nuevo.
const r4 = await writeClaimFromPayload(orgId, payload({ CloseDate: '2026-07-25T09:00:00-03:00' }));
check(!r4.counters.claim_events, 'sin cambio de estado no ensucia el timeline');

// ── Limpieza ─────────────────────────────────────────────────────────────────
const ids = (
  await db.select({ id: schema.claims.id }).from(schema.claims).where(eq(schema.claims.externalRef, NRO))
).map(r => r.id);
if (ids.length) {
  await db.delete(schema.claimEvents).where(inArray(schema.claimEvents.claimId, ids));
  await db.delete(schema.claims).where(inArray(schema.claims.id, ids));
}
console.log('\nLimpieza ok.');
console.log(fallos === 0 ? '\n✅ Camino de siniestros verificado.' : `\n❌ ${fallos} verificaciones fallaron.`);
process.exit(fallos === 0 ? 0 : 1);
