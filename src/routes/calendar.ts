// Router del Calendario (jul-2026) — portado de app/src/trpc/routers/calendar.ts
// de la app v0.1 a REST sobre Express.
//
// GET /calendar?year=&month= junta las cuatro fuentes de la vista: vencimientos
// de pólizas vigentes, cuotas impagas y siniestros (derivados de sus tablas) +
// la agenda propia (calendar_events). El BFF devuelve el payload ya con labels
// de display (mismo criterio que v1.ts): el frontend solo renderiza.
//
// La agenda es lo único que se escribe acá — es el PRIMER camino de escritura
// del backend (antes todo era lectura del cockpit). Alta/edición/borrado/
// completado con audit transaccional y stamping server-side del productor
// (ctx.producerId, nunca del client). Todo bajo withAuthedTx: RLS scopea por
// org y, para rol productor, por cartera. La validación es autoritativa acá
// (hand-rolled: el backend todavía no tiene zod).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';

import { withAuthedTx, schema, type AuthedTx } from '../db/client.js';
import { writeAuditLogTx } from '../audit.js';

const { calendarEvents, claims, contacts, policies, policyInstallments } = schema;

// ── Mapeos dominio → etiquetas (mismo criterio que routes/v1.ts) ─────────────

const RAMO_LABEL: Record<string, string> = {
  automotor: 'Automotor',
  hogar: 'Hogar',
  vida: 'Vida',
  art: 'ART',
  comercio: 'Comercio',
  accidentes_personales: 'Accidentes',
  motovehiculo: 'Automotor',
  incendio: 'Integral',
  responsabilidad_civil: 'Integral',
  consorcio: 'Integral',
  seguro_tecnico: 'Integral',
  transporte: 'Integral',
  embarcaciones: 'Integral',
  otros: 'Integral',
};
const ramoLabel = (r: string | null): string => (r ? (RAMO_LABEL[r] ?? 'Integral') : 'Integral');

const CLAIM_TIPO_LABEL: Record<string, string> = {
  robo: 'Robo',
  choque: 'Choque',
  incendio: 'Incendio',
  danos_agua: 'Daños por agua',
  granizo: 'Granizo',
  cristales: 'Cristales',
  resp_civil: 'Resp. civil',
  otros: 'Otro',
};
const CLAIM_STATUS_LABEL: Record<string, string> = {
  abierto: 'Abierto',
  en_curso: 'En curso',
  cerrado: 'Cerrado',
};
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cupon: 'Cupón',
  debito_bancario: 'Débito bancario',
  tarjeta_credito: 'Tarjeta de crédito',
};
const paymentLabel = (m: string | null): string | null => (m ? (PAYMENT_METHOD_LABEL[m] ?? m) : null);

const CALENDAR_EVENT_KINDS = ['llamada', 'reunion', 'tramite', 'otro'] as const;
type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];

// Display name del titular (misma lógica que routes/v1.ts).
function displayName(c: {
  contactKind: string;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactLegalName: string | null;
}): string {
  if (c.contactKind === 'PERSONA_JURIDICA') return c.contactLegalName ?? '—';
  if (c.contactLastName && c.contactFirstName) return `${c.contactLastName}, ${c.contactFirstName}`;
  return c.contactLastName ?? c.contactFirstName ?? '—';
}

// Campos del titular para el join (arma el display name).
const contactNameFields = {
  contactKind: contacts.kind,
  contactFirstName: contacts.firstName,
  contactLastName: contacts.lastName,
  contactLegalName: contacts.legalName,
};

// Primer/último día del mes, 'AAAA-MM-DD' (aritmética UTC, sin sorpresas de TZ).
function monthRange(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
}

// time de PG llega 'HH:MM:SS'; la UI usa 'HH:MM'. Vacío/null → null (todo el día).
const hm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// Forma de un evento de agenda tal como lo consume el frontend.
function eventShape(row: typeof calendarEvents.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    notes: row.notes,
    date: row.date,
    time: hm(row.time),
    contactId: row.contactId,
    policyId: row.policyId,
    completedAt: iso(row.completedAt),
  };
}

// ── Validación del body (hand-rolled) ────────────────────────────────────────

const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isHm = (s: unknown): s is string => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

interface EventInput {
  kind: CalendarEventKind;
  title: string;
  notes: string | null;
  date: string;
  time: string | null;
  contactId: string | null;
  policyId: string | null;
}

// Devuelve el input normalizado o un mensaje de error (400).
function parseEventBody(body: unknown): { data: EventInput } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;

  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (title.length < 1) return { error: 'El título es obligatorio.' };
  if (title.length > 120) return { error: 'El título es demasiado largo (máx. 120).' };

  if (!isYmd(b.date)) return { error: 'Fecha inválida (AAAA-MM-DD).' };

  const kind = (CALENDAR_EVENT_KINDS as readonly string[]).includes(b.kind as string)
    ? (b.kind as CalendarEventKind)
    : 'otro';

  const timeRaw = typeof b.time === 'string' ? b.time.trim() : '';
  let time: string | null = null;
  if (timeRaw !== '') {
    if (!isHm(timeRaw)) return { error: 'Hora inválida (HH:MM).' };
    time = timeRaw;
  }

  const notesRaw = typeof b.notes === 'string' ? b.notes.trim() : '';
  if (notesRaw.length > 2000) return { error: 'Las notas son demasiado largas.' };
  const notes = notesRaw !== '' ? notesRaw : null;

  let contactId: string | null = null;
  if (b.contactId != null && b.contactId !== '') {
    if (!isUuid(b.contactId)) return { error: 'Asegurado inválido.' };
    contactId = b.contactId;
  }
  let policyId: string | null = null;
  if (b.policyId != null && b.policyId !== '') {
    if (!isUuid(b.policyId)) return { error: 'Póliza inválida.' };
    policyId = b.policyId;
  }

  return { data: { kind, title, notes, date: b.date, time, contactId, policyId } };
}

// El FK garantiza existencia, no pertenencia: estos SELECT corren bajo RLS, así
// que solo ven filas de la org/cartera de quien escribe. Lanza si no pertenece.
async function assertOwned(tx: AuthedTx, input: EventInput): Promise<void> {
  if (input.contactId) {
    const [c] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, input.contactId)).limit(1);
    if (!c) throw httpError(404, 'Asegurado no encontrado.');
  }
  if (input.policyId) {
    const [p] = await tx.select({ id: policies.id }).from(policies).where(eq(policies.id, input.policyId)).limit(1);
    if (!p) throw httpError(404, 'Póliza no encontrada.');
  }
}

// Error con status para el handler central (mapea a JSON { error }).
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const httpError = (status: number, message: string) => new HttpError(status, message);

// ── Router ───────────────────────────────────────────────────────────────────
// Se monta bajo /api/v1/calendar en routes/v1.ts (hereda requireAuthedOrg).

export const calendar = Router();

// GET /calendar?year=YYYY&month=M — las cuatro fuentes del mes, display-ready.
calendar.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const y = Number(req.query.year);
    const m = Number(req.query.month);
    const year = Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : now.getUTCFullYear();
    const month = Number.isInteger(m) && m >= 1 && m <= 12 ? m : now.getUTCMonth() + 1;
    const { from, to } = monthRange(year, month);

    const data = await withAuthedTx(req.authCtx!, async tx => {
      const vencimientos = await tx
        .select({
          id: policies.id,
          date: policies.endDate,
          policyNumber: policies.policyNumber,
          ramo: policies.ramo,
          paymentMethod: policies.paymentMethod,
          ...contactNameFields,
        })
        .from(policies)
        .innerJoin(contacts, eq(contacts.id, policies.contactId))
        .where(and(eq(policies.status, 'vigente'), gte(policies.endDate, from), lte(policies.endDate, to)))
        .orderBy(asc(policies.endDate));

      const cuotas = await tx
        .select({
          id: policyInstallments.id,
          date: policyInstallments.dueDate,
          number: policyInstallments.number,
          amount: policyInstallments.amount,
          policyId: policyInstallments.policyId,
          currency: policies.currency,
          paymentMethod: policies.paymentMethod,
          ...contactNameFields,
        })
        .from(policyInstallments)
        .innerJoin(policies, eq(policies.id, policyInstallments.policyId))
        .innerJoin(contacts, eq(contacts.id, policies.contactId))
        .where(
          and(
            isNull(policyInstallments.paidAt),
            gte(policyInstallments.dueDate, from),
            lte(policyInstallments.dueDate, to),
          ),
        )
        .orderBy(asc(policyInstallments.dueDate));

      const siniestros = await tx
        .select({
          id: claims.id,
          date: sql<string>`${claims.occurredAt}::date`,
          tipo: claims.tipo,
          status: claims.status,
          ...contactNameFields,
        })
        .from(claims)
        .innerJoin(policies, eq(policies.id, claims.policyId))
        .innerJoin(contacts, eq(contacts.id, policies.contactId))
        .where(and(sql`${claims.occurredAt}::date >= ${from}`, sql`${claims.occurredAt}::date <= ${to}`))
        .orderBy(asc(claims.occurredAt));

      const eventos = await tx
        .select({ e: calendarEvents, ...contactNameFields })
        .from(calendarEvents)
        .leftJoin(contacts, eq(contacts.id, calendarEvents.contactId))
        .where(and(gte(calendarEvents.date, from), lte(calendarEvents.date, to)))
        .orderBy(asc(calendarEvents.date), asc(calendarEvents.time));

      return {
        vencimientos: vencimientos.map(v => ({
          id: v.id,
          date: v.date,
          policyNumber: v.policyNumber,
          ramo: ramoLabel(v.ramo),
          paymentMethod: paymentLabel(v.paymentMethod),
          client: displayName(v),
        })),
        cuotas: cuotas.map(c => ({
          id: c.id,
          date: c.date,
          number: c.number,
          amount: c.amount == null ? 0 : Number(c.amount),
          currency: c.currency,
          policyId: c.policyId,
          paymentMethod: paymentLabel(c.paymentMethod),
          client: displayName(c),
        })),
        siniestros: siniestros.map(s => ({
          id: s.id,
          date: s.date,
          tipo: CLAIM_TIPO_LABEL[s.tipo] ?? s.tipo,
          status: CLAIM_STATUS_LABEL[s.status] ?? s.status,
          client: displayName(s),
        })),
        // contactName: para precargar el typeahead al editar (Fase 3: el
        // frontend ya no tiene CONTACTS del bootstrap para resolver el id).
        eventos: eventos.map(r => ({
          ...eventShape(r.e),
          contactName: r.e.contactId ? displayName({ ...r, contactKind: r.contactKind ?? 'PERSONA_FISICA' }) : null,
        })),
      };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /calendar/events — alta de un evento de agenda.
calendar.post('/events', async (req: Request, res: Response, next: NextFunction) => {
  const parsed = parseEventBody(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const input = parsed.data;
  const ctx = req.authCtx!;
  try {
    const row = await withAuthedTx(ctx, async tx => {
      await assertOwned(tx, input);
      const [inserted] = await tx
        .insert(calendarEvents)
        .values({
          orgId: ctx.orgId,
          // El evento nace en la agenda de quien lo crea (organizador: su
          // self-producer). Server-side siempre, nunca del client.
          producerId: ctx.producerId,
          createdByUserId: ctx.userId,
          kind: input.kind,
          title: input.title,
          notes: input.notes,
          date: input.date,
          time: input.time,
          contactId: input.contactId,
          policyId: input.policyId,
        })
        .returning();
      if (!inserted) throw httpError(500, 'El alta no devolvió fila.');
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'create_calendar_event',
        entityType: 'calendar_event',
        entityId: inserted.id,
        payload: { kind: inserted.kind, date: inserted.date },
      });
      return inserted;
    });
    res.status(201).json(eventShape(row));
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// PATCH /calendar/events/:id — edición. RLS oculta lo ajeno → 404.
calendar.patch('/events/:id', async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Id inválido.' });
    return;
  }
  const parsed = parseEventBody(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const input = parsed.data;
  const ctx = req.authCtx!;
  try {
    const row = await withAuthedTx(ctx, async tx => {
      await assertOwned(tx, input);
      const [updated] = await tx
        .update(calendarEvents)
        .set({
          kind: input.kind,
          title: input.title,
          notes: input.notes,
          date: input.date,
          time: input.time,
          contactId: input.contactId,
          policyId: input.policyId,
          updatedAt: new Date(),
        })
        .where(eq(calendarEvents.id, id))
        .returning();
      if (!updated) throw httpError(404, 'Evento no encontrado.');
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'update_calendar_event',
        entityType: 'calendar_event',
        entityId: updated.id,
      });
      return updated;
    });
    res.json(eventShape(row));
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// DELETE /calendar/events/:id — baja.
calendar.delete('/events/:id', async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Id inválido.' });
    return;
  }
  const ctx = req.authCtx!;
  try {
    await withAuthedTx(ctx, async tx => {
      const [row] = await tx
        .delete(calendarEvents)
        .where(eq(calendarEvents.id, id))
        .returning({ id: calendarEvents.id });
      if (!row) throw httpError(404, 'Evento no encontrado.');
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'delete_calendar_event',
        entityType: 'calendar_event',
        entityId: row.id,
      });
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// POST /calendar/events/:id/toggle — check de "hecho" (togglea completed_at).
calendar.post('/events/:id/toggle', async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Id inválido.' });
    return;
  }
  const ctx = req.authCtx!;
  try {
    const row = await withAuthedTx(ctx, async tx => {
      const [updated] = await tx
        .update(calendarEvents)
        .set({
          completedAt: sql`CASE WHEN ${calendarEvents.completedAt} IS NULL THEN now() ELSE NULL END`,
          updatedAt: new Date(),
        })
        .where(eq(calendarEvents.id, id))
        .returning();
      if (!updated) throw httpError(404, 'Evento no encontrado.');
      return updated;
    });
    res.json(eventShape(row));
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});
