// Prepara una org de Rumbo para recibir la sync de San Cristóbal.
//
// Crea (idempotente) lo que la sync necesita como pivote y que no puede
// inventar sola: la aseguradora en el catálogo de la org, un `producer` por
// cada código que SC asoció al usuario B2B, y el `producer_code` que los ata.
// Sin esto, `runScSync` falla al resolver la aseguradora y todas las pólizas
// quedarían sin productor asignado.
//
// La lista de códigos NO se hardcodea: sale de `User/producers-current-user`,
// que es la verdad de SC sobre qué códigos puede leer nuestro usuario.
//
// Uso:
//   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
//     scripts/sc-bootstrap-org.ts [--org <uuid>] [--self <código>] [--dry-run]
//
// `--self` marca cuál de los códigos es el del dueño de la org (el organizador;
// por defecto, el que SC informa como `OrganizerCode`).

import { and, eq } from 'drizzle-orm';

import { db, schema } from '../src/db/client.js';
import { scGet, scProducers } from '../src/lib/sc/client.js';
import { SC_INSURER_KEY, SC_INSURER_NAME } from '../src/sc-sync-job.js';

const { insurers, producerCodes, producers } = schema;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY = process.argv.includes('--dry-run');

const orgId = arg('org') ?? process.env.SC_SYNC_ORG_ID;
if (!orgId) throw new Error('Falta la org destino: pasá --org <uuid> o seteá SC_SYNC_ORG_ID.');

const [org] = await db
  .select({ id: schema.organizations.id, name: schema.organizations.name })
  .from(schema.organizations)
  .where(eq(schema.organizations.id, orgId))
  .limit(1);
if (!org) throw new Error(`No existe la org ${orgId}.`);
console.log(`Org destino: ${org.name} (${org.id})${DRY ? ' — DRY RUN' : ''}`);

const refs = await scProducers();
console.log(`SC informa ${refs.length} códigos asociados al usuario B2B.`);

// El organizador sale del propio SC: todos los códigos cuelgan del mismo.
let selfCode = arg('self') ?? null;
if (!selfCode && refs[0]) {
  const info = await scGet<{ producerInfo?: { OrganizerCode?: string } }>(
    `/api/Producer/GetInfo?producerCode=${encodeURIComponent(refs[0].Code)}`,
  );
  const organizerCode = info.producerInfo?.OrganizerCode;
  // El código del organizador puede no estar entre los legibles; en ese caso el
  // "self" es el productor que comparte CUIT con él.
  selfCode = refs.find(r => r.Code === organizerCode)?.Code ?? refs[0].Code;
  console.log(`Organizador informado por SC: ${organizerCode} → self = ${selfCode}`);
}

// ── Aseguradora ──────────────────────────────────────────────────────────────

let insurerId: string;
const [existingInsurer] = await db
  .select({ id: insurers.id })
  .from(insurers)
  .where(and(eq(insurers.orgId, orgId), eq(insurers.name, SC_INSURER_NAME)))
  .limit(1);

if (existingInsurer) {
  insurerId = existingInsurer.id;
  console.log(`Aseguradora ya existía: ${insurerId}`);
} else if (DRY) {
  insurerId = '(dry-run)';
  console.log(`Crearía la aseguradora "${SC_INSURER_NAME}".`);
} else {
  const [row] = await db
    .insert(insurers)
    .values({ orgId, name: SC_INSURER_NAME, key: SC_INSURER_KEY })
    .returning({ id: insurers.id });
  insurerId = row!.id;
  console.log(`Aseguradora creada: ${insurerId}`);
}

// ── Productores + códigos ────────────────────────────────────────────────────

let created = 0;
let linked = 0;
for (const ref of refs) {
  const isSelf = ref.Code === selfCode;
  const name = ref.Producer.trim();

  if (DRY) {
    console.log(`  ${ref.Code} → ${name}${isSelf ? ' (self)' : ''}`);
    continue;
  }

  const [existingLink] = await db
    .select({ id: producerCodes.id })
    .from(producerCodes)
    .where(
      and(eq(producerCodes.orgId, orgId), eq(producerCodes.insurerId, insurerId), eq(producerCodes.code, ref.Code)),
    )
    .limit(1);
  if (existingLink) continue;

  // Un mismo PAS puede tener varios códigos (Pablo tiene dos): se reutiliza el
  // productor por nombre en vez de duplicarlo.
  const [existingProducer] = await db
    .select({ id: producers.id })
    .from(producers)
    .where(and(eq(producers.orgId, orgId), eq(producers.name, name)))
    .limit(1);

  let producerId = existingProducer?.id;
  if (!producerId) {
    const [row] = await db.insert(producers).values({ orgId, name, isSelf }).returning({ id: producers.id });
    producerId = row!.id;
    created++;
  }

  await db.insert(producerCodes).values({ orgId, producerId, insurerId, code: ref.Code });
  linked++;
}

console.log(`Listo: ${created} productores creados, ${linked} códigos vinculados.`);
process.exit(0);
