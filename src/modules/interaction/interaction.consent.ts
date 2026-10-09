import { User } from "../../database/models";
import { purgeBufferedForUser } from "./interaction.buffer";

// Bump when the consent wording/purpose changes; events record the version
// the user agreed to.
export const TRACKING_CONSENT_VERSION = 1;

export interface ConsentLike {
  granted?: boolean;
  version?: number | null;
  updatedAt?: Date | null;
}

export interface ConsentState {
  granted: boolean;
  version: number | null;
  updatedAt: Date | null;
}

export async function getTrackingConsent(userId: string): Promise<ConsentState> {
  const user = await User.findById(userId).select("trackingConsent").lean();
  const c = user?.trackingConsent;
  return { granted: c?.granted === true, version: c?.version ?? null, updatedAt: c?.updatedAt ?? null };
}

export async function setTrackingConsent(userId: string, granted: boolean): Promise<ConsentState> {
  const updatedAt = new Date();
  await User.updateOne(
    { _id: userId },
    { $set: { trackingConsent: { granted, version: TRACKING_CONSENT_VERSION, updatedAt } } }
  );
  // Withdrawal takes effect immediately, including for events still buffered.
  if (!granted) purgeBufferedForUser(userId);
  return { granted, version: TRACKING_CONSENT_VERSION, updatedAt };
}
