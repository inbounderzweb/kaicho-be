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
