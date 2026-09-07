import { Schema, model, Document, Types } from "mongoose";
import { ROLES, UserRole } from "../../common/constants/roles";

export type { UserRole };

export interface Address {
  _id?: Types.ObjectId;
  label?: string;
  // Structured address fields (the form's real inputs).
  receiverName?: string;
  receiverPhone?: string;
  houseNo?: string;
  building?: string;
  area?: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  // Auto-derived from the structured fields on every write and kept only for
  // backward compatibility — never edited directly, not exposed in the form.
  // `line1 = [houseNo, building]`, `line2 = [area, landmark]`.
  line1: string;
  line2?: string;
  isDefault?: boolean;
}

export interface UserDocument extends Document {
  phone?: string;
  countryCode: string;
  phoneVerified: boolean;
  googleId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  emailVerified: boolean;
  avatar?: string;
  addresses: Address[];
  wishlist: string[];
  role: UserRole;
  isActive: boolean;
  tokenVersion: number;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AddressSchema = new Schema<Address>(
  {
    label: { type: String },
    // Not `required` at the schema layer on purpose: the Zod create schema is
    // the real gate for new writes, and a Mongoose `required` here would make
    // any legacy subdocument that predates these fields fail to save on an
    // unrelated user update. The migration backfills them; the API rejects a
    // create without them.
    receiverName: { type: String },
    receiverPhone: { type: String },
    houseNo: { type: String },
    building: { type: String },
    area: { type: String },
    landmark: { type: String },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    line1: { type: String, required: true },
    line2: { type: String },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true }
);

const UserSchema = new Schema<UserDocument>(
  {
    // Optional now that Google sign-in can create an account with no phone.
    // `sparse` so many phone-less (Google-only) users don't collide on a
    // single null value under the unique index.
    phone: { type: String, unique: true, sparse: true, index: true },
    countryCode: { type: String, required: true, default: "+91" },
    phoneVerified: { type: Boolean, default: false },
    // Google's `sub` claim — stable per-user id. Sparse-unique so OTP-only
    // users (no googleId) don't collide, and one Google account maps to one
    // user.
    googleId: { type: String, unique: true, sparse: true, index: true },
    firstName: { type: String },
    lastName: { type: String },
    email: { type: String },
    emailVerified: { type: Boolean, default: false },
    avatar: { type: String },
    addresses: { type: [AddressSchema], default: [] },
    wishlist: { type: [String], default: [] },
    role: { type: String, enum: ROLES, default: "user" },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

export const User = model<UserDocument>("User", UserSchema);
