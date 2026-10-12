import { UserInteractionEvent } from "../../database/models";

// Built explicitly and awaited at boot - same rationale as the other
// ensure*Indexes functions (the unique + TTL indexes must exist before the
// first writes). Additive only.
export async function ensureInteractionIndexes(): Promise<void> {
  await UserInteractionEvent.createIndexes();
  console.log("[interaction] indexes ensured (userId+eventId unique, TTL on expiresAt)");
}
