// Endpoints PÚBLICOS de pre-denuncias (Slice 1, docs/rumbo/17-pre-denuncias.md).
//
// Sin sesión: los consume el formulario que completa el asegurado (o un
// tercero) desde el link del productor (/d/:slug en el SPA). Corren con el
// cliente OWNER (bypass RLS) scopeados a mano por el slug del link — mismo
// patrón que el cron (batch/sistema).
//
// Reglas duras del doc 17 que este archivo implementa:
//   1. NUNCA se escribe en contacts/policies: todo lo declarado va al jsonb
//      del intake; el alta/match real sucede al Convertir (Slice 2).
//   2. CERO eco de PII: el lookup devuelve solo { matched: boolean }; el match
//      (contactId/policyId) se guarda para el PAS, jamás se responde al
//      visitante; los emails al declarante usan SOLO datos declarados.
//   3. El slug es rotable; acá solo se resuelven links activos.
//
// El rate limit del montaje (app.ts) acota los POST por IP; GET queda libre
// (payload mínimo). Validación hand-rolled como routes/calendar.ts.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { and, eq, or, sql } from 'drizzle-orm';

import { db, schema } from '../db/client.js';
import { sendEmail } from '../email.js';
import { INTAKE_CATALOG, findRamo, findTipo } from '../lib/claim-intake-catalog.js';

const { claimIntakes, contacts, members, organizations, policyRisks, producerIntakeLinks, producers, users } = schema;

// ── Helpers ──────────────────────────────────────────────────────────────────

const isSlug = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{10,64}$/.test(s);
const digits = (v: unknown): string => (typeof v === 'string' ? v.replace(/\D/g, '') : '');
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t !== '' && t.length <= max ? t : null;
};
const isEmail = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isHm = (s: unknown): s is string => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);

// 'YYYY-MM-DD' de hoy en huso AR (mismo criterio que expiry-job).
function todayAr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' });
}

function firstWord(s: string | null | undefined): string {
  return (s ?? '').trim().split(/\s+/)[0] || '';
}

interface LinkCtx {
  orgId: string;
  orgName: string;
  producerId: string;
  producerName: string;
}

async function resolveLink(slug: string): Promise<LinkCtx | null> {
  const [row] = await db
    .select({
      orgId: producerIntakeLinks.orgId,
      producerId: producerIntakeLinks.producerId,
      orgName: organizations.name,
      producerName: producers.name,
    })
    .from(producerIntakeLinks)
    .innerJoin(producers, eq(producers.id, producerIntakeLinks.producerId))
    .innerJoin(organizations, eq(organizations.id, producerIntakeLinks.orgId))
    .where(and(eq(producerIntakeLinks.slug, slug), eq(producerIntakeLinks.active, true)))
    .limit(1);
  return row ?? null;
}

// ── Validación del submit ────────────────────────────────────────────────────

interface SubmitInput {
  declarante: Record<string, unknown>;
  aseguradoDeclarado: Record<string, unknown>;
  incidente: Record<string, unknown>;
}

function parseSubmit(body: unknown): { data: SubmitInput } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;

  // Quién completa.
  const kind = b.declaranteKind === 'tercero' ? 'tercero' : b.declaranteKind === 'asegurado' ? 'asegurado' : null;
  if (!kind) return { error: 'Indicá quién completa la pre-denuncia.' };

  let tercero: Record<string, unknown> | undefined;
  if (kind === 'tercero') {
    const t = (b.tercero ?? {}) as Record<string, unknown>;
    const nombre = str(t.nombre, 120);
    const apellido = str(t.apellido, 120);
    const dni = digits(t.dni);
    const email = t.email;
    if (!nombre || !apellido) return { error: 'Completá nombre y apellido de quien realiza la denuncia.' };
    if (dni.length < 6 || dni.length > 11) return { error: 'El DNI de quien denuncia no parece válido.' };
    if (!isEmail(email)) return { error: 'El email de quien denuncia no parece válido.' };
    const telefono = str(t.telefono, 40);
    tercero = { nombre, apellido, dni, email, ...(telefono ? { telefono } : {}) };
  }

  // Asegurado declarado.
  const a = (b.asegurado ?? {}) as Record<string, unknown>;
  const doc = digits(a.doc);
  if (doc.length < 6 || doc.length > 11) return { error: 'El DNI o CUIT del asegurado no parece válido.' };
  const aseguradoNombre = str(a.nombre, 160);
  const aseguradoTelefono = str(a.telefono, 40);
  const aseguradoEmail = a.email;
  if (!aseguradoTelefono) return { error: 'Completá un teléfono de contacto del asegurado.' };
  if (!isEmail(aseguradoEmail)) return { error: 'El email del asegurado no parece válido.' };

  // Incidente.
  const i = (b.incidente ?? {}) as Record<string, unknown>;
  const ramo = findRamo(i.ramo);
  if (!ramo) return { error: 'Elegí qué bien está asegurado.' };
  const tipo = findTipo(i.ramo, i.tipo);
  if (!tipo) return { error: 'Elegí qué pasó.' };
  if (!isYmd(i.fecha)) return { error: 'La fecha del siniestro no es válida.' };
  if (i.fecha > todayAr()) return { error: 'La fecha del siniestro no puede ser futura.' };
  if (i.fecha < '2000-01-01') return { error: 'La fecha del siniestro no es válida.' };
  if (!isHm(i.hora)) return { error: 'La hora del siniestro no es válida (HH:MM).' };
  const provincia = str(i.provincia, 80);
  const localidad = str(i.localidad, 120);
  if (!provincia || !localidad) return { error: 'Completá provincia y localidad del siniestro.' };
  const direccion = str(i.direccion, 200);
  const bien = str(i.bien, 60);
  const relato = str(i.relato, 4000);
  if (!relato || relato.length < 10) return { error: 'Contanos qué pasó (al menos unas palabras).' };

  if (b.consent !== true) return { error: 'Necesitamos tu consentimiento para procesar los datos.' };

  return {
    data: {
      declarante: { kind, ...(tercero ? { tercero } : {}) },
      aseguradoDeclarado: {
        doc,
        ...(aseguradoNombre ? { nombre: aseguradoNombre } : {}),
        telefono: aseguradoTelefono,
        email: aseguradoEmail,
      },
      incidente: {
        ramo: ramo.code,
        ramoLabel: ramo.label,
        tipo: tipo.code,
        tipoLabel: tipo.label,
        bucket: tipo.bucket,
        fecha: i.fecha,
        hora: i.hora,
        provincia,
        localidad,
        ...(direccion ? { direccion } : {}),
        ...(bien ? { bien } : {}),
        relato,
      },
    },
  };
}

// ── Emails ───────────────────────────────────────────────────────────────────

interface IntakeMailCtx {
  number: number;
  link: LinkCtx;
  data: SubmitInput;
  matchedContact: boolean;
  matchedPolicyNumber: string | null;
}

// Al declarante: SOLO datos declarados (regla #2 — nada del match). Reply-to:
// el productor, para que la respuesta del cliente le llegue a él.
function composeConfirmEmail(ctx: IntakeMailCtx): { subject: string; text: string } {
  const { declarante, aseguradoDeclarado, incidente } = ctx.data;
  const tercero = declarante.tercero as Record<string, unknown> | undefined;
  const nombre = firstWord((tercero?.nombre as string) ?? (aseguradoDeclarado.nombre as string));
  return {
    subject: `Pre-denuncia N° ${ctx.number} recibida`,
    text: [
      `Hola${nombre ? ` ${nombre}` : ''},`,
      '',
      `Recibimos tu pre-denuncia N° ${ctx.number}: ${incidente.tipoLabel} (${incidente.ramoLabel}), ocurrido el ${incidente.fecha} a las ${incidente.hora}.`,
      '',
      `${ctx.link.producerName} va a gestionar la denuncia formal en la compañía de seguros y se va a contactar con vos.`,
      'Si querés agregar información, respondé este correo.',
      '',
      'Saludos,',
      ctx.link.producerName,
      ctx.link.orgName !== ctx.link.producerName ? ctx.link.orgName : '',
    ]
      .filter((l, idx, arr) => !(l === '' && arr[idx - 1] === ''))
      .join('\n')
      .trimEnd(),
  };
}

// Al PAS/organizador: resumen operativo + matcheos + deep link. Reply-to: el
// declarante (responder = contestarle al cliente).
function composePasEmail(ctx: IntakeMailCtx, appUrl: string): { subject: string; text: string } {
  const { declarante, aseguradoDeclarado, incidente } = ctx.data;
  const tercero = declarante.tercero as Record<string, unknown> | undefined;
  const nombreAsegurado = (aseguradoDeclarado.nombre as string) ?? '(en cartera)';
  const relato = incidente.relato as string;
  return {
    subject: `Nueva pre-denuncia N° ${ctx.number} — ${incidente.tipoLabel} · ${nombreAsegurado}`,
    text: [
      `Entró una pre-denuncia por el link de ${ctx.link.producerName}.`,
      '',
      `Asegurado (declarado): ${nombreAsegurado} · doc ${aseguradoDeclarado.doc}`,
      `Contacto declarado: ${aseguradoDeclarado.telefono} · ${aseguradoDeclarado.email}`,
      tercero
        ? `La completó un tercero: ${tercero.nombre} ${tercero.apellido} · DNI ${tercero.dni} · ${tercero.email}`
        : 'La completó el asegurado.',
      '',
      `Qué pasó: ${incidente.tipoLabel} (${incidente.ramoLabel})`,
      `Cuándo: ${incidente.fecha} ${incidente.hora}`,
      `Dónde: ${[incidente.direccion, incidente.localidad, incidente.provincia].filter(Boolean).join(', ')}`,
      incidente.bien ? `Bien: ${incidente.bien}` : '',
      '',
      `Relato: ${relato.length > 600 ? `${relato.slice(0, 600)}…` : relato}`,
      '',
      `En cartera: ${ctx.matchedContact ? 'contacto encontrado por documento' : 'sin match por documento'}${
        ctx.matchedPolicyNumber ? ` · póliza sugerida por patente: ${ctx.matchedPolicyNumber}` : ''
      }`,
      '',
      appUrl ? `Verla en Rumbo: ${appUrl}/?goto=pre-denuncias` : '',
    ]
      .filter((l, idx, arr) => !(l === '' && arr[idx - 1] === ''))
      .join('\n')
      .trimEnd(),
  };
}

// ── Router ───────────────────────────────────────────────────────────────────

export const publicIntake = Router();

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

// GET /api/public/pre-denuncia/:slug — branding mínimo + catálogo. Nunca PII.
publicIntake.get(
  '/pre-denuncia/:slug',
  wrap(async (req, res) => {
    if (!isSlug(req.params.slug)) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    const link = await resolveLink(req.params.slug);
    if (!link) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    res.json({
      producer: link.producerName,
      org: link.orgName,
      catalog: INTAKE_CATALOG.map(r => ({
        code: r.code,
        label: r.label,
        publicLabel: r.publicLabel,
        tipos: r.tipos.map(t => ({ code: t.code, label: t.label })),
      })),
    });
  }),
);

// POST /api/public/pre-denuncia/:slug/lookup — { doc } → { matched }. Solo el
// booleano: el dato del match queda para el PAS (B-78 de la competencia).
publicIntake.post(
  '/pre-denuncia/:slug/lookup',
  wrap(async (req, res) => {
    if (!isSlug(req.params.slug)) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    const link = await resolveLink(req.params.slug);
    if (!link) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    const doc = digits((req.body as Record<string, unknown> | undefined)?.doc);
    if (doc.length < 6 || doc.length > 11) {
      res.json({ matched: false });
      return;
    }
    const [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, link.orgId), or(eq(contacts.dni, doc), eq(contacts.cuit, doc))))
      .limit(1);
    res.json({ matched: Boolean(row) });
  }),
);

// POST /api/public/pre-denuncia/:slug — el submit. Crea el intake (owner, con
// numeración por org y retry sobre el unique), matchea en silencio y dispara
// los dos emails (resilientes: un email caído no pierde la pre-denuncia).
publicIntake.post(
  '/pre-denuncia/:slug',
  wrap(async (req, res) => {
    if (!isSlug(req.params.slug)) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    const link = await resolveLink(req.params.slug);
    if (!link) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    const parsed = parseSubmit(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { data } = parsed;

    // Match silencioso: contacto por documento declarado.
    const doc = data.aseguradoDeclarado.doc as string;
    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, link.orgId), or(eq(contacts.dni, doc), eq(contacts.cuit, doc))))
      .limit(1);
    // Sin match y sin nombre declarado no hay forma de identificar a la persona.
    if (!contact && !data.aseguradoDeclarado.nombre) {
      res.status(400).json({ error: 'Completá el nombre del asegurado.' });
      return;
    }

    // Match silencioso: póliza por patente/bien (normalizado alfanumérico).
    let matchedPolicyId: string | null = null;
    let matchedPolicyNumber: string | null = null;
    const bienNorm = ((data.incidente.bien as string) ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (bienNorm.length >= 5 && bienNorm.length <= 10) {
      const [risk] = await db
        .select({ policyId: policyRisks.policyId })
        .from(policyRisks)
        .where(
          and(
            eq(policyRisks.orgId, link.orgId),
            sql`upper(regexp_replace(coalesce(${policyRisks.patente}, ''), '[^A-Za-z0-9]', '', 'g')) = ${bienNorm}`,
          ),
        )
        .limit(1);
      if (risk) {
        matchedPolicyId = risk.policyId;
        const [pol] = await db
          .select({ policyNumber: schema.policies.policyNumber })
          .from(schema.policies)
          .where(eq(schema.policies.id, risk.policyId))
          .limit(1);
        matchedPolicyNumber = pol?.policyNumber ?? null;
      }
    }

    // Insert con numeración por org: max+1 en el mismo statement; ante la
    // carrera (unique org+number) se reintenta.
    let number = 0;
    let intakeId: string | null = null;
    for (let attempt = 0; attempt < 3 && !intakeId; attempt++) {
      try {
        const [row] = await db
          .insert(claimIntakes)
          .values({
            orgId: link.orgId,
            producerId: link.producerId,
            mode: 'producer_link',
            number: sql`(select coalesce(max(${claimIntakes.number}), 0) + 1 from ${claimIntakes} where ${claimIntakes.orgId} = ${link.orgId})`,
            declarante: data.declarante,
            aseguradoDeclarado: data.aseguradoDeclarado,
            incidente: data.incidente,
            matchedContactId: contact?.id ?? null,
            matchedPolicyId,
            consentAt: new Date(),
          })
          .returning({ id: claimIntakes.id, number: claimIntakes.number });
        if (row) {
          intakeId = row.id;
          number = row.number;
        }
      } catch (err) {
        if ((err as { code?: string }).code !== '23505' || attempt === 2) throw err;
      }
    }
    if (!intakeId) {
      res.status(500).json({ error: 'No pudimos registrar la pre-denuncia. Probá de nuevo.' });
      return;
    }

    // Destinatarios internos: productor con cuenta + organizador (owner).
    const [producerUser] = await db
      .select({ email: users.email })
      .from(producers)
      .innerJoin(users, eq(users.id, producers.userId))
      .where(eq(producers.id, link.producerId))
      .limit(1);
    const [owner] = await db
      .select({ email: users.email })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, link.orgId), eq(members.role, 'owner')))
      .limit(1);

    const mailCtx: IntakeMailCtx = {
      number,
      link,
      data,
      matchedContact: Boolean(contact),
      matchedPolicyNumber,
    };
    const appUrl = process.env.APP_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? '';
    const declaranteEmail = ((data.declarante.tercero as Record<string, unknown>)?.email ??
      data.aseguradoDeclarado.email) as string;
    const pasReplyTo = producerUser?.email ?? owner?.email;

    try {
      await sendEmail({
        to: declaranteEmail,
        ...composeConfirmEmail(mailCtx),
        ...(pasReplyTo ? { replyTo: pasReplyTo } : {}),
      });
    } catch (err) {
      console.error(`[public-intake] email al declarante falló (intake ${intakeId}):`, err);
    }
    const internos = [...new Set([producerUser?.email, owner?.email].filter((e): e is string => Boolean(e)))];
    for (const to of internos) {
      try {
        await sendEmail({ to, ...composePasEmail(mailCtx, appUrl), replyTo: declaranteEmail });
      } catch (err) {
        console.error(`[public-intake] email interno a ${to} falló (intake ${intakeId}):`, err);
      }
    }

    res.status(201).json({ number });
  }),
);
