// Documentos / adjuntos (Slice 4 de paridad; portado del router documents +
// route handlers /api/documents/upload y /api/documents/[id] del monolito).
// Server-proxied: el binario pasa por acá (multer en memoria, 10 MB) → sin CORS
// en el bucket. Metadata en Postgres (RLS); binario en R2 (SigV4 propio).
// Si R2 no está configurado (faltan R2_*), upload/download devuelven 503 con
// mensaje claro y el resto de la app sigue andando.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import multer from 'multer';

import { withAuthedTx, schema } from '../db/client.js';
import { writeAuditLogTx } from '../audit.js';
import { deleteObject, documentKey, getObject, isR2Configured, putObject } from '../r2.js';

const { contacts, documents, policies } = schema;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

export const documentsRouter = Router();

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

// Subida (multipart: file + policyId XOR contactId).
documentsRouter.post(
  '/documents/upload',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!isR2Configured()) {
      res.status(503).json({ error: 'El almacenamiento de documentos no está configurado todavía (R2).' });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Falta el archivo.' });
      return;
    }
    const policyId = typeof req.body.policyId === 'string' && req.body.policyId ? req.body.policyId : null;
    const contactId = typeof req.body.contactId === 'string' && req.body.contactId ? req.body.contactId : null;
    if (Boolean(policyId) === Boolean(contactId)) {
      res.status(400).json({ error: 'Indicá una póliza o un asegurado (exactamente uno).' });
      return;
    }
    if ((policyId && !isUuid(policyId)) || (contactId && !isUuid(contactId))) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    if (file.size === 0) {
      res.status(400).json({ error: 'El archivo está vacío.' });
      return;
    }
    const contentType = file.mimetype || 'application/octet-stream';
    if (!ALLOWED.has(contentType)) {
      res.status(400).json({ error: 'Formato no permitido (PDF o imagen).' });
      return;
    }

    const ctx = req.authCtx!;
    // La póliza/asegurado debe ser de la org (RLS oculta lo ajeno → no se encuentra).
    const owned = await withAuthedTx(ctx, async tx => {
      if (policyId) {
        const [p] = await tx.select({ id: policies.id }).from(policies).where(eq(policies.id, policyId)).limit(1);
        return Boolean(p);
      }
      const [c] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId!)).limit(1);
      return Boolean(c);
    });
    if (!owned) {
      res.status(404).json({ error: 'No encontrado.' });
      return;
    }

    const docId = randomUUID();
    const key = documentKey(ctx.orgId, docId);
    await putObject(key, new Uint8Array(file.buffer), contentType);

    try {
      await withAuthedTx(ctx, async tx => {
        const [row] = await tx
          .insert(documents)
          .values({
            id: docId,
            orgId: ctx.orgId,
            policyId,
            contactId,
            fileName: file.originalname || 'documento',
            contentType,
            sizeBytes: file.size,
            storageKey: key,
            uploadedByUserId: ctx.userId,
          })
          .returning({ id: documents.id });
        await writeAuditLogTx(tx, {
          orgId: ctx.orgId,
          userId: ctx.userId,
          action: 'upload_document',
          entityType: 'document',
          entityId: row!.id,
          payload: policyId ? { policyId } : { contactId },
        });
      });
    } catch (err) {
      // Si la metadata no se pudo guardar, el objeto ya subido queda huérfano en
      // R2: limpiarlo best-effort antes de propagar el error.
      await deleteObject(key).catch(() => {});
      throw err;
    }
    res.status(201).json({ id: docId });
  }),
);

// Descarga: valida pertenencia vía RLS y strea el binario con el content-type
// verificado de la metadata (no el que diga R2).
documentsRouter.get(
  '/documents/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    if (!isR2Configured()) {
      res.status(503).json({ error: 'El almacenamiento de documentos no está configurado todavía (R2).' });
      return;
    }
    const doc = await withAuthedTx(req.authCtx!, async tx => {
      const [d] = await tx
        .select({ storageKey: documents.storageKey, contentType: documents.contentType, fileName: documents.fileName })
        .from(documents)
        .where(eq(documents.id, id))
        .limit(1);
      return d ?? null;
    });
    if (!doc) {
      res.status(404).json({ error: 'Documento no encontrado.' });
      return;
    }
    const obj = await getObject(doc.storageKey);
    res.setHeader('Content-Type', doc.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.fileName.replace(/[^\w. -]/g, '_')}"`);
    const buf = Buffer.from(await obj.arrayBuffer());
    res.send(buf);
  }),
);

// Borrado: metadata primero (tx con audit); el objeto de R2 se borra DESPUÉS
// del commit. Antes el delete de R2 corría adentro de la tx: si la tx revertía
// después, la fila quedaba apuntando a un objeto ya borrado (download roto).
// Al revés el peor caso es un objeto huérfano en R2, inaccesible y re-borrable.
documentsRouter.delete(
  '/documents/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Id inválido.' });
      return;
    }
    const ctx = req.authCtx!;
    const out = await withAuthedTx(ctx, async tx => {
      const [doc] = await tx
        .delete(documents)
        .where(eq(documents.id, id))
        .returning({ id: documents.id, storageKey: documents.storageKey });
      if (!doc) return null;
      await writeAuditLogTx(tx, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: 'delete_document',
        entityType: 'document',
        entityId: doc.id,
      });
      return doc;
    });
    if (!out) {
      res.status(404).json({ error: 'Documento no encontrado.' });
      return;
    }
    if (isR2Configured()) {
      await deleteObject(out.storageKey).catch(e => {
        console.error(`[documents] R2 delete falló para ${out.storageKey} (metadata ya borrada):`, e);
      });
    }
    res.json({ ok: true });
  }),
);
