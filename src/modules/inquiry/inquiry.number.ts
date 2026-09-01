import crypto from "crypto";
import { AppError } from "../../common/errors";
import { Inquiry, InquiryDocument } from "../../database/models";

// Direct mirror of order.service.ts's generateOrderNumber / createOrderWith-
// UniqueNumber: a human-friendly, unambiguous code (no 0/O/1/I) with a
// date prefix, minted optimistically and retried only on a unique-index
// collision.
const INQUIRY_NUMBER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const INQUIRY_NUMBER_ATTEMPTS = 5;

export function generateInquiryNumber(now: Date = new Date()): string {
  const datePart = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(
    now.getUTCDate()
  ).padStart(2, "0")}`;
  const bytes = crypto.randomBytes(6);
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += INQUIRY_NUMBER_ALPHABET[bytes[i] % INQUIRY_NUMBER_ALPHABET.length];
  }
  return `INQ-${datePart}-${suffix}`;
}

export async function createInquiryWithUniqueNumber(
  payload: Omit<Partial<InquiryDocument>, "inquiryNumber">
): Promise<InquiryDocument> {
  let lastError: unknown;
  for (let attempt = 0; attempt < INQUIRY_NUMBER_ATTEMPTS; attempt++) {
    try {
      return await Inquiry.create({ ...payload, inquiryNumber: generateInquiryNumber() });
    } catch (err) {
      const candidate = err as { code?: number; keyPattern?: Record<string, unknown> };
      if (candidate?.code === 11000 && candidate.keyPattern && "inquiryNumber" in candidate.keyPattern) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw new AppError("Could not generate a unique inquiry number, please retry", 500, true, lastError);
}
