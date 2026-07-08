// Firmado AWS Signature V4 para APIs S3-compatibles (Cloudflare R2). Sin
// dependencias: usa Web Crypto (HMAC-SHA256), disponible en el runtime de Node y
// edge. Aislado y puro (sin env, sin fetch) → testeable contra los vectores
// oficiales de AWS. La R2 client (src/server/r2.ts) lo usa para firmar PUT/GET/
// DELETE de objetos.
//
// Las object keys que generamos son solo uuids (orgId/documentId), así que la URI
// canónica no necesita encoding especial de nombres de archivo.

const enc = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    enc.encode(data) as BufferSource,
  );
  return new Uint8Array(sig);
}

export interface S3SignInput {
  method: string; // GET | PUT | DELETE
  url: string; // URL completa (host + path [+ query])
  headers: Record<string, string>; // debe incluir host
  payloadHash: string; // sha256 hex del body (o de "" para GET/DELETE)
  region: string; // R2: "auto"
  service: string; // "s3"
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date; // inyectable para tests
}

// Firma una request y devuelve los headers a enviar (incluye Authorization,
// x-amz-date y x-amz-content-sha256). El `signature` es lo que validan los tests.
export async function signS3Request(
  input: S3SignInput,
): Promise<{ headers: Record<string, string>; signature: string }> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8); // YYYYMMDD
  const u = new URL(input.url);

  const allHeaders: Record<string, string> = {
    ...input.headers,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": input.payloadHash,
  };

  // Headers canónicos: nombre en minúscula, valor trimmeado, ordenados por nombre.
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(allHeaders)) {
    norm[k.toLowerCase()] = String(v).trim();
  }
  const sortedKeys = Object.keys(norm).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${norm[k]}\n`).join("");
  const signedHeaders = sortedKeys.join(";");

  // Query string canónica: ordenada por clave, RFC3986. (No la usamos hoy.)
  const params = [...u.searchParams.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const canonicalQuery = params
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");

  // URI canónica: segmentos del path RFC3986-encoded (los "/" se preservan).
  const canonicalUri = u.pathname
    .split("/")
    .map((seg) => rfc3986(seg))
    .join("/");

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // Derivación de la signing key (HMAC encadenado).
  let key = await hmac(enc.encode("AWS4" + input.secretAccessKey), dateStamp);
  key = await hmac(key, input.region);
  key = await hmac(key, input.service);
  key = await hmac(key, "aws4_request");
  const signature = toHex(await hmac(key, stringToSign));

  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: { ...allHeaders, Authorization: authorization },
    signature,
  };
}

// RFC3986: encodeURIComponent + los que deja afuera (!*'()), preservando los no
// reservados. S3 SigV4 no re-encodea, así que esto alcanza para nuestras keys.
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}
