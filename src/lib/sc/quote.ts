// Cotización de Automotor contra San Cristóbal (`Quoted/QuoteCA7`).
//
// Primera integración de **rating en vivo**. Hasta ahora `quote_items` se
// cargaba a mano: el PAS cotizaba en el portal de cada compañía y transcribía la
// cuota. Acá la aseguradora responde en el momento.
//
// ── Lo que hace distinto a esto de la sync ───────────────────────────────────
//
// La sync es de solo lectura. **Cotizar no lo es**: en el modo completo, si el
// tomador no existe en San Cristóbal, la cotización le CREA la cuenta. Este
// módulo implementa solo el modo **rápido** (código de productor + edad), que no
// lleva documento del tomador y por lo tanto no crea nada. Alcanza para comparar
// precios, que es lo que necesita el multicotizador. Emitir es otra historia y
// otra conversación con SC.
//
// ── Por qué la normalización no es opcional ──────────────────────────────────
//
// Cada aseguradora nombra sus coberturas a su manera. Si guardáramos `CA7_C`
// tal cual, la segunda aseguradora obligaría a reescribir la comparación. Por
// eso cada opción viaja con DOS campos: la cobertura normalizada de Rumbo (para
// agrupar y comparar) y el código nativo (para no perder el original ni la
// trazabilidad). Es la lección #3 del deep-dive: *sin normalización, el
// multicotizador es una mentira*.
//
// Verificado contra UAT el 29-jul-2026: 10 códigos de producto devuelven 13
// opciones con precios reales.

import { scEnv, scGet } from './client.js';

/** Valores del enum `normalized_coverage` (src/db/schema.ts). */
export type NormalizedCoverage =
  | 'incendio_robo_garage'
  | 'rc'
  | 'rc_grua'
  | 'rc_robo_incendio'
  | 'terceros_completo'
  | 'terceros_completo_full'
  | 'todo_riesgo_franquicia'
  | 'todo_riesgo_sin_franquicia';

/**
 * Catálogo de coberturas de Automotor de SC (`TypeList/CA7ProductOffering`),
 * mapeado a la taxonomía de Rumbo.
 *
 * La normalización PIERDE granularidad a propósito: cinco variantes de "terceros
 * completos" de SC caen en dos categorías nuestras. Esa pérdida es el punto —
 * es lo que permite comparar contra otra compañía. El detalle exacto no se
 * pierde: viaja en `nativeCode` y en la descripción.
 *
 * Las de la familia C se separan por gama porque el precio las separa: en la
 * prueba, Premium salió 16% más caro que la C base.
 */
const COVERAGE_BY_PRODUCT: Record<string, NormalizedCoverage> = {
  CA7_A: 'rc', // Responsabilidad civil únicamente
  CA7_B: 'rc_robo_incendio', // Destrucción total por accidente o incendio + robo total
  CA7_B1: 'rc_robo_incendio', // Destrucción total por incendio + robo total
  CA7_B3: 'rc_robo_incendio', // Robo total
  CA7_C: 'terceros_completo', // Terceros Completos
  CA7_C1: 'terceros_completo', // Total/parcial por incendio y robo
  CA7_C4: 'terceros_completo', // Total/parcial incendio + total robo
  CA7_CPlus: 'terceros_completo_full', // Terceros Completos Plus
  CA7_CM: 'terceros_completo_full', // Terceros Completos Premium
  CA7_D: 'todo_riesgo_franquicia', // Todo riesgo (se refina por franquicia)
};

/** Los códigos que se piden cuando el caller no elige. Todo el abanico. */
export const CA7_ALL_PRODUCTS = Object.keys(COVERAGE_BY_PRODUCT);

/**
 * Cobertura normalizada de una opción.
 *
 * Todo Riesgo se decide por la franquicia, no por el código: SC devuelve el
 * mismo `CA7_D` cuatro veces, una por tramo de franquicia. Sin franquicia
 * informada, es todo riesgo sin franquicia.
 */
export function normalizeCoverage(productCode: string, deductibleValue?: string | null): NormalizedCoverage | null {
  const base = COVERAGE_BY_PRODUCT[productCode];
  if (!base) return null;
  if (base === 'todo_riesgo_franquicia' && !deductibleValue) return 'todo_riesgo_sin_franquicia';
  return base;
}

// ── Entrada ──────────────────────────────────────────────────────────────────

export interface Ca7QuoteInput {
  /** Código del PAS en SC (`99-999999`). Define el tarifario que aplica. */
  producerCode: string;
  /** Edad del tomador. En el modo rápido reemplaza a sus datos personales. */
  age: number;
  /** Código Infoauto: **excluyente para cotizar**, no hay alternativa. */
  infoautoCode: string;
  year: number;
  /** Suma asegurada. SC la valida contra el valor de Infoauto. */
  statedAmount: number;
  /** CP y provincia del riesgo (`AR_17` = Neuquén). Cambian la tarifa. */
  postalCode: number;
  state: string;
  usage?: string;
  category?: string;
  fuelType?: string;
  is0Km?: boolean;
  hasGNC?: boolean;
  /** Ajuste automático de suma asegurada (CAA), en %. */
  automaticAdjust?: number;
  startDate?: string;
  paymentFees?: number;
  /** Subconjunto de coberturas. Por defecto, todas. */
  products?: string[];
}

export interface Ca7QuoteOption {
  productCode: string;
  /** Cómo la nombra SC ("Terceros Completos Plus"). */
  nativeDescription: string | null;
  coverage: NormalizedCoverage | null;
  prima: number | null;
  premio: number | null;
  /** Franquicia tal como la informa SC ("2,5 %"). Parte de la identidad. */
  deductible: string | null;
  currency: string;
  /** Solo viene en el modo completo; el rápido no permite emitir. */
  quoteId: string | null;
}

interface ScAmount {
  Amount?: number;
  Currency?: string;
}
interface ScSummary {
  ProductCode?: string;
  TotalPremium?: ScAmount;
  TotalCost?: ScAmount;
  DeductibleValue?: string | null;
  DeductiblePercentage?: string | null;
  DeductibleTypeFullDescription?: string | null;
  QuoteId?: string | null;
}

/**
 * Arma el body de `QuoteCA7`. Los defaults salen de probar contra UAT, no de la
 * documentación — que en varios campos no coincide:
 *
 *  · El campo es `InfoautoCode`, no `InfoAutoCode`.
 *  · `TypeOfContracting` es `CA7_Traditional`; el doc dice `Ca7_Tradicional`.
 *  · El uso particular se llama `Personal`; `Particular` no existe, y SC valida
 *    además la combinación uso × categoría.
 *  · `CurrencyCode`, `Usage`, `Category` y `FuelType` son obligatorios y el doc
 *    no los lista.
 */
export function buildCa7Request(input: Ca7QuoteInput): Record<string, unknown> {
  return {
    InsuredData: { ProducerCode: input.producerCode, Age: input.age },
    PolicyData: {
      StartDate: input.startDate ?? new Date().toISOString().slice(0, 10),
      PolicyTermCode: 'Annual',
      PaymentMethodCode: 'responsive',
      CurrencyCode: 'ars',
      PaymentFees: String(input.paymentFees ?? 1),
      CommercialAlternative: '0',
      TypeOfContracting: 'CA7_Traditional',
      PolicyType: 'CA7_Car',
      LocationPostalCode: input.postalCode,
      LocationState: input.state,
    },
    VehicleData: {
      Vehicle: {
        Year: input.year,
        InfoautoCode: input.infoautoCode,
        StatedAmount: input.statedAmount,
        Is0Km: input.is0Km ?? false,
        HasGNC: input.hasGNC ?? false,
        HasGPS: false,
        IsNational: true,
        Usage: input.usage ?? 'Personal',
        Category: input.category ?? 'Car',
        FuelType: input.fuelType ?? 'NAF',
        AutomaticAdjust: input.automaticAdjust ?? 40,
        RiskLocationPostalCode: input.postalCode,
        RiskLocationState: input.state,
      },
      Product: (input.products ?? CA7_ALL_PRODUCTS).map(ProductCode => ({ ProductCode })),
    },
  };
}

/** Traduce las opciones crudas de SC al modelo de Rumbo. */
export function parseCa7Summaries(summaries: ScSummary[]): Ca7QuoteOption[] {
  return summaries
    .filter(s => s.ProductCode)
    .map(s => {
      const deductible = s.DeductibleValue ?? s.DeductiblePercentage ?? null;
      return {
        productCode: s.ProductCode!,
        nativeDescription: s.DeductibleTypeFullDescription ?? null,
        coverage: normalizeCoverage(s.ProductCode!, deductible),
        prima: typeof s.TotalPremium?.Amount === 'number' ? s.TotalPremium.Amount : null,
        premio: typeof s.TotalCost?.Amount === 'number' ? s.TotalCost.Amount : null,
        deductible: deductible ? `${deductible} %` : null,
        currency: (s.TotalCost?.Currency ?? s.TotalPremium?.Currency ?? 'ars').toUpperCase(),
        quoteId: s.QuoteId ?? null,
      };
    });
}

/**
 * Cotiza Automotor. Devuelve una opción por (cobertura × franquicia) — con el
 * abanico completo son 13 para un auto, no 10: Todo Riesgo aporta cuatro.
 */
export async function quoteCa7(input: Ca7QuoteInput): Promise<Ca7QuoteOption[]> {
  const body = await scPost<{ Summaries?: ScSummary[] }>('/api/Quoted/QuoteCA7', buildCa7Request(input));
  return parseCa7Summaries(body.Summaries ?? []);
}

// `scGet` no sirve acá: cotizar es el único POST de la integración además del
// login. Se reusa su misma disciplina —timeout, doble validación de error— sin
// duplicar el token bucket, porque la cotización no comparte la cuota del
// detalle de póliza (1 cada 30 s) y estrangularla sería gratuito.
async function scPost<T>(path: string, body: unknown): Promise<T> {
  const { getToken, ScError } = await import('./client.js');
  const base =
    scEnv() === 'prod'
      ? 'https://api.sancristobal.com.ar/b2b-gateway'
      : 'https://api-uat.sancristobalonline.com.ar/b2b-gateway';
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const raw = await r.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!r.ok) {
    const msg =
      (parsed as { Message?: string; failureReason?: string } | null)?.Message ??
      (parsed as { failureReason?: string } | null)?.failureReason ??
      raw.slice(0, 200);
    throw new ScError(`SC ${r.status}: ${msg}`, path, r.status);
  }
  // Un 200 puede traer `HasError` — mismo contrato que el resto de la API.
  const env = parsed as { HasError?: boolean; Messages?: Array<{ Description?: string }> } | null;
  if (env?.HasError === true) {
    const detail = (env.Messages ?? [])
      .map(m => m.Description)
      .filter(Boolean)
      .join('; ');
    throw new ScError(`SC 200 con HasError: ${detail || 'sin detalle'}`, path, 200, true);
  }
  return parsed as T;
}

/** Catálogo de coberturas de SC, por si la UI quiere ofrecer un subconjunto. */
export function scCoverageCatalog(): Promise<{ Values?: Array<{ Code: string; Description: string }> }> {
  return scGet('/api/TypeList/CA7ProductOffering');
}
