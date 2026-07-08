-- 0004_two_factor_failed_count — 2FA con Better Auth 1.6.x (jul-2026)
--
-- Better Auth 1.6 agrega el contador de intentos fallidos al modelo twoFactor
-- (anti fuerza bruta del código TOTP). La tabla two_factors del monolito viejo
-- (BA anterior) no lo tiene. Columna con default → el monolito viejo sigue
-- funcionando igual (no la conoce, no la toca).
--
-- Sin runner: aplicar a mano contra la branch de Neon (dev YA aplicada):
--   psql "$DATABASE_URL" -f migrations/0004_two_factor_failed_count.sql

ALTER TABLE two_factors ADD COLUMN IF NOT EXISTS failed_verification_count integer NOT NULL DEFAULT 0;
