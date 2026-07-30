// Carga el catálogo de marcas y modelos desde los datos abiertos de la DNRPA.
//
// Correr una vez al desplegar, y después cada tanto (los modelos nuevos entran
// por las inscripciones iniciales; mensual sobra). Es acumulativo: cargar de
// nuevo ensancha el catálogo, no lo reemplaza.
//
// Uso:
//   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
//     scripts/cargar-catalogo-vehiculos.ts [--meses 3]
//
// `--meses` es cuántos CSV mensuales bajar de cada dataset. Más meses = más cola
// larga de modelos viejos, y más descarga (cada mes de transferencias pesa ~35 MB).

import { cargarCatalogoDnrpa } from '../src/lib/vehiculos-dnrpa.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const meses = Math.max(1, Number(arg('meses') ?? 1));
console.log(`Bajando ${meses} mes(es) de inscripciones iniciales y transferencias (DNRPA)…\n`);

const r = await cargarCatalogoDnrpa(meses);
console.log(`  archivos leídos : ${r.archivos}`);
console.log(`  filas           : ${r.filas.toLocaleString('es-AR')}`);
console.log(`  marcas          : ${r.marcas}`);
console.log(`  marca+modelo    : ${r.modelos.toLocaleString('es-AR')}`);
console.log('\nFuente: DNRPA — datos abiertos del Ministerio de Justicia (datos.gob.ar).');
process.exit(0);
