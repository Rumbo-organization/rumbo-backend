// Cliente HTTP de la API de InfoAuto (docs/rumbo/19-api-infoauto.md).
//
// Resuelve lo que San Cristóbal no provee: ir de "Toyota Corolla XEI" al
// **código Infoauto (CODIA)**, que SC exige como dato excluyente para cotizar
// auto. SC solo resuelve un código que ya traigas.
//
// SOLO LECTURA. Sin SDK: fetch directo (mismo criterio que sc/client.ts).
//
// ── Tres restricciones que NO son opcionales ────────────────────────────────
//
//  1. **El token se reutiliza o te bloquean.** Textual de la documentación:
//     "Generar un nuevo access token para cada consulta o serie de consultas es
//     considerado un mal uso de la API y puede generar el bloqueo de las
//     credenciales". No es rate limiting suave: es baja de credenciales. Por eso
//     el token va cacheado en Redis (compartido entre invocaciones serverless) y
//     se renueva por `/auth/refresh` antes de volver a loguear.
//  2. **El catálogo NO se puede espejar.** InfoAuto declara mal uso explícito
//     "cualquier software que recorra el catálogo de vehículos de forma
//     automática y sistemática generando una copia local". Por eso acá no hay
//     ninguna función de descarga masiva: se consulta el nivel que el usuario
//     pidió y nada más.
//  3. **Los precios vienen en MILES de pesos.** La conversión ×1000 se hace acá,
//     una sola vez, en el borde. Si se dispersa por la app, tarde o temprano
//     alguien la aplica dos veces o ninguna y la suma asegurada sale 1000× mal.
//
// ⚠️ Relevado de la documentación del portal (4-ago-2026) — **sin ejecutar
// llamadas contra la API**. Los paths están confirmados; los nombres de los
// campos de respuesta salen del "Modelo de datos" del portal. La primera corrida
// real contra la API es la que valida esto.

import { isRedisConfigured, redisGet, redisSet } from '../../redis.js';

/**
 * Base de la API. Demo por default: la licencia productiva todavía no está
 * contratada (pendiente #1 del doc). El pase a prod es cambiar esta env var.
 */
const BASE_URL = (process.env.INFOAUTO_BASE_URL ?? 'https://demo.api.infoauto.com.ar').replace(/\/+$/, '');

/**
 * Base de datos del servicio. InfoAuto expone `cars` y `motorcycles` bajo el
 * mismo host, y **cada una tiene sus propias credenciales**. Hoy solo Autos:
 * Motovehículo se habilita cuando se contrate Infomoto.
 */
const DB = 'cars';

/** El catálogo responde rápido; no hay razón para esperar como con SC. */
const REQUEST_TIMEOUT_MS = Number(process.env.INFOAUTO_TIMEOUT_MS ?? 20_000);
/** Reintentos ante 429/5xx. El 4xx no se reintenta: es contrato, no clima. */
const MAX_RETRIES = 2;
/**
 * Techo de llamadas por segundo. InfoAuto no publica el número del plan, y la
 * consecuencia de pasarse es bloqueo de credenciales, así que el default es
 * conservador. El uso real es una persona eligiendo un auto, no un batch.
 */
const RATE_PER_SEC = Number(process.env.INFOAUTO_RATE_PER_SEC ?? 4);

/** El access token dura 1 h; se cachea por menos para no cortar al filo. */
const ACCESS_TTL_SEC = 55 * 60;
/** El refresh token dura 24 h; mismo criterio. */
const REFRESH_TTL_SEC = 23 * 60 * 60;

export function isInfoautoConfigured(): boolean {
  return Boolean(process.env.INFOAUTO_USER && process.env.INFOAUTO_PASSWORD);
}

// ── Errores ──────────────────────────────────────────────────────────────────

export class InfoautoError extends Error {
  constructor(
    message: string,
    readonly path: string,
    /** `null` cuando el fallo fue de red/timeout (no hubo respuesta). */
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'InfoautoError';
  }
}

/** 429: nos pasamos del cupo. Distinto de un 5xx — acá hay que aflojar, no insistir. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof InfoautoError && err.status === 429;
}

// ── Throttle ─────────────────────────────────────────────────────────────────

let tokens = RATE_PER_SEC;
let lastRefill = Date.now();

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function takeToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(RATE_PER_SEC, tokens + ((now - lastRefill) / 1000) * RATE_PER_SEC);
    lastRefill = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(Math.ceil((1 - tokens) * (1000 / RATE_PER_SEC)));
  }
}

// ── Token ────────────────────────────────────────────────────────────────────

let memoAccess: { value: string; expiresAt: number } | null = null;

function cacheKey(kind: 'access' | 'refresh'): string {
  return `infoauto:${kind}:${DB}:${process.env.INFOAUTO_USER}`;
}

interface LoginBody {
  access_token?: string;
  refresh_token?: string;
}

/**
 * Login con Basic. Es la vía cara: devuelve access + refresh.
 *
 * Se llama lo menos posible — solo cuando no hay refresh token usable.
 */
async function login(): Promise<string> {
  const user = process.env.INFOAUTO_USER;
  const password = process.env.INFOAUTO_PASSWORD;
  const path = `/${DB}/auth/login`;
  if (!user || !password) throw new InfoautoError('INFOAUTO_USER/INFOAUTO_PASSWORD sin configurar.', path, null);

  const basic = Buffer.from(`${user}:${password}`).toString('base64');
  const r = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new InfoautoError(`Login InfoAuto ${r.status}: ${body.slice(0, 200)}`, path, r.status);
  }
  const body = (await r.json()) as LoginBody;
  if (!body.access_token) throw new InfoautoError('Login InfoAuto sin access_token.', path, r.status);

  if (isRedisConfigured() && body.refresh_token) {
    await redisSet(cacheKey('refresh'), body.refresh_token, REFRESH_TTL_SEC).catch(() => {});
  }
  return body.access_token;
}

/**
 * Renueva el access token con el refresh (Bearer). Barato comparado con el
 * login, y es el camino que la documentación pide usar.
 *
 * Devuelve `null` si no hay refresh guardado o ya no sirve — el llamador
 * cae a `login()`.
 */
async function refresh(): Promise<string | null> {
  if (!isRedisConfigured()) return null;
  const token = await redisGet(cacheKey('refresh')).catch(() => null);
  if (!token) return null;

  const r = await fetch(`${BASE_URL}/${DB}/auth/refresh`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null);
  if (!r || !r.ok) return null;

  const body = (await r.json().catch(() => ({}))) as LoginBody;
  return body.access_token ?? null;
}

/**
 * Access token vigente. Redis lo comparte entre invocaciones serverless (cada
 * cold start arranca con la memoria vacía); sin Redis cae a memoria de módulo,
 * que alcanza para el CLI y para Docker.
 *
 * `force` descarta lo cacheado — lo usa el 401 de `infoautoGet`.
 */
export async function getAccessToken(force = false): Promise<string> {
  if (!force) {
    if (memoAccess && memoAccess.expiresAt > Date.now()) return memoAccess.value;
    if (isRedisConfigured()) {
      const cached = await redisGet(cacheKey('access')).catch(() => null);
      if (cached) {
        // El TTL de Redis dice cuánto le queda a la CLAVE, no al token, y este
        // proceso no sabe cuándo se emitió. Se confía por poco; si ya venció, el
        // 401 lo descarta y renueva.
        memoAccess = { value: cached, expiresAt: Date.now() + 60_000 };
        return cached;
      }
    }
  }

  const token = (await refresh()) ?? (await login());
  memoAccess = { value: token, expiresAt: Date.now() + ACCESS_TTL_SEC * 1000 };
  if (isRedisConfigured()) await redisSet(cacheKey('access'), token, ACCESS_TTL_SEC).catch(() => {});
  return token;
}

// ── Request ──────────────────────────────────────────────────────────────────

/**
 * GET contra `/{db}/pub`. Reintenta 429 y 5xx; ante 401 renueva el token una
 * vez y repite (el token pudo vencer entre el cache y la llamada).
 */
async function infoautoGet<T>(path: string): Promise<T> {
  const url = `${BASE_URL}/${DB}/pub${path}`;
  let lastErr: InfoautoError | null = null;

  for (let intento = 0; intento <= MAX_RETRIES; intento++) {
    await takeToken();
    const token = await getAccessToken(intento > 0 && lastErr?.status === 401);

    let r: Response;
    try {
      r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      lastErr = new InfoautoError(`InfoAuto sin respuesta: ${(e as Error).message}`, path, null);
      if (intento < MAX_RETRIES) {
        await sleep(500 * (intento + 1));
        continue;
      }
      throw lastErr;
    }

    if (r.ok) return (await r.json()) as T;

    const body = await r.text().catch(() => '');
    lastErr = new InfoautoError(`InfoAuto ${r.status}: ${body.slice(0, 200)}`, path, r.status);

    // 401 → token vencido, vale un reintento renovando. 429/5xx → esperar.
    const reintentable = r.status === 401 || r.status === 429 || r.status >= 500;
    if (!reintentable || intento === MAX_RETRIES) throw lastErr;
    await sleep(r.status === 429 ? 1500 * (intento + 1) : 500 * (intento + 1));
  }

  throw lastErr ?? new InfoautoError('InfoAuto: fallo desconocido.', path, null);
}

// ── Tipos de respuesta ───────────────────────────────────────────────────────
//
// Campos según el "Modelo de datos" del portal. Los tres niveles del catálogo
// comparten `list_price`, `prices`, `prices_from` y `prices_to`.

interface RawBrand {
  id?: number;
  name?: string;
  prices?: boolean;
  prices_from?: number | null;
  prices_to?: number | null;
}

interface RawGroup {
  id?: number;
  brand_id?: number;
  name?: string;
  prices?: boolean;
  prices_from?: number | null;
  prices_to?: number | null;
}

interface RawModel {
  codia?: number | string;
  brand_id?: number;
  group_id?: number;
  description?: string;
  /** Baja del modelo: otro CODIA (reasignado) o 9999999 (sin reasignación). */
  r_codia?: number | string | null;
  prices?: boolean;
  prices_from?: number | null;
  prices_to?: number | null;
  list_price?: boolean;
}

interface RawPrice {
  year?: number;
  /** En MILES de pesos. Se convierte antes de salir de este módulo. */
  price?: number;
}

export interface InfoautoBrand {
  id: number;
  nombre: string;
  tienePrecios: boolean;
  anioDesde: number | null;
  anioHasta: number | null;
}

export interface InfoautoGroup {
  id: number;
  nombre: string;
  tienePrecios: boolean;
  anioDesde: number | null;
  anioHasta: number | null;
}

export interface InfoautoModel {
  codia: string;
  descripcion: string;
  tienePrecios: boolean;
  anioDesde: number | null;
  anioHasta: number | null;
  /** `true` si el modelo está dado de baja en el padrón (`r_codia` presente). */
  deBaja: boolean;
}

export interface InfoautoPrice {
  anio: number;
  /** En pesos. La conversión desde miles ya está aplicada. */
  precio: number;
}

/** El código especial que marca baja sin reasignación. */
const BAJA_SIN_REASIGNACION = '9999999';

// ── Catálogo ─────────────────────────────────────────────────────────────────

export async function listarMarcas(): Promise<InfoautoBrand[]> {
  const raw = await infoautoGet<RawBrand[]>('/brands/');
  return raw
    .filter(b => b.id != null)
    .map(b => ({
      id: Number(b.id),
      nombre: (b.name ?? '').trim(),
      tienePrecios: b.prices === true,
      anioDesde: b.prices_from ?? null,
      anioHasta: b.prices_to ?? null,
    }));
}

export async function listarGrupos(brandId: number): Promise<InfoautoGroup[]> {
  const raw = await infoautoGet<RawGroup[]>(`/brands/${brandId}/groups/`);
  return raw
    .filter(g => g.id != null)
    .map(g => ({
      id: Number(g.id),
      nombre: (g.name ?? '').trim(),
      tienePrecios: g.prices === true,
      anioDesde: g.prices_from ?? null,
      anioHasta: g.prices_to ?? null,
    }));
}

export async function listarModelos(brandId: number, groupId: number): Promise<InfoautoModel[]> {
  const raw = await infoautoGet<RawModel[]>(`/brands/${brandId}/groups/${groupId}/models/`);
  return raw
    .filter(m => m.codia != null)
    .map(m => ({
      codia: String(m.codia),
      descripcion: (m.description ?? '').trim(),
      tienePrecios: m.prices === true,
      anioDesde: m.prices_from ?? null,
      anioHasta: m.prices_to ?? null,
      deBaja: m.r_codia != null && String(m.r_codia) !== '',
    }));
}

/**
 * Precios usados del modelo, por año. **Acá se aplica el ×1000**: la API los
 * informa en miles de pesos.
 *
 * Ojo: son precios de USADO. El 0km es otra entidad (`/models/{codia}/list_price`)
 * y confundirlos infla o desinfla la suma asegurada.
 */
export async function listarPrecios(codia: string): Promise<InfoautoPrice[]> {
  const raw = await infoautoGet<RawPrice[]>(`/models/${encodeURIComponent(codia)}/prices/`);
  return raw
    .filter(p => p.year != null && p.price != null)
    .map(p => ({ anio: Number(p.year), precio: Number(p.price) * 1000 }))
    .sort((a, b) => b.anio - a.anio);
}

/** Un modelo por CODIA — para confirmar que un código tipeado es el auto correcto. */
export async function obtenerModelo(codia: string): Promise<InfoautoModel | null> {
  const m = await infoautoGet<RawModel | null>(`/models/${encodeURIComponent(codia)}`);
  if (!m || m.codia == null) return null;
  return {
    codia: String(m.codia),
    descripcion: (m.description ?? '').trim(),
    tienePrecios: m.prices === true,
    anioDesde: m.prices_from ?? null,
    anioHasta: m.prices_to ?? null,
    deBaja: m.r_codia != null && String(m.r_codia) !== '',
  };
}

/** Texto para avisarle al PAS que el modelo salió del padrón. */
export function motivoBaja(m: InfoautoModel, rCodia?: string | null): string | null {
  if (!m.deBaja) return null;
  return rCodia === BAJA_SIN_REASIGNACION
    ? 'Este modelo está dado de baja en el padrón, sin reasignación.'
    : 'Este modelo está dado de baja en el padrón.';
}
