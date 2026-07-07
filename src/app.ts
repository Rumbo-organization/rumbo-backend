import { ALLOWED_ORIGINS } from './env.js';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.js';
import { pool } from './db.js';
import { v1 } from './routes/v1.js';

// App Express compartida por los dos entrypoints:
//  - src/index.ts  → local / Docker (app.listen)
//  - api/index.ts  → Vercel serverless (export default, sin listen)
const app = express();

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));

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

// REST v1 (D-026): /bootstrap (BFF del cockpit) + lecturas individuales.
// Todo detrás de requireAuthedOrg (sesión + org activa) y de withAuthedTx
// (RLS por organización). Pendiente: escrituras + middleware de auditoría.
app.use('/api/v1', v1);

// Errores no manejados: JSON consistente (sin stack al cliente).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'Error interno' });
});

export default app;
