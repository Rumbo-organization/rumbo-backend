// Endpoints INTERNOS de pre-denuncias (docs/rumbo/17-pre-denuncias.md):
// lista + detalle, convertir/rechazar (Slice 2), descarga de adjuntos y link
// puntual por póliza (Slices 3-4), y gestión de los links públicos por
// productor (crear + rotar). Heredan requireAuthedOrg del router v1; todas
// las queries corren bajo withAuthedTx (RLS: tenant + producer_scope — el
// organizador ve todo, el productor su cartera).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, or, sql } from 'drizzle-orm';

import { withAuthedTx, schema } from '../db/client.js';
import { writeAuditLogTx } from '../audit.js';
import { getObject, isR2Configured } from '../r2.js';

const { claimIntakes, claims, contacts, documents, insurers, policies, producerIntakeLinks, producers } = schema;

const INTAKE_STATUS_LABEL: Record<string, string> = {
  pendiente: 'Pendiente',
  convertida: 'Convertida',
  rechazada: 'Rechazada',
  vencida: 'Vencida',
  borrador: 'Esperando al cliente',
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

      // Pólizas sugeridas para la conversión, RANKEADAS (doc 17: patente >
      // ramo declarado > vigente > fin de vigencia). Universo: la póliza
      // matcheada por patente + las del contacto matcheado. Si no hay match,
      // el drawer cae al picker de pólizas general.
      const inc = r.intake.incidente as Record<string, unknown>;
      const suggested: {
        id: string;
        num: string | null;
        insurer: string;
        ramo: string;
        status: string;
        byPatente: boolean;
        sameRamo: boolean;
      }[] = [];
      if (r.intake.matchedPolicyId || r.intake.matchedContactId) {
        const conds = [];
        if (r.intake.matchedPolicyId) conds.push(eq(policies.id, r.intake.matchedPolicyId));
        if (r.intake.matchedContactId) conds.push(eq(policies.contactId, r.intake.matchedContactId));
        const polRows = await tx
          .select({
            id: policies.id,
            num: policies.policyNumber,
            ramo: policies.ramo,
            status: policies.status,
            endDate: policies.endDate,
            insurer: insurers.name,
          })
          .from(policies)
          .innerJoin(insurers, eq(insurers.id, policies.insurerId))
          .where(conds.length > 1 ? or(...conds) : conds[0])
          .limit(12);
        for (const p of polRows) {
          suggested.push({
            id: p.id,
            num: p.num,
            insurer: p.insurer,
            ramo: p.ramo,
            status: p.status,
            byPatente: p.id === r.intake.matchedPolicyId,
            sameRamo: p.ramo === (inc.ramo as string),
          });
        }
        suggested.sort(
          (a, b) =>
            Number(b.byPatente) - Number(a.byPatente) ||
            Number(b.sameRamo) - Number(a.sameRamo) ||
            Number(b.status === 'vigente') - Number(a.status === 'vigente'),
        );
      }

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
        suggestedPolicies: suggested,
        // Adjuntos (Slice 3): metadata para listarlos; el binario se baja por
        // GET /intakes/:id/attachments/:index. La key de R2 no se expone.
        attachments: (r.intake.attachments ?? []).map((a, ix) => ({
          index: ix,
          fileName: (a as Record<string, unknown>).fileName ?? 'adjunto',
          sizeBytes: (a as Record<string, unknown>).sizeBytes ?? 0,
          slot: (a as Record<string, unknown>).slot ?? null,
        })),
        // Modo B: vencimiento del link (visible para el PAS en borradores).
        expiresAt: r.intake.expiresAt ? r.intake.expiresAt.toISOString() : null,
      };
    });
    if (!out) {
      res.status(404).json({ error: 'Pre-denuncia no encontrada.' });
      return;
    }
    res.json(out);
  }),
);

// ── Adjuntos y Modo B (Slices 3-4) ───────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// GET /api/v1/intakes/:id/attachments/:index — descarga autenticada de un
// adjunto del intake (RLS scopea; patrón download de documents.ts).
intakesRouter.get(
  '/:id/attachments/:index',
  wrap(async (req, res) => {
    const id = req.params.id;
    const index = parseInt(String(req.params.index ?? ''), 10);
    if (!isUuid(id) || !Number.isInteger(index) || index < 0 || index > 7) {
      res.status(400).json({ error: 'Adjunto inválido.' });
      return;
    }
    if (!isR2Configured()) {
      res.status(503).json({ error: 'El almacenamiento de adjuntos no está configurado todavía.' });
      return;
    }
    const att = await withAuthedTx(req.authCtx!, async tx => {
      const [row] = await tx
        .select({ attachments: claimIntakes.attachments })
        .from(claimIntakes)
        .where(eq(claimIntakes.id, id))
        .limit(1);
      return (row?.attachments?.[index] as Record<string, unknown> | undefined) ?? null;
    });
    if (!att || typeof att.key !== 'string') {
      res.status(404).json({ error: 'Adjunto no encontrado.' });
      return;
    }
    const obj = await getObject(att.key);
    res.setHeader('Content-Type', String(att.contentType ?? 'application/octet-stream'));
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${String(att.fileName ?? 'adjunto').replace(/[^\w. -]/g, '_')}"`,
    );
    res.send(Buffer.from(await obj.arrayBuffer()));
  }),
);

// POST /api/v1/intakes/policy-link { policyId } — Modo B: crea el intake
// `borrador` y devuelve el token PLANO (solo se ve acá; en DB queda el hash).
// El link /d/{token} es privado: se lo manda el PAS al titular y trae prefill.
intakesRouter.post(
  '/policy-link',
  wrap(async (req, res) => {
    const policyId = (req.body as Record<string, unknown> | undefined)?.policyId;
    if (!isUuid(policyId)) {
      res.status(400).json({ error: 'Póliza inválida.' });
      return;
    }
    const ctx = req.authCtx!;
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const out = await withAuthedTx(ctx, async tx => {
      const [policy] = await tx
        .select({ id: policies.id, producerId: policies.producerId })
        .from(policies)
        .where(eq(policies.id, policyId))
        .limit(1);
      if (!policy) return null;

      let row: { id: string } | undefined;
      for (let attempt = 0; attempt < 3 && !row; attempt++) {
        try {
          [row] = await tx
            .insert(claimIntakes)
            .values({
              orgId: ctx.orgId,
              producerId: policy.producerId ?? ctx.producerId,
              mode: 'policy_link',
              number: sql`(select coalesce(max(${claimIntakes.number}), 0) + 1 from ${claimIntakes} where ${claimIntakes.orgId} = ${ctx.orgId})`,
              status: 'borrador',
              declarante: {},
              aseguradoDeclarado: {},
              incidente: {},
              policyId: policy.id,
              tokenHash: sha256(token),
              expiresAt,
            })
            .returning({ id: claimIntakes.id });
        } catch (err) {
          if ((err as { code?: string }).code !== '23505' || attempt === 2) throw err;
        }
      }
      if (!row) throw new Error('policy-link: el insert no devolvió fila');
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'create_policy_intake_link',
        entityType: 'claim_intake',
        entityId: row.id,
        payload: { policyId: policy.id },
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Póliza no encontrada.' });
      return;
    }
    res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
  }),
);

// ── Convertir / Rechazar (Slice 2) ───────────────────────────────────────────

const CLAIM_BUCKETS = new Set([
  'robo',
  'choque',
  'incendio',
  'danos_agua',
  'granizo',
  'cristales',
  'resp_civil',
  'otros',
]);
const IMPORTANCES = new Set(['alta', 'media', 'baja']);

// Denunciante estructurado del intake → texto de claims.reported_by.
function reportedByOf(intake: typeof claimIntakes.$inferSelect): string {
  const decl = intake.declarante as Record<string, unknown>;
  const ase = intake.aseguradoDeclarado as Record<string, unknown>;
  const t = decl.tercero as Record<string, unknown> | undefined;
  if (t) return `Tercero: ${t.nombre} ${t.apellido} · DNI ${t.dni}`;
  return `El asegurado${ase.nombre ? ` (${ase.nombre})` : ''} · doc ${ase.doc}`;
}

// POST /api/v1/intakes/:id/convert { policyId, importance? } — crea el
// siniestro con los datos del intake (tipo bucket + tipo_detalle específico,
// fecha+hora, lugar, relato, denunciante) y marca la pre-denuncia convertida.
// Solo desde `pendiente`. RLS scopea intake y póliza (404 si son ajenos).
intakesRouter.post(
  '/:id/convert',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const policyId = b.policyId;
    if (!isUuid(policyId)) {
      res.status(400).json({ error: 'Elegí la póliza del siniestro.' });
      return;
    }
    const importance = typeof b.importance === 'string' && IMPORTANCES.has(b.importance) ? b.importance : null;

    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [intake] = await tx.select().from(claimIntakes).where(eq(claimIntakes.id, id)).limit(1);
      if (!intake) return { error: 404 as const };
      if (intake.status !== 'pendiente') return { error: 409 as const };
      const [policy] = await tx.select({ id: policies.id }).from(policies).where(eq(policies.id, policyId)).limit(1);
      if (!policy) return { error: 400 as const, msg: 'Póliza no encontrada en tu cartera.' };

      const inc = intake.incidente as Record<string, unknown>;
      const bucket = CLAIM_BUCKETS.has(inc.bucket as string) ? (inc.bucket as 'otros') : 'otros';
      // Córdoba es UTC-3 todo el año: fecha+hora declaradas → timestamp.
      const occurredAt = new Date(`${inc.fecha}T${inc.hora}:00-03:00`);
      const location = [inc.direccion, inc.localidad, inc.provincia].filter(Boolean).join(', ');

      const [claim] = await tx
        .insert(claims)
        .values({
          orgId: ctx.orgId,
          policyId: policy.id,
          tipo: bucket,
          tipoDetalle: (inc.tipoLabel as string) ?? null,
          importance: importance as 'alta' | null,
          occurredAt,
          reportedBy: reportedByOf(intake),
          location: location || null,
          description: (inc.relato as string) ?? null,
        })
        .returning({ id: claims.id });
      if (!claim) throw new Error('convertir intake: el insert del siniestro no devolvió fila');

      // Promoción de adjuntos (Slice 3): una fila de `documents` por adjunto,
      // colgada del siniestro. El binario NO se copia — misma key de R2.
      const atts = (intake.attachments ?? []) as Record<string, unknown>[];
      for (const a of atts) {
        if (typeof a.key !== 'string') continue;
        await tx.insert(documents).values({
          orgId: ctx.orgId,
          claimId: claim.id,
          fileName: String(a.fileName ?? 'adjunto'),
          contentType: String(a.contentType ?? 'application/octet-stream'),
          sizeBytes: Number(a.sizeBytes ?? 0),
          storageKey: a.key,
          uploadedByUserId: ctx.userId,
        });
      }

      await tx
        .update(claimIntakes)
        .set({ status: 'convertida', convertedClaimId: claim.id, updatedAt: new Date() })
        .where(eq(claimIntakes.id, id));
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'convert_intake',
        entityType: 'claim_intake',
        entityId: id,
        payload: { claimId: claim.id, policyId: policy.id },
      });
      return { claimId: claim.id };
    });

    if ('error' in out) {
      if (out.error === 404) res.status(404).json({ error: 'Pre-denuncia no encontrada.' });
      else if (out.error === 409) res.status(409).json({ error: 'La pre-denuncia ya fue resuelta.' });
      else res.status(400).json({ error: out.msg ?? 'Datos inválidos.' });
      return;
    }
    res.status(201).json({ claimId: out.claimId });
  }),
);

// POST /api/v1/intakes/:id/reject { reason? } — terminal, con motivo opcional
// (la competencia rechaza sin motivo; el nuestro alimenta calidad del canal).
intakesRouter.post(
  '/:id/reject',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const reasonRaw = (req.body as Record<string, unknown> | undefined)?.reason;
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() !== '' ? reasonRaw.trim().slice(0, 500) : null;

    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [row] = await tx
        .update(claimIntakes)
        .set({ status: 'rechazada', rejectReason: reason, updatedAt: new Date() })
        .where(and(eq(claimIntakes.id, id), eq(claimIntakes.status, 'pendiente')))
        .returning({ id: claimIntakes.id });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'reject_intake',
        entityType: 'claim_intake',
        entityId: id,
        ...(reason ? { payload: { reason } } : {}),
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Pre-denuncia no encontrada o ya resuelta.' });
      return;
    }
    res.json({ ok: true });
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
