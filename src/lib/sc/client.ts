// Cliente HTTP del gateway B2B de San Cristóbal (docs/rumbo/18-api-b2b-sancristobal.md).
//
// SOLO LECTURA: acá no hay un solo endpoint de escritura. El acuerdo con SC nos
// habilita a leer la cartera de los códigos de productor asociados al usuario
// B2B; cualquier POST que no sea el login es un bug.
//
// Sin SDK (mismo criterio que email.ts/redis.ts): fetch directo. Tres cosas que
// este cliente resuelve y que NO son opcionales:
//
//  1. **Token cacheado.** `Expires_In` viene en MINUTOS (no segundos) y SC no
//     emite un token nuevo hasta que pasan los 120 min: re-loguear devuelve el
//     mismo. Si no se cachea, cada corrida quema una llamada al login para nada.
//  2. **Doble validación de error.** Un 200 puede ser un error de negocio: hay
//     que mirar `HasError` dentro del body. Nunca asumir éxito por el status.
//  3. **Rate limits.** SC documenta 3/s para el detalle de póliza; acá se va a
//     2/s (margen) con un token bucket global al proceso.
//
// Verificado contra UAT el 28-jul-2026. Endpoints confirmados deshabilitados
// para el usuario `B2B_Rumbo`: `Job/GetMovements`, `Producer/producer-promises`,
// `Producer/earned-commissions-paginated` (ver §9 del doc).

import { isRedisConfigured, redisGet, redisSet } from '../../redis.js';

const BASE_URLS = {
  uat: 'https://api-uat.sancristobalonline.com.ar/b2b-gateway',
  prod: 'https://api.sancristobal.com.ar/b2b-gateway',
} as const;

export type ScEnv = keyof typeof BASE_URLS;

/** Timeout por request. El detalle de algunos ramos tarda decenas de segundos. */
const REQUEST_TIMEOUT_MS = 45_000;
/** Reintentos ante 5xx/timeout (el 4xx no se reintenta: es contrato, no clima). */
const MAX_RETRIES = 2;
/** Presupuesto del token bucket: 2 req/s sostenidos (SC documenta 3/s). */
const RATE_PER_SEC = 2;
/** Timeouts consecutivos del MISMO endpoint que abren el breaker. */
const BREAKER_THRESHOLD = 3;
/** TTL del token en cache: 110 min, bajo los 120 que dura del lado de SC. */
const TOKEN_TTL_SEC = 110 * 60;

export function scEnv(): ScEnv {
  return process.env.SC_B2B_ENV === 'prod' ? 'prod' : 'uat';
}

export function isScConfigured(): boolean {
  return Boolean(process.env.SC_B2B_USER && process.env.SC_B2B_PASSWORD);
}

// ── Errores ──────────────────────────────────────────────────────────────────

export class ScError extends Error {
  constructor(
    message: string,
    readonly path: string,
    /** `null` cuando el fallo fue de red/timeout (no hubo respuesta). */
    readonly status: number | null,
    /** `true` cuando el 200 traía `HasError` (error de negocio, no de transporte). */
    readonly business = false,
  ) {
    super(message);
    this.name = 'ScError';
  }
}

/** Ramo equivocado para ese endpoint de detalle: SC responde 422 y es barato. */
export function isWrongRamo(err: unknown): boolean {
  return err instanceof ScError && err.status === 422;
}

/** El usuario B2B no tiene habilitado el servicio (Comisiones, GetMovements…). */
export function isNotEnabled(err: unknown): boolean {
  return err instanceof ScError && /no est[aá] habilitad/i.test(err.message);
}

// ── Rate limiting (token bucket global al proceso) ────────────────────────────

let tokens = RATE_PER_SEC;
let lastRefill = Date.now();

async function takeToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(RATE_PER_SEC, tokens + ((now - lastRefill) / 1000) * RATE_PER_SEC);
    lastRefill = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - tokens) / RATE_PER_SEC) * 1000));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Circuit breaker por endpoint ─────────────────────────────────────────────
//
// UAT tiene endpoints que cuelgan indefinidamente (`PolicyDetail/combined` no
// respondió en 90 s, tres veces). Sin breaker, una corrida con presupuesto de
// 50 s se consume entera en un solo request muerto y la cola nunca avanza.

const consecutiveTimeouts = new Map<string, number>();

/** Endpoints que agotaron el umbral en esta corrida (para reportar en la bitácora). */
export function trippedEndpoints(): string[] {
  return [...consecutiveTimeouts].filter(([, n]) => n >= BREAKER_THRESHOLD).map(([k]) => k);
}

export function resetBreaker(): void {
  consecutiveTimeouts.clear();
}

function breakerKey(path: string): string {
  return path.split('?')[0] ?? path;
}

// ── Token ────────────────────────────────────────────────────────────────────

let memoToken: { value: string; expiresAt: number } | null = null;

function tokenCacheKey(): string {
  return `sc:token:${scEnv()}:${process.env.SC_B2B_USER}`;
}

async function login(): Promise<string> {
  const userName = process.env.SC_B2B_USER;
  const password = process.env.SC_B2B_PASSWORD;
  if (!userName || !password)
    throw new ScError('SC_B2B_USER/SC_B2B_PASSWORD sin configurar.', '/api/Auth/LoginAsync', null);

  const r = await fetch(`${BASE_URLS[scEnv()]}/api/Auth/LoginAsync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName, password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new ScError(`Login SC ${r.status}: ${body.slice(0, 200)}`, '/api/Auth/LoginAsync', r.status);
  }
  const body = (await r.json()) as { Auth_Token?: string; Expires_In?: number };
  if (!body.Auth_Token) throw new ScError('Login SC sin Auth_Token.', '/api/Auth/LoginAsync', r.status);
  return body.Auth_Token;
}

/**
 * Token vigente, de cache si lo hay. Redis lo comparte entre invocaciones
 * serverless (cada cold start arranca con la memoria vacía); sin Redis cae a
 * memoria de módulo, que alcanza para el CLI y para Docker.
 */
export async function getToken(): Promise<string> {
  if (memoToken && memoToken.expiresAt > Date.now()) return memoToken.value;

  if (isRedisConfigured()) {
    const cached = await redisGet(tokenCacheKey()).catch(() => null);
    if (cached) {
      memoToken = { value: cached, expiresAt: Date.now() + 60_000 };
      return cached;
    }
  }

  const token = await login();
  memoToken = { value: token, expiresAt: Date.now() + TOKEN_TTL_SEC * 1000 };
  if (isRedisConfigured()) await redisSet(tokenCacheKey(), token, TOKEN_TTL_SEC).catch(() => {});
  return token;
}

// ── Request ──────────────────────────────────────────────────────────────────

interface ScEnvelope {
  HasError?: boolean;
  Messages?: Array<{ Description?: string; MessageBeautiful?: string; Code?: string }>;
}

function envelopeError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const env = body as ScEnvelope;
  if (env.HasError !== true) return null;
  const msg = (env.Messages ?? [])
    .map(m => m.MessageBeautiful ?? m.Description ?? m.Code)
    .filter(Boolean)
    .join('; ');
  return msg || 'HasError sin Messages';
}

/** `failureReason` es la forma que usa el gateway para los errores de gateway. */
function failureReason(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const reason = (body as { failureReason?: unknown }).failureReason;
  return typeof reason === 'string' ? reason : null;
}

/**
 * GET autenticado contra el gateway. Aplica rate limit, timeout, reintentos y
 * las DOS validaciones de error (status + `HasError`).
 */
export async function scGet<T>(path: string): Promise<T> {
  const key = breakerKey(path);
  if ((consecutiveTimeouts.get(key) ?? 0) >= BREAKER_THRESHOLD) {
    throw new ScError(`Breaker abierto para ${key} (${BREAKER_THRESHOLD} timeouts seguidos).`, path, null);
  }

  let lastErr: ScError | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await takeToken();
    const token = await getToken();
    let r: Response;
    try {
      r = await fetch(`${BASE_URLS[scEnv()]}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout / red caída: NO se reintenta acá. Un reintento cuesta otros 45 s
      // y el cron tiene un presupuesto de decenas de segundos — tres intentos
      // seguidos se comen la corrida entera sin drenar nada. El reintento real
      // es la cola persistida: el ítem queda pendiente y lo toma la próxima
      // corrida. A los BREAKER_THRESHOLD fallos el endpoint queda cortado.
      consecutiveTimeouts.set(key, (consecutiveTimeouts.get(key) ?? 0) + 1);
      throw new ScError(`Sin respuesta de SC (${(err as Error).name}).`, path, null);
    }
    consecutiveTimeouts.set(key, 0);

    const raw = await r.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }

    if (!r.ok) {
      const reason = failureReason(body) ?? raw.slice(0, 200);
      lastErr = new ScError(`SC ${r.status}: ${reason}`, path, r.status);
      // 4xx = contrato (ramo equivocado, servicio no habilitado): no se reintenta.
      // El 429 es la excepción: SC tiene cuotas por ventana (3/s en el detalle,
      // 1 cada 5 s en comisiones) y esperar alcanza. `Retry-After` si viene.
      if (r.status < 500 && r.status !== 429) throw lastErr;
      const retryAfter = Number(r.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1) * (r.status === 429 ? 5 : 1));
      continue;
    }

    const business = envelopeError(body);
    if (business) throw new ScError(`SC 200 con HasError: ${business}`, path, r.status, true);

    return body as T;
  }
  throw lastErr ?? new ScError('SC: agotados los reintentos.', path, null);
}

// ── Endpoints usados por la sync (todos de lectura) ───────────────────────────

export interface ScProducerRef {
  Producer: string;
  Code: string;
  TaxId: string;
}

/** Códigos de productor asociados al usuario B2B. Es el universo de la sync. */
export function scProducers(): Promise<ScProducerRef[]> {
  return scGet<ScProducerRef[]>('/api/User/producers-current-user');
}

export interface ScPortfolioPolicy {
  State: string;
  PolicyNumber: string;
  InsuredName: string;
  InsuredDocumentType: string;
  InsuredDocument: string;
  PolicyType: string;
  ProducerCode: string;
  OrganizerCode: string;
  TypeOfContracting: string;
}

/** Cartera VIGENTE del código (WIKI §23). No trae histórico ni detalle financiero. */
export async function scPortfolio(producerCode: string): Promise<ScPortfolioPolicy[]> {
  const body = await scGet<{ Policies?: ScPortfolioPolicy[] }>(
    `/api/Producer/portfolio-by-producer-code?producerCode=${encodeURIComponent(producerCode)}`,
  );
  return body.Policies ?? [];
}

/**
 * Feed delta de cartera (WIKI §10): nº de pólizas con movimiento ESE día.
 * Ventana dura de 30 días hacia atrás → hay que pollear al menos mensualmente.
 * Es el sustituto de `Job/GetMovements`, que SC no nos tiene habilitado.
 */
export async function scMovementsByDate(taxId: string, producerCode: string, ymd: string): Promise<string[]> {
  const qs = new URLSearchParams({ taxId, producerCode, date: ymd });
  const body = await scGet<{ PolicyNumbers?: string[] }>(`/api/Producer/movements-by-date?${qs}`);
  return body.PolicyNumbers ?? [];
}

export interface ScPaymentMovement {
  Poliza: string;
  Pagos: Array<{ Ext_ApplicationDate?: string; PaymentAmount?: string; ReversedDate?: string }>;
}

/** Feed delta de cobranzas (WIKI §11). Se consulta a día vencido. */
export async function scPaymentsByDay(cuit: string, ymd: string): Promise<ScPaymentMovement[]> {
  const qs = new URLSearchParams({ cuit, dia: ymd });
  const body = await scGet<{ MovimientosCobranzas?: ScPaymentMovement[] }>(
    `/api/Payment/ConsultaMovimientosCobranzaPorDia?${qs}`,
  );
  return body.MovimientosCobranzas ?? [];
}

/** Novedades de siniestros del día (WIKI §14): lista liviana de nº de siniestro. */
export async function scClaimNews(producerCode: string, ymd: string): Promise<string[]> {
  const qs = new URLSearchParams({ producerCode, newsDate: ymd });
  const body = await scGet<string[] | { ClaimNumbers?: string[] }>(`/api/Claims/News?${qs}`);
  if (Array.isArray(body)) return body;
  return body.ClaimNumbers ?? [];
}

/** Detalle de un siniestro. `Claims/Producer` está deprecado: no usarlo. */
export async function scClaimDetail(claimNumber: string): Promise<Record<string, unknown> | null> {
  const body = await scGet<{ Claims?: Array<Record<string, unknown>> }>(
    `/api/Claims/ClaimNumber?claimNumber=${encodeURIComponent(claimNumber)}`,
  );
  return body.Claims?.[0] ?? null;
}

/**
 * Detalle de póliza por el endpoint del ramo. Devuelve el contenido YA
 * desenvuelto: agro usa `PolicyDetails` (plural) y el resto `PolicyDetail`.
 */
export async function scPolicyDetail(endpoint: string, policyNumber: string): Promise<Record<string, unknown>> {
  const path =
    endpoint === 'GetPolicyDetailByPolicyNumber'
      ? `/api/PolicyDetail/GetPolicyDetailByPolicyNumber?policyNumber=${encodeURIComponent(policyNumber)}&includePayments=true`
      : `/api/PolicyDetail/${endpoint}?policyNumber=${encodeURIComponent(policyNumber)}`;
  const body = await scGet<Record<string, unknown>>(path);
  const detail = (body.PolicyDetail ?? body.PolicyDetails ?? body) as Record<string, unknown>;
  if (!detail || typeof detail !== 'object') throw new ScError('Detalle de póliza vacío.', path, 200, true);
  return detail;
}
