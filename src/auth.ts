import { ALLOWED_ORIGINS, BETTER_AUTH_SECRET, IS_PROD } from './env.js';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';

import { db, schema } from './db/client.js';
import { ensureUserOrg } from './onboarding.js';
import { sendEmail } from './email.js';
import { isRedisConfigured, redisGet, redisSet } from './redis.js';

const APP_NAME = process.env.APP_NAME ?? 'Rumbo';

// Better Auth (D-021) sobre las tablas snake_case de la app v0.1 (users,
// sessions, accounts, organizations, members…) — las que ya tienen los datos
// y las policies RLS. El adapter Drizzle mapea cada modelo a su tabla; sin
// esto, Better Auth crea/usa sus tablas default camelCase (user, session…)
// y quedan dos familias de auth en paralelo.
export const auth = betterAuth({
  appName: process.env.APP_NAME ?? 'Rumbo',
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
      organization: schema.organizations,
      member: schema.members,
      invitation: schema.invitations,
      twoFactor: schema.twoFactors,
    },
  }),
  // env.ts ya garantiza que en prod BETTER_AUTH_SECRET exista; el fallback solo
  // es alcanzable en local/Docker (A02 OWASP).
  secret: BETTER_AUTH_SECRET ?? 'dev-only-secret-cambiar',
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:4000',
  trustedOrigins: ALLOWED_ORIGINS,
  emailAndPassword: {
    enabled: true,
    // Se exige verificación recién con dominio + Resend en prod
    // (REQUIRE_EMAIL_VERIFICATION=on). Slice 3 de paridad.
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'on',
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: `Restablecé tu contraseña de ${APP_NAME}`,
        text: `Hola ${user.name},\n\nPara crear una contraseña nueva entrá acá:\n${url}\n\nSi no pediste este cambio, ignorá este email.\n\n${APP_NAME}`,
      });
    },
  },

  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: `Verificá tu email en ${APP_NAME}`,
        text: `Hola ${user.name},\n\nConfirmá tu email entrando acá:\n${url}\n\n${APP_NAME}`,
      });
    },
  },

  // A07 (OWASP): rate limiting anti fuerza bruta sobre los endpoints de auth
  // (login/signup/2fa). Con Upstash configurado el contador vive en Redis y
  // el límite es GLOBAL entre instancias serverless (sin él, en memoria por
  // instancia el límite real era 5×N y cada cold start lo reseteaba).
  // customStorage y NO secondaryStorage: secondaryStorage además mueve el
  // almacenamiento de sesiones a Redis — acá solo queremos el rate limit.
  // Ventanas más cortas en los endpoints sensibles (paridad con el monolito).
  rateLimit: {
    enabled: true,
    window: 60, // segundos
    max: 60, // requests por IP por ventana
    ...(isRedisConfigured()
      ? {
          customStorage: {
            get: async (key: string) => {
              const raw = await redisGet(`ba:rl:${key}`);
              return raw ? JSON.parse(raw) : undefined;
            },
            set: async (key: string, value: unknown) => {
              // TTL 2× la ventana más larga (60s): la key muere sola.
              await redisSet(`ba:rl:${key}`, JSON.stringify(value), 120);
            },
          },
        }
      : {}),
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 60, max: 5 },
      '/forget-password': { window: 60, max: 3 },
      '/two-factor/verify-totp': { window: 60, max: 5 },
      '/two-factor/verify-backup-code': { window: 60, max: 3 },
    },
  },
  socialProviders:
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {},

  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },

  databaseHooks: {
    user: {
      create: {
        // Gating de beta privada (paridad §4): con BETA_ALLOWLIST=on solo se
        // registran emails anotados en la waitlist. El founder habilita gente
        // insertándola ahí (script add-to-waitlist del monolito, misma DB).
        before: async (user) => {
          if (process.env.BETA_ALLOWLIST !== 'on') return;
          const [hit] = await db
            .select({ id: schema.waitlist.id })
            .from(schema.waitlist)
            .where(eq(schema.waitlist.email, user.email.toLowerCase()))
            .limit(1);
          if (!hit) {
            throw new APIError('FORBIDDEN', {
              code: 'BETA_NOT_ALLOWED',
              message: 'Estamos en beta privada: el acceso es por invitación. Escribinos para coordinar tu acceso.',
            });
          }
        },
      },
    },
    session: {
      create: {
        // Organizations-only (D-016.16.5): al crear la sesión, la org activa es
        // la del usuario. ensureUserOrg la resuelve o, si es el primer login y
        // no tiene ninguna, la provisiona (onboarding automático: org + owner +
        // productor self). Así ningún login queda sin org → el cockpit siempre
        // se hidrata contra datos reales, nunca cae al demo estático.
        before: async (session) => {
          const orgId = await ensureUserOrg(session.userId);
          return {
            data: { ...session, activeOrganizationId: orgId },
          };
        },
      },
    },
  },

  advanced: {
    // A02/A05 (OWASP): en prod la cookie de sesión va secure + httpOnly.
    // El SPA proxea /api/* a esta API (rewrite en rumbo-frontend/vercel.json),
    // igual que Vite en dev ⇒ para el browser todo es UN origen (el dominio del
    // frontend) y la cookie es first-party. sameSite='lax' siempre: sobrevive el
    // redirect top-level de Google al callback y bloquea CSRF cross-site.
    // (El esquema anterior de dos dominios + sameSite='none' rompía el login en
    // iOS: Safari bloquea Set-Cookie third-party y el state de OAuth se perdía.)
    useSecureCookies: IS_PROD,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
    },
    database: {
      generateId: 'uuid',
    },
  },

  plugins: [
    organization(),
    twoFactor({ issuer: process.env.APP_NAME ?? 'Rumbo' }),
  ],
});
