import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { env } from "../../config/env";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const SEND_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

let transporter: Transporter<SMTPTransport.SentMessageInfo> | null = null;

function getTransporter(): Transporter<SMTPTransport.SentMessageInfo> {
  if (!env.smtpHost.trim() || !env.smtpUser.trim() || !env.smtpPass) {
    throw new Error("Email delivery unavailable: configure SMTP_HOST, SMTP_USER and SMTP_PASS");
  }
  if (!Number.isInteger(env.smtpPort) || env.smtpPort < 1 || env.smtpPort > 65535) {
    throw new Error("Email delivery unavailable: SMTP_PORT must be a valid port number");
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost.trim(),
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: { user: env.smtpUser.trim(), pass: env.smtpPass },
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
      dnsTimeout: SEND_TIMEOUT_MS,
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
  const recipient = message.to.split(",").map((address) => maskEmail(address.trim())).join(", ");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: SMTPTransport.SentMessageInfo;
    try {
      result = await client.sendMail({
        from: env.smtpFrom.trim() || env.smtpUser.trim(),
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    } catch (err) {
      const failure = err as { code?: string; responseCode?: number; command?: string } | null;
      // Retry only an explicit temporary SMTP refusal. A lost connection can
      // happen AFTER acceptance; retrying it blindly can send duplicate mail.
      const temporary = typeof failure?.responseCode === "number" &&
        failure.responseCode >= 400 && failure.responseCode < 500;
      if (temporary && attempt < MAX_ATTEMPTS) {
        console.warn(`[email] temporary SMTP refusal (${failure?.responseCode}); retry ${attempt}/${MAX_ATTEMPTS - 1} for ${recipient}`);
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      // Do not put message bodies, links, SMTP responses or raw addresses in
      // errors: auth/order callers log this message for troubleshooting.
      throw new Error(
        `Email submission failed for ${recipient} (${failure?.code ?? "unknown"}, SMTP ${failure?.responseCode ?? "unknown"}, ${failure?.command ?? "unknown"})`
      );
    }

    // Nodemailer resolves even when only SOME recipients were accepted.
    // Treat that as a visible delivery failure, without resending to those
    // already accepted by the provider.
    if (!result.accepted?.length || result.rejected?.length || result.pending?.length) {
      throw new Error(`Email submission incomplete for ${recipient}: ${result.accepted?.length ?? 0} accepted, ${result.rejected?.length ?? 0} rejected, ${result.pending?.length ?? 0} pending`);
    }
    console.info(`[email] SMTP accepted message for ${recipient}`);
    return;
  }
}

export { maskEmail };
