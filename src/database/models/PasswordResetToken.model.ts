import { Schema, model, Document, Types } from "mongoose";

// One pending password-reset link per user. Same storage rules as
// EmailVerificationToken: only the SHA-256 of the token is kept, consuming it
// deletes the row (single use), and the TTL index sweeps abandoned ones.
export interface PasswordResetTokenDocument extends Document {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const PasswordResetTokenSchema = new Schema<PasswordResetTokenDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetToken = model<PasswordResetTokenDocument>(
  "PasswordResetToken",
  PasswordResetTokenSchema,
  "password_reset_tokens"
);
