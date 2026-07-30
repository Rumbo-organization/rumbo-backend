// Sonda: qué catálogos de San Cristóbal existen de verdad y qué devuelven.
//
// **Por qué existe.** El cotizador necesita catálogos (provincias, usos,
// categorías, combustibles, coberturas…) y hoy se los pide a SC EN VIVO cada vez
// que se abre el formulario. Para cachearlos de nuestro lado primero hay que
// saber cuáles responden: la documentación menciona "41 catálogos de TypeList"
// pero no los nombra, y el doc ya mintió en varios campos de `QuoteCA7`.
//
// Es de solo lectura y no escribe nada. Uso:
//   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
//     scripts/sc-probe-catalogos.ts

import { scGet } from '../src/lib/sc/client.js';

/** Nombres candidatos de `TypeList/*`. Los que fallan son parte del resultado. */
const TYPELISTS = [
  // Confirmados en uso o en la documentación.
  'Usage',
  'CA7ProductOffering',
  'CP7BuildingActivity',
  'PersonOccupationVidaIndividual',
  'BeneficiaryTypes',
  'AAHRelationShip',
  // Campos de `VehicleData` que hoy se mandan hardcodeados.
  'Category',
  'CA7Category',
  'VehicleCategory',
  'FuelType',
  'CA7FuelType',
  'Color',
  'CA7Color',
  'AutomaticAdjust',
  'CA7AutomaticAdjust',
  'GpsProvider',
  // Campos de `InsuredData` / `PolicyData` (modo completo y Hogar).
  'OfficialIDType',
  'DocumentType',
  'Gender',
  'Genre',
  'PaymentMethod',
  'PaymentMethodCode',
  'PolicyTerm',
  'PolicyTermCode',
  'Currency',
  'CurrencyCode',
  'PolicyType',
  'TypeOfContracting',
  'CommercialAlternative',
  'AffinityGroup',
  // Hogar / Vida.
  'CP7PolicyType',
  'CP7BasicPlan',
  'CP7AdditionalPlan',
  'LifeOffering',
  'OccupationType',
];

/** Catálogos que no son `TypeList` pero el formulario también necesita. */
const OTROS: Array<[string, string]> = [
  ['provincias', '/api/ClaimCatalog/states-by-country?countryCode=AR'],
  ['typelist-indice', '/api/TypeList'],
  ['postal', '/api/Postal/GetPostalCodes?state=AR_13'],
  ['locations', '/api/Location/GetStates'],
];

/** Cuenta valores y muestra los primeros, sea cual sea el envelope. */
function resumen(body: unknown): { n: number; muestra: string } {
  const b = body as Record<string, unknown> | unknown[] | null;
  const arr = Array.isArray(b)
    ? b
    : ((b?.['Values'] ?? b?.['States'] ?? b?.['Items'] ?? b?.['Data'] ?? null) as unknown[] | null);
  if (!Array.isArray(arr)) return { n: -1, muestra: JSON.stringify(b).slice(0, 120) };
  const muestra = arr
    .slice(0, 3)
    .map(v => {
      const o = v as Record<string, unknown>;
      const code = o?.Code ?? o?.code ?? o?.Id ?? '?';
      const desc = o?.Description ?? o?.description ?? o?.Name ?? '?';
      return `${code}=${desc}`;
    })
    .join(' | ');
  return { n: arr.length, muestra };
}

const okList: string[] = [];

async function probe(label: string, path: string): Promise<void> {
  try {
    const body = await scGet<unknown>(path);
    const { n, muestra } = resumen(body);
    if (n > 0) {
      okList.push(label);
      console.log(`  ok    ${label.padEnd(32)} ${String(n).padStart(4)} valores — ${muestra}`);
    } else if (n === 0) {
      console.log(`  vacío ${label.padEnd(32)}    0 valores (existe pero sin datos en este ambiente)`);
    } else {
      console.log(`  ???   ${label.padEnd(32)} envelope inesperado — ${muestra}`);
    }
  } catch (err) {
    const msg = (err as Error).message.replace(/\s+/g, ' ').slice(0, 90);
    console.log(`  falla ${label.padEnd(32)} ${msg}`);
  }
}

console.log(`Sonda de catálogos — ambiente ${process.env.SC_B2B_ENV ?? 'uat'}\n`);
console.log('TypeList:');
for (const name of TYPELISTS) await probe(name, `/api/TypeList/${name}`);

console.log('\nOtros catálogos:');
for (const [label, path] of OTROS) await probe(label, path);

console.log(`\n${okList.length} catálogos con datos: ${okList.join(', ')}`);
process.exit(0);
