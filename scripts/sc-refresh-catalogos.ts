// Refresca los catálogos de San Cristóbal en nuestra base.
//
// Hay que correrlo **una vez antes de usar el cotizador** (si no, el formulario
// responde 503 diciendo justamente esto) y después cada tanto — los códigos de
// la compañía cambian sin avisar, pero no cambian seguido: mensual alcanza.
//
// No borra nada si la llamada falla: un catálogo viejo sirve, uno vacío deja al
// productor sin formulario.
//
// Uso:
//   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
//     scripts/sc-refresh-catalogos.ts [--only provincia,uso]

import { refreshScCatalogs } from '../src/lib/sc/catalogs.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const only = arg('only')
  ?.split(',')
  .map(s => s.trim())
  .filter(Boolean);

console.log(`Refrescando catálogos de San Cristóbal (${process.env.SC_B2B_ENV ?? 'uat'})…\n`);

const resultados = await refreshScCatalogs(only);
let fallos = 0;
for (const r of resultados) {
  if (r.error) {
    fallos++;
    console.log(`  falla ${r.kind.padEnd(20)} ${r.error.replace(/\s+/g, ' ').slice(0, 100)}`);
  } else {
    console.log(`  ok    ${r.kind.padEnd(20)} ${String(r.n).padStart(4)} valores`);
  }
}

const total = resultados.reduce((a, r) => a + r.n, 0);
console.log(`\n${total} valores en ${resultados.length - fallos}/${resultados.length} catálogos.`);
process.exit(fallos > 0 ? 1 : 0);
