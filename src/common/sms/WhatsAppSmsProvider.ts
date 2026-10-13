import { SmsProvider } from "./SmsProvider";
import { env } from "../../config/env";

async function graphSend(payload: Record<string, unknown>): Promise<void> {
  if (!env.whatsappAccessToken || !env.whatsappPhoneNumberId) {
    throw new Error("WhatsApp is not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID)");
  }
  const res = await fetch(
    `https://graph.facebook.com/${env.whatsappApiVersion}/${env.whatsappPhoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.whatsappAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    }
  );
  if (!res.ok) {
    throw new Error(`WhatsApp send failed (${res.status}): ${await res.text()}`);
  }
}

// Meta wants digits only, with country code and no "+".
const toWaId = (phone: string) => phone.replace(/\D/g, "");

// Send an approved template. `bodyParams` fill {{1}}, {{2}}... in order.
// Required for business-initiated messages outside the 24h reply window.
export function sendWhatsAppTemplate(
  phone: string,
  template: string,
  bodyParams: string[] = [],
  extraComponents: unknown[] = []
): Promise<void> {
  const components: unknown[] = [];
  if (bodyParams.length) {
    components.push({
      type: "body",
      parameters: bodyParams.map((text) => ({ type: "text", text })),
    });
  }
  components.push(...extraComponents);
  return graphSend({
    to: toWaId(phone),
    type: "template",
    template: { name: template, language: { code: env.whatsappTemplateLang }, components },
  });
}

export class WhatsAppSmsProvider implements SmsProvider {
  // auth.service sends "<code> is your Kaicho verification code...". The code
  // is pulled out and sent through the approved Authentication template.
  // Anything else goes as free text (only delivered inside a 24h window).
  async sendSms(phone: string, message: string): Promise<void> {
    const otp = message.match(/^\s*(\d{4,8})\b/)?.[1];
    if (otp) {
      await sendWhatsAppTemplate(phone, env.whatsappOtpTemplate, [otp], [
        // Authentication templates with a copy-code button need the code here too.
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: otp }] },
      ]);
      return;
    }
    await graphSend({ to: toWaId(phone), type: "text", text: { body: message } });
  }
}
