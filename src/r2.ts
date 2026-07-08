// Cliente de Cloudflare R2 (object storage para los adjuntos). Habla la API S3
// firmando con SigV4 (@/lib/sigv4, validado contra el vector de AWS). Server-only
// (usa secrets). Si falta config, las funciones tiran un error claro — la feature
// queda inerte hasta que se aprovisione el bucket + credenciales (R2_*).
//
// Enfoque server-proxied (el archivo pasa por el route handler, no hay subida
// directa del browser) → no hace falta CORS en el bucket. Los PDFs de póliza son
// chicos; el límite de body de la función serverless alcanza.

import { sha256Hex, signS3Request } from "./lib/sigv4.js";

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
  );
}

function r2Config(): R2Config {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "R2 no configurado: faltan R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y/o R2_BUCKET.",
    );
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

// Key del objeto en R2: solo uuids (sin nombre de archivo) → URI canónica trivial.
export function documentKey(orgId: string, documentId: string): string {
  return `${orgId}/${documentId}`;
}

async function r2Fetch(
  method: string,
  key: string,
  opts?: { body?: Uint8Array; contentType?: string },
): Promise<Response> {
  const cfg = r2Config();
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const url = `https://${host}/${cfg.bucket}/${key}`;
  const body = opts?.body;
  const payloadHash = body ? await sha256Hex(body) : await sha256Hex("");

  // Solo firmamos host (+ content-type en PUT); el resto van sin firmar. R2 usa
  // region "auto".
  const headersToSign: Record<string, string> = { host };
  if (opts?.contentType) headersToSign["content-type"] = opts.contentType;

  const { headers } = await signS3Request({
    method,
    url,
    headers: headersToSign,
    payloadHash,
    region: "auto",
    service: "s3",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });

  return fetch(url, {
    method,
    headers,
    body: body ? (body as BodyInit) : null,
  });
}

export async function putObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const res = await r2Fetch("PUT", key, { body, contentType });
  if (!res.ok) {
    throw new Error(`R2 put falló (${res.status})`);
  }
}

// Devuelve la Response cruda de R2 para que el route handler stree el body.
export async function getObject(key: string): Promise<Response> {
  const res = await r2Fetch("GET", key);
  if (!res.ok) {
    throw new Error(`R2 get falló (${res.status})`);
  }
  return res;
}

export async function deleteObject(key: string): Promise<void> {
  const res = await r2Fetch("DELETE", key);
  // 404 = ya no estaba; lo tratamos como éxito (idempotente).
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 delete falló (${res.status})`);
  }
}
