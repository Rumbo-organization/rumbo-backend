// Traducción de los payloads de San Cristóbal al modelo de Rumbo.
//
// Todo acá es PURO: entra un objeto de SC, sale un objeto plano listo para
// insertar. Sin I/O y sin drizzle — así se puede razonar (y testear) el mapeo
// sin una DB, que es donde están los bugs sutiles de una integración.
//
// El payload de SC es grande y desprolijo: valores envueltos en
// `{ Code, Description }`, montos en `{ Amount, Currency, Description }`,
// fechas ISO con offset, centinelas `0001-01-01` para "sin fecha", y el mismo
// concepto con cinco nombres distintos según el producto (§A.3 del doc). Los
// helpers de arriba absorben eso; los mappers de abajo se quedan con la
// semántica.
//
// Lo que NO se mapea acá y es deliberado: comisiones (SC no nos habilita el
// servicio) y el histórico de pólizas no vigentes (la API solo da vigentes +
// 30 días de movimientos; el histórico sigue viniendo del export XLSX).

import type { ContactMethod } from '../../db/schema.js';
import type { RumboRamo } from './ramos.js';

// ── Helpers de desenvoltura ──────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
}

function arr(v: unknown): Rec[] {
  return Array.isArray(v) ? (v.filter(x => x && typeof x === 'object') as Rec[]) : [];
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

/** `{ Code, Description }` → el code. Buena parte del payload viene así. */
function code(v: unknown): string | null {
  const o = rec(v);
  return o ? str(o.Code) : str(v);
}

function description(v: unknown): string | null {
  const o = rec(v);
  return o ? (str(o.Description) ?? str(o.DisplayName)) : str(v);
}

/** `{ Amount, Currency, Description }` o número suelto → string numérico. */
function money(v: unknown): string | null {
  const o = rec(v);
  const n = o ? o.Amount : v;
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : null;
}

/** ISO con offset → `YYYY-MM-DD`. `0001-01-01` es el centinela de "sin fecha". */
export function ymd(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const day = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith('0001-')) return null;
  return day;
}

function ts(v: unknown): Date | null {
  const day = ymd(v);
  if (!day) return null;
  const d = new Date(str(v) as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Deja solo dígitos (DNI/CUIT se guardan normalizados en Rumbo). */
function digits(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const only = s.replace(/\D/g, '');
  return only || null;
}

// ── Contacto (titular de la póliza) ──────────────────────────────────────────

export interface MappedContact {
  kind: 'PERSONA_FISICA' | 'PERSONA_JURIDICA';
  firstName: string | null;
  lastName: string | null;
  legalName: string | null;
  dni: string | null;
  cuit: string | null;
  contactMethods: ContactMethod[];
  addressStreet: string | null;
  addressNumber: string | null;
  addressCity: string | null;
  addressProvince: string | null;
  addressPostalCode: string | null;
}

/** El titular es el `PrimaryNamedInsured`; si SC no lo marca, el primero. */
export function primaryContact(detail: Rec): Rec | null {
  const contacts = arr(detail.Contacts);
  return contacts.find(c => c.PrimaryNamedInsured === true) ?? contacts[0] ?? null;
}

/**
 * Contacto de SC → fila de `contacts`. Cierra **G1** (mail/teléfono) y **G2**
 * (dirección): los dos datos que el export XLSX no trae en bulk y que dejaban
 * la ficha del asegurado vacía.
 */
export function mapContact(scContact: Rec): MappedContact {
  const isCompany = code(scContact.ContactType) === 'company';
  const cuit = digits(scContact.CUIL) ?? (isCompany ? digits(scContact.TaxID) : null);
  const dni = isCompany ? null : digits(scContact.TaxID);

  const methods: ContactMethod[] = [];
  for (const [i, field] of (['EmailAddress1', 'EmailAddress2'] as const).entries()) {
    const value = str(scContact[field]);
    if (value) methods.push({ type: 'email', value, primary: i === 0 });
  }
  for (const [i, phone] of arr(scContact.AvailablePhoneNumbers).entries()) {
    const value = str(phone.PhoneNumber);
    if (!value) continue;
    const isMobile = code(phone.PhoneType) === 'mobile';
    methods.push({ type: isMobile ? 'celular' : 'telefono', value, primary: i === 0 });
  }

  // `Addresses[]` es el domicilio del contacto; `MaillingAddress` (sic, con dos
  // eles en el original de SC) es el de correspondencia y sirve de respaldo.
  const address = arr(scContact.Addresses).find(a => a.PrimaryAddress === true) ?? arr(scContact.Addresses)[0] ?? null;

  return {
    kind: isCompany ? 'PERSONA_JURIDICA' : 'PERSONA_FISICA',
    firstName: isCompany ? null : str(scContact.FirstName),
    lastName: isCompany ? null : str(scContact.LastName),
    legalName: isCompany ? (str(scContact.Name) ?? str(scContact.LastName)) : null,
    dni,
    cuit,
    contactMethods: methods,
    addressStreet: address ? str(address.AddressLine1) : null,
    addressNumber: address ? str(address.StreetNumber) : null,
    addressCity: address ? str(address.City) : null,
    addressProvince: address ? description(address.State) : null,
    addressPostalCode: address ? str(address.PostalCode) : null,
  };
}

/** Respaldo cuando solo tenemos la fila liviana de cartera (sin detalle aún). */
export function mapPortfolioContact(insuredName: string, documentType: string, document: string): MappedContact {
  const isCompany = /CUIT/i.test(documentType);
  // SC formatea "APELLIDO, Nombre" en la cartera liviana.
  const [last = insuredName, first = ''] = insuredName.includes(',') ? insuredName.split(/,\s*/) : [insuredName, ''];
  return {
    kind: isCompany ? 'PERSONA_JURIDICA' : 'PERSONA_FISICA',
    firstName: isCompany ? null : first.trim() || null,
    lastName: isCompany ? null : last.trim(),
    legalName: isCompany ? insuredName.trim() : null,
    dni: isCompany ? null : digits(document),
    cuit: isCompany ? digits(document) : null,
    contactMethods: [],
    addressStreet: null,
    addressNumber: null,
    addressCity: null,
    addressProvince: null,
    addressPostalCode: null,
  };
}

// ── Póliza ───────────────────────────────────────────────────────────────────

export type RumboPolicyStatus = 'propuesta' | 'vigente' | 'vencida' | 'anulada' | 'renovada';

export interface MappedPolicy {
  policyNumber: string;
  ramo: RumboRamo;
  status: RumboPolicyStatus;
  startDate: string | null;
  endDate: string | null;
  prima: string | null;
  premio: string | null;
  sumaAsegurada: string | null;
  currency: string;
  canceledAt: string | null;
  cancelReason: string | null;
  paymentMethod: 'cupon' | 'debito_bancario' | 'tarjeta_credito' | null;
  producerCode: string | null;
}

/**
 * Estado de la póliza. SC lo informa en castellano (`PolicyStatus`) y además
 * deja pistas estructurales: `ReasonsCancellation` poblado = baja, `NextPolicy`
 * = ya fue renovada (sale de la lista de vencimientos), y una vigencia
 * terminada sin baja = vencida.
 */
export function mapPolicyStatus(detail: Rec, today = new Date()): RumboPolicyStatus {
  const raw = (str(detail.PolicyStatus) ?? description(detail.Status) ?? '').toLowerCase();
  if (raw.includes('cancel') || raw.includes('anul') || rec(detail.ReasonsCancellation)) return 'anulada';
  if (str(detail.NextPolicy)) return 'renovada';
  if (raw.includes('propuesta') || raw.includes('cotiz')) return 'propuesta';
  // Automotor informa "Expiró" con una vigencia que todavía no terminó (la
  // fecha de fin es la del período nuevo). Manda lo que dice SC.
  if (raw.includes('expir') || raw.includes('venc')) return 'vencida';
  const end = ymd(detail.PeriodEnd);
  if (end && end < today.toISOString().slice(0, 10)) return 'vencida';
  return 'vigente';
}

/**
 * Nº de póliza. **Automotor no trae `PolicyNumber`** — es el único ramo así, y
 * sin él la póliza queda sin `external_ref`, o sea sin la identidad que le da
 * idempotencia (el índice único es parcial sobre `external_ref IS NOT NULL`:
 * cada corrida insertaría un duplicado). Se cae en cascada:
 *   1. `PolicyNumber` cuando está;
 *   2. `JobNumber` sin el sufijo de endoso (`01-04-01-30772228-1` → sin `-1`);
 *   3. el número que pedimos, que siempre conocemos.
 */
export function resolvePolicyNumber(detail: Rec, requested?: string | null): string | null {
  const direct = str(detail.PolicyNumber);
  if (direct) return direct;
  const job = str(detail.JobNumber);
  if (job) {
    const parts = job.split('-');
    if (parts.length >= 5) return parts.slice(0, 4).join('-');
  }
  return requested?.trim() || null;
}

/** `responsive` = efectivo/cupón; los otros dos son literales del enum de SC. */
function mapPaymentMethod(detail: Rec): MappedPolicy['paymentMethod'] {
  const pm = rec(detail.PaymentMethod);
  switch (code(pm?.PaymentMethod)) {
    case 'creditcard':
      return 'tarjeta_credito';
    case 'directDebit':
      return 'debito_bancario';
    case 'responsive':
      return 'cupon';
    default:
      return null;
  }
}

/**
 * Cabecera de la póliza. **G8**: `TotalPremium` es la PRIMA (el riesgo puro) y
 * `TotalCost` el PREMIO (lo que paga el asegurado, con impuestos). El export
 * XLSX solo traía el premio — la prima neta solo sale por acá.
 */
export function mapPolicy(detail: Rec, ramo: RumboRamo, requestedNumber?: string | null): MappedPolicy {
  const cancellation = rec(detail.ReasonsCancellation);
  // Automotor tampoco trae los totales de cabecera: los acumulados viven en la
  // última transacción (`TotalPremiumRPT`/`TotalCostRPT`, ya acumulados hasta
  // ella — a diferencia de `Transaction*Rpt`, que es el delta del movimiento).
  const lastTx = arr(detail.Transactions).at(-1) ?? {};
  // Suma asegurada: auto/moto la trae el vehículo (`StatedAmount`). En patrimonial
  // vive repartida en las coberturas por-riesgo (fuzzy) → se difiere, queda null.
  const suma = money(rec(detail.Vehicle)?.StatedAmount);
  return {
    policyNumber: resolvePolicyNumber(detail, requestedNumber) as string,
    ramo,
    status: mapPolicyStatus(detail),
    startDate: ymd(detail.PeriodStart),
    endDate: ymd(detail.PeriodEnd),
    prima: money(detail.TotalPremium) ?? money(lastTx.TotalPremiumRPT),
    premio: money(detail.TotalCost) ?? money(lastTx.TotalCostRPT),
    sumaAsegurada: suma,
    currency: (
      code(arr(detail.PreferredCoverageCurrencies).find(c => c.Selected === true)?.Code) ?? 'ars'
    ).toUpperCase(),
    canceledAt: cancellation ? ymd(cancellation.CancellationDate) : null,
    cancelReason: cancellation ? (str(cancellation.ReasonDescription) ?? str(cancellation.CancellationComments)) : null,
    paymentMethod: mapPaymentMethod(detail),
    producerCode: code(detail.ProducerAgent) ?? code(detail.ProducerOfService),
  };
}

// ── Cuotas (G3) ──────────────────────────────────────────────────────────────

export interface MappedInstallment {
  number: number;
  dueDate: string;
  amount: string;
  paidAt: Date | null;
  externalRef: string | null;
}

/** Estados de `PaidStatus` que significan "cobrada". */
const PAID_STATUSES = new Set(['paid', 'paidinfull', 'fullypaid', 'zeroamount']);

/**
 * `Invoice.Invoices[]` → `policy_installments`. Cierra **G3** (plan de pagos),
 * que estaba en cero: ni el export ni el alta manual lo traían.
 *
 * ⚠️ `Invoice` puede venir `null` si SC todavía no generó la info financiera
 * (§12 del doc). En ese caso devolvemos `[]` y el caller NO borra lo que ya
 * había — no es "no tiene cuotas", es "todavía no se sabe".
 *
 * La fecha de pago sale del historial de pagos (`Payments[]` inline o
 * `GetHistoryByPolicyNumber`), matcheando por vencimiento. Cuando SC marca la
 * cuota como pagada pero no expone el pago, se usa el vencimiento como fecha:
 * el estado que deriva la UI (pagada/vencida/pendiente) queda bien, que es lo
 * que importa; la fecha exacta se corrige cuando aparece el pago.
 */
export function mapInstallments(detail: Rec, payments: Rec[] = []): MappedInstallment[] {
  const invoice = rec(detail.Invoice);
  const invoices = invoice ? arr(invoice.Invoices) : [];
  const paidByDueDate = new Map<string, Date>();
  for (const p of [...arr(detail.Payments), ...payments]) {
    const due = ymd(p.InvoiceDueDate);
    const applied = ts(p.ApplicationDate ?? p.Ext_ApplicationDate);
    // Un pago revertido no cuenta como cobrado.
    if (due && applied && !ymd(p.ReversedDate)) paidByDueDate.set(due, applied);
  }

  const out: MappedInstallment[] = [];
  for (const inv of invoices) {
    const dueDate = ymd(inv.InvoiceDueDate);
    const number = Number(str(inv.InstallmentNumber));
    const amount = money(inv.AmountDue) ?? money(inv.Amount);
    if (!dueDate || !Number.isInteger(number) || !amount) continue;

    const status = (str(inv.PaidStatus) ?? '').toLowerCase();
    const paidAt = paidByDueDate.get(dueDate) ?? (PAID_STATUSES.has(status) ? new Date(`${dueDate}T00:00:00Z`) : null);

    out.push({ number, dueDate, amount, paidAt, externalRef: str(inv.InvoiceNumber) });
  }
  return out;
}

// ── Endosos / movimientos ────────────────────────────────────────────────────

export type RumboEndorsementType = 'emision' | 'refacturacion' | 'endoso' | 'anulacion';

export interface MappedEndorsement {
  number: number;
  type: RumboEndorsementType;
  issuedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  prima: string | null;
  premio: string | null;
  description: string | null;
  externalRef: string | null;
  raw: Rec;
}

/**
 * Tipifica un movimiento. Dos gotchas del doc, los dos verificados en payloads
 * reales:
 *
 *  1. La **refacturación mensual** tiene el MISMO `Subtype`/`SubtypeDescription`
 *     que un endoso común (`PolicyChange` / "Endoso") — solo se distingue por
 *     `JobDescription: "Endoso Refacturación - N"`. Es la señal de retención
 *     del mercado AR (§2.38 del deep-dive), así que perderla no es una opción.
 *  2. La **emisión** cambia de código por ramo (`Submission` en la mayoría,
 *     `Issuance` en agro) → hay que mirar también la descripción. La
 *     **renovación** (`Renewal`) entra en el mismo bucket: es el alta del
 *     período nuevo, y el movimiento #0 de una póliza renovada viene así
 *     (verificado en UAT: `01-04-17-30000642-0` es `Renewal`). El texto
 *     literal de SC se conserva en `description`, así que no se pierde.
 */
export function mapEndorsementType(tx: Rec): RumboEndorsementType {
  const job = (str(tx.JobDescription) ?? '').toLowerCase();
  if (job.includes('refactur')) return 'refacturacion';

  const subtype = (str(tx.Subtype) ?? '').toLowerCase();
  const label = (str(tx.SubtypeDescription) ?? '').toLowerCase();
  if (subtype === 'submission' || subtype === 'issuance' || subtype === 'renewal') return 'emision';
  if (label.includes('emisi') || label.includes('renovaci')) return 'emision';
  if (subtype === 'cancellation' || label.includes('cancel') || label.includes('anul')) return 'anulacion';
  return 'endoso';
}

/** `01-04-02-30012952-900` → `900`. El sufijo del JobNumber es el nº de endoso. */
function endorsementNumber(tx: Rec, fallback: number): number {
  const parts = (str(tx.JobNumber) ?? '').split('-');
  const suffix = parts.length >= 5 ? Number(parts[4]) : NaN;
  return Number.isInteger(suffix) ? suffix : fallback;
}

/**
 * `Transactions[]` → `policy_endorsements` (E0 / D-024). ⚠️ Semántica de los
 * montos: `TransactionPremiumRpt`/`TransactionCostRpt` son el DELTA de esa
 * transacción (pueden ser negativos en reversas); `TotalPremiumRPT`/
 * `TotalCostRPT` son el acumulado. En el endoso guardamos el delta, que es lo
 * que el movimiento representa.
 */
export function mapEndorsements(detail: Rec): MappedEndorsement[] {
  return arr(detail.Transactions).map((tx, i) => ({
    number: endorsementNumber(tx, i),
    type: mapEndorsementType(tx),
    issuedAt: ymd(tx.CloseDate) ?? ymd(tx.JobCreateTime) ?? ymd(tx.CreateDate),
    startDate: ymd(tx.PeriodStart) ?? ymd(tx.EditEffectiveDate),
    endDate: ymd(tx.PeriodEnd),
    prima: money(tx.TransactionPremiumRpt) ?? money(tx.TotalPremiumRPT),
    premio: money(tx.TransactionCostRpt) ?? money(tx.TotalCostRPT),
    description: str(tx.JobDescription) ?? str(tx.SubtypeDescription),
    externalRef: str(tx.JobNumber),
    raw: tx,
  }));
}

// ── Bienes asegurados ────────────────────────────────────────────────────────

export interface MappedRisk {
  patente: string | null;
  descripcion: string | null;
  data: Rec;
  externalRef: string | null;
}

/** Saca los escalares de un objeto de SC (los anidados van aparte o se omiten). */
function scalars(o: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      const d = description(v);
      if (d) out[k] = d;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Bienes cubiertos, con forma distinta según la familia de ramo:
 *  · automotor  → `Vehicles[]`/`Vehicle` (patente promovida: el PAS busca por patente).
 *  · patrimonial→ `LocationRisks[]` (ubicaciones y edificios) y `SpecificRisks[]`.
 *  · colectivos → `Insureds[].Insureds[]` (vida/AP: los "bienes" son personas).
 */
export function mapRisks(detail: Rec): MappedRisk[] {
  const out: MappedRisk[] = [];

  // Automotor: `Vehicle` (singular) en póliza individual, `FleetOfVehicles` en
  // flota. Nombres verificados contra el payload real — son `BrandName` /
  // `ModelName` / `VersionName`, no `Make` / `Model` como se había asumido.
  const vehicles = [
    ...arr(detail.Vehicles),
    ...arr(detail.FleetOfVehicles),
    ...(rec(detail.Vehicle) ? [rec(detail.Vehicle) as Rec] : []),
  ];
  for (const v of vehicles) {
    const patente = str(v.LicensePlate) ?? str(v.Plate) ?? str(v.Ext_LicensePlate);
    const descripcion = [
      str(v.BrandName) ?? str(v.Make),
      str(v.ModelName) ?? str(v.Model),
      str(v.VersionName),
      str(v.Year),
    ]
      .filter(Boolean)
      .join(' ');
    out.push({
      patente,
      descripcion: descripcion || patente,
      data: scalars(v),
      externalRef: str(v.PublicId) ?? patente,
    });
  }

  for (const loc of arr(detail.LocationRisks)) {
    const address = rec(loc.Address);
    const label = address ? (str(address.DisplayText) ?? str(address.AddressLine1)) : null;
    for (const building of arr(loc.BuildingRisks)) {
      out.push({
        patente: null,
        descripcion: str(building.BuildingDescription) ?? label ?? description(building.OccupancyType),
        data: { ...scalars(building), ...(label ? { direccion: label } : {}) },
        externalRef: str(building.PublicId),
      });
    }
    for (const specific of arr(loc.SpecificRisks)) {
      out.push({
        patente: null,
        descripcion: description(specific.ClassCode) ?? str(specific.Description) ?? label,
        data: scalars(specific),
        externalRef: str(specific.PublicId),
      });
    }
  }

  for (const group of arr(detail.Insureds)) {
    for (const person of arr(group.Insureds)) {
      const name = [str(person.LastName), str(person.FirstName)].filter(Boolean).join(', ');
      out.push({
        patente: null,
        descripcion: name || str(person.TaxID),
        data: { ...scalars(person), ...(str(group.GroupName) ? { grupo: str(group.GroupName) } : {}) },
        externalRef: str(person.TaxID) ?? str(person.InsuredNumber),
      });
    }
  }

  return out;
}

// ── Siniestros (G4–G7) ───────────────────────────────────────────────────────

export type RumboClaimType =
  'robo' | 'choque' | 'incendio' | 'danos_agua' | 'granizo' | 'cristales' | 'resp_civil' | 'otros';

export interface MappedClaim {
  claimNumber: string;
  policyNumber: string | null;
  tipo: RumboClaimType;
  tipoDetalle: string | null;
  status: 'abierto' | 'en_curso' | 'cerrado';
  occurredAt: Date;
  reportedBy: string;
  location: string | null;
  description: string | null;
  closedAt: string | null;
}

/**
 * **G6** — tipo de siniestro. Hoy los 91 siniestros importados están todos en
 * "otros" porque el export no lo traía; SC lo informa en
 * `Exposures[].CoverageSubType`/`ExposureType`, en castellano y sin taxonomía
 * fija, así que se clasifica por palabras clave contra el enum de Rumbo.
 */
export function mapClaimType(text: string | null): RumboClaimType {
  const t = (text ?? '').toLowerCase();
  if (!t) return 'otros';
  if (t.includes('robo') || t.includes('hurto')) return 'robo';
  if (t.includes('granizo')) return 'granizo';
  if (t.includes('cristal') || t.includes('parabris')) return 'cristales';
  if (t.includes('incendio') || t.includes('fuego')) return 'incendio';
  if (t.includes('agua') || t.includes('inundac')) return 'danos_agua';
  if (t.includes('responsabilidad civil') || t.includes('rc ')) return 'resp_civil';
  if (t.includes('choque') || t.includes('colisi') || t.includes('accidente') || t.includes('daño')) return 'choque';
  return 'otros';
}

function mapClaimStatus(scClaim: Rec, closedAt: string | null): MappedClaim['status'] {
  if (closedAt) return 'cerrado';
  const state = (str(scClaim.State) ?? '').toLowerCase();
  if (state.includes('open') || state.includes('abiert')) {
    // "Análisis Inicial" = recién entrado; cualquier otra etapa ya es gestión.
    const stage = arr(scClaim.Exposures).map(e => (str(e.ExposureStage) ?? '').toLowerCase())[0] ?? '';
    return stage && !stage.includes('inicial') ? 'en_curso' : 'abierto';
  }
  return 'abierto';
}

/** `Claims/ClaimNumber` → fila de `claims`. **G7** = `CloseDate` (sin centinela). */
export function mapClaim(scClaim: Rec): MappedClaim | null {
  const claimNumber = str(scClaim.ClaimNumber) ?? str(scClaim.Number);
  const occurredAt = ts(scClaim.LossDate) ?? ts(scClaim.ReportedDate);
  if (!claimNumber || !occurredAt) return null;

  const exposure = arr(scClaim.Exposures)[0] ?? null;
  const tipoDetalle = exposure
    ? (description(exposure.CoverageSubType) ?? description(exposure.ExposureType) ?? description(exposure.Coverage))
    : null;
  const closedAt = ymd(scClaim.CloseDate);
  const insured = rec(scClaim.Insured);

  return {
    claimNumber,
    policyNumber: str(scClaim.PolicyNumber),
    tipo: mapClaimType(tipoDetalle),
    tipoDetalle,
    status: mapClaimStatus(scClaim, closedAt),
    occurredAt,
    reportedBy:
      description(scClaim.HowReported) ?? (insured ? (str(insured.Name) ?? 'San Cristóbal') : 'San Cristóbal'),
    location: str(scClaim.LossLocation) ?? (insured ? str(insured.Address) : null),
    description: str(scClaim.Description) ?? tipoDetalle,
    closedAt,
  };
}
