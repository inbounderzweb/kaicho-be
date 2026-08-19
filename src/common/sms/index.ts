import { SmsProvider } from "./SmsProvider";
import { ConsoleSmsProvider } from "./ConsoleSmsProvider";
import { env } from "../../config/env";

export * from "./SmsProvider";

let provider: SmsProvider | undefined;

export function getSmsProvider(): SmsProvider {
  if (!provider) {
    switch (env.smsProvider) {
      case "console":
      default:
        provider = new ConsoleSmsProvider();
    }
  }
  return provider;
}
