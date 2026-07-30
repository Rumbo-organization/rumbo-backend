// Catálogo de marcas y modelos desde los datos abiertos de la DNRPA.
//
// Fuente: https://datos.gob.ar (Ministerio de Justicia — DNRPA). Licencia
// abierta: los datos se pueden reutilizar citando la fuente.
//
// ── Por qué estos dos datasets ───────────────────────────────────────────────
//
//  · **Inscripciones iniciales** son 0km. Traen los modelos del año, y nada más:
//    un Corolla 2012 no aparece nunca.
//  · **Transferencias** son usados cambiando de manos. Ahí está la mitad larga
//    del catálogo — con ellas el rango de años va de 1925 a 2027.
//
// Juntos, dos meses dan ~580 marcas y ~15.400 marca+modelo, a nivel versión
// ("TOYOTA / YARIS CROSS XLI 1.5 CVT"). Más meses ensanchan la cola.
//
// ── Lo que este catálogo NO es ───────────────────────────────────────────────
//
// **No sirve para cotizar.** Los códigos son de la DNRPA; las aseguradoras piden
// el código de Infoauto y ningún otro (probado: `QuoteCA7` sin `InfoautoCode`
// devuelve 400). Esto identifica el vehículo y se busca; el precio se carga a
// mano. Si algún día se licencia Infoauto, entra como otro `provider`.

import { sql } from 'drizzle-orm';

import { db, schema } from '../db/client.js';

const { vehicleCatalog } = schema;

export const DNRPA_PROVIDER = 'dnrpa';

/** Los dos datasets, por su nombre en el portal. */
const DATASETS = ['inscripciones-iniciales-de-autos', 'transferencias-de-autos'];

const CKAN = 'https://datos.gob.ar/api/3/action/package_show?id=';

interface CkanResource {
  format?: string;
  url?: string;
  name?: string;
}

/**
 * URLs de los CSV mensuales más recientes de un dataset.
 *
 * Se consultan al portal en vez de construirlas: cada mes es un recurso con su
 * propio UUID, así que no hay patrón que adivinar.
 *
 * ⚠️ Hoy el portal publica **un solo mes como CSV**; los anteriores viven dentro
 * de los ZIP anuales. Así que pedir más meses no trae más archivos. Alcanza:
 * un mes de transferencias ya da 15.000 modelos y años desde 1925, porque son
 * autos usados de todas las épocas. El parámetro queda por si algún día
 * publican más, y el día que haga falta más cola larga hay que leer los ZIP.
 */
async function urlsMensuales(dataset: string, meses: number): Promise<string[]> {
  const r = await fetch(`${CKAN}${dataset}`, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`El portal de datos abiertos respondió ${r.status} para ${dataset}.`);
  const j = (await r.json()) as { result?: { resources?: CkanResource[] } };
  return (j.result?.resources ?? [])
    .filter(x => (x.format ?? '').toUpperCase() === 'CSV' && x.url?.endsWith('.csv'))
    .map(x => x.url!)
    .slice(0, meses);
}

interface Fila {
  marcaCodigo: string | null;
  marca: string;
  modeloCodigo: string | null;
  modelo: string;
  tipo: string | null;
  anio: number | null;
}

/**
 * Parser de CSV a propósito mínimo: estos archivos no entrecomillan campos, así
 * que `split(',')` alcanza. Se valida contando columnas — si algún día la DNRPA
 * empieza a entrecomillar, las filas se descartan en vez de entrar corruptas.
 */
function* parseCsv(texto: string): Generator<Fila> {
  const lineas = texto.split('\n');
  const cols = (lineas[0] ?? '').replace(/^﻿/, '').trim().split(',');
  const i = (n: string) => cols.indexOf(n);
  const iMarcaCod = i('automotor_marca_codigo');
  const iMarca = i('automotor_marca_descripcion');
  const iModeloCod = i('automotor_modelo_codigo');
  const iModelo = i('automotor_modelo_descripcion');
  const iTipo = i('automotor_tipo_descripcion');
  const iAnio = i('automotor_anio_modelo');
  if (iMarca < 0 || iModelo < 0) throw new Error('El CSV no tiene las columnas de marca y modelo.');

  for (let n = 1; n < lineas.length; n++) {
    const c = (lineas[n] ?? '').split(',');
    if (c.length !== cols.length) continue; // fila partida o con comas de más
    const marca = (c[iMarca] ?? '').trim();
    const modelo = (c[iModelo] ?? '').trim();
    if (!marca || !modelo) continue;
    const anio = Number((c[iAnio] ?? '').trim());
    yield {
      marcaCodigo: (c[iMarcaCod] ?? '').trim() || null,
      marca,
      modeloCodigo: (c[iModeloCod] ?? '').trim() || null,
      modelo,
      tipo: (c[iTipo] ?? '').trim() || null,
      anio: Number.isInteger(anio) && anio > 1900 && anio < 2100 ? anio : null,
    };
  }
}

interface Acumulado extends Fila {
  anioDesde: number | null;
  anioHasta: number | null;
  frecuencia: number;
}

export interface CargaResult {
  archivos: number;
  filas: number;
  marcas: number;
  modelos: number;
}

/**
 * Descarga, deduplica y guarda. Devuelve cuánto entró.
 *
 * Se acumula todo en memoria antes de escribir: son ~15k filas distintas sobre
 * ~200k leídas, y hacerlo así permite calcular el rango de años y la frecuencia
 * de una sola pasada. La escritura va por lotes porque un INSERT de 15k filas
 * con parámetros revienta el límite del protocolo.
 */
export async function cargarCatalogoDnrpa(meses = 1): Promise<CargaResult> {
  const urls = (await Promise.all(DATASETS.map(d => urlsMensuales(d, meses)))).flat();
  const acc = new Map<string, Acumulado>();
  let filas = 0;

  for (const url of urls) {
    const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!r.ok) throw new Error(`No se pudo bajar ${url}: ${r.status}`);
    for (const f of parseCsv(await r.text())) {
      filas++;
      const clave = `${f.marca}|${f.modelo}`;
      const prev = acc.get(clave);
      if (!prev) {
        acc.set(clave, { ...f, anioDesde: f.anio, anioHasta: f.anio, frecuencia: 1 });
        continue;
      }
      prev.frecuencia++;
      if (f.anio != null) {
        prev.anioDesde = prev.anioDesde == null ? f.anio : Math.min(prev.anioDesde, f.anio);
        prev.anioHasta = prev.anioHasta == null ? f.anio : Math.max(prev.anioHasta, f.anio);
      }
      // El código puede venir vacío en algunas filas: gana el primero que exista.
      prev.marcaCodigo ??= f.marcaCodigo;
      prev.modeloCodigo ??= f.modeloCodigo;
    }
  }

  const ahora = new Date();
  const values = [...acc.values()].map(a => ({
    provider: DNRPA_PROVIDER,
    marcaCodigo: a.marcaCodigo,
    marca: a.marca,
    modeloCodigo: a.modeloCodigo,
    modelo: a.modelo,
    tipo: a.tipo,
    anioDesde: a.anioDesde,
    anioHasta: a.anioHasta,
    frecuencia: a.frecuencia,
    fetchedAt: ahora,
    updatedAt: ahora,
  }));

  for (let i = 0; i < values.length; i += 500) {
    await db
      .insert(vehicleCatalog)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [vehicleCatalog.provider, vehicleCatalog.marca, vehicleCatalog.modelo],
        set: {
          marcaCodigo: sql`coalesce(excluded.marca_codigo, ${vehicleCatalog.marcaCodigo})`,
          modeloCodigo: sql`coalesce(excluded.modelo_codigo, ${vehicleCatalog.modeloCodigo})`,
          tipo: sql`coalesce(excluded.tipo, ${vehicleCatalog.tipo})`,
          // Una carga nueva ensancha el rango, no lo reemplaza: cada mes trae su
          // recorte de años y quedarse con el último angostaría el catálogo.
          anioDesde: sql`least(excluded.anio_desde, ${vehicleCatalog.anioDesde})`,
          anioHasta: sql`greatest(excluded.anio_hasta, ${vehicleCatalog.anioHasta})`,
          frecuencia: sql`${vehicleCatalog.frecuencia} + excluded.frecuencia`,
          fetchedAt: sql`excluded.fetched_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  return {
    archivos: urls.length,
    filas,
    marcas: new Set([...acc.values()].map(a => a.marca)).size,
    modelos: acc.size,
  };
}
