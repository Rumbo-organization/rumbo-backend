// Multicotizador (Slice 5 de paridad; portado del router quotes del monolito).
// Las opciones se cargan a mano (addItem) y la matriz comparativa consume byId.
// withAuthedTx (RLS) + audit.
//
// ── Sobre el rating en vivo de automotor ─────────────────────────────────────
//
// Hubo uno contra San Cristóbal y **se dio de baja**: su API exige el código de
// Infoauto y ningún otro (probado — `QuoteCA7` sin `InfoautoCode` devuelve 400
// "no puede ser nulo"), y el padrón de Infoauto es un producto licenciado al que
// no tenemos acceso. Cotizar apoyado solo en los autos que ya estaban en la
// cartera cubría media consulta y ninguna del auto que el productor todavía no
// asegura, que es la mitad del trabajo.
//
// El vehículo ahora se elige del catálogo público de la DNRPA (`vehicle_catalog`)
// y **todas** las opciones se cargan a mano. Si algún día hay padrón, el rating
// vuelve: la normalización de coberturas y la forma de `quote_items` quedan.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { asc, desc, eq, sql } from 'drizzle-orm';

import { withAuthedTx, schema } from '../db/client.js';
import { writeAuditLogTx } from '../audit.js';

const { contacts, insurers, quoteItems, quotes } = schema;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const POLICY_RAMOS = [
  'automotor',
  'motovehiculo',
  'hogar',
  'vida',
  'art',
  'comercio',
  'accidentes_personales',
  'incendio',
  'responsabilidad_civil',
  'consorcio',
  'seguro_tecnico',
  'transporte',
  'embarcaciones',
  'otros',
];
export const NORMALIZED_COVERAGE_LABELS: Record<string, string> = {
  rc: 'Responsabilidad civil',
  rc_grua: 'RC con grúa',
  rc_robo_incendio: 'RC + robo + incendio total',
  incendio_robo_garage: 'Incendio y robo en garage',
  terceros_completo: 'Tercero completo',
  terceros_completo_full: 'Tercero completo full',
  todo_riesgo_franquicia: 'Todo riesgo con franquicia',
  todo_riesgo_sin_franquicia: 'Todo riesgo sin franquicia',
};

function displayName(c: {
  kind: string | null;
  firstName: string | null;
  lastName: string | null;
  legalName: string | null;
}): string {
  if (c.kind === 'PERSONA_JURIDICA') return c.legalName ?? '—';
  if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
  return c.lastName ?? c.firstName ?? '—';
}
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
const optionalText = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);
// Código estable y mono-aspecto (misma derivación que el BFF): año + sufijo uuid.
const quoteNum = (id: string, createdAt: Date) =>
  `COT-${createdAt.getFullYear()}-${id.replace(/-/g, '').slice(-4).toUpperCase()}`;

export const quotesRouter = Router();

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

// Historial (más recientes primero) — misma forma de fila que la array
// COTIZACIONES del cockpit + total para paginar. Uncapped por página.
quotesRouter.get(
  '/cotizaciones',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 100);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const out = await withAuthedTx(req.authCtx!, async tx => {
      const rows = await tx
        .select({
          q: quotes,
          cKind: contacts.kind,
          cFirst: contacts.firstName,
          cLast: contacts.lastName,
          cLegal: contacts.legalName,
          itemCount: sql<number>`(select count(*)::int from ${quoteItems} where ${quoteItems.quoteId} = ${quotes.id})`,
          bestCuota: sql<
            string | null
          >`(select ${quoteItems.cuota} from ${quoteItems} where ${quoteItems.quoteId} = ${quotes.id} and ${quoteItems.cuota} is not null order by ${quoteItems.cuota} asc limit 1)`,
          bestInsurer: sql<
            string | null
          >`(select ${insurers.name} from ${quoteItems} join ${insurers} on ${insurers.id} = ${quoteItems.insurerId} where ${quoteItems.quoteId} = ${quotes.id} and ${quoteItems.cuota} is not null order by ${quoteItems.cuota} asc limit 1)`,
        })
        .from(quotes)
        .leftJoin(contacts, eq(contacts.id, quotes.contactId))
        .orderBy(desc(quotes.createdAt))
        .limit(limit)
        .offset(offset);
      const [agg] = await tx.select({ n: sql<number>`count(*)::int` }).from(quotes);
      const now = Date.now();
      const data = rows.map(({ q, cKind, cFirst, cLast, cLegal, itemCount, bestCuota, bestInsurer }) => {
        const client = displayName({ kind: cKind, firstName: cFirst, lastName: cLast, legalName: cLegal });
        const ageDays = Math.round((now - q.createdAt.getTime()) / 86400000);
        const valid = 15 - ageDays;
        return {
          id: q.id,
          num: quoteNum(q.id, q.createdAt),
          client: client !== '—' ? client : (q.reference ?? '—'),
          ramo: RAMO_LABELS[q.ramo] ?? q.ramo,
          status: valid < 0 ? 'Vencida' : (itemCount ?? 0) > 0 ? 'Enviada' : 'Borrador',
          best: bestInsurer ?? '—',
          monthly: bestCuota == null ? 0 : Number(bestCuota),
          options: itemCount ?? 0,
          date: q.createdAt.toISOString().slice(0, 10),
          valid,
        };
      });
      return { data, total: agg?.n ?? 0, limit, offset };
    });
    res.json(out);
  }),
);

// Detalle con items (matriz comparativa: coverage normalizada + labels).
quotesRouter.get(
  '/quotes/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const out = await withAuthedTx(req.authCtx!, async tx => {
      const [row] = await tx
        .select({
          q: quotes,
          cKind: contacts.kind,
          cFirst: contacts.firstName,
          cLast: contacts.lastName,
          cLegal: contacts.legalName,
        })
        .from(quotes)
        .leftJoin(contacts, eq(contacts.id, quotes.contactId))
        .where(eq(quotes.id, id))
        .limit(1);
      if (!row) return null;
      const { q } = row;
      const items = await tx
        .select({ it: quoteItems, insurerName: insurers.name })
        .from(quoteItems)
        .innerJoin(insurers, eq(insurers.id, quoteItems.insurerId))
        .where(eq(quoteItems.quoteId, id))
        .orderBy(asc(quoteItems.createdAt));
      const client = displayName({
        kind: row.cKind,
        firstName: row.cFirst,
        lastName: row.cLast,
        legalName: row.cLegal,
      });
      return {
        id: q.id,
        num: quoteNum(q.id, q.createdAt),
        contactId: q.contactId,
        client: client !== '—' ? client : (q.reference ?? '—'),
        ramo: RAMO_LABELS[q.ramo] ?? q.ramo,
        reference: q.reference,
        vehicle: [q.vehicleMarca, q.vehicleModelo, q.vehicleVersion, q.vehicleAnio].filter(Boolean).join(' ') || null,
        // Datos de rating del vehículo: permiten cotizar sin volver a elegirlo.
        details: q.details ?? null,
        notes: q.notes,
        date: q.createdAt.toISOString().slice(0, 10),
        items: items.map(({ it, insurerName }) => ({
          id: it.id,
          insurerId: it.insurerId,
          insurer: insurerName,
          coverage: it.coverage,
          coverageLabel: it.coverage ? (NORMALIZED_COVERAGE_LABELS[it.coverage] ?? it.coverage) : null,
          sumaAsegurada: it.sumaAsegurada == null ? null : Number(it.sumaAsegurada),
          cuota: it.cuota == null ? null : Number(it.cuota),
          prima: it.prima == null ? null : Number(it.prima),
          premio: it.premio == null ? null : Number(it.premio),
          // La franquicia distingue opciones que si no se verían idénticas: la
          // aseguradora devuelve cuatro Todo Riesgo con el mismo código y solo
          // cambia esto (y el precio).
          deductible: it.deductible,
          nativeCode: it.nativeCode,
          // Para que la UI pueda distinguir lo que trajo la API de lo cargado
          // a mano: recotizar reemplaza lo primero y respeta lo segundo.
          source: it.source,
          currency: it.currency,
        })),
      };
    });
    if (!out) {
      res.status(404).json({ error: 'Cotización no encontrada.' });
      return;
    }
    res.json(out);
  }),
);

quotesRouter.post(
  '/quotes',
  wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const contactId = b.contactId != null && b.contactId !== '' ? String(b.contactId) : null;
    if (contactId !== null && !isUuid(contactId)) {
      res.status(400).json({ error: 'Asegurado inválido.' });
      return;
    }
    const ramo = POLICY_RAMOS.includes(String(b.ramo)) ? String(b.ramo) : 'automotor';
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      if (contactId) {
        const [c] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
        if (!c) return null;
      }
      const [row] = await tx
        .insert(quotes)
        .values({
          orgId: ctx.orgId,
          // La cotización nace en la cartera del productor que la crea.
          producerId: ctx.producerId,
          contactId,
          ramo: ramo as (typeof quotes.$inferInsert)['ramo'],
          reference: optionalText(b.reference, 120),
          vehicleMarca: optionalText(b.vehicleMarca, 80),
          vehicleModelo: optionalText(b.vehicleModelo, 80),
          vehicleAnio: optionalText(b.vehicleAnio, 8),
          vehicleVersion: optionalText(b.vehicleVersion, 120),
          notes: optionalText(b.notes, 500),
          // Datos del vehículo elegido del catálogo (códigos DNRPA, tipo, años).
          // Se guardan al crear para no perder de qué auto se habla — no sirven
          // para cotizar por API, pero sí para identificarlo sin ambigüedad.
          details: b.details && typeof b.details === 'object' ? (b.details as Record<string, unknown>) : null,
          source: 'manual' as const,
        })
        .returning({ id: quotes.id });
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'create_quote',
        entityType: 'quote',
        entityId: row!.id,
        payload: { ramo },
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Asegurado no encontrado.' });
      return;
    }
    res.status(201).json(out);
  }),
);

quotesRouter.delete(
  '/quotes/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [row] = await tx.delete(quotes).where(eq(quotes.id, id)).returning({ id: quotes.id });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'delete_quote',
        entityType: 'quote',
        entityId: row.id,
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Cotización no encontrada.' });
      return;
    }
    res.json({ ok: true });
  }),
);

// Una opción: aseguradora × cobertura → suma + cuota. Se exige cuota o suma.
quotesRouter.post(
  '/quotes/:id/items',
  wrap(async (req, res) => {
    const quoteId = req.params.id;
    if (!isUuid(quoteId)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const insurerId = String(b.insurerId ?? '');
    if (!isUuid(insurerId)) {
      res.status(400).json({ error: 'Elegí una aseguradora.' });
      return;
    }
    const coverage = typeof b.coverage === 'string' && NORMALIZED_COVERAGE_LABELS[b.coverage] ? b.coverage : null;
    const suma = b.sumaAsegurada != null && b.sumaAsegurada !== '' ? Number(b.sumaAsegurada) : null;
    const cuota = b.cuota != null && b.cuota !== '' ? Number(b.cuota) : null;
    if ((suma == null || !Number.isFinite(suma)) && (cuota == null || !Number.isFinite(cuota))) {
      res.status(400).json({ error: 'Cargá al menos la cuota o la suma asegurada.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [q] = await tx.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, quoteId)).limit(1);
      if (!q) return 'no-quote';
      const [ins] = await tx.select({ id: insurers.id }).from(insurers).where(eq(insurers.id, insurerId)).limit(1);
      if (!ins) return 'no-insurer';
      const [row] = await tx
        .insert(quoteItems)
        .values({
          orgId: ctx.orgId,
          quoteId,
          insurerId,
          coverage: coverage as (typeof quoteItems.$inferInsert)['coverage'],
          sumaAsegurada: suma != null && Number.isFinite(suma) ? String(suma) : null,
          cuota: cuota != null && Number.isFinite(cuota) ? String(cuota) : null,
          currency: b.currency === 'USD' ? 'USD' : 'ARS',
          source: 'manual' as const,
        })
        .returning({ id: quoteItems.id, coverage: quoteItems.coverage });
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'add_quote_item',
        entityType: 'quote',
        entityId: quoteId,
        payload: { insurerId, coverage: row!.coverage },
      });
      return row;
    });
    if (out === 'no-quote') {
      res.status(404).json({ error: 'Cotización no encontrada.' });
      return;
    }
    if (out === 'no-insurer') {
      res.status(404).json({ error: 'Aseguradora no encontrada.' });
      return;
    }
    res.status(201).json(out);
  }),
);

// ── Catálogo de vehículos ────────────────────────────────────────────────────
//
// Sale de `vehicle_catalog`: los datos abiertos de la DNRPA (inscripciones
// iniciales + transferencias). ~580 marcas y ~15.400 marca+modelo, con años de
// 1925 en adelante — cubre el auto que el productor todavía no asegura, que es
// lo que la versión anterior no podía hacer.
//
// Antes esto se armaba con la cartera ya sincronizada, para tener el código de
// Infoauto que exigía la API de la aseguradora. Ese camino se dio de baja: sin
// padrón de Infoauto no hay rating en vivo, y atar el catálogo a la cartera
// dejaba afuera justo al prospecto nuevo.
//
// ⚠️ Los códigos que devuelve son **de la DNRPA** y no sirven para cotizar
// contra ninguna compañía. Identifican el vehículo; el precio se carga a mano.
quotesRouter.get(
  '/vehiculos',
  wrap(async (req, res) => {
    const q = String((req.query.q ?? '') as string).trim();
    const marca = String((req.query.marca ?? '') as string).trim();
    const modelo = String((req.query.modelo ?? '') as string).trim();
    const ctx = req.authCtx!;

    // Una sola llamada devuelve los tres niveles de la cascada: marcas, modelos
    // de la marca elegida y las versiones concretas. Datos estructurados y no
    // texto libre — un typo dejaría al PAS sin resultados.
    const out = await withAuthedTx(ctx, async tx => {
      // Ordenadas por frecuencia real de patentamiento: las 10 marcas que el
      // productor ve todos los días quedan arriba, y la cola larga (580 marcas,
      // con acoplados y maquinaria) no le estorba.
      const marcas = await tx.execute<{ marca: string; n: number }>(sql`
        SELECT marca, sum(frecuencia)::int AS n
          FROM vehicle_catalog
         WHERE provider = 'dnrpa'
         GROUP BY 1 ORDER BY n DESC, marca ASC`);

      const modelos = marca
        ? await tx.execute<{ modelo: string; n: number }>(sql`
            SELECT modelo, sum(frecuencia)::int AS n
              FROM vehicle_catalog
             WHERE provider = 'dnrpa' AND marca = ${marca}
             GROUP BY 1 ORDER BY n DESC, modelo ASC
             LIMIT 400`)
        : { rows: [] };

      // Las versiones solo se listan cuando ya hay por dónde acotar: sin filtro
      // ni búsqueda, devolver la lista entera no ayuda a elegir.
      const hayFiltro = Boolean(marca || q);
      const vehiculos = hayFiltro
        ? await tx.execute(sql`
            SELECT marca_codigo   AS "marcaCodigo",
                   marca,
                   modelo_codigo  AS "modeloCodigo",
                   modelo,
                   tipo,
                   anio_desde     AS "anioDesde",
                   anio_hasta     AS "anioHasta"
              FROM vehicle_catalog
             WHERE provider = 'dnrpa'
               AND (${marca} = '' OR marca = ${marca})
               AND (${modelo} = '' OR modelo = ${modelo})
               AND (${q} = '' OR (marca || ' ' || modelo) ILIKE ${'%' + q + '%'})
             ORDER BY frecuencia DESC, marca ASC, modelo ASC
             LIMIT 60`)
        : { rows: [] };

      return { marcas: marcas.rows, modelos: modelos.rows, vehiculos: vehiculos.rows };
    });
    res.json(out);
  }),
);

// Catálogos que necesita el formulario de cotización, en una sola llamada.
//
// Van acá y no hardcodeados en el front por dos razones: los códigos son de la
// aseguradora (la provincia viaja como `AR_17`, no como "Neuquén") y cambian sin
// avisarnos. Pedirle al PAS que tipee un código interno era pedirle que adivine.
//
// **Salen de nuestra base, no de la aseguradora.** Antes esta ruta le pegaba a
// San Cristóbal en vivo, dos veces, cada vez que se abría el formulario: abrir
// una pantalla dependía de que la API de un tercero estuviera arriba. Ahora los
// refresca un job (`scripts/sc-refresh-catalogos.ts`) y acá se leen de
// `insurer_catalogs`. El formulario abre aunque SC esté caído; a la compañía se
// le pega solo al cotizar, que es lo único incacheable porque es tarifa.
quotesRouter.get(
  '/cotizador/catalogos',
  wrap(async (req, res) => {
    const { readScCatalogs } = await import('../lib/sc/catalogs.js');
    const { catalogos, fetchedAt } = await withAuthedTx(req.authCtx!, tx =>
      readScCatalogs(tx, [
        'provincia',
        'uso',
        'categoria',
        'combustible',
        'color',
        'cobertura',
        'proveedor_gps',
        'tipo_documento',
        'actividad_comercio',
        'ocupacion_vida',
        'tipo_beneficiario',
        'parentesco',
      ]),
    );

    // Caché nunca sembrada. Es un paso de operación, no un error del PAS: sin
    // esto el formulario mostraría selectores vacíos sin explicar por qué.
    if (!fetchedAt) {
      res.status(503).json({
        error: 'Los catálogos de la aseguradora todavía no se cargaron. Corré scripts/sc-refresh-catalogos.ts.',
      });
      return;
    }

    res.json({
      // `provincias` y `usos` conservan el nombre que ya consume el front.
      provincias: catalogos.provincia,
      usos: catalogos.uso,
      categorias: catalogos.categoria,
      combustibles: catalogos.combustible,
      colores: catalogos.color,
      coberturas: catalogos.cobertura,
      proveedoresGps: catalogos.proveedor_gps,
      tiposDocumento: catalogos.tipo_documento,
      actividadesComercio: catalogos.actividad_comercio,
      ocupacionesVida: catalogos.ocupacion_vida,
      tiposBeneficiario: catalogos.tipo_beneficiario,
      parentescos: catalogos.parentesco,
      actualizado: fetchedAt,
    });
  }),
);

quotesRouter.delete(
  '/quote-items/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [row] = await tx
        .delete(quoteItems)
        .where(eq(quoteItems.id, id))
        .returning({ id: quoteItems.id, quoteId: quoteItems.quoteId });
      if (!row) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'delete_quote_item',
        entityType: 'quote',
        entityId: row.quoteId,
      });
      return row;
    });
    if (!out) {
      res.status(404).json({ error: 'Opción no encontrada.' });
      return;
    }
    res.json({ ok: true });
  }),
);

// Aseguradoras: picker con id (el /insurers del cockpit devuelve solo nombres)
// + alta con upsert por (org, name) — paridad insurers.create.
quotesRouter.get(
  '/insurers/picker',
  wrap(async (req, res) => {
    const data = await withAuthedTx(req.authCtx!, tx =>
      tx.select({ id: insurers.id, name: insurers.name }).from(insurers).orderBy(asc(insurers.name)),
    );
    res.json({ data });
  }),
);

quotesRouter.post(
  '/insurers',
  wrap(async (req, res) => {
    const name = optionalText((req.body ?? {}).name, 120);
    if (!name) {
      res.status(400).json({ error: 'Falta el nombre.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [existing] = await tx
        .select({ id: insurers.id })
        .from(insurers)
        .where(sql`lower(${insurers.name}) = lower(${name})`)
        .limit(1);
      if (existing) return existing;
      const [row] = await tx.insert(insurers).values({ orgId: ctx.orgId, name }).returning({ id: insurers.id });
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'create_insurer',
        entityType: 'insurer',
        entityId: row!.id,
        payload: { name },
      });
      return row;
    });
    res.status(201).json(out);
  }),
);
