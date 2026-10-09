function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function verificationEmail(params: {
  name: string;
  link: string;
  expiryMinutes: number;
}) {
  const { name, link, expiryMinutes } = params;
  const subject = "Verify your Kaicho account";

  const text = [
    `Hello ${name},`,
    "",
    "Thanks for creating your Kaicho account.",
    "",
    "Open the link below to verify your email:",
    link,
    "",
    `This verification link expires in ${expiryMinutes} minutes.`,
    "",
    "If you did not create this account, you can safely ignore this email.",
  ].join("\n");

  // `name` is user-supplied; `link` is built server-side from a base64url
  // token and a configured origin. Both are escaped anyway.
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f5f1;font-family:Arial,Helvetica,sans-serif;color:#1f2a24;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 16px;font-size:20px;">Verify your Kaicho account</h1>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Hello ${escapeHtml(name)},</p>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Thanks for creating your Kaicho account. Click the button below to verify your email:</p>
            <p style="margin:0 0 24px;">
              <a href="${escapeHtml(link)}" style="display:inline-block;background:#00a961;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 28px;border-radius:999px;">Verify Email</a>
            </p>
            <p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#5b6660;">This verification link expires in ${expiryMinutes} minutes.</p>
            <p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#5b6660;">If the button doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
            <p style="margin:0;font-size:13px;line-height:1.5;color:#5b6660;">If you did not create this account, you can safely ignore this email.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}

export function inquiryReceivedEmail(params: {
  name: string;
  inquiryNumber: string;
  kind: "contact" | "bulk_order";
}) {
  const { name, inquiryNumber, kind } = params;
  const what = kind === "bulk_order" ? "bulk / B2B order enquiry" : "enquiry";
  const subject = `We've received your ${what} (${inquiryNumber})`;

  // Deliberately does not repeat what the sender typed: this goes to an address
  // the (unauthenticated) submitter supplied, so it must not reflect their text.
  const text = [
    `Hello ${name},`,
    "",
    `Thank you for contacting Kaicho. We have received your ${what}.`,
    "",
    `Your reference number is ${inquiryNumber}.`,
    "",
    "Our team will review it and get back to you shortly. If you need to add anything, just reply to this email and quote your reference number.",
    "",
    "If you did not send this enquiry, you can safely ignore this email.",
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f5f1;font-family:Arial,Helvetica,sans-serif;color:#1f2a24;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 16px;font-size:20px;">We've received your ${escapeHtml(what)}</h1>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Hello ${escapeHtml(name)},</p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Thank you for contacting Kaicho. Our team will review your ${escapeHtml(what)} and get back to you shortly.</p>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Your reference number:<br><strong style="font-size:18px;">${escapeHtml(inquiryNumber)}</strong></p>
            <p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#5b6660;">Need to add something? Reply to this email and quote your reference number.</p>
            <p style="margin:0;font-size:13px;line-height:1.5;color:#5b6660;">If you did not send this enquiry, you can safely ignore this email.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}

export type OrderEmailStatus =
  | "PROCESSING"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED"
  | "RETURNED"
  | "REFUNDED";

const ORDER_STATUS_COPY: Record<OrderEmailStatus, { subject: string; headline: string; body: string }> = {
  PROCESSING: {
    subject: "is being prepared",
    headline: "We're preparing your order",
    body: "Your order is being packed and will be handed to the courier soon.",
  },
  SHIPPED: {
    subject: "has been shipped",
    headline: "Your order is on its way",
    body: "Your order has been shipped.",
  },
  OUT_FOR_DELIVERY: {
    subject: "is out for delivery",
    headline: "Your order is out for delivery",
    body: "Your order is out for delivery and should reach you today.",
  },
  DELIVERED: {
    subject: "has been delivered",
    headline: "Your order has been delivered",
    body: "Your order has been delivered. We hope you enjoy it!",
  },
  CANCELLED: {
    subject: "has been cancelled",
    headline: "Your order has been cancelled",
    body: "Your order has been cancelled. If you paid online, any refund will be processed to your original payment method.",
  },
  RETURNED: {
    subject: "return has been received",
    headline: "We've received your return",
    body: "We have received your returned order and will process your refund shortly.",
  },
  REFUNDED: {
    subject: "has been refunded",
    headline: "Your refund has been issued",
    body: "Your refund has been issued. Depending on your bank, it can take a few business days to show up.",
  },
};

export function orderStatusEmail(params: {
  name: string;
  orderNumber: string;
  status: OrderEmailStatus;
  orderLink: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  estimatedDelivery?: string;
}) {
  const { name, orderNumber, status, orderLink, carrier, trackingNumber, trackingUrl, estimatedDelivery } = params;
  const copy = ORDER_STATUS_COPY[status];
  const subject = `Your Kaicho order ${orderNumber} ${copy.subject}`;

  const trackingLines: string[] = [];
  if (carrier) trackingLines.push(`Courier: ${carrier}`);
  if (trackingNumber) trackingLines.push(`Tracking number: ${trackingNumber}`);
  if (estimatedDelivery) trackingLines.push(`Expected delivery: ${estimatedDelivery}`);
  if (trackingUrl) trackingLines.push(`Track your parcel: ${trackingUrl}`);

  const text = [
    `Hello ${name},`,
    "",
    copy.body,
    "",
    `Order number: ${orderNumber}`,
    ...trackingLines,
    "",
    `View your order: ${orderLink}`,
  ].join("\n");

  const detailRows = [
    `<strong>Order number:</strong> ${escapeHtml(orderNumber)}`,
    ...(carrier ? [`<strong>Courier:</strong> ${escapeHtml(carrier)}`] : []),
    ...(trackingNumber ? [`<strong>Tracking number:</strong> ${escapeHtml(trackingNumber)}`] : []),
    ...(estimatedDelivery ? [`<strong>Expected delivery:</strong> ${escapeHtml(estimatedDelivery)}`] : []),
    ...(trackingUrl ? [`<a href="${escapeHtml(trackingUrl)}" style="color:#00a961;">Track your parcel</a>`] : []),
  ]
    .map((row) => `<p style="margin:0 0 6px;font-size:14px;line-height:1.5;">${row}</p>`)
    .join("\n            ");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f5f1;font-family:Arial,Helvetica,sans-serif;color:#1f2a24;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 16px;font-size:20px;">${escapeHtml(copy.headline)}</h1>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Hello ${escapeHtml(name)},</p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${escapeHtml(copy.body)}</p>
            ${detailRows}
            <p style="margin:20px 0 0;">
              <a href="${escapeHtml(orderLink)}" style="display:inline-block;background:#00a961;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 28px;border-radius:999px;">View your order</a>
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}
