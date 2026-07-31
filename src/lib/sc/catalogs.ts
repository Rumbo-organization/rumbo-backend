// Catálogos de San Cristóbal, traídos una vez y guardados de nuestro lado.
//
// El formulario de cotización necesita los códigos de la compañía (`AR_13` por
// Córdoba, `Personal` por uso particular). Pedírselos a SC en cada apertura ataba
// abrir un formulario a que su API estuviera arriba. Acá se refrescan por job y
// el formulario lee de la base. A SC se le pega solo al cotizar.
//
// ── Qué existe de verdad (sonda contra UAT, 30-jul-2026) ─────────────────────
//
// La documentación habla de "41 catálogos de TypeList" pero no los nombra, y ya
// mintió en varios campos de `QuoteCA7`. Esta lista salió de probar contra UAT
// con `scripts/sc-probe-catalogos.ts`, no del doc. Aprendizajes:
//
//  · El nombre no sigue una regla: `Usage` y `GpsProvider` van en singular,
//    `Categories`, `Colors` y `FuelTypes` en plural. Adivinar no sirve, hay que
//    sondear.
//  · **No existe catálogo** para `AutomaticAdjust`, `PaymentMethodCode`,
//    `PolicyTermCode`, `CurrencyCode`, `TypeOfContracting` ni `AffinityGroup`:
//    devuelven 404. Sus valores válidos siguen saliendo de probar contra UAT.
//  · `TypeList/PolicyType` existe pero pide un parámetro `filter` que rechaza
//    todo lo que le pasamos por query string. Sin resolver.
//  · **`CP7BasicPlan` no existe.** Los planes enlatados de Hogar no son
//    descubribles por API: se acuerdan con SC. Es conversación comercial.
//  · Un 404 dice "ese catálogo no existe"; un 400 dice "existe, te falta un
//    parámetro". La diferencia es la que separa seguir buscando de rendirse.

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';

import { type AuthedTx, db, schema } from '../../db/client.js';
import { scGet } from './client.js';

const { insurerCatalogs } = schema;

/** Integración de origen. Hoy solo San Cristóbal; la columna ya admite más. */
export const SC_PROVIDER = 'sc';

interface CatalogSource {
  /** Nombre del catálogo en Rumbo. Es la clave que ve la API y el front. */
  kind: string;
  path: string;
  /** Clave del envelope donde vienen los valores. */
  envelope: 'Values' | 'States';
}

/**
 * Los 12 catálogos que respondieron con datos. El orden acá no importa; el de
 * los valores dentro de cada uno sí, y se preserva en `sort`.
 */
export const SC_CATALOGS: CatalogSource[] = [
  // Auto: lo que ya usa el formulario.
  { kind: 'provincia', path: '/api/ClaimCatalog/states-by-country?countryCode=AR', envelope: 'States' },
  { kind: 'uso', path: '/api/TypeList/Usage', envelope: 'Values' },
  // Auto: campos que hoy `buildCa7Request` manda hardcodeados (`Car`, `NAF`).
  { kind: 'categoria', path: '/api/TypeList/Categories', envelope: 'Values' },
  { kind: 'combustible', path: '/api/TypeList/FuelTypes', envelope: 'Values' },
  { kind: 'color', path: '/api/TypeList/Colors', envelope: 'Values' },
  { kind: 'cobertura', path: '/api/TypeList/CA7ProductOffering', envelope: 'Values' },
  { kind: 'proveedor_gps', path: '/api/TypeList/GpsProvider', envelope: 'Values' },
  // Modo completo (el que devuelve `QuoteId` y habilita emitir).
  { kind: 'tipo_documento', path: '/api/TypeList/OfficialIDType', envelope: 'Values' },
  // Hogar / Comercio.
  { kind: 'actividad_comercio', path: '/api/TypeList/CP7BuildingActivity', envelope: 'Values' },
  // Vida.
  { kind: 'ocupacion_vida', path: '/api/TypeList/PersonOccupationVidaIndividual', envelope: 'Values' },
  { kind: 'tipo_beneficiario', path: '/api/TypeList/BeneficiaryTypes', envelope: 'Values' },
  { kind: 'parentesco', path: '/api/TypeList/AAHRelationShip', envelope: 'Values' },
];

interface ScValue {
  Code?: string;
  Description?: string;
}

export interface RefreshResult {
  kind: string;
  n: number;
  error?: string;
}

/**
 * Refresca un catálogo. Devuelve cuántos valores quedaron.
 *
 * Los valores que la compañía dejó de informar se borran, pero **solo si la
 * llamada salió bien**: si SC falla, la caché vieja se queda como está. Un
 * catálogo desactualizado sirve; uno vacío deja al productor sin formulario.
 */
async function refreshOne(src: CatalogSource): Promise<RefreshResult> {
  const body = await scGet<Record<string, ScValue[] | undefined>>(src.path);
  const valores = (body[src.envelope] ?? []).filter(v => v.Code);
  if (valores.length === 0) {
    // Un catálogo vacío no es un refresco exitoso: en UAT, SC devuelve 200 con
    // registros en blanco cuando el backend del catálogo no tiene datos.
    return { kind: src.kind, n: 0, error: 'la aseguradora devolvió el catálogo vacío' };
  }

  const filas = valores.map((v, i) => ({
    provider: SC_PROVIDER,
    kind: src.kind,
    code: v.Code!,
    label: (v.Description ?? v.Code!).trim() || v.Code!,
    sort: i,
    fetchedAt: new Date(),
    updatedAt: new Date(),
  }));

  await db.transaction(async tx => {
    await tx
      .insert(insurerCatalogs)
      .values(filas)
      .onConflictDoUpdate({
        target: [insurerCatalogs.provider, insurerCatalogs.kind, insurerCatalogs.code],
        set: {
          label: sql`excluded.label`,
          sort: sql`excluded.sort`,
          fetchedAt: sql`excluded.fetched_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
    // Poda: códigos que la compañía ya no informa.
    await tx.delete(insurerCatalogs).where(
      and(
        eq(insurerCatalogs.provider, SC_PROVIDER),
        eq(insurerCatalogs.kind, src.kind),
        notInArray(
          insurerCatalogs.code,
          filas.map(f => f.code),
        ),
      ),
    );
  });

  return { kind: src.kind, n: filas.length };
}

/**
 * Refresca todos los catálogos. **No aborta al primer error**: que Vida no
 * responda no tiene por qué dejar sin provincias al cotizador de auto.
 */
export async function refreshScCatalogs(only?: string[]): Promise<RefreshResult[]> {
  const objetivo = only?.length ? SC_CATALOGS.filter(c => only.includes(c.kind)) : SC_CATALOGS;
  const out: RefreshResult[] = [];
  for (const src of objetivo) {
    try {
      out.push(await refreshOne(src));
    } catch (err) {
      out.push({ kind: src.kind, n: 0, error: (err as Error).message });
    }
  }
  return out;
}

export interface CatalogEntry {
  code: string;
  label: string;
}

/**
 * Lee los catálogos pedidos, ya ordenados. Una sola query para todos: el
 * formulario los necesita juntos y no tiene sentido pagar N viajes a la base.
 *
 * Va por la transacción autenticada aunque la tabla no tenga `org_id`: así la
 * lectura pasa por la policy en vez de esquivarla con la conexión owner.
 */
export async function readScCatalogs(
  tx: AuthedTx,
  kinds: string[],
): Promise<{ catalogos: Record<string, CatalogEntry[]>; fetchedAt: Date | null }> {
  const filas = await tx
    .select({
      kind: insurerCatalogs.kind,
      code: insurerCatalogs.code,
      label: insurerCatalogs.label,
      fetchedAt: insurerCatalogs.fetchedAt,
    })
    .from(insurerCatalogs)
    .where(and(eq(insurerCatalogs.provider, SC_PROVIDER), inArray(insurerCatalogs.kind, kinds)))
    .orderBy(insurerCatalogs.kind, insurerCatalogs.sort);

  const catalogos: Record<string, CatalogEntry[]> = Object.fromEntries(kinds.map(k => [k, []]));
  let fetchedAt: Date | null = null;
  for (const f of filas) {
    catalogos[f.kind]?.push({ code: f.code, label: f.label });
    // El más viejo de todos: es el que decide si la caché está para refrescar.
    if (!fetchedAt || f.fetchedAt < fetchedAt) fetchedAt = f.fetchedAt;
  }
  return { catalogos, fetchedAt };
}
