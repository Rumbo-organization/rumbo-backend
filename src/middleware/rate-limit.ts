import type { NextFunction, Request, Response } from 'express';

import { incrWindow, isRedisConfigured } from '../redis.js';

// A04/A07 (OWASP): rate limiting sobre escrituras (POST/PATCH/DELETE) del API v1.
// Ventana fija por IP. Con Upstash configurado (UPSTASH_REDIS_REST_*) el
// contador es GLOBAL entre instancias serverless; sin él, cae al Map en
// memoria por instancia (local/Docker). Las lecturas (GET/HEAD/OPTIONS) no
// cuentan. Si Redis está caído: fail-open con log (no bloquear la operatoria
// del PAS por una dependencia de infraestructura).

const TOO_MANY = 'Demasiadas operaciones seguidas. Probá de nuevo en un momento.';

interface Bucket {
  count: number;
  reset: number;
}
const buckets = new Map<string, Bucket>();

export function writeRateLimit(max = 60, windowMs = 60_000, prefix = 'v1w') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    // El prefijo separa el presupuesto de cada montaje (v1 vs. público):
    // clavado por IP pura, dos instancias compartirían el mismo bucket.
    const key = `${prefix}:${req.ip ?? 'unknown'}`;

    if (isRedisConfigured()) {
      incrWindow(`rl:${key}`, Math.ceil(windowMs / 1000))
        .then(({ count, ttl }) => {
          if (count > max) {
            res.setHeader('Retry-After', String(Math.max(ttl, 1)));
            res.status(429).json({ error: TOO_MANY });
            return;
          }
          next();
        })
        .catch(err => {
          console.error('[rate-limit] Redis caído, fail-open:', err);
          next();
        });
      return;
    }

    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      res.status(429).json({ error: TOO_MANY });
      return;
    }
    next();
  };
}

// Limpieza perezosa: cada tanto purga buckets vencidos para no crecer sin techo.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 5 * 60_000).unref();
