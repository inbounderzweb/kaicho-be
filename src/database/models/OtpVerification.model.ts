import { Schema, model, Document } from "mongoose";

export type OtpPurpose = "login";

export interface OtpVerificationDocument extends Document {
  phone: string;
  otpHash: string;
  purpose: OtpPurpose;
  expiresAt: Date;
  attempts: number;
  verified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const OtpVerificationSchema = new Schema<OtpVerificationDocument>(
  {
    phone: { type: String, required: true, index: true },
    otpHash: { type: String, required: true },
    purpose: { type: String, enum: ["login"], default: "login" },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    verified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

OtpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpVerification = model<OtpVerificationDocument>(
  "OtpVerification",
  OtpVerificationSchema
);
