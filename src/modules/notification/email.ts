import { env } from "../../config/env";
import { sendEmail } from "../../common/email/email.service";

export interface NewOrderEmailDetails {
  orderNumber: string;
  customerName: string;
  amount: number;
  itemsCount: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

// Email errors are reported, while the saved order and in-app alert remain
// independent. All mail uses the same bounded, observable SMTP sender.
export async function sendNewOrderEmail(details: NewOrderEmailDetails): Promise<void> {
  const recipient = env.adminNotificationEmail.trim();
  if (!recipient) {
    console.warn("[notification] ADMIN_NOTIFICATION_EMAIL not configured — skipping new-order email");
    return;
  }

  try {
    await sendEmail({
      to: recipient,
      subject: `New order ${details.orderNumber} — ₹${details.amount}`,
      text: [
        "A new order has been placed.",
        `Order: ${details.orderNumber}`,
        `Customer: ${details.customerName}`,
        `Items: ${details.itemsCount}`,
        `Amount: ₹${details.amount}`,
      ].join("\n"),
      html: `
        <p>A new order has been placed.</p>
        <ul>
          <li><strong>Order:</strong> ${escapeHtml(details.orderNumber)}</li>
          <li><strong>Customer:</strong> ${escapeHtml(details.customerName)}</li>
          <li><strong>Items:</strong> ${details.itemsCount}</li>
          <li><strong>Amount:</strong> ₹${details.amount}</li>
        </ul>
      `,
    });
  } catch (err) {
    console.error(`[notification] Failed to send new-order email for ${details.orderNumber}:`, err instanceof Error ? err.message : "unknown error");
  }
}
