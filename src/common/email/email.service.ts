import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const SEND_TIMEOUT_MS = 10_000;

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.smtpHost || !env.smtpUser || !env.smtpPass) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: { user: env.smtpUser, pass: env.smtpPass },
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
  }
  return transporter;
}

// "jane@example.com" -> "j***@example.com" - enough to correlate a log line
// with a support ticket without writing a full address to the logs.
function maskEmail(address: string): string {
  const [local, domain] = address.split("@");
  return `${local?.slice(0, 1) ?? ""}***@${domain ?? ""}`;
}

// Throws on failure; callers decide whether that is fatal. Message bodies
// carry one-time links, so nothing from them is ever logged here.
export async function sendEmail(message: EmailMessage): Promise<void> {
  const client = getTransporter();
  if (!client) {
    console.warn(
      `[email] SMTP not configured - not sending "${message.subject}" to ${maskEmail(message.to)}`
    );
    return;
  }

  await client.sendMail({
    from: env.smtpFrom || env.smtpUser,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
}

export { maskEmail };
