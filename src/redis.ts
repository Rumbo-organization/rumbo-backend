// Upstash Redis (REST) — storage compartido para el rate limiting en
// serverless. Sin SDK: fetch directo a la API REST (mismo criterio que
// email.ts con Resend — una dependencia menos, mismo contrato).
//
// Con UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN seteadas, los
// limiters (writeRateLimit y el de Better Auth) cuentan contra Redis y el
// límite es GLOBAL entre instancias. Sin ellas, caen al Map en memoria
// por instancia (suficiente en local/Docker; en Vercel el límite efectivo
// era 5×N instancias por ventana y cada cold start lo reseteaba).

const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export function isRedisConfigured(): boolean {
  return Boolean(REST_URL && REST_TOKEN);
}

// Pipeline REST de Upstash: POST /pipeline con [[cmd, ...args], ...].
async function pipeline(cmds: (string | number)[][]): Promise<unknown[]> {
  const r = await fetch(`${REST_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  const out = (await r.json()) as Array<{ result?: unknown; error?: string }>;
  const failed = out.find(x => x.error);
  if (failed) throw new Error(`Upstash: ${failed.error}`);
  return out.map(x => x.result);
}

// Contador de ventana fija: INCR + EXPIRE NX (solo la primera vez fija el
// vencimiento). Devuelve el conteo de la ventana y el TTL restante (Retry-After).
export async function incrWindow(key: string, windowSec: number): Promise<{ count: number; ttl: number }> {
  const [count, , ttl] = await pipeline([
    ['INCR', key],
    ['EXPIRE', key, windowSec, 'NX'],
    ['TTL', key],
  ]);
  return { count: Number(count), ttl: Number(ttl) };
}

// get/set string con TTL — contrato del customStorage de Better Auth.
export async function redisGet(key: string): Promise<string | null> {
  const [v] = await pipeline([['GET', key]]);
  return v == null ? null : String(v);
}

export async function redisSet(key: string, value: string, ttlSec: number): Promise<void> {
  await pipeline([['SET', key, value, 'EX', ttlSec]]);
}
