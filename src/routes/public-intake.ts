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
//   2. CERO eco de PII: el lookup devuelve { matched } + nombre ENMASCARADO
//      ("R*** P***", nunca completo, jamás teléfono/email); el match
//      (contactId/policyId) se guarda para el PAS, jamás se responde al
//      visitante; los emails al declarante usan SOLO datos declarados.
//   3. El slug es rotable; acá solo se resuelven links activos.
//
// El rate limit del montaje (app.ts) acota los POST por IP; GET queda libre
// (payload mínimo). Validación hand-rolled como routes/calendar.ts.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import multer from 'multer';

import { db, schema } from '../db/client.js';
import { sendEmail } from '../email.js';
import { isR2Configured, putObject } from '../r2.js';
import { INTAKE_CATALOG, findRamo, findTipo } from '../lib/claim-intake-catalog.js';

const { claimIntakes, contacts, members, organizations, policies, policyRisks, producerIntakeLinks, producers, users } =
  schema;

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

// 'HH:MM' de la hora actual en huso AR (para rechazar horas futuras del día de
// hoy: un siniestro que aún no ocurrió no se puede pre-denunciar). h23 evita el
// '24:00' de medianoche; ambos zero-padded → la comparación de strings alcanza.
function nowHmAr(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Cordoba',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
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

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Modo B: link puntual por póliza (Slice 4) ────────────────────────────────
//
// El token (secreto, hasheado en DB) apunta a un intake `borrador` creado al
// generar el link desde la póliza. Este link es PRIVADO (se lo mandó el PAS al
// titular), así que el prefill completo es legítimo — a diferencia del link
// por productor, que es público y no ecoa PII.

interface TokenCtx {
  intake: typeof claimIntakes.$inferSelect;
  link: LinkCtx;
  policyNumber: string | null;
  policyRamo: string | null;
  contactId: string | null;
  contact: {
    kind: string;
    firstName: string | null;
    lastName: string | null;
    legalName: string | null;
    dni: string | null;
    cuit: string | null;
    contactMethods: unknown;
  } | null;
}

async function resolveToken(raw: string): Promise<TokenCtx | null> {
  const hash = sha256(raw);
  const [row] = await db
    .select({
      intake: claimIntakes,
      orgName: organizations.name,
      producerName: producers.name,
      policyNumber: policies.policyNumber,
      policyRamo: policies.ramo,
      contactId: policies.contactId,
      cKind: contacts.kind,
      cFirst: contacts.firstName,
      cLast: contacts.lastName,
      cLegal: contacts.legalName,
      cDni: contacts.dni,
      cCuit: contacts.cuit,
      cMethods: contacts.contactMethods,
    })
    .from(claimIntakes)
    .innerJoin(organizations, eq(organizations.id, claimIntakes.orgId))
    .leftJoin(producers, eq(producers.id, claimIntakes.producerId))
    .leftJoin(policies, eq(policies.id, claimIntakes.policyId))
    .leftJoin(contacts, eq(contacts.id, policies.contactId))
    .where(and(eq(claimIntakes.tokenHash, hash), eq(claimIntakes.mode, 'policy_link')))
    .limit(1);
  if (!row) return null;
  return {
    intake: row.intake,
    link: {
      orgId: row.intake.orgId,
      orgName: row.orgName,
      producerId: row.intake.producerId ?? '',
      producerName: row.producerName ?? row.orgName,
    },
    policyNumber: row.policyNumber,
    policyRamo: row.policyRamo,
    contactId: row.contactId,
    contact: row.cKind
      ? {
          kind: row.cKind,
          firstName: row.cFirst,
          lastName: row.cLast,
          legalName: row.cLegal,
          dni: row.cDni,
          cuit: row.cCuit,
          contactMethods: row.cMethods,
        }
      : null,
  };
}

// Display completo del titular (para el prefill del Modo B; misma lógica que
// routes/v1.ts).
function fullName(c: { kind: string; firstName: string | null; lastName: string | null; legalName: string | null }) {
  if (c.kind === 'PERSONA_JURIDICA') return c.legalName ?? '';
  if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
  return c.lastName ?? c.firstName ?? '';
}

function methodValue(methods: unknown, type: string): string | null {
  if (!Array.isArray(methods)) return null;
  const rows = (methods as Array<{ type?: string; value?: string; primary?: boolean }>).filter(
    m => m.value?.trim() && (type === 'phone' ? m.type !== 'email' : m.type === 'email'),
  );
  return (rows.find(m => m.primary) ?? rows[0])?.value?.trim() ?? null;
}

const tokenVigente = (i: typeof claimIntakes.$inferSelect) =>
  i.status === 'borrador' && i.expiresAt !== null && i.expiresAt > new Date();

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
  if (i.fecha === todayAr() && i.hora > nowHmAr()) return { error: 'La hora del siniestro no puede ser futura.' };
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

const publicCatalog = (only?: string | null) =>
  INTAKE_CATALOG.filter(r => !only || r.code === only).map(r => ({
    code: r.code,
    label: r.label,
    publicLabel: r.publicLabel,
    tipos: r.tipos.map(t => ({ code: t.code, label: t.label })),
  }));

// GET /api/public/pre-denuncia/:slug — resolución DUAL: link por productor
// (Modo A: branding + catálogo, nunca PII) o token por póliza (Modo B:
// catálogo del ramo + prefill completo del titular — el link es privado).
publicIntake.get(
  '/pre-denuncia/:slug',
  wrap(async (req, res) => {
    if (!isSlug(req.params.slug)) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    const link = await resolveLink(req.params.slug);
    if (link) {
      res.json({
        mode: 'producer_link',
        producer: link.producerName,
        org: link.orgName,
        catalog: publicCatalog(),
      });
      return;
    }

    const tok = await resolveToken(req.params.slug);
    if (!tok) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    if (tok.intake.status !== 'borrador') {
      res.status(410).json({ error: 'Esta pre-denuncia ya fue enviada. Tu productor la está gestionando.' });
      return;
    }
    if (!tokenVigente(tok.intake)) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    // Patente del riesgo de la póliza (si hay), para prefill del bien.
    let patente: string | null = null;
    if (tok.intake.policyId) {
      const [risk] = await db
        .select({ patente: policyRisks.patente })
        .from(policyRisks)
        .where(eq(policyRisks.policyId, tok.intake.policyId))
        .limit(1);
      patente = risk?.patente ?? null;
    }
    const ramoCode = findRamo(tok.policyRamo)?.code ?? null;
    res.json({
      mode: 'policy_link',
      producer: tok.link.producerName,
      org: tok.link.orgName,
      catalog: publicCatalog(ramoCode),
      prefill: {
        nombre: tok.contact ? fullName(tok.contact) : '',
        doc: tok.contact?.dni ?? tok.contact?.cuit ?? '',
        telefono: tok.contact ? (methodValue(tok.contact.contactMethods, 'phone') ?? '') : '',
        email: tok.contact ? (methodValue(tok.contact.contactMethods, 'email') ?? '') : '',
        ramo: ramoCode,
        bien: patente ?? '',
        policyNumber: tok.policyNumber,
      },
    });
  }),
);

// Nombre enmascarado para el feedback del lookup ("R*** P***"): suficiente
// para que el asegurado confirme que lo identificamos bien (y detecte un DNI
// mal tipeado), inútil para enumerar la cartera. Es el máximo de PII que la
// superficie pública devuelve (doc 17, regla #2 — nunca nombre completo,
// teléfono ni email, que es la fuga B-78 de la competencia).
function maskName(c: {
  kind: string;
  firstName: string | null;
  lastName: string | null;
  legalName: string | null;
}): string {
  const full =
    c.kind === 'PERSONA_JURIDICA' ? (c.legalName ?? '') : [c.firstName, c.lastName].filter(Boolean).join(' ');
  return full
    .split(/\s+/)
    .filter(Boolean)
    .map(w => (w.length <= 2 ? `${w[0]}.` : `${w[0]}***`))
    .join(' ');
}

// POST /api/public/pre-denuncia/:slug/lookup — { doc } → { matched, nombre? }
// con el nombre ENMASCARADO. El match real (contactId) queda para el PAS.
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
      .select({
        id: contacts.id,
        kind: contacts.kind,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        legalName: contacts.legalName,
      })
      .from(contacts)
      .where(and(eq(contacts.orgId, link.orgId), or(eq(contacts.dni, doc), eq(contacts.cuit, doc))))
      .limit(1);
    if (!row) {
      res.json({ matched: false });
      return;
    }
    const nombre = maskName(row);
    res.json({ matched: true, ...(nombre ? { nombre } : {}) });
  }),
);

// POST /api/public/pre-denuncia/:slug — el submit, DUAL como el GET.
// Modo A (link por productor): INSERT con numeración por org y match
// silencioso. Modo B (token por póliza): UPDATE del borrador (match conocido:
// el titular y la póliza del link). En ambos: dos emails resilientes y un
// uploadToken para subir adjuntos (Slice 3).
publicIntake.post(
  '/pre-denuncia/:slug',
  wrap(async (req, res) => {
    if (!isSlug(req.params.slug)) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    const link = await resolveLink(req.params.slug);
    const tok = link ? null : await resolveToken(req.params.slug);
    if (!link && !tok) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }
    if (tok && tok.intake.status !== 'borrador') {
      res.status(410).json({ error: 'Esta pre-denuncia ya fue enviada.' });
      return;
    }
    if (tok && !tokenVigente(tok.intake)) {
      res.status(404).json({ error: 'Link inválido o vencido.' });
      return;
    }

    const parsed = parseSubmit(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { data } = parsed;

    const uploadToken = randomBytes(24).toString('base64url');
    const uploadTokenHash = sha256(uploadToken);

    let linkCtx: LinkCtx;
    let number = 0;
    let intakeId: string | null = null;
    let contactMatched = false;
    let matchedPolicyNumber: string | null = null;

    if (tok) {
      // ── Modo B: completar el borrador ──────────────────────────────────────
      linkCtx = tok.link;
      contactMatched = Boolean(tok.contactId);
      matchedPolicyNumber = tok.policyNumber;
      const [row] = await db
        .update(claimIntakes)
        .set({
          declarante: data.declarante,
          aseguradoDeclarado: data.aseguradoDeclarado,
          incidente: data.incidente,
          matchedContactId: tok.contactId,
          matchedPolicyId: tok.intake.policyId,
          status: 'pendiente',
          consentAt: new Date(),
          submittedAt: new Date(),
          uploadTokenHash,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(claimIntakes.id, tok.intake.id),
            eq(claimIntakes.status, 'borrador'),
            gt(claimIntakes.expiresAt, new Date()),
          ),
        )
        .returning({ id: claimIntakes.id, number: claimIntakes.number });
      if (!row) {
        res.status(404).json({ error: 'Link inválido o vencido.' });
        return;
      }
      intakeId = row.id;
      number = row.number;
    } else {
      // ── Modo A: alta nueva con match silencioso ────────────────────────────
      linkCtx = link!;

      // Contacto por documento declarado.
      const doc = data.aseguradoDeclarado.doc as string;
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.orgId, linkCtx.orgId), or(eq(contacts.dni, doc), eq(contacts.cuit, doc))))
        .limit(1);
      // Sin match y sin nombre declarado no hay forma de identificar a la persona.
      if (!contact && !data.aseguradoDeclarado.nombre) {
        res.status(400).json({ error: 'Completá el nombre del asegurado.' });
        return;
      }
      contactMatched = Boolean(contact);

      // Póliza por patente/bien (normalizado alfanumérico).
      let matchedPolicyId: string | null = null;
      const bienNorm = ((data.incidente.bien as string) ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (bienNorm.length >= 5 && bienNorm.length <= 10) {
        const [risk] = await db
          .select({ policyId: policyRisks.policyId })
          .from(policyRisks)
          .where(
            and(
              eq(policyRisks.orgId, linkCtx.orgId),
              sql`upper(regexp_replace(coalesce(${policyRisks.patente}, ''), '[^A-Za-z0-9]', '', 'g')) = ${bienNorm}`,
            ),
          )
          .limit(1);
        if (risk) {
          matchedPolicyId = risk.policyId;
          const [pol] = await db
            .select({ policyNumber: policies.policyNumber })
            .from(policies)
            .where(eq(policies.id, risk.policyId))
            .limit(1);
          matchedPolicyNumber = pol?.policyNumber ?? null;
        }
      }

      // Insert con numeración por org: max+1 en el mismo statement; ante la
      // carrera (unique org+number) se reintenta.
      for (let attempt = 0; attempt < 3 && !intakeId; attempt++) {
        try {
          const [row] = await db
            .insert(claimIntakes)
            .values({
              orgId: linkCtx.orgId,
              producerId: linkCtx.producerId,
              mode: 'producer_link',
              number: sql`(select coalesce(max(${claimIntakes.number}), 0) + 1 from ${claimIntakes} where ${claimIntakes.orgId} = ${linkCtx.orgId})`,
              declarante: data.declarante,
              aseguradoDeclarado: data.aseguradoDeclarado,
              incidente: data.incidente,
              matchedContactId: contact?.id ?? null,
              matchedPolicyId,
              consentAt: new Date(),
              uploadTokenHash,
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
      .where(eq(producers.id, linkCtx.producerId))
      .limit(1);
    const [owner] = await db
      .select({ email: users.email })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, linkCtx.orgId), eq(members.role, 'owner')))
      .limit(1);

    const mailCtx: IntakeMailCtx = {
      number,
      link: linkCtx,
      data,
      matchedContact: contactMatched,
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

    // intakeId + uploadToken habilitan la subida de adjuntos (Slice 3): el id
    // solo sirve junto con el token (hasheado en la fila) y por 1 hora.
    res.status(201).json({ number, intakeId, uploadToken });
  }),
);

// ── Adjuntos (Slice 3) ───────────────────────────────────────────────────────
//
// Un archivo por request (Vercel capea el body en ~4.5 MB; el form comprime
// las imágenes client-side). Autoriza el uploadToken del submit, por una
// ventana de 1 hora y hasta 8 adjuntos. El binario va a R2 bajo key propia del
// intake; la metadata queda en el jsonb `attachments` (append atómico) hasta
// que la conversión la promueva a `documents`.

const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024; // techo real de Vercel ~4.5 MB
const ATTACHMENT_ALLOWED = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const ATTACHMENT_WINDOW_MS = 60 * 60 * 1000;
const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ATTACHMENT_MAX_BYTES } });

publicIntake.post(
  '/pre-denuncia/attachments/:intakeId',
  attachmentUpload.single('file'),
  wrap(async (req, res) => {
    if (!isR2Configured()) {
      res.status(503).json({ error: 'El almacenamiento de adjuntos no está configurado todavía.' });
      return;
    }
    const intakeId = String(req.params.intakeId ?? '');
    const idOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(intakeId);
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!idOk || !isSlug(token)) {
      res.status(404).json({ error: 'Subida no autorizada.' });
      return;
    }
    const file = req.file;
    if (!file || file.size === 0) {
      res.status(400).json({ error: 'Falta el archivo.' });
      return;
    }
    const contentType = file.mimetype || 'application/octet-stream';
    if (!ATTACHMENT_ALLOWED.has(contentType)) {
      res.status(400).json({ error: 'Formato no permitido (foto o PDF).' });
      return;
    }
    const slot = str(req.body?.slot, 60) ?? 'Adjunto';

    const [intake] = await db
      .select({
        orgId: claimIntakes.orgId,
        status: claimIntakes.status,
        submittedAt: claimIntakes.submittedAt,
        uploadTokenHash: claimIntakes.uploadTokenHash,
        attachments: claimIntakes.attachments,
      })
      .from(claimIntakes)
      .where(eq(claimIntakes.id, intakeId))
      .limit(1);
    if (
      !intake ||
      intake.status !== 'pendiente' ||
      !intake.uploadTokenHash ||
      intake.uploadTokenHash !== sha256(token) ||
      Date.now() - intake.submittedAt.getTime() > ATTACHMENT_WINDOW_MS ||
      (intake.attachments?.length ?? 0) >= 8
    ) {
      res.status(404).json({ error: 'Subida no autorizada.' });
      return;
    }

    const key = `${intake.orgId}/intake/${intakeId}/${randomUUID()}`;
    await putObject(key, new Uint8Array(file.buffer), contentType);

    const meta = {
      key,
      fileName: file.originalname || 'adjunto',
      contentType,
      sizeBytes: file.size,
      slot,
    };
    // Append atómico con re-chequeo del tope (dos subidas en paralelo no lo pisan).
    const updated = await db
      .update(claimIntakes)
      .set({
        attachments: sql`${claimIntakes.attachments} || ${JSON.stringify([meta])}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(claimIntakes.id, intakeId), sql`jsonb_array_length(${claimIntakes.attachments}) < 8`))
      .returning({ id: claimIntakes.id });
    if (!updated.length) {
      // No se pudo registrar (tope alcanzado en la carrera): limpiar el objeto.
      const { deleteObject } = await import('../r2.js');
      await deleteObject(key).catch(() => {});
      res.status(409).json({ error: 'Se alcanzó el máximo de adjuntos.' });
      return;
    }
    res.status(201).json({ ok: true });
  }),
);
