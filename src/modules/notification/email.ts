import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.smtpHost || !env.smtpUser || !env.smtpPass) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: { user: env.smtpUser, pass: env.smtpPass },
    });
  }
  return transporter;
}

export interface NewOrderEmailDetails {
  orderNumber: string;
  customerName: string;
  amount: number;
  itemsCount: number;
}

// Never throws — a broken/unset SMTP config must not affect order placement,
// only mean the email leg of the notification silently doesn't fire (the
// Socket.IO leg and the order itself are unaffected either way).
export async function sendNewOrderEmail(details: NewOrderEmailDetails): Promise<void> {
  const client = getTransporter();
  if (!client || !env.adminNotificationEmail) {
    console.warn("[notification] SMTP or ADMIN_NOTIFICATION_EMAIL not configured — skipping new-order email");
    return;
  }

  try {
    await client.sendMail({
      from: env.smtpFrom || env.smtpUser,
      to: env.adminNotificationEmail,
      subject: `New order ${details.orderNumber} — ₹${details.amount}`,
      html: `
        <p>A new order has been placed.</p>
        <ul>
          <li><strong>Order:</strong> ${details.orderNumber}</li>
          <li><strong>Customer:</strong> ${details.customerName}</li>
          <li><strong>Items:</strong> ${details.itemsCount}</li>
          <li><strong>Amount:</strong> ₹${details.amount}</li>
        </ul>
      `,
    });
  } catch (err) {
    console.error("[notification] Failed to send new-order email", err);
  }
}
