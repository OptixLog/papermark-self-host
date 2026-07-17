// Self-host patch: SMTP email transport (used with AWS SES SMTP endpoint).
// Activated when EMAIL_SMTP_HOST is set; lib/resend.ts routes sendEmail()
// through this instead of the Resend API. Copied in by patches/apply.mjs.
// upstream ships nodemailer without @types/nodemailer
// @ts-expect-error no type declarations
import nodemailer from "nodemailer";

let _transporter: any = null;

export function getSmtpTransport() {
  if (!process.env.EMAIL_SMTP_HOST) return null;
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.EMAIL_SMTP_HOST,
      port: Number(process.env.EMAIL_SMTP_PORT || 587),
      secure: Number(process.env.EMAIL_SMTP_PORT || 587) === 465,
      auth: {
        user: process.env.EMAIL_SMTP_USER!,
        pass: process.env.EMAIL_SMTP_PASSWORD!,
      },
    });
  }
  return _transporter;
}

// Rewrite upstream's papermark.com from-addresses onto the self-host
// sending domain (SES only allows verified identities).
export function rewriteFromAddress(fromAddress: string): string {
  const domain = process.env.EMAIL_FROM_DOMAIN;
  if (!domain) return fromAddress;
  const match = fromAddress.match(/^(.*)<([^@]+)@([^>]+)>\s*$/);
  if (match) {
    const display = match[1].trim() || "Papermark";
    return `${display} <${match[2]}@${domain}>`;
  }
  const bare = fromAddress.match(/^([^@]+)@(.+)$/);
  if (bare) return `${bare[1]}@${domain}`;
  return `no-reply@${domain}`;
}

export async function sendViaSmtp({
  from,
  to,
  cc,
  replyTo,
  subject,
  html,
  text,
  headers,
}: {
  from: string;
  to: string;
  cc?: string | string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}) {
  const transporter = getSmtpTransport();
  if (!transporter) throw new Error("SMTP transport not configured");
  const info = await transporter.sendMail({
    from: rewriteFromAddress(from),
    to,
    cc,
    replyTo,
    subject,
    html,
    text,
    headers,
  });
  return { id: info.messageId };
}
