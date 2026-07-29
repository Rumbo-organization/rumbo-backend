// Calidad de datos de un contacto (F-014, paridad `computeDataQualityScore`
// del monolito).
//
// Vive acá y no dentro de una ruta porque tiene DOS consumidores que deben
// coincidir: el alta/edición desde la app (`routes/v1.ts`) y la sincronización
// con aseguradoras (`sc-sync-job.ts`). Si cada uno tuviera su copia, un
// contacto mostraría una calidad distinta según quién lo tocó último.

export interface QualityInput {
  dni: string | null;
  cuit: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressProvince: string | null;
  contactMethods: unknown;
  notes: string | null;
}

/**
 * 0–100: documento 30 + medio de contacto 30 + dirección completa 25 +
 * observaciones 15. La dirección puntúa solo completa (calle + localidad +
 * provincia): media dirección no sirve para operar.
 */
export function qualityScoreOf(c: QualityInput): number {
  let s = 0;
  if (c.dni || c.cuit) s += 30;
  if (Array.isArray(c.contactMethods) && c.contactMethods.length > 0) s += 30;
  if (c.addressStreet && c.addressCity && c.addressProvince) s += 25;
  if (c.notes && c.notes.trim()) s += 15;
  return s;
}
