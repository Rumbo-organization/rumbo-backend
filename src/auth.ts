import { ALLOWED_ORIGINS } from './env.js';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';

import { db, schema } from './db/client.js';
import { ensureUserOrg } from './onboarding.js';

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
  // Solo cae en el fallback si falta la env var (nunca usar en producción).
  secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-secret-cambiar',
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:4000',
  trustedOrigins: ALLOWED_ORIGINS,
  emailAndPassword: { enabled: true },
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
    database: {
      generateId: 'uuid',
    },
  },

  plugins: [
    organization(),
    twoFactor({ issuer: process.env.APP_NAME ?? 'Rumbo' }),
  ],
});
