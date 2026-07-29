// Ruteo por ramo: nº de póliza de SC → endpoint de detalle + ramo de Rumbo.
//
// El nº de póliza de SC es `país-casa-ramo-número` (§3.2 del doc), a veces con
// sufijo de endoso: `01-04-17-30000642`. El TERCER segmento es el ramo, y de él
// depende qué endpoint hay que pegar — no hay uno genérico:
//
//   · `SearchPolicyDetails` **está deprecado** (SC responde 500 diciéndolo).
//   · `GetPolicyDetailByPolicyNumber` es **exclusivo de automotor**: cualquier
//     otro ramo da 422 "Ramo no habilitado".
//
// El 422 es rápido y barato, así que un ramo desconocido se resuelve sondeando
// los candidatos una vez y cacheando el resultado. Igual conviene que el mapa
// estático crezca: cada sonda son N requests contra el rate limit.
//
// Confirmados contra UAT el 28-jul-2026: 02→fire, 06→personal-accidents,
// 07→combined, 11→general-liability, 17→life. El resto sale del doc §12.

import { isTripped, isWrongRamo, scPolicyDetail } from './client.js';

/** Valores del enum `policy_ramo` (src/db/schema.ts). */
export type RumboRamo =
  | 'automotor'
  | 'hogar'
  | 'vida'
  | 'art'
  | 'comercio'
  | 'accidentes_personales'
  | 'otros'
  | 'motovehiculo'
  | 'incendio'
  | 'responsabilidad_civil'
  | 'consorcio'
  | 'seguro_tecnico'
  | 'transporte'
  | 'embarcaciones';

interface RamoRoute {
  /** Sufijo de `/api/PolicyDetail/…`, o el nombre completo para automotor. */
  endpoint: string;
  ramo: RumboRamo;
}

/** Ramo SC (3er segmento del nº de póliza) → endpoint + ramo de Rumbo. */
const BY_RAMO_CODE: Record<string, RamoRoute> = {
  '01': { endpoint: 'GetPolicyDetailByPolicyNumber', ramo: 'automotor' },
  '21': { endpoint: 'GetPolicyDetailByPolicyNumber', ramo: 'motovehiculo' },
  '02': { endpoint: 'fire', ramo: 'incendio' },
  '03': { endpoint: 'other-risk', ramo: 'otros' },
  '04': { endpoint: 'theft', ramo: 'otros' }, // Robo: Rumbo no tiene ramo propio.
  '06': { endpoint: 'personal-accidents', ramo: 'accidentes_personales' },
  '07': { endpoint: 'combined', ramo: 'hogar' }, // se refina por PolicyType, abajo.
  '11': { endpoint: 'general-liability', ramo: 'responsabilidad_civil' },
  '17': { endpoint: 'life', ramo: 'vida' },
  '19': { endpoint: 'burial', ramo: 'otros' }, // Sepelio.
};

/** Endpoints del Swagger cuyo nº de ramo todavía no vimos en la cartera real. */
const UNMAPPED_ENDPOINTS: RamoRoute[] = [
  { endpoint: 'transport', ramo: 'transporte' },
  { endpoint: 'technical', ramo: 'seguro_tecnico' },
  { endpoint: 'hull-and-aircraft', ramo: 'embarcaciones' },
  { endpoint: 'caution', ramo: 'otros' }, // Caución.
  { endpoint: 'agriculture', ramo: 'otros' }, // Agropecuario.
];

/** Ramos descubiertos por sonda en esta corrida (no persiste entre procesos). */
const discovered = new Map<string, RamoRoute>();

/** `01-04-17-30000642[-99]` → `17`. */
export function ramoCode(policyNumber: string): string {
  return policyNumber.split('-')[2] ?? '';
}

/**
 * Refina el ramo cuando el nº de póliza no alcanza. Combinado (07) cubre Hogar,
 * Comercio y Consorcio: los tres comparten endpoint y solo se distinguen por el
 * `PolicyType` que devuelve la cartera / el detalle.
 */
export function refineRamo(base: RumboRamo, policyType: string | null | undefined): RumboRamo {
  if (base !== 'hogar' || !policyType) return base;
  if (policyType.includes('IntegralTrade')) return 'comercio';
  if (policyType.includes('Consortium')) return 'consorcio';
  return 'hogar';
}

export function knownRoute(policyNumber: string): RamoRoute | null {
  const code = ramoCode(policyNumber);
  return BY_RAMO_CODE[code] ?? discovered.get(code) ?? null;
}

export interface ResolvedDetail extends RamoRoute {
  detail: Record<string, unknown>;
}

/**
 * Trae el detalle resolviendo el endpoint por ramo. Si el ramo no está mapeado,
 * sondea los candidatos: el endpoint equivocado responde 422 al instante, así
 * que la sonda cuesta poco y solo pasa una vez por ramo nuevo.
 *
 * Los errores que NO son 422 (breaker abierto, 500, timeout) se propagan: el
 * caller los anota en la cola y reintenta en la próxima corrida.
 */
export async function fetchDetailByRamo(policyNumber: string): Promise<ResolvedDetail> {
  const route = knownRoute(policyNumber);
  if (route) {
    const detail = await scPolicyDetail(route.endpoint, policyNumber);
    return { ...route, detail };
  }

  const code = ramoCode(policyNumber);
  // Se saltean los endpoints ya cortados: si no, la sonda choca contra el
  // breaker de OTRO ramo (`combined` cuelga siempre) y aborta antes de llegar al
  // que corresponde — el ramo nuevo se queda sin descubrir y gasta intentos por
  // un problema que no es suyo. Pasó con el ramo 15.
  const candidates = [...Object.values(BY_RAMO_CODE), ...UNMAPPED_ENDPOINTS].filter(
    c => !isTripped(`/api/PolicyDetail/${c.endpoint}`),
  );
  for (const candidate of candidates) {
    try {
      const detail = await scPolicyDetail(candidate.endpoint, policyNumber);
      discovered.set(code, candidate);
      console.warn(
        `[sc:ramos] ramo ${code} sin mapear → resuelto por sonda a "${candidate.endpoint}". ` +
          `Agregalo a BY_RAMO_CODE en src/lib/sc/ramos.ts para ahorrar requests.`,
      );
      return { ...candidate, detail };
    } catch (err) {
      if (isWrongRamo(err)) continue;
      throw err;
    }
  }
  throw new Error(`Ningún endpoint de PolicyDetail acepta el ramo ${code} (póliza ${policyNumber}).`);
}
