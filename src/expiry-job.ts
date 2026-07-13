// Job diario de avisos de vencimiento por email (Slice 5 de paridad; portado
// de server/expiry-notifications.ts + lib/expiry-notifications.ts del
// monolito, fiel en semántica).
//
// Dos salidas por corrida:
// - Digest interno: cada productor con cuenta recibe SUS pólizas por vencer;
//   el organizador (member owner) recibe las de toda la org. Misma casilla
//   (PAS solo) = un único email. Incluye "Tu agenda de hoy" (calendario).
// - Aviso al asegurado (gated por EXPIRY_EMAILS_TO_CONTACTS=on): un email por
//   póliza a la casilla del asegurado, reply-to su productor. Se loguea en
//   communications (channel email, template vencimiento).
//
// Ventanas 30/7 días con 2 de tolerancia hacia atrás. Dedup dura:
// expiry_notifications unique (policy, window); las filas se insertan al FINAL
// (un fallo intermedio reintenta mañana entero). Corre con el cliente owner
// (batch de sistema): RLS no aplica y el scoping por productor se hace acá.

import { and, eq, gte, inArray, isNull, lt, lte, notExists, sql } from 'drizzle-orm';

import { db, schema } from './db/client.js';
import { sendEmail, type SendEmailInput } from './email.js';

const {
  calendarEvents,
  claimIntakes,
  communications,
  contacts,
  expiryNotifications,
  insurers,
  members,
  organizations,
  policies,
  producers,
  users,
} = schema;

// ── Dominio puro ─────────────────────────────────────────────────────────────

export const EXPIRY_WINDOWS = [
  { window: '30d', days: 30 },
  { window: '7d', days: 7 },
] as const;
export const TOLERANCE_DAYS = 2;

// Labels FIELES de los 14 ramos (los emails no colapsan buckets como el BFF).
const RAMO_LABELS: Record<string, string> = {
  automotor: 'Automotor',
  motovehiculo: 'Motovehículo',
  hogar: 'Hogar',
  vida: 'Vida',
  art: 'ART',
  comercio: 'Comercio',
  accidentes_personales: 'Accidentes personales',
  incendio: 'Incendio',
  responsabilidad_civil: 'Responsabilidad civil',
  consorcio: 'Consorcio',
  seguro_tecnico: 'Seguro técnico',
  transporte: 'Transporte',
  embarcaciones: 'Embarcaciones',
  otros: 'Otros',
};
const PAYMENT_LABELS: Record<string, string> = {
  cupon: 'Cupón',
  debito_bancario: 'Débito bancario',
  tarjeta_credito: 'Tarjeta de crédito',
};
const EVENT_KIND_LABELS: Record<string, string> = {
  llamada: 'Llamada',
  reunion: 'Reunión',
  tramite: 'Trámite',
  otro: 'Otro',
};

export function todayAr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' });
}
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function formatDateAr(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}
function primaryEmail(methods: unknown): string | null {
  if (!Array.isArray(methods)) return null;
  const emails = (methods as Array<{ type?: string; value?: string; primary?: boolean }>).filter(
    m => m.type === 'email' && m.value?.trim(),
  );
  return (emails.find(m => m.primary) ?? emails[0])?.value?.trim() ?? null;
}
function displayName(c: {
  kind: string;
  firstName: string | null;
  lastName: string | null;
  legalName: string | null;
}): string {
  if (c.kind === 'PERSONA_JURIDICA') return c.legalName ?? '—';
  if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
  return c.lastName ?? c.firstName ?? '—';
}
// Para el saludo del email: nombre de pila (jurídicas: razón social completa).
// No derivar de contactName ("Apellido, Nombre"): partirlo saluda mal a
// jurídicas ("Hola S.A.") y a contactos con un solo nombre cargado.
function greetingName(c: {
  kind: string;
  firstName: string | null;
  lastName: string | null;
  legalName: string | null;
}): string {
  if (c.kind === 'PERSONA_JURIDICA') return c.legalName ?? '—';
  return c.firstName ?? c.lastName ?? '—';
}

interface DuePolicy {
  window: '30d' | '7d';
  policyId: string;
  orgId: string;
  orgName: string;
  policyNumber: string | null;
  ramo: string;
  endDate: string;
  contactId: string;
  contactName: string;
  contactFirstName: string;
  contactEmail: string | null;
  producerId: string | null;
  producerName: string | null;
  producerEmail: string | null;
  paymentMethod: string | null;
}
interface AgendaItem {
  id: string;
  title: string;
  time: string | null;
  kindLabel: string;
}
// Pre-denuncia pendiente de revisión (Slice 5): entra al digest todos los
// días hasta que el PAS la resuelva — ese es el empujón.
interface PendingIntake {
  id: string;
  orgId: string;
  producerId: string | null;
  number: number;
  tipoLabel: string;
  ramoLabel: string;
  nombre: string;
  daysAgo: number;
}

function paymentSuffix(pm: string | null): string {
  if (!pm) return '';
  if (pm === 'cupon') return ` | ${PAYMENT_LABELS[pm]} (contactar)`;
  return ` | ${PAYMENT_LABELS[pm] ?? pm}`;
}

export function composeDigest(
  rows: DuePolicy[],
  appUrl: string,
  agenda: AgendaItem[] = [],
  intakes: PendingIntake[] = [],
): Pick<SendEmailInput, 'subject' | 'text'> {
  const n = rows.length;
  const m = agenda.length;
  const k = intakes.length;
  const policyLines = rows
    .slice()
    .sort((a, b) => a.endDate.localeCompare(b.endDate))
    .map(
      r =>
        `• ${r.contactName} | ${RAMO_LABELS[r.ramo] ?? r.ramo}${r.policyNumber ? ` ${r.policyNumber}` : ''} | vence el ${formatDateAr(r.endDate)}${paymentSuffix(r.paymentMethod)}`,
    );
  const agendaLines = agenda
    .slice()
    .sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99'))
    .map(a => `• ${a.time ? `${a.time.slice(0, 5)} · ` : ''}${a.title} (${a.kindLabel})`);

  const intakeLines = intakes
    .slice()
    .sort((a, b) => b.daysAgo - a.daysAgo)
    .map(
      i =>
        `• N° ${i.number} · ${i.tipoLabel} (${i.ramoLabel}) · ${i.nombre} · ${i.daysAgo === 0 ? 'hoy' : i.daysAgo === 1 ? 'hace 1 día' : `hace ${i.daysAgo} días`}`,
    );

  const subjectBits: string[] = [];
  if (n > 0) subjectBits.push(`Vencimientos próximos: ${n} ${n === 1 ? 'póliza' : 'pólizas'}`);
  if (k > 0) subjectBits.push(`${k} pre-denuncia${k === 1 ? '' : 's'} sin revisar`);
  if (m > 0) subjectBits.push(`Hoy: ${m} en agenda`);
  const subject = subjectBits.join(' · ') || `Tu agenda de hoy: ${m} ${m === 1 ? 'evento' : 'eventos'}`;

  const parts: string[] = [];
  if (k > 0) {
    parts.push(
      k === 1 ? 'Tenés 1 pre-denuncia esperando revisión:' : `Tenés ${k} pre-denuncias esperando revisión:`,
      '',
      ...intakeLines,
      '',
      `Revisarlas en Rumbo: ${appUrl}/?goto=pre-denuncias`,
    );
  }
  if (m > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(
      m === 1 ? 'Tu agenda de hoy (1 evento):' : `Tu agenda de hoy (${m} eventos):`,
      '',
      ...agendaLines,
      '',
      `Ver el calendario: ${appUrl}/?goto=calendario`,
    );
  }
  if (n > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(
      n === 1 ? 'Tenés 1 póliza por vencer en tu cartera:' : `Tenés ${n} pólizas por vencer en tu cartera:`,
      '',
      ...policyLines,
      '',
      `Verlas en Rumbo: ${appUrl}/?goto=vencimientos`,
      '',
      'Las renovaciones se gestionan en el portal de cada compañía.',
    );
  }
  return { subject, text: parts.join('\n') };
}

export function composeContactEmail(row: DuePolicy): Pick<SendEmailInput, 'subject' | 'text'> {
  const firstName = row.contactFirstName;
  const producer = row.producerName ?? row.orgName;
  const ramoLabel = (RAMO_LABELS[row.ramo] ?? row.ramo).toLowerCase();
  return {
    subject: `Tu póliza de ${ramoLabel} vence el ${formatDateAr(row.endDate)}`,
    text: [
      `Hola ${firstName},`,
      '',
      `Te escribo para recordarte que tu póliza${row.policyNumber ? ` ${row.policyNumber}` : ''} de ${ramoLabel} vence el ${formatDateAr(row.endDate)}.`,
      '',
      'Si querés renovarla o revisar la cobertura, respondé este correo y lo coordinamos.',
      '',
      'Saludos,',
      producer,
      row.orgName !== producer ? row.orgName : '',
    ]
      .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
      .join('\n')
      .trimEnd(),
  };
}

export interface RunExpiryResult {
  policiesNotified: number;
  agendaItemsNotified: number;
  digestsSent: number;
  contactEmailsSent: number;
  sendFailures: string[];
}

// ── Job ──────────────────────────────────────────────────────────────────────

export async function runExpiryNotifications(
  opts: {
    send?: (email: SendEmailInput) => Promise<void>;
    today?: string;
    contactEmailsEnabled?: boolean;
    appUrl?: string;
  } = {},
): Promise<RunExpiryResult> {
  const send = opts.send ?? sendEmail;
  const today = opts.today ?? todayAr();
  const appUrl = opts.appUrl ?? process.env.APP_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? '';
  const contactEmailsEnabled = opts.contactEmailsEnabled ?? process.env.EXPIRY_EMAILS_TO_CONTACTS === 'on';

  // 0. Higiene del Modo B (Slice 5): borradores con el link vencido → vencida.
  await db
    .update(claimIntakes)
    .set({ status: 'vencida', updatedAt: new Date() })
    .where(and(eq(claimIntakes.status, 'borrador'), lt(claimIntakes.expiresAt, new Date())));

  // 1. Candidatas por ventana: vigentes, en ventana (con tolerancia), sin aviso previo.
  const due: DuePolicy[] = [];
  for (const { window, days } of EXPIRY_WINDOWS) {
    const rows = await db
      .select({
        policyId: policies.id,
        orgId: policies.orgId,
        orgName: organizations.name,
        policyNumber: policies.policyNumber,
        ramo: policies.ramo,
        endDate: policies.endDate,
        paymentMethod: policies.paymentMethod,
        contactId: contacts.id,
        cKind: contacts.kind,
        cFirst: contacts.firstName,
        cLast: contacts.lastName,
        cLegal: contacts.legalName,
        contactMethods: contacts.contactMethods,
        producerId: producers.id,
        producerName: producers.name,
      })
      .from(policies)
      .innerJoin(contacts, eq(contacts.id, policies.contactId))
      .innerJoin(insurers, eq(insurers.id, policies.insurerId))
      .innerJoin(organizations, eq(organizations.id, policies.orgId))
      .leftJoin(producers, eq(producers.id, policies.producerId))
      .where(
        and(
          eq(policies.status, 'vigente'),
          gte(policies.endDate, addDays(today, days - TOLERANCE_DAYS)),
          lte(policies.endDate, addDays(today, days)),
          notExists(
            db
              .select({ one: sql`1` })
              .from(expiryNotifications)
              .where(and(eq(expiryNotifications.policyId, policies.id), eq(expiryNotifications.window, window))),
          ),
        ),
      );
    for (const r of rows) {
      if (!r.endDate) continue;
      due.push({
        window,
        policyId: r.policyId,
        orgId: r.orgId,
        orgName: r.orgName,
        policyNumber: r.policyNumber,
        ramo: r.ramo,
        endDate: r.endDate,
        contactId: r.contactId,
        contactName: displayName({ kind: r.cKind, firstName: r.cFirst, lastName: r.cLast, legalName: r.cLegal }),
        contactFirstName: greetingName({ kind: r.cKind, firstName: r.cFirst, lastName: r.cLast, legalName: r.cLegal }),
        contactEmail: primaryEmail(r.contactMethods),
        producerId: r.producerId,
        producerName: r.producerName,
        producerEmail: null,
        paymentMethod: r.paymentMethod,
      });
    }
  }

  // Agenda de HOY (pendientes): mismo digest matinal. Sin dedup propio.
  const todayEvents = await db
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      time: calendarEvents.time,
      kind: calendarEvents.kind,
      orgId: calendarEvents.orgId,
      producerId: calendarEvents.producerId,
    })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.date, today), isNull(calendarEvents.completedAt)));

  // Pre-denuncias pendientes (Slice 5): entran al digest todos los días hasta
  // que el PAS las resuelva. Sin dedup propio a propósito.
  const pendingIntakeRows = await db
    .select({
      id: claimIntakes.id,
      orgId: claimIntakes.orgId,
      producerId: claimIntakes.producerId,
      number: claimIntakes.number,
      incidente: claimIntakes.incidente,
      aseguradoDeclarado: claimIntakes.aseguradoDeclarado,
      submittedAt: claimIntakes.submittedAt,
    })
    .from(claimIntakes)
    .where(eq(claimIntakes.status, 'pendiente'));
  const now = Date.now();
  const pendingIntakes: PendingIntake[] = pendingIntakeRows.map(r => {
    const inc = r.incidente as Record<string, unknown>;
    const ase = r.aseguradoDeclarado as Record<string, unknown>;
    return {
      id: r.id,
      orgId: r.orgId,
      producerId: r.producerId,
      number: r.number,
      tipoLabel: (inc.tipoLabel as string) ?? '—',
      ramoLabel: (inc.ramoLabel as string) ?? '—',
      nombre: (ase.nombre as string) ?? '—',
      daysAgo: Math.max(0, Math.floor((now - r.submittedAt.getTime()) / 86400000)),
    };
  });

  if (due.length === 0 && todayEvents.length === 0 && pendingIntakes.length === 0) {
    return { policiesNotified: 0, agendaItemsNotified: 0, digestsSent: 0, contactEmailsSent: 0, sendFailures: [] };
  }

  // 2. Destinatarios internos: productores con cuenta + organizador de cada org.
  const orgIds = [
    ...new Set([...due.map(d => d.orgId), ...todayEvents.map(e => e.orgId), ...pendingIntakes.map(i => i.orgId)]),
  ];
  const owners = await db
    .select({ orgId: members.organizationId, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(inArray(members.organizationId, orgIds), eq(members.role, 'owner')));
  const ownerByOrg = new Map(owners.map(o => [o.orgId, o.email]));

  const producerRows = await db
    .select({ id: producers.id, orgId: producers.orgId, name: producers.name, email: users.email })
    .from(producers)
    .innerJoin(users, eq(users.id, producers.userId))
    .where(inArray(producers.orgId, orgIds));
  // Por id, no por nombre: dos productores homónimos (o un rename) misruteaban
  // el digest con el match `${orgId}:${name}` anterior.
  const producerEmailById = new Map(producerRows.map(p => [p.id, p.email]));
  for (const d of due) {
    d.producerEmail = d.producerId ? (producerEmailById.get(d.producerId) ?? null) : null;
  }

  // 3. Digest por casilla (productor lo suyo, organizador todo; dedup por póliza).
  const digests = new Map<string, DuePolicy[]>();
  const push = (email: string | null, row: DuePolicy) => {
    if (!email) return;
    const list = digests.get(email) ?? [];
    if (!list.some(x => x.policyId === row.policyId)) list.push(row);
    digests.set(email, list);
  };
  for (const d of due) {
    push(d.producerEmail, d);
    push(ownerByOrg.get(d.orgId) ?? null, d);
  }

  const sendFailures: string[] = [];
  const failedPolicyIds = new Set<string>();

  const agendaByEmail = new Map<string, AgendaItem[]>();
  const pushAgenda = (email: string | null | undefined, e: (typeof todayEvents)[number]) => {
    if (!email) return;
    const list = agendaByEmail.get(email) ?? [];
    if (!list.some(x => x.id === e.id)) {
      list.push({ id: e.id, title: e.title, time: e.time, kindLabel: EVENT_KIND_LABELS[e.kind] ?? e.kind });
    }
    agendaByEmail.set(email, list);
  };
  for (const e of todayEvents) {
    pushAgenda(e.producerId ? producerEmailById.get(e.producerId) : null, e);
    pushAgenda(ownerByOrg.get(e.orgId), e);
  }

  // Pre-denuncias pendientes por casilla: mismo scoping (productor lo suyo,
  // organizador todas las de la org; misma casilla no duplica).
  const intakesByEmail = new Map<string, PendingIntake[]>();
  const pushIntake = (email: string | null | undefined, i: PendingIntake) => {
    if (!email) return;
    const list = intakesByEmail.get(email) ?? [];
    if (!list.some(x => x.id === i.id)) list.push(i);
    intakesByEmail.set(email, list);
  };
  for (const i of pendingIntakes) {
    pushIntake(i.producerId ? producerEmailById.get(i.producerId) : null, i);
    pushIntake(ownerByOrg.get(i.orgId), i);
  }

  for (const email of [...agendaByEmail.keys(), ...intakesByEmail.keys()]) {
    if (!digests.has(email)) digests.set(email, []);
  }

  // Envíos resilientes: un destinatario fallido no hunde la corrida; sus
  // pólizas no se marcan avisadas → reintento mañana.
  let digestsSent = 0;
  for (const [email, rows] of digests) {
    try {
      await send({
        to: email,
        ...composeDigest(rows, appUrl, agendaByEmail.get(email) ?? [], intakesByEmail.get(email) ?? []),
      });
      digestsSent++;
    } catch (e) {
      sendFailures.push(`digest a ${email}: ${e instanceof Error ? e.message : String(e)}`);
      for (const r of rows) failedPolicyIds.add(r.policyId);
    }
  }

  // 4. Aviso al asegurado (gated). Reply-to: su productor (o el organizador).
  let contactEmailsSent = 0;
  const sentContactEmail = new Map<string, string>();
  if (contactEmailsEnabled) {
    for (const d of due) {
      if (!d.contactEmail) continue;
      const replyTo = d.producerEmail ?? ownerByOrg.get(d.orgId) ?? undefined;
      try {
        await send({ to: d.contactEmail, ...composeContactEmail(d), ...(replyTo ? { replyTo } : {}) });
        sentContactEmail.set(d.policyId, d.contactEmail);
        contactEmailsSent++;
      } catch (e) {
        sendFailures.push(`asegurado ${d.contactEmail}: ${e instanceof Error ? e.message : String(e)}`);
        failedPolicyIds.add(d.policyId);
      }
    }
  }

  // 5. Registro al FINAL: dedup + communications de los avisos al asegurado.
  const delivered = due.filter(d => !failedPolicyIds.has(d.policyId));
  if (delivered.length > 0) {
    await db.insert(expiryNotifications).values(
      delivered.map(d => ({
        orgId: d.orgId,
        policyId: d.policyId,
        window: d.window,
        contactEmail: sentContactEmail.get(d.policyId) ?? null,
      })),
    );
  }
  const logged = delivered.filter(d => sentContactEmail.has(d.policyId));
  if (logged.length > 0) {
    await db.insert(communications).values(
      logged.map(d => ({
        orgId: d.orgId,
        contactId: d.contactId,
        policyId: d.policyId,
        channel: 'email' as const,
        templateId: 'vencimiento',
        body: composeContactEmail(d).text,
      })),
    );
  }

  if (sendFailures.length > 0) {
    console.error(`[expiry-notifications] ${sendFailures.length} envío(s) fallido(s):\n` + sendFailures.join('\n'));
  }

  return {
    policiesNotified: delivered.length,
    agendaItemsNotified: todayEvents.length,
    digestsSent,
    contactEmailsSent,
    sendFailures,
  };
}
