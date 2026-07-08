// Email transaccional (Slice 3 de paridad; portado de server/email.ts del
// monolito, sin el SDK de Resend: fetch directo a la API — una dependencia
// menos, mismo contrato).
//
// Pluggable por entorno: con RESEND_API_KEY seteada manda por Resend; sin ella
// (dev local) loguea el contenido a consola — el flujo de auth no se bloquea
// nunca por falta de proveedor.
//
// EMAIL_FROM: remitente verificado en Resend. Hasta verificar dominio propio
// se puede usar el sandbox `onboarding@resend.dev` (solo entrega al dueño de
// la cuenta Resend — gotcha de PARIDAD-MIGRACION.md §15). Con dominio:
// `no-reply@<dominio>`.

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  /** Respuestas del destinatario van acá (ej. el asegurado le responde a su
   *  productor, no al remitente no-reply). */
  replyTo?: string;
}

const APP_NAME = process.env.APP_NAME ?? 'Rumbo';

export async function sendEmail({ to, subject, text, replyTo }: SendEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? 'onboarding@resend.dev';
  if (!apiKey) {
    console.log(
      `[email:console] to=${to} subject="${subject}"\n${text}\n[email:console] (seteá RESEND_API_KEY para envío real)`,
    );
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${APP_NAME} <${from}>`,
      to,
      subject,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!r.ok) {
    // Fail loud: el caller (Better Auth) decide si la operación sigue. Para
    // verificación/reset preferimos error visible a un silencio confuso.
    const body = await r.text().catch(() => '');
    throw new Error(`Resend ${r.status}: ${body.slice(0, 300)}`);
  }
}
