import { SmsProvider } from "./SmsProvider";
import { ConsoleSmsProvider } from "./ConsoleSmsProvider";
import { WhatsAppSmsProvider } from "./WhatsAppSmsProvider";
import { env } from "../../config/env";

export * from "./SmsProvider";
export { sendWhatsAppTemplate } from "./WhatsAppSmsProvider";

let provider: SmsProvider | undefined;

export function getSmsProvider(): SmsProvider {
  if (!provider) {
    switch (env.smsProvider) {
      case "whatsapp":
        provider = new WhatsAppSmsProvider();
        break;
      case "console":
      default:
        provider = new ConsoleSmsProvider();
    }
  }
  return provider;
}
