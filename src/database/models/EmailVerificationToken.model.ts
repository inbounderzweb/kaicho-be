import { Schema, model, Document, Types } from "mongoose";

// One pending email-verification link per user. Only the SHA-256 of the
// token is stored - the raw token exists solely in the emailed link, so a
// database leak can't be turned into verified accounts. Consuming a token
// deletes the row (single use); the TTL index sweeps abandoned ones.
export interface EmailVerificationTokenDocument extends Document {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const EmailVerificationTokenSchema = new Schema<EmailVerificationTokenDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

EmailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerificationToken = model<EmailVerificationTokenDocument>(
  "EmailVerificationToken",
  EmailVerificationTokenSchema,
  "email_verification_tokens"
);
