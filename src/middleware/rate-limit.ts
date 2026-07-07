import type { NextFunction, Request, Response } from 'express';

// A04/A07 (OWASP): rate limiting sobre escrituras (POST/PATCH/DELETE) del API v1.
// Ventana fija por IP, in-memory. Las lecturas (GET/HEAD/OPTIONS) no cuentan.
//
// Caveat serverless: el Map vive por instancia, así que en Vercel el límite es
// por-instancia, no global. Suficiente como primera barrera; endurecer con un
// storage compartido (Redis/Upstash) si el abuso lo requiere.

interface Bucket {
  count: number;
  reset: number;
}
const buckets = new Map<string, Bucket>();

export function writeRateLimit(max = 60, windowMs = 60_000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      res.status(429).json({ error: 'Demasiadas operaciones seguidas. Probá de nuevo en un momento.' });
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
