// Endpoints INTERNOS de pre-denuncias (Slice 1, docs/rumbo/17-pre-denuncias.md):
// lista + detalle para la sección "Pre-denuncias" del cockpit, y gestión de los
// links públicos por productor (crear + rotar). Heredan requireAuthedOrg del
// router v1; todas las queries corren bajo withAuthedTx (RLS: tenant +
// producer_scope — el organizador ve todo, el productor su cartera).
//
// Convertir/Rechazar llegan en el Slice 2.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';

import { withAuthedTx, schema } from '../db/client.js';
import { writeAuditLogTx } from '../audit.js';

const { claimIntakes, contacts, producerIntakeLinks, producers } = schema;

const INTAKE_STATUS_LABEL: Record<string, string> = {
  pendiente: 'Pendiente',
  convertida: 'Convertida',
  rechazada: 'Rechazada',
  vencida: 'Vencida',
};

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

type H = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const wrap =
  (fn: H): H =>
  async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (e) {
      next(e);
    }
  };

// Display name del contacto matcheado (misma lógica que routes/v1.ts).
function contactDisplayName(c: {
  kind: string | null;
  firstName: string | null;
  lastName: string | null;
  legalName: string | null;
}): string | null {
  if (!c.kind) return null;
  if (c.kind === 'PERSONA_JURIDICA') return c.legalName;
  if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
  return c.lastName ?? c.firstName;
}

// Forma de fila del listado (display-ready, criterio BFF de v1.ts).
function rowShape(r: {
  intake: typeof claimIntakes.$inferSelect;
  producerName: string | null;
  cKind: string | null;
  cFirst: string | null;
  cLast: string | null;
  cLegal: string | null;
}) {
  const inc = r.intake.incidente as Record<string, unknown>;
  const decl = r.intake.aseguradoDeclarado as Record<string, unknown>;
  const nombre =
    (decl.nombre as string | undefined) ??
    contactDisplayName({ kind: r.cKind, firstName: r.cFirst, lastName: r.cLast, legalName: r.cLegal }) ??
    '—';
  return {
    id: r.intake.id,
    number: r.intake.number,
    status: r.intake.status,
    statusLabel: INTAKE_STATUS_LABEL[r.intake.status] ?? r.intake.status,
    submittedAt: r.intake.submittedAt.toISOString(),
    fechaSiniestro: (inc.fecha as string) ?? null,
    nombre,
    ramoLabel: (inc.ramoLabel as string) ?? '—',
    tipoLabel: (inc.tipoLabel as string) ?? '—',
    producerId: r.intake.producerId,
    producerName: r.producerName,
    convertedClaimId: r.intake.convertedClaimId,
  };
}

// ── Pre-denuncias ────────────────────────────────────────────────────────────

export const intakesRouter = Router();

// GET /api/v1/intakes?status=&producer=&limit=&offset= — lista + counts.
// Los counts respetan el filtro por productor (no el de estado: alimentan las
// KPI cards que actúan como filtros).
intakesRouter.get(
  '/',
  wrap(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const producer = typeof req.query.producer === 'string' && isUuid(req.query.producer) ? req.query.producer : '';
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

    const out = await withAuthedTx(req.authCtx!, async tx => {
      const conds = [];
      if (INTAKE_STATUS_LABEL[status]) conds.push(eq(claimIntakes.status, status as 'pendiente'));
      if (producer) conds.push(eq(claimIntakes.producerId, producer));
      const where = conds.length ? and(...conds) : undefined;

      const rows = await tx
        .select({
          intake: claimIntakes,
          producerName: producers.name,
          cKind: contacts.kind,
          cFirst: contacts.firstName,
          cLast: contacts.lastName,
          cLegal: contacts.legalName,
        })
        .from(claimIntakes)
        .leftJoin(producers, eq(producers.id, claimIntakes.producerId))
        .leftJoin(contacts, eq(contacts.id, claimIntakes.matchedContactId))
        .where(where)
        .orderBy(desc(claimIntakes.submittedAt))
        .limit(limit)
        .offset(offset);

      const total =
        (
          await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(claimIntakes)
            .where(where)
        )[0]?.n ?? 0;

      const countRows = await tx
        .select({ status: claimIntakes.status, n: sql<number>`count(*)::int` })
        .from(claimIntakes)
        .where(producer ? eq(claimIntakes.producerId, producer) : undefined)
        .groupBy(claimIntakes.status);
      const by = Object.fromEntries(countRows.map(r => [r.status, r.n]));
      const counts = {
        total: countRows.reduce((a, r) => a + r.n, 0),
        pendientes: by.pendiente ?? 0,
        convertidas: by.convertida ?? 0,
        rechazadas: by.rechazada ?? 0,
      };

      return { data: rows.map(rowShape), total, counts, limit, offset };
    });
    res.json(out);
  }),
);

// GET /api/v1/intakes/:id — detalle completo para el drawer del PAS.
intakesRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const out = await withAuthedTx(req.authCtx!, async tx => {
      const [r] = await tx
        .select({
          intake: claimIntakes,
          producerName: producers.name,
          cKind: contacts.kind,
          cFirst: contacts.firstName,
          cLast: contacts.lastName,
          cLegal: contacts.legalName,
        })
        .from(claimIntakes)
        .leftJoin(producers, eq(producers.id, claimIntakes.producerId))
        .leftJoin(contacts, eq(contacts.id, claimIntakes.matchedContactId))
        .where(eq(claimIntakes.id, id))
        .limit(1);
      if (!r) return null;
      return {
        ...rowShape(r),
        declarante: r.intake.declarante,
        aseguradoDeclarado: r.intake.aseguradoDeclarado,
        incidente: r.intake.incidente,
        matchedContactId: r.intake.matchedContactId,
        matchedContactName: contactDisplayName({
          kind: r.cKind,
          firstName: r.cFirst,
          lastName: r.cLast,
          legalName: r.cLegal,
        }),
        matchedPolicyId: r.intake.matchedPolicyId,
        rejectReason: r.intake.rejectReason,
      };
    });
    if (!out) {
      res.status(404).json({ error: 'Pre-denuncia no encontrada.' });
      return;
    }
    res.json(out);
  }),
);

// ── Links públicos por productor ─────────────────────────────────────────────

export const intakeLinksRouter = Router();

const newSlug = () => randomBytes(18).toString('base64url');

// GET /api/v1/producer-intake-links — productores visibles (RLS) + su link.
intakeLinksRouter.get(
  '/',
  wrap(async (req, res) => {
    const out = await withAuthedTx(req.authCtx!, async tx => {
      const rows = await tx
        .select({
          producerId: producers.id,
          producerName: producers.name,
          isSelf: producers.isSelf,
          linkId: producerIntakeLinks.id,
          slug: producerIntakeLinks.slug,
          active: producerIntakeLinks.active,
        })
        .from(producers)
        .leftJoin(producerIntakeLinks, eq(producerIntakeLinks.producerId, producers.id))
        .orderBy(desc(producers.isSelf), producers.name);
      return { data: rows };
    });
    res.json(out);
  }),
);

// POST /api/v1/producer-intake-links { producerId } — crea el link (idempotente:
// si el productor ya tiene uno, devuelve el existente).
intakeLinksRouter.post(
  '/',
  wrap(async (req, res) => {
    const producerId = (req.body as Record<string, unknown> | undefined)?.producerId;
    if (!isUuid(producerId)) {
      res.status(400).json({ error: 'Productor inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [producer] = await tx
        .select({ id: producers.id })
        .from(producers)
        .where(eq(producers.id, producerId))
        .limit(1);
      if (!producer) return null;
      const [existing] = await tx
        .select({ id: producerIntakeLinks.id, slug: producerIntakeLinks.slug, active: producerIntakeLinks.active })
        .from(producerIntakeLinks)
        .where(eq(producerIntakeLinks.producerId, producerId))
        .limit(1);
      if (existing) return existing;
      const [row] = await tx
        .insert(producerIntakeLinks)
        .values({ orgId: ctx.orgId, producerId, slug: newSlug() })
        .returning({ id: producerIntakeLinks.id, slug: producerIntakeLinks.slug, active: producerIntakeLinks.active });
      if (!row) throw new Error('alta de link: el insert no devolvió fila');
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'create_intake_link',
        entityType: 'producer_intake_link',
        entityId: row.id,
        payload: { producerId },
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Productor no encontrado.' });
      return;
    }
    res.status(201).json(out);
  }),
);

// POST /api/v1/producer-intake-links/:id/rotate — slug nuevo, el viejo muere
// al instante (links filtrados o abusados; O-183).
intakeLinksRouter.post(
  '/:id/rotate',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [row] = await tx
        .update(producerIntakeLinks)
        .set({ slug: newSlug(), active: true, rotatedAt: new Date(), updatedAt: new Date() })
        .where(eq(producerIntakeLinks.id, id))
        .returning({ id: producerIntakeLinks.id, slug: producerIntakeLinks.slug, active: producerIntakeLinks.active });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'rotate_intake_link',
        entityType: 'producer_intake_link',
        entityId: row.id,
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Link no encontrado.' });
      return;
    }
    res.json(out);
  }),
);
