import dotenv from 'dotenv';

// Desarrollo local fuera de Docker: carga el .env compartido del repo devops
// (directorio padre). En Docker (env_file) y en Vercel (env del proyecto) las
// variables ya vienen en el entorno y dotenv no pisa valores existentes.
dotenv.config({ path: ['.env', '../.env'], quiet: true });

// Orígenes permitidos para CORS y Better Auth. En dev el browser puede entrar
// por localhost o 127.0.0.1 — ambos deben estar o el fetch muere en preflight.
// El frontend Vite corre en :3000 (ver vite.config.js / CORS_ORIGIN).
export const ALLOWED_ORIGINS = Array.from(new Set([
  process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]));
