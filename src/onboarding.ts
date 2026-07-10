import { eq } from 'drizzle-orm';

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
  const [existing] = await db
    .select({ orgId: schema.members.organizationId })
    .from(schema.members)
    .where(eq(schema.members.userId, userId))
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
