import { Schema, model, Document, Types } from "mongoose";
import { ROLES, UserRole } from "../../common/constants/roles";

export type { UserRole };

export interface Address {
  _id?: Types.ObjectId;
  label?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  isDefault?: boolean;
}

export interface UserDocument extends Document {
  phone: string;
  countryCode: string;
  phoneVerified: boolean;
  firstName?: string;
  lastName?: string;
  email?: string;
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
    line1: { type: String, required: true },
    line2: { type: String },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true }
);

const UserSchema = new Schema<UserDocument>(
  {
    phone: { type: String, required: true, unique: true, index: true },
    countryCode: { type: String, required: true, default: "+91" },
    phoneVerified: { type: Boolean, default: false },
    firstName: { type: String },
    lastName: { type: String },
    email: { type: String },
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
