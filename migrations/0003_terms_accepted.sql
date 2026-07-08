-- 0003_terms_accepted — Aceptación de legales (jul-2026)
--
-- Decisión de producto (08-jul-2026): la superficie pública (landing, legales)
-- vive en OTRO repo de Vercel. La app registra la aceptación de Términos y
-- Privacidad en el registro (checkbox) o, para cuentas existentes, una única
-- vez al iniciar sesión (modal). Ley 25.326.
--
-- Sin runner: aplicar a mano contra la branch de Neon (dev YA aplicada):
--   psql "$DATABASE_URL" -f migrations/0003_terms_accepted.sql
--
-- RLS: users ya tiene self_isolation (ALL, id = current_user_id()) → el propio
-- usuario puede setear su terms_accepted_at dentro de withAuthedTx. Idempotente.

ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
