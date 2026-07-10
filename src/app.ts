import { ALLOWED_ORIGINS, IS_PROD } from './env.js';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.js';
import { pool } from './db.js';
import { v1 } from './routes/v1.js';
import { writeRateLimit } from './middleware/rate-limit.js';

// App Express compartida por los dos entrypoints:
//  - src/index.ts  → local / Docker (app.listen)
//  - api/index.ts  → Vercel serverless (export default, sin listen)
const app = express();

// Detrás del proxy de Vercel: confiar en 1 hop para que req.ip sea la IP real
// del cliente (la usa el rate limiter). Solo en prod.
if (IS_PROD) app.set('trust proxy', 1);

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));

// A05 (OWASP): headers de seguridad base (sin dependencia extra). HSTS solo en
// prod (https). El SPA se sirve aparte; acá sólo respondemos JSON de API.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Better Auth maneja su propio body parsing: montar ANTES de express.json().
app.all('/api/auth/{*any}', toNodeHandler(auth));

app.use(express.json());

app.get('/api/health', async (_req, res) => {
  let db = 'ok';
  try {
    await pool.query('select 1');
  } catch {
    db = 'down';
  }
  res.status(db === 'ok' ? 200 : 503).json({
    ok: db === 'ok',
    db,
    name: process.env.APP_NAME ?? 'app',
    version: '0.1.0',
    ts: new Date().toISOString(),
  });
});

// Cron diario de avisos de vencimiento (Slice 5 de paridad). Job de SISTEMA:
// sin sesión, protegido por CRON_SECRET (Vercel Cron manda Authorization:
// Bearer <CRON_SECRET>). Corre con el cliente owner (bypass RLS) y scopea por
// org/productor en el código (PARIDAD §5, "batch/sistema").
app.get('/api/cron/expiry-notifications', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'CRON_SECRET sin configurar.' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'No autorizado.' });
    return;
  }
  try {
    const { runExpiryNotifications } = await import('./expiry-job.js');
    const result = await runExpiryNotifications();
    res.json(result);
  } catch (err) {
    console.error('[cron:expiry]', err);
    res.status(500).json({ error: 'La corrida falló; se reintenta mañana.' });
  }
});

// REST v1 (D-026): /bootstrap (BFF del cockpit) + lecturas + escrituras.
// writeRateLimit acota POST/PATCH/DELETE por IP (A04/A07). Detrás:
// requireAuthedOrg (sesión + org) y withAuthedTx (RLS + audit).
app.use('/api/v1', writeRateLimit(), v1);

// Errores no manejados: JSON consistente (sin stack al cliente).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'Error interno' });
});

export default app;
