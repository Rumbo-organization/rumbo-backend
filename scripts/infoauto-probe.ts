// Sonda: qué devuelve de verdad la API de InfoAuto.
//
// **Por qué existe.** El cliente (`src/lib/infoauto/client.ts`) se escribió
// contra la documentación del portal, sin haber ejecutado una sola llamada: los
// paths estaban confirmados, pero los nombres de los campos de respuesta
// (`codia`, `description`, `prices_from`, `year`, `price`) salieron del "Modelo
// de datos", no de una respuesta real. Si alguno no coincide, el mapeo devuelve
// objetos vacíos **en silencio** — no tira error. Esta sonda es la que lo
// detecta.
//
// Imprime cada nivel dos veces: el JSON **crudo** de la API y el objeto ya
// mapeado. Si el crudo tiene datos y el mapeado sale vacío, el mapeo está mal.
//
// Es de solo lectura y no escribe nada. Uso:
//   DOTENV_CONFIG_PATH=../.env ./node_modules/.bin/tsx -r dotenv/config \
//     scripts/infoauto-probe.ts

import {
  aniosDeModelo,
  getAccessToken,
  isInfoautoConfigured,
  listarGrupos,
  listarMarcas,
  listarModelos,
  listarPrecios,
} from '../src/lib/infoauto/client.js';

const BASE = (process.env.INFOAUTO_BASE_URL ?? 'https://demo.api.infoauto.com.ar').replace(/\/+$/, '');

/** GET crudo, sin mapear. Es el punto de comparación contra el cliente. */
async function raw(path: string): Promise<unknown> {
  const token = await getAccessToken();
  const r = await fetch(`${BASE}/cars/pub${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return { __status: r.status, __body: (await r.text()).slice(0, 300) };
  return r.json();
}

/** Primeros N elementos, para no tapar la consola con el padrón entero. */
function muestra(v: unknown, n = 2): string {
  const arr = Array.isArray(v) ? v.slice(0, n) : v;
  return JSON.stringify(arr, null, 2);
}

async function main(): Promise<void> {
  if (!isInfoautoConfigured()) {
    console.error('✗ INFOAUTO_USER/INFOAUTO_PASSWORD sin configurar.');
    process.exit(1);
  }
  console.log(`Base: ${BASE}\n`);

  // 1. Auth. Nunca imprimir el token — solo que se consiguió.
  console.log('── 1. Login ─────────────────────────────────────────');
  const t0 = Date.now();
  const token = await getAccessToken();
  console.log(`✓ access token obtenido (${token.length} chars, ${Date.now() - t0} ms)\n`);

  // 2. Marcas.
  console.log('── 2. GET /brands/ ──────────────────────────────────');
  const marcasRaw = await raw('/brands/');
  console.log('CRUDO:', muestra(marcasRaw));
  const marcas = await listarMarcas();
  console.log(`MAPEADO: ${marcas.length} marcas`);
  console.log(muestra(marcas, 3));
  if (marcas.length && !marcas[0].nombre) console.log('⚠️  nombre vacío → el campo `name` no coincide');
  console.log();

  const marca = marcas.find(m => /^toyota/i.test(m.nombre)) ?? marcas.find(m => m.tienePrecios) ?? marcas[0];
  if (!marca) {
    console.error('✗ Sin marcas: no se puede seguir.');
    process.exit(1);
  }
  console.log(`→ Marca elegida: ${marca.nombre} (id ${marca.id})\n`);

  // 3. Grupos.
  console.log(`── 3. GET /brands/${marca.id}/groups/ ────────────────`);
  console.log('CRUDO:', muestra(await raw(`/brands/${marca.id}/groups/`)));
  const grupos = await listarGrupos(marca.id);
  console.log(`MAPEADO: ${grupos.length} grupos`);
  console.log(muestra(grupos, 3));
  console.log();

  const grupo = grupos.find(g => g.tienePrecios) ?? grupos[0];
  if (!grupo) {
    console.error('✗ Sin grupos para esa marca.');
    process.exit(1);
  }
  console.log(`→ Grupo elegido: ${grupo.nombre} (id ${grupo.id})\n`);

  // 4. Modelos. Acá aparece el CODIA, que es el dato que necesita la aseguradora.
  console.log(`── 4. GET /brands/${marca.id}/groups/${grupo.id}/models/ ──`);
  console.log('CRUDO:', muestra(await raw(`/brands/${marca.id}/groups/${grupo.id}/models/`)));
  const modelos = await listarModelos(marca.id, grupo.id);
  console.log(`MAPEADO: ${modelos.length} modelos`);
  console.log(muestra(modelos, 3));
  if (modelos.length && !modelos[0].codia) console.log('⚠️  codia vacío → el campo `codia` no coincide');
  console.log(`   dados de baja: ${modelos.filter(m => m.deBaja).length}`);
  console.log();

  const modelo = modelos.find(m => m.tienePrecios) ?? modelos[0];
  if (!modelo) {
    console.error('✗ Sin modelos para ese grupo.');
    process.exit(1);
  }
  console.log(`→ Modelo elegido: ${modelo.descripcion} (CODIA ${modelo.codia})\n`);

  // 5. Años cotizables. Salen del rango que el modelo ya trae — sin llamada.
  console.log('── 5. Años (derivados de prices_from/prices_to) ──────');
  console.log(`   ${JSON.stringify(aniosDeModelo(modelo))}`);
  console.log();

  // 6. Precios. El chequeo que más importa cuando la licencia los incluya: la
  //    API los informa en MILES de pesos y el cliente aplica el ×1000. Si el
  //    mapeado no es exactamente mil veces el crudo, la suma asegurada sale mal.
  //
  //    Con la licencia de demo esto da 403 — no es un bug, es alcance de plan.
  console.log(`── 6. GET /models/${modelo.codia}/prices/ ────────────`);
  const preciosRaw = (await raw(`/models/${modelo.codia}/prices/`)) as
    Array<{ year?: number; price?: number }> | { __status?: number };

  if (!Array.isArray(preciosRaw)) {
    const status = (preciosRaw as { __status?: number }).__status;
    console.log(
      status === 403
        ? '⚠️  403 — la licencia NO incluye precios. El catálogo sí funciona.\n' +
            '   La suma asegurada queda a cargo del productor y el ×1000 sin verificar.'
        : `⚠️  status ${status}`,
    );
    console.log('\n✓ Sonda completa (con hallazgos).');
    return;
  }

  console.log('CRUDO:', muestra(preciosRaw, 3));
  const precios = await listarPrecios(modelo.codia);
  console.log(`MAPEADO: ${precios.length} años`);
  console.log(muestra(precios, 3));

  if (preciosRaw[0]?.price != null && precios.length) {
    const crudo = Number(preciosRaw[0].price);
    const mapeado = precios.find(p => p.anio === Number(preciosRaw[0].year))?.precio;
    console.log(`\n   ×1000: crudo ${crudo} → mapeado ${mapeado}`);
    console.log(
      mapeado === crudo * 1000
        ? '   ✓ la conversión de miles de pesos está bien aplicada'
        : '   ⚠️  la conversión NO da: revisar listarPrecios()',
    );
    // Sanity check de orden de magnitud: un auto usado en pesos hoy no vale ni
    // $100.000 ni $10.000.000.000. Si cae afuera, la unidad no es la que creemos.
    if (mapeado != null && (mapeado < 1e5 || mapeado > 1e10)) {
      console.log(`   ⚠️  $${mapeado.toLocaleString('es-AR')} no parece un precio de auto — revisar la unidad`);
    }
  }

  console.log('\n✓ Sonda completa.');
}

main().catch(e => {
  console.error('\n✗ Falló:', (e as Error).message);
  process.exit(1);
});
