// Schema raíz de Rumbo.
//
// Las tablas de auth (`users`, `organizations`, `members`, `sessions`,
// `accounts`, `verifications`, `invitations`, `two_factors`) son la **fuente
// de verdad** y las administra Better Auth (D-021; los nombres de propiedad TS
// siguen los modelos de Better Auth + plugins organization/twoFactor — el
// adapter de Drizzle matchea por nombre de propiedad, las columnas quedan en
// snake_case). Reemplazan el espejo de Clerk de D-016.16.2: ya no hay webhooks
// ni `ensureOrgUser()` — el id de sesión ES el uuid local.
//
// `audit_log` implementa D-015.15.2: grano de operación de negocio, retention
// 7 años, escrita app-level desde Server Actions / tRPC mutations.

import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  uuid,
  boolean,
  integer,
  numeric,
  date,
  time,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Forma de cada entrada del jsonb `contact_methods` (portado de la app v0.1,
// donde el tipo se derivaba del schema Zod en src/lib/contacts.ts).
export interface ContactMethod {
  type: "telefono" | "celular" | "email" | "whatsapp";
  value: string;
  label?: string;
  primary?: boolean;
}

// ── Auth — Better Auth como fuente de verdad (D-021) ────────────────────────
//
// RLS: `users`/`organizations`/`members` tienen policies para el rol
// authenticated (self/tenant isolation). Las tablas internas de auth
// (`sessions`, `accounts`, `verifications`, `invitations`, `two_factors`) solo
// las toca Better Auth vía el cliente owner → RLS habilitada SIN policies ni
// grants (fail-closed para authenticated). Ver migración de RLS de D-021.

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Plugin twoFactor (F-003).
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  // Aceptación de Términos y Privacidad (Ley 25.326): checkbox en el registro
  // o modal única vez al iniciar sesión (migración 0003). Null = no aceptó aún.
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  // Perfil fiscal del PAS (M7, F-060). Columnas propias (Better Auth las
  // ignora): CUIT normalizado a dígitos, matrícula SSN y condición fiscal.
  cuit: text("cuit"),
  ssnMatricula: text("ssn_matricula"),
  fiscalCondition: text("fiscal_condition"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Plugin organization: modelo `member` (reemplaza a `memberships`). Better Auth
// exige un `id` propio; el unique (org, user) preserva la semántica anterior.
export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("members_org_user_idx").on(table.organizationId, table.userId),
    index("members_user_idx").on(table.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Plugin organization: org activa de la sesión (la lee el context tRPC).
    activeOrganizationId: uuid("active_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("accounts_user_idx").on(table.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

// Plugin organization: invitaciones a una org. Sin UI en v0.1 (F-005 single-org)
// pero el plugin requiere el modelo; la UI llega con multi-productor (v0.3).
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("invitations_org_idx").on(table.organizationId)],
);

// Plugin twoFactor (F-003): secret TOTP + backup codes (cifrados por BA).
export const twoFactors = pgTable(
  "two_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(false),
    // Better Auth 1.6: contador anti fuerza bruta del código TOTP (migración
    // 0004). El monolito viejo (BA anterior) no la conoce; default 0.
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
  },
  (table) => [index("two_factors_user_idx").on(table.userId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_log_org_created_idx").on(table.orgId, table.createdAt),
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
  ],
);

// ── M2 — Centro de Contactos (Capa 3, D-017.4) ──────────────────────────────
//
// Tabla única con discriminador `kind` (no herencia de 3 tablas: over-engineering
// que mataría los joins de F-011 360° y F-012 búsqueda). Modelo anclado en el
// modelo AR real del competidor principal (deep-dive §2.6/§2.14), referencia no copia.
//
// `dni` y `cuit` son columnas explícitas y ambas se almacenan (decisión del
// founder 29/05/2026): física usa `dni` (+ `cuit` opcional), jurídica usa `cuit`.
// Se revisa post-validación con Pablo si una sobra. Se guardan normalizadas
// (solo dígitos) vía Zod transform en la capa de aplicación; el formateo es
// responsabilidad del display.
//
// Dirección embebida (una sola, F-010 singular). La dirección del *riesgo*
// (radicación del auto, ubicación del hogar) NO vive acá — vive en el riesgo
// (F-020). Esta es solo el domicilio del contacto.
//
// `contact_methods` jsonb array (F-010 "contactos múltiples"); el primary phone
// alimenta el `wa.me` de F-051. Se extrae a tabla propia si v0.4 (WhatsApp API
// con threading por número) lo requiere.

export const contactKind = pgEnum("contact_kind", [
  "PERSONA_FISICA",
  "PERSONA_JURIDICA",
]);

// Ciclo de vida del contacto (F-013). "excliente" es estado, no soft-delete
// (buena práctica del competidor principal, deep-dive §2.3 — replicada sin copiar nombres).
export const contactStatus = pgEnum("contact_status", [
  "prospecto",
  "asegurado",
  "exasegurado",
]);

// Etapa del prospecto en el pipeline comercial (E8, O-10). Solo aplica a
// contactos con status=prospecto; nullable (un prospecto sin etapa cae en
// "nuevo" en el kanban). Al ganar/perder, el contacto pasa a cliente/excliente y
// la etapa se limpia.
export const prospectStage = pgEnum("prospect_stage", [
  "nuevo",
  "contactado",
  "cotizado",
  "negociacion",
]);

// Origen de un registro sincronizable (D-019 seam). Compartido por `contacts`
// y `policies`: hoy se usan `manual` / `import_csv`; `sync` queda listo para
// cuando llegue la sincronización con aseguradoras (gated por el deal B2B con
// cada compañía, doc 14 — acá es solo el asiento, no la implementación).
export const recordSource = pgEnum("record_source", [
  "manual",
  "import_csv",
  "sync",
]);

// La forma de cada entrada de `contact_methods` (tipo `ContactMethod`) y los
// schemas Zod de validación viven en `@/lib/contacts` (fuente única compartida
// con los forms RHF de la UI). Acá solo tipamos la columna jsonb.

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    kind: contactKind("kind").notNull(),

    // Nombre — física: first/last; jurídica: legalName. El display lo deriva
    // la app (física: "APELLIDO Nombre"; jurídica: razón social).
    firstName: text("first_name"),
    lastName: text("last_name"),
    legalName: text("legal_name"),

    // Documentos AR (normalizados, solo dígitos).
    dni: text("dni"),
    cuit: text("cuit"),

    status: contactStatus("status").notNull().default("prospecto"),
    // Etapa del pipeline comercial (E8). Solo significativa para prospectos.
    pipelineStage: prospectStage("pipeline_stage"),
    // Nota libre del contacto (agregada en migración posterior al checkout base).
    notes: text("notes"),
    // Productor asignado (agregada en migración posterior; nullable).
    producerId: uuid("producer_id").references((): AnyPgColumn => producers.id, {
      onDelete: "set null",
    }),

    // Origen del registro (D-019 seam). Default `manual`; el import CSV pasará a
    // setearlo en `import_csv`, y la sync de aseguradoras en `sync`.
    source: recordSource("source").notNull().default("manual"),

    // Dirección embebida (domicilio del contacto).
    addressStreet: text("address_street"),
    addressNumber: text("address_number"),
    addressFloor: text("address_floor"),
    addressApartment: text("address_apartment"),
    addressCity: text("address_city"),
    addressProvince: text("address_province"),
    addressPostalCode: text("address_postal_code"),

    contactMethods: jsonb("contact_methods")
      .$type<ContactMethod[]>()
      .notNull()
      .default([]),

    // F-014 — campos completados / total ponderado (0-100). Lo recalcula la
    // mutation en cada write; almacenado para permitir filtro/orden por calidad.
    dataQualityScore: integer("data_quality_score").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("contacts_org_idx").on(table.orgId),
    index("contacts_org_status_idx").on(table.orgId, table.status),
    index("contacts_dni_idx").on(table.dni),
    index("contacts_cuit_idx").on(table.cuit),
    // Búsqueda trigram (F-012) por nombre — pg_trgm/GIN. Requiere la extensión;
    // ver migrations/0002_search_trgm_indexes.sql.
    index("contacts_first_name_trgm").using("gin", sql`${table.firstName} gin_trgm_ops`),
    index("contacts_last_name_trgm").using("gin", sql`${table.lastName} gin_trgm_ops`),
    index("contacts_legal_name_trgm").using("gin", sql`${table.legalName} gin_trgm_ops`),
  ],
);

// ── M3 — Centro de Pólizas (Capa 4, D-019 seams-first) ──────────────────────
//
// Se construye a baja escala (alta manual, pocas aseguradoras) pero con las
// costuras de sincronización con aseguradoras listas desde el schema (D-019):
// el origen del dato (`source`), la referencia externa + payload crudo (O-64,
// deep-dive §2.16), el ID de lote, y la distinción "fecha lectura ≠ fecha
// actualización" (§2.16). Todas las columnas de sync son nullable: las usa la
// sync futura, no el alta manual. El índice único (org, aseguradora,
// external_ref) hace la sync idempotente desde el día 1 (previene el duplicado
// B-33 del competidor principal).
//
// La sync REAL no se implementa acá — está gated por el acuerdo comercial B2B
// con cada aseguradora (doc 14). Esto es solo el asiento.

// Catálogo de aseguradoras, org-scoped (v0.1: cada org configura las suyas; la
// identidad canónica global + coberturas normalizadas llegan con el
// multicotizador, O-103/O-106). Es el FK que referencia la póliza.
export const insurers = pgTable(
  "insurers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("insurers_org_idx").on(table.orgId),
    uniqueIndex("insurers_org_name_idx").on(table.orgId, table.name),
    // Búsqueda trigram por nombre de aseguradora (ver 0002_search_trgm_indexes.sql).
    index("insurers_name_trgm").using("gin", sql`${table.name} gin_trgm_ops`),
  ],
);

// ── Productores y organizador (D-019 organizador-first) ──────────────────────
//
// Un PAS puede ser "organizador": además de su cartera, tiene otros productores
// (colegas con matrícula propia) bajo su organización. Cada productor tiene su
// CÓDIGO por aseguradora — la clave con que la compañía identifica su cartera y
// sobre la que se arma la sincronización (doc 14). El organizador ve las carteras
// de todos (pólizas, siniestros, cuotas, estados, renovaciones) pero NO las
// comisiones de cada uno (privadas). v0.x: los productores son entidades dentro
// de la org del organizador; las orgs jerárquicas (cada productor con su login)
// son escala broker, futuro.
export const producers = pgTable(
  "producers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ssnMatricula: text("ssn_matricula"),
    // El productor dueño de la org (el organizador, p.ej. Pablo); los demás están
    // bajo su organización. Su comisión es de productor; sobre los otros, override.
    isSelf: boolean("is_self").notNull().default(false),
    // Vínculo opcional al usuario de Better Auth (agregada en migración
    // posterior al checkout base; nullable — no todo productor tiene login).
    userId: uuid("user_id").references((): AnyPgColumn => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("producers_org_idx").on(table.orgId)],
);

// Código de productor por aseguradora (la clave de la sync). Único por
// (org, aseguradora, código): un código identifica a un productor en esa compañía.
export const producerCodes = pgTable(
  "producer_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    producerId: uuid("producer_id")
      .notNull()
      .references(() => producers.id, { onDelete: "cascade" }),
    insurerId: uuid("insurer_id")
      .notNull()
      .references(() => insurers.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("producer_codes_org_idx").on(table.orgId),
    index("producer_codes_producer_idx").on(table.producerId),
    uniqueIndex("producer_codes_org_insurer_code_idx").on(
      table.orgId,
      table.insurerId,
      table.code,
    ),
  ],
);

// Ramo / línea de producto. Ampliado a los ramos reales del export de
// aseguradora (San Cristóbal): vida* colapsa a `vida` y AP* a
// `accidentes_personales`; el label original se preserva en external_raw. Ver
// docs/rumbo/15-import-cartera.md. Los valores nuevos van al final → la
// migración solo agrega (ALTER TYPE ADD VALUE), sin reordenar.
export const policyRamo = pgEnum("policy_ramo", [
  "automotor",
  "hogar",
  "vida",
  "art",
  "comercio",
  "accidentes_personales",
  "otros",
  "motovehiculo",
  "incendio",
  "responsabilidad_civil",
  "consorcio",
  "seguro_tecnico",
  "transporte",
  "embarcaciones",
]);

// Ciclo de vida de la póliza (v0.1, a refinar con Pablo). `renovada` es terminal
// y la setea solo la acción de renovar (F-026): la póliza fue sucedida por un
// nuevo período → sale de la lista de vencimientos. No es elegible en el alta.
export const policyStatus = pgEnum("policy_status", [
  "propuesta",
  "vigente",
  "vencida",
  "anulada",
  "renovada",
]);

// Forma de pago de la póliza (agregada en migración posterior al checkout base).
export const paymentMethod = pgEnum("payment_method", [
  "cupon",
  "debito_bancario",
  "tarjeta_credito",
]);

// Centro de Siniestros (M4, F-030/F-032). Estados default; custom states → v0.3.
export const claimStatus = pgEnum("claim_status", [
  "abierto",
  "en_curso",
  "cerrado",
]);

// Tipo de siniestro. Tokens ASCII en DB; las etiquetas en español viven en
// @/lib/claims. Set acotado v0.1 (cubre los ramos más comunes) + `otros`.
export const claimType = pgEnum("claim_type", [
  "robo",
  "choque",
  "incendio",
  "danos_agua",
  "granizo",
  "cristales",
  "resp_civil",
  "otros",
]);

// Eventos del timeline de un siniestro (M4 Inc.2, F-033): comentarios del PAS y
// cambios de estado. La creación es implícita (se muestra desde la fila claim).
export const claimEventKind = pgEnum("claim_event_kind", [
  "comment",
  "status_change",
]);

// Importancia/priorización de un siniestro (E4, deep-dive §2.32). Input subjetivo
// del PAS que segmenta operativamente cuáles atender primero. Base manual de la
// priorización asistida por IA (O-140). Nullable = sin priorizar.
export const claimImportance = pgEnum("claim_importance", [
  "alta",
  "media",
  "baja",
]);

export const policies = pgTable(
  "policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Titular de la póliza. Los roles múltiples (Asegurado/Tomador/Beneficiario,
    // deep-dive §2.7) son un seam futuro (tabla `policy_parties`); v0.1 = un
    // titular.
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    insurerId: uuid("insurer_id")
      .notNull()
      .references(() => insurers.id, { onDelete: "restrict" }),
    // Productor dueño de esta póliza (D-019 organizador). Nullable: el alta manual
    // puede no tenerlo; el import lo resuelve por el código de productor (PAS).
    producerId: uuid("producer_id").references(() => producers.id, {
      onDelete: "set null",
    }),

    ramo: policyRamo("ramo").notNull(),
    policyNumber: text("policy_number"),
    status: policyStatus("status").notNull().default("vigente"),

    startDate: date("start_date"),
    endDate: date("end_date"),

    // Montos. numeric → string en la app; el formateo es del display.
    prima: numeric("prima", { precision: 14, scale: 2 }),
    premio: numeric("premio", { precision: 14, scale: 2 }),
    // Suma asegurada (capital cubierto del bien). La trae el export de
    // aseguradora; en alta manual es opcional.
    sumaAsegurada: numeric("suma_asegurada", { precision: 14, scale: 2 }),
    currency: text("currency").notNull().default("ARS"),

    // Baja de la póliza. La aseguradora informa fecha + motivo (texto libre, sin
    // taxonomía propia en v0.1); alimenta el análisis de churn de exclientes.
    canceledAt: date("canceled_at"),
    cancelReason: text("cancel_reason"),

    // Renovación (F-026, Incremento 2): la póliza nueva apunta a la que renovó.
    // Self-FK → preserva el linaje de períodos. set null si se borrara la previa.
    renewedFromPolicyId: uuid("renewed_from_policy_id").references(
      (): AnyPgColumn => policies.id,
      { onDelete: "set null" },
    ),

    // ── Costuras de sync (nullable; las usa la sync futura, no el alta manual) ─
    source: recordSource("source").notNull().default("manual"),
    externalRef: text("external_ref"), // nº de póliza en la aseguradora
    externalRaw: jsonb("external_raw"), // payload crudo persistido (O-64)
    syncBatchId: text("sync_batch_id"), // ID Lote (§2.16)
    lastReadAt: timestamp("last_read_at", { withTimezone: true }), // fecha lectura
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }), // fecha actualización

    // Columnas agregadas en migraciones posteriores al checkout base.
    notes: text("notes"),
    paymentMethod: paymentMethod("payment_method"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("policies_org_idx").on(table.orgId),
    index("policies_org_status_idx").on(table.orgId, table.status),
    index("policies_contact_idx").on(table.contactId),
    index("policies_insurer_idx").on(table.insurerId),
    // Vencimientos (F-025): query por ventana de fecha de fin dentro de la org.
    index("policies_org_enddate_idx").on(table.orgId, table.endDate),
    // Búsqueda por substring (ILIKE '%q%') del listado paginado — pg_trgm/GIN.
    // Ver migrations/0002_search_trgm_indexes.sql y roadmap/PLAN-ESCALABILIDAD.md.
    index("policies_policy_number_trgm").using("gin", sql`${table.policyNumber} gin_trgm_ops`),
    index("policies_notes_trgm").using("gin", sql`${table.notes} gin_trgm_ops`),
    // Idempotencia de sync: una póliza externa por (org, aseguradora, ref).
    uniqueIndex("policies_external_ref_idx")
      .on(table.orgId, table.insurerId, table.externalRef)
      .where(sql`${table.externalRef} IS NOT NULL`),
  ],
);

// Bien asegurado / riesgo de una póliza (M3). Polimórfico por ramo: columnas
// promovidas e indexadas para lo que se busca y se muestra (`patente`,
// `descripcion`) + `data` jsonb para los atributos que varían por ramo
// (marca/modelo/año en auto; domicilio del riesgo, m², tipo en hogar; etc.). Así
// no se migra el schema por cada atributo nuevo. Relación 1:N: una póliza puede
// cubrir varios bienes (flota, comercio multi-local), aunque el export de
// aseguradora trae uno por póliza. Mismas costuras de origen/import que el resto
// (D-019). Ver docs/rumbo/15-import-cartera.md.
export const policyRisks = pgTable(
  "policy_risks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => policies.id, { onDelete: "cascade" }),

    // `patente` se promueve e indexa (búsqueda F-012: el PAS busca por patente).
    // `descripcion` es el texto libre del riesgo que da la aseguradora.
    patente: text("patente"),
    descripcion: text("descripcion"),

    // Atributos variables por ramo (no promovidos): marca, modelo, año, motor,
    // chasis, uso (auto); domicilio del riesgo, m², tipo (hogar); etc.
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),

    // ── Costuras de origen/import (D-019) ─────────────────────────────────────
    source: recordSource("source").notNull().default("manual"),
    externalRef: text("external_ref"), // nº de póliza/bien en la aseguradora
    externalRaw: jsonb("external_raw"), // payload crudo del bien (O-64)

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("policy_risks_org_idx").on(table.orgId),
    index("policy_risks_policy_idx").on(table.policyId),
    // Búsqueda por patente dentro de la org (F-012).
    index("policy_risks_org_patente_idx").on(table.orgId, table.patente),
    // Filtro "flota" por descripción del riesgo — pg_trgm/GIN
    // (ver 0002_search_trgm_indexes.sql).
    index("policy_risks_descripcion_trgm").using("gin", sql`${table.descripcion} gin_trgm_ops`),
  ],
);

// Centro de Siniestros (M4, D-019 seams-first). El siniestro cuelga de una
// póliza (el "bien asegurado", §2.8.1); el contacto se deriva por la póliza.
export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => policies.id, { onDelete: "restrict" }),

    tipo: claimType("tipo").notNull(),
    status: claimStatus("status").notNull().default("abierto"),
    // Priorización del PAS (E4, §2.32). Nullable: los siniestros existentes y los
    // que entran por sync quedan "sin priorizar" hasta que el PAS los clasifique.
    importance: claimImportance("importance"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(), // fecha+hora del hecho
    reportedBy: text("reported_by").notNull(), // denunciante

    claimNumber: text("claim_number"), // nº de siniestro de la aseguradora
    location: text("location"),
    description: text("description"),

    // ── Costuras de sync (las usa la sync futura, no el alta manual) ──────────
    source: recordSource("source").notNull().default("manual"),
    externalRef: text("external_ref"),

    // F-034: última actividad (alta, comentario o cambio de estado). Se bumpea
    // en cada evento; alimenta la alerta "abierto hace N días sin movimiento".
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("claims_org_idx").on(table.orgId),
    index("claims_org_status_idx").on(table.orgId, table.status),
    index("claims_policy_idx").on(table.policyId),
    // Idempotencia del import/sync de siniestros: un siniestro externo por
    // (org, ref = nº de siniestro de la aseguradora). El alta manual no setea
    // external_ref → queda fuera del índice (parcial).
    uniqueIndex("claims_external_ref_idx")
      .on(table.orgId, table.externalRef)
      .where(sql`${table.externalRef} IS NOT NULL`),
  ],
);

// Timeline de un siniestro (M4 Inc.2, F-033): comentarios + cambios de estado.
export const claimEvents = pgTable(
  "claim_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),

    kind: claimEventKind("kind").notNull(),
    body: text("body"), // texto del comentario (kind=comment)
    newStatus: claimStatus("new_status"), // estado destino (kind=status_change)

    // Autor del evento (fila espejo local en `users`). Nullable por robustez.
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("claim_events_org_idx").on(table.orgId),
    index("claim_events_claim_idx").on(table.claimId, table.createdAt),
  ],
);

// Plan de pagos de una póliza (M3, F-026). Cronograma de cuotas; el estado
// (pagada / vencida / pendiente) se deriva de `paidAt` + `dueDate` (sin cron).
export const policyInstallments = pgTable(
  "policy_installments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => policies.id, { onDelete: "cascade" }),

    number: integer("number").notNull(), // nº de cuota (1..N)
    dueDate: date("due_date").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }), // null = pendiente

    // ── Costuras de sync (las llenará la sync del plan real, v0.2/F-102) ──────
    source: recordSource("source").notNull().default("manual"),
    externalRef: text("external_ref"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("policy_installments_org_idx").on(table.orgId),
    index("policy_installments_policy_idx").on(table.policyId),
    // Cuotas vencidas (F-043): impagas por vencimiento dentro de la org.
    index("policy_installments_org_due_idx").on(table.orgId, table.dueDate),
  ],
);

// Tipo de movimiento de póliza (endoso). El endoso es la fuente de verdad de
// cualquier modificación de la póliza (deep-dive §2.13: el ajuste inflacionario
// AR no es cálculo runtime, son endosos formales emitidos mes a mes). Tipificado
// (O-57): el competidor principal solo muestra "Emisión"/"Endoso"; Rumbo
// distingue para analytics, en particular `refacturacion` (ajuste de prima sin
// cambio de contrato), que es la señal de retención/churn del mercado AR (§2.38).
export const endorsementType = pgEnum("endorsement_type", [
  "emision", // #0 — alta de la póliza
  "refacturacion", // ajuste de prima sin cambio de contrato (inflación AR)
  "endoso", // cambio genérico (cobertura, bien, partes, beneficiario)
  "anulacion", // baja
]);

// Endosos / movimientos de una póliza (E0, doc 15: la única pieza conceptual que
// faltaba). La póliza = secuencia de movimientos; su prima/premio vigentes
// reflejan el último endoso, y el plan de pagos se deriva de la secuencia. Hoy se
// carga a mano o por sync; vacío hasta entonces (no bloquea, D-024).
export const policyEndorsements = pgTable(
  "policy_endorsements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => policies.id, { onDelete: "cascade" }),

    // Nº de movimiento: 0 = Emisión, 1+ = endosos posteriores (§2.13). Lo provee
    // la aseguradora en el sync; en el alta manual lo elige el usuario.
    number: integer("number").notNull(),
    type: endorsementType("type").notNull().default("endoso"),

    issuedAt: date("issued_at"), // fecha de emisión del endoso
    startDate: date("start_date"), // inicio de vigencia que aplica
    endDate: date("end_date"), // fin de vigencia que aplica

    // Montos del movimiento. numeric → string en la app; el formateo es del display.
    prima: numeric("prima", { precision: 14, scale: 2 }),
    premio: numeric("premio", { precision: 14, scale: 2 }),

    description: text("description"), // detalle del cambio (O-57)

    // ── Costuras de sync (nullable; las usa la sync futura, no el alta manual) ─
    source: recordSource("source").notNull().default("manual"),
    externalRef: text("external_ref"),
    externalRaw: jsonb("external_raw"), // payload crudo del movimiento (O-64)

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("policy_endorsements_org_idx").on(table.orgId),
    index("policy_endorsements_policy_idx").on(table.policyId),
    // Un movimiento por número por póliza: idempotencia del alta/sync y evita el
    // duplicado que el competidor principal sí tiene (§2.14, B-33).
    uniqueIndex("policy_endorsements_policy_number_idx").on(
      table.orgId,
      table.policyId,
      table.number,
    ),
  ],
);

// Rol de una parte en la póliza (E1, deep-dive §2.14). El titular vive en
// `policies.contact_id`; esta tabla suma las OTRAS partes (tomador, beneficiario,
// etc.). Set acotado v0.1 + `otro`.
export const policyPartyRole = pgEnum("policy_party_role", [
  "asegurado",
  "tomador",
  "beneficiario",
  "conductor",
  "acreedor_prendario",
  "otro",
]);

// Partes / personas de una póliza (E1, seam `policy_parties` ya documentado).
// Una parte ES un contacto del sistema: NO duplicamos PII por-parte (la
// minimizamos a propósito, doc 15 §lente PII); apuntamos al contacto, que es la
// fuente única de los datos de la persona (O-60: id interno propio = el uuid del
// contacto, independiente del documento).
export const policyParties = pgTable(
  "policy_parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => policies.id, { onDelete: "cascade" }),
    // restrict: un contacto que es parte de una póliza no se borra sin antes
    // sacarlo de la póliza (igual que el titular en `policies`).
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    role: policyPartyRole("role").notNull(),

    // ── Costuras de sync (nullable; las usa la sync futura, no el alta manual) ─
    source: recordSource("source").notNull().default("manual"),
    externalRef: text("external_ref"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("policy_parties_org_idx").on(table.orgId),
    index("policy_parties_policy_idx").on(table.policyId),
    index("policy_parties_contact_idx").on(table.contactId),
    // O-59: una persona no se repite con el mismo rol en la misma póliza (evita
    // el duplicado que el competidor principal sí tiene, B-33). Idempotente.
    uniqueIndex("policy_parties_unique_idx").on(
      table.orgId,
      table.policyId,
      table.contactId,
      table.role,
    ),
  ],
);

// Tipo de relación entre dos contactos (E2, deep-dive §2.21 / O-82). La
// competencia las deja SIN tipo (B-44) → grafo plano sin semántica; Rumbo las tipifica
// (habilita cross-sell familiar, grupos, segmentación). El par se guarda en UNA
// fila dirigida (contact_id → related_contact_id), y el lado inverso se deriva
// (O-83: hijo↔padre_madre, empleado↔empleador; los simétricos se mapean a sí
// mismos). El mapa de inversos vive en @/lib/contact-relationships.
export const contactRelationType = pgEnum("contact_relation_type", [
  "conyuge",
  "conviviente",
  "hijo",
  "padre_madre",
  "hermano",
  "socio",
  "empleado",
  "empleador",
  "familiar",
  "otro",
]);

// Relaciones persona↔persona (E2). Vincula dos contactos de la org con un tipo.
// Bidireccional por derivación: una sola fila, render simétrico (O-83).
export const contactRelationships = pgTable(
  "contact_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // El tipo se interpreta desde contact_id: "contact_id es <tipo> de
    // related_contact_id" (ej. hijo). cascade: si se borra un contacto, su
    // relación se va con él.
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    relatedContactId: uuid("related_contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    type: contactRelationType("type").notNull(),
    note: text("note"),

    // ── Costuras de sync (nullable) ───────────────────────────────────────────
    source: recordSource("source").notNull().default("manual"),
    externalRef: text("external_ref"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("contact_relationships_org_idx").on(table.orgId),
    index("contact_relationships_contact_idx").on(table.contactId),
    index("contact_relationships_related_idx").on(table.relatedContactId),
    // Una relación por par dirigido (idempotencia). El doble-sentido (B→A) lo
    // bloquea el router chequeando ambas direcciones antes de insertar.
    uniqueIndex("contact_relationships_pair_idx").on(
      table.orgId,
      table.contactId,
      table.relatedContactId,
    ),
  ],
);

// Direcciones adicionales de un contacto (E2, deep-dive §2.17 / lección #1:
// "múltiples direcciones por contacto"). El domicilio PRINCIPAL sigue embebido en
// `contacts` (alimenta la calidad de datos y el import); esta tabla guarda las
// OTRAS direcciones (trabajo, segunda propiedad, etc.) con una etiqueta libre.
// La ubicación del *riesgo* (radicación del auto/hogar) NO vive acá — vive en
// `policy_risks`.
export const contactAddresses = pgTable(
  "contact_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),

    label: text("label"), // "Trabajo", "Country", etc.
    street: text("street"),
    number: text("number"),
    floor: text("floor"),
    apartment: text("apartment"),
    city: text("city"),
    province: text("province"),
    postalCode: text("postal_code"),

    // ── Costuras de sync (nullable) ───────────────────────────────────────────
    source: recordSource("source").notNull().default("manual"),
    externalRef: text("external_ref"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("contact_addresses_org_idx").on(table.orgId),
    index("contact_addresses_contact_idx").on(table.contactId),
  ],
);

// Rol del responsable asignado a un contacto (E2, deep-dive §2.20 / O-79, O-80).
// "Ejecutivo" en la competencia; Rumbo lo nombra "Responsable" y permite especializar
// (comercial, cobranzas, siniestros). Los permisos derivados (O-81) quedan v0.2.
export const contactAssigneeRole = pgEnum("contact_assignee_role", [
  "responsable",
  "comercial",
  "cobranzas",
  "siniestros",
]);

// Asignación de un usuario de la org como responsable de un contacto (E2). M2M
// org→usuarios→contactos. El usuario asignable es un miembro de la org (se valida
// en el router); listar sus nombres requiere la policy SELECT de co-miembros
// sobre `users` (anticipada en 0001; ver migración de RLS de esta tabla).
export const contactAssignees = pgTable(
  "contact_assignees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    // Usuario responsable (miembro de la org). cascade: si se elimina el usuario,
    // su asignación se va con él.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: contactAssigneeRole("role").notNull().default("responsable"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("contact_assignees_org_idx").on(table.orgId),
    index("contact_assignees_contact_idx").on(table.contactId),
    index("contact_assignees_user_idx").on(table.userId),
    // Un usuario no se asigna dos veces con el mismo rol al mismo contacto.
    uniqueIndex("contact_assignees_unique_idx").on(
      table.orgId,
      table.contactId,
      table.userId,
      table.role,
    ),
  ],
);

// ── E3 — Multicotizador (deep-dive §2.25-2.28, D-024) ───────────────────────
//
// Catálogo propio de coberturas normalizadas (O-106): la capa que el competidor
// principal mantiene contra los códigos nativos de cada aseguradora. v0.1 cubre
// las 8 de Automotor (§2.27.5); se extiende a otros ramos sumando valores. Es la
// "infraestructura crítica del multicotizador" (lección #3). Las labels viven en
// @/lib/quotes.
export const normalizedCoverage = pgEnum("normalized_coverage", [
  "incendio_robo_garage", // Cobertura E - Incendio y Robo en garage
  "rc", // Responsabilidad Civil
  "rc_grua", // RC con grúa
  "rc_robo_incendio", // RC + robo + incendio total
  "terceros_completo", // Tercero completo
  "terceros_completo_full", // Tercero completo full
  "todo_riesgo_franquicia", // Todo Riesgo con franquicia
  "todo_riesgo_sin_franquicia", // Todo Riesgo sin franquicia
]);

// Cotización (cabecera). Inputs del vehículo + asegurado; opcionalmente vinculada
// a un contacto (O-108, funnel real). El rating en vivo está gated por
// integración (D-024) → las opciones se cargan a mano en `quote_items`.
export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Vínculo opcional al contacto (prospecto/cliente). set null: borrar el
    // contacto no borra la cotización.
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    ramo: policyRamo("ramo").notNull().default("automotor"),
    reference: text("reference"), // nombre del prospecto / contexto libre

    // Datos del vehículo (Automotor; texto libre, sin catálogo de marcas v0.1).
    vehicleMarca: text("vehicle_marca"),
    vehicleModelo: text("vehicle_modelo"),
    vehicleAnio: text("vehicle_anio"),
    vehicleVersion: text("vehicle_version"),

    notes: text("notes"),

    // Columnas agregadas en migraciones posteriores al checkout base.
    producerId: uuid("producer_id").references((): AnyPgColumn => producers.id, {
      onDelete: "set null",
    }),
    details: jsonb("details"),

    // ── Costuras de sync/origen (nullable) ────────────────────────────────────
    source: recordSource("source").notNull().default("manual"),
    externalRef: text("external_ref"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("quotes_org_idx").on(table.orgId),
    index("quotes_org_created_idx").on(table.orgId, table.createdAt), // historial
    index("quotes_contact_idx").on(table.contactId),
  ],
);

// Opción de una cotización: una fila por (aseguradora × cobertura) con su suma
// asegurada y cuota (§2.28.2). El catálogo normalizado permite agrupar/comparar
// (matriz, E3.2); el `nativeCode` preserva el código crudo de la aseguradora.
export const quoteItems = pgTable(
  "quote_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    insurerId: uuid("insurer_id")
      .notNull()
      .references(() => insurers.id, { onDelete: "restrict" }),

    // Categoría normalizada (para agrupar/comparar); nullable porque un ramo sin
    // catálogo aún puede cargar opciones con solo el código nativo.
    coverage: normalizedCoverage("coverage"),
    nativeCode: text("native_code"), // "C - Terceros Completos" (código de la aseguradora)

    sumaAsegurada: numeric("suma_asegurada", { precision: 14, scale: 2 }),
    cuota: numeric("cuota", { precision: 14, scale: 2 }),
    currency: text("currency").notNull().default("ARS"),

    source: recordSource("source").notNull().default("manual"),
    externalRef: text("external_ref"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("quote_items_org_idx").on(table.orgId),
    index("quote_items_quote_idx").on(table.quoteId),
  ],
);

// Documentos / adjuntos (épica Documentos, deep-dive §2.15/§2.22). Es la primera
// entidad cuyo dato es un ARCHIVO: el binario vive en object storage (Cloudflare
// R2), no en Postgres; acá guardamos solo la metadata. La key de R2 es
// `${orgId}/${id}` (uuids → sin encoding de nombres); el filename real va en
// `file_name` (para el display y el Content-Disposition al descargar).
//
// Polimórfica: cuelga de una póliza O de un contacto (XOR, no ambos). cascade en
// ambos: si se borra la póliza/contacto, su metadata se va (el objeto en R2 lo
// limpia el router al borrar explícito; el cascade de DB no toca R2).
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").references(() => policies.id, {
      onDelete: "cascade",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),

    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(), // key del objeto en R2

    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("documents_org_idx").on(table.orgId),
    index("documents_policy_idx").on(table.policyId),
    index("documents_contact_idx").on(table.contactId),
    // Cuelga de exactamente uno: póliza XOR contacto.
    check(
      "documents_target_chk",
      sql`(${table.policyId} IS NOT NULL) <> (${table.contactId} IS NOT NULL)`,
    ),
  ],
);

// Log de comunicaciones (M6, F-052): el "marqué que envié". v0.1 registra el
// hecho (canal + template + cuerpo) al abrir wa.me — no hay API de WhatsApp,
// así que es un registro manual/asistido, no un tracking de entrega. La
// póliza es opcional (una comunicación puede ser general del contacto).
export const communicationChannel = pgEnum("communication_channel", [
  "whatsapp",
  "email",
  "llamada",
  "otro",
]);

export const communications = pgTable(
  "communications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").references(() => policies.id, {
      onDelete: "set null",
    }),
    channel: communicationChannel("channel").notNull().default("whatsapp"),
    templateId: text("template_id"),
    body: text("body"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("communications_org_idx").on(table.orgId),
    index("communications_contact_idx").on(table.contactId, table.createdAt),
  ],
);

// Plantillas de mensajes propias del PAS (E7, O-49). Los 4 templates built-in
// viven en @/lib/messaging; estos son los que el PAS crea/edita para reusar en
// el envío por WhatsApp (con variables {nombre} {poliza} {vencimiento} {monto}).
// La API real de WhatsApp Business (bandeja, delivery) queda gated por Meta.
export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    body: text("body").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("message_templates_org_idx").on(table.orgId)],
);

// Dedup de avisos de vencimiento por email (Slice 5 de paridad). Unique
// (policy, window): una póliza se avisa UNA vez por ventana (30d/7d). RLS
// habilitado SIN policies (fail-closed): solo la toca el cron con el cliente
// owner. La tabla YA existe en la DB (migración 0050 del monolito).
export const expiryNotificationWindow = pgEnum("expiry_notification_window", [
  "30d",
  "7d",
]);

export const expiryNotifications = pgTable(
  "expiry_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => policies.id, { onDelete: "cascade" }),
    window: expiryNotificationWindow("window").notNull(),
    // Si el aviso al asegurado salió (flag EXPIRY_EMAILS_TO_CONTACTS): a qué
    // casilla. null = solo digest interno (flag apagado o asegurado sin email).
    contactEmail: text("contact_email"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("expiry_notifications_policy_window_idx").on(
      table.policyId,
      table.window,
    ),
    index("expiry_notifications_org_idx").on(table.orgId),
  ],
);

// Allowlist de la beta privada (ex-"lista de espera", M8). Tabla global (no
// org-scoped, es pre-cuenta): la pobla el owner manualmente (Neon/script). El
// gate de registro (auth.ts, BETA_ALLOWLIST) lee de acá. Sin RLS ni grants al
// rol authenticated. Ya no hay endpoint público que la escriba.
export const waitlist = pgTable("waitlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── Calendario (jul-2026) ────────────────────────────────────────────────────
//
// Agenda propia del PAS: llamadas, reuniones, trámites — con vínculo opcional
// a asegurado/póliza. Los vencimientos/cuotas/siniestros que muestra el
// calendario son DERIVADOS de sus tablas (no se duplican); acá solo vive lo
// que el usuario agenda a mano. producer_id: dueño del evento (sistema de
// roles) — se estampa server-side al crear. Portado 1:1 de la app v0.1
// (migración drizzle 0052): la DDL + RLS vive en migrations/0001_calendar_events.sql.
export const calendarEventKind = pgEnum("calendar_event_kind", [
  "llamada",
  "reunion",
  "tramite",
  "otro",
]);

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // set null: borrar un productor no borra su agenda (la hereda la org).
    producerId: uuid("producer_id").references(() => producers.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: calendarEventKind("kind").notNull().default("otro"),
    title: text("title").notNull(),
    notes: text("notes"),
    date: date("date").notNull(),
    time: time("time"), // null = todo el día
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    policyId: uuid("policy_id").references(() => policies.id, {
      onDelete: "cascade",
    }),
    // Check de "hecho" de la agenda (tachado en la UI). null = pendiente.
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("calendar_events_org_date_idx").on(table.orgId, table.date),
  ],
);
