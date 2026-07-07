import dotenv from 'dotenv';

// Desarrollo local fuera de Docker: carga el .env compartido del repo devops
// (directorio padre). En Docker (env_file) y en Vercel (env del proyecto) las
// variables ya vienen en el entorno y dotenv no pisa valores existentes.
dotenv.config({ path: ['.env', '../.env'], quiet: true });

export const IS_PROD = process.env.NODE_ENV === 'production';

// A02 (OWASP): el secret de sesión es obligatorio en producción — sin fallback.
// Local/Docker cae al valor de dev; el deploy DEBE fallar si falta.
export const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
if (IS_PROD && !BETTER_AUTH_SECRET) {
  throw new Error('BETTER_AUTH_SECRET es obligatorio en producción (no hay fallback).');
}

// Orígenes permitidos para CORS y Better Auth. En dev el browser puede entrar
// por localhost o 127.0.0.1 — ambos deben estar o el fetch muere en preflight.
// El frontend Vite corre en :3000 (ver vite.config.js / CORS_ORIGIN).
export const ALLOWED_ORIGINS = Array.from(new Set([
  process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]));
