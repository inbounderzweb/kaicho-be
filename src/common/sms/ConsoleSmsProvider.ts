import { SmsProvider } from "./SmsProvider";
import { env } from "../../config/env";

function maskPhone(phone: string): string {
  if (phone.length <= 4) return "*".repeat(phone.length);
  return "*".repeat(phone.length - 4) + phone.slice(-4);
}

export class ConsoleSmsProvider implements SmsProvider {
  async sendSms(phone: string, message: string): Promise<void> {
    if (env.nodeEnv === "development") {
      console.log(`[sms:console] to ${phone} -> ${message}`);
    } else {
      console.log(`[sms:console] OTP sent to ${maskPhone(phone)}`);
    }
  }
}
