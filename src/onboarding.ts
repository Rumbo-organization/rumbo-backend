import { desc, eq } from 'drizzle-orm';

import { db, schema } from './db/client.js';

// Slug URL-safe a partir del nombre (sin acentos, minúsculas, guiones).
function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}

// Provisiona la organización de un usuario en su primer login (onboarding
// automático): organización + membership `owner` + productor `self`. Sin esto,
// un usuario nuevo (Google o email) no tiene org → /api/v1/* devuelve 403 y el
// frontend cae al demo estático. Idempotente: si ya tiene membership devuelve
// esa org sin crear nada. Corre sobre la conexión owner (bypassea RLS): antes de
// que exista la org no hay claims que satisfagan las policies.
export async function ensureUserOrg(userId: string): Promise<string> {
  // ⚠️ El `ORDER BY` no es cosmético. Este valor termina en
  // `session.activeOrganizationId` (auth.ts, hook `session.create.before`), o
  // sea que decide en qué organización aterriza el usuario en CADA login. Sin
  // orden explícito, `limit 1` sobre varias memberships devuelve una fila
  // arbitraria: Postgres no garantiza orden, y el mismo usuario puede caer en
  // una org distinta según el plan de query o después de un UPDATE/VACUUM.
  //
  // Con D-019 (organizador-first) pertenecer a varias orgs es lo normal —un PAS
  // invitado a la organización de su organizador—, así que esto pasa de rareza
  // a caso común.
  //
  // Criterio: la membership MÁS RECIENTE. A quien lo invitaron a una
  // organización, esa es la que vino a usar; su propia org de onboarding queda
  // a un clic en el switcher. Es un default, no una preferencia: el "org por
  // defecto" elegido por el usuario es una feature aparte (haría falta
  // persistirlo, hoy no existe en el modelo).
  const [existing] = await db
    .select({ orgId: schema.members.organizationId })
    .from(schema.members)
    .where(eq(schema.members.userId, userId))
    .orderBy(desc(schema.members.createdAt))
    .limit(1);
  if (existing) return existing.orgId;

  const [u] = await db
    .select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  const displayName = u?.name?.trim() || u?.email?.split('@')[0] || 'Mi organización';
  // Sufijo del uuid del user → slug único sin depender de Math.random.
  const slug = `${slugify(displayName)}-${userId.replace(/-/g, '').slice(0, 6)}`;

  // org + membership + productor en una sola transacción: si algo falla no queda
  // una organización huérfana ni una membership sin su productor.
  return db.transaction(async tx => {
    const [org] = await tx
      .insert(schema.organizations)
      .values({ name: displayName, slug })
      .returning({ id: schema.organizations.id });
    if (!org) throw new Error('onboarding: no se pudo crear la organización');

    await tx.insert(schema.members).values({
      organizationId: org.id,
      userId,
      role: 'owner',
    });

    await tx.insert(schema.producers).values({
      orgId: org.id,
      name: displayName,
      isSelf: true,
      userId,
    });

    return org.id;
  });
}
