import mongoose from "mongoose";
import { AppError } from "../../common/errors";
import { User, Address } from "../../database/models";
import type { CreateAddressInput, UpdateAddressInput } from "./address.validation";

// Addresses are deliberately NOT a new collection — they already exist as
// User.addresses subdocuments (see User.model.ts). Every mutation here is an
// atomic array update ($push / positional $set / $pull) on the User document
// rather than a load-mutate-save round trip, so two concurrent address edits
// from the same account can't clobber each other's whole array.

function isValidObjectId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

// `line1` / `line2` are compatibility fields — recomputed from the structured
// inputs on every write so anything still reading them (historical order
// snapshots, older clients) stays correct without being a second source of
// truth the form has to keep in sync.
export function deriveAddressLines(parts: {
  houseNo?: string;
  building?: string;
  area?: string;
  landmark?: string;
}): { line1: string; line2?: string } {
  const line1 = [parts.houseNo, parts.building].map((s) => s?.trim()).filter(Boolean).join(", ");
  const line2 =
    [parts.area, parts.landmark].map((s) => s?.trim()).filter(Boolean).join(", ") || undefined;
  return { line1, line2 };
}

export interface AddressDto {
  addressId: string;
  label?: string;
  receiverName?: string;
  receiverPhone?: string;
  houseNo?: string;
  building?: string;
  area?: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  /** Derived, read-only. Kept so older consumers keep rendering. */
  line1: string;
  line2?: string;
  isDefault: boolean;
}

function toDto(address: Address): AddressDto {
  return {
    addressId: address._id!.toString(),
    label: address.label,
    receiverName: address.receiverName,
    receiverPhone: address.receiverPhone,
    houseNo: address.houseNo,
    building: address.building,
    area: address.area,
    landmark: address.landmark,
    city: address.city,
    state: address.state,
    pincode: address.pincode,
    line1: address.line1,
    line2: address.line2,
    isDefault: address.isDefault ?? false,
  };
}

export async function listAddresses(userId: string): Promise<AddressDto[]> {
  const user = await User.findById(userId).select("addresses").lean();
  if (!user) {
    throw new AppError("Not authenticated", 401);
  }
  // Default first, then insertion order (ObjectIds are time-ordered) so the
  // checkout address selector can just pick items[0] as the pre-selection.
  return (user.addresses ?? []).map(toDto).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

// The very first address a user adds becomes their default automatically —
// otherwise a brand-new account would have an address book where nothing is
// selected, which every caller would then have to special-case.
export async function createAddress(userId: string, input: CreateAddressInput): Promise<AddressDto> {
  const user = await User.findById(userId).select("addresses").exec();
  if (!user) {
    throw new AppError("Not authenticated", 401);
  }

  const shouldBeDefault = input.isDefault === true || (user.addresses?.length ?? 0) === 0;

  if (shouldBeDefault) {
    await User.updateOne({ _id: userId }, { $set: { "addresses.$[].isDefault": false } });
  }

  const { line1, line2 } = deriveAddressLines(input);
  const addressId = new mongoose.Types.ObjectId();
  const subdoc = {
    _id: addressId,
    label: input.label,
    receiverName: input.receiverName,
    receiverPhone: input.receiverPhone,
    houseNo: input.houseNo,
    building: input.building,
    area: input.area,
    landmark: input.landmark,
    city: input.city,
    state: input.state,
    pincode: input.pincode,
    line1,
    line2,
    isDefault: shouldBeDefault,
  };

  await User.updateOne({ _id: userId }, { $push: { addresses: subdoc } });

  return toDto(subdoc as unknown as Address);
}

export async function updateAddress(
  userId: string,
  addressId: string,
  patch: UpdateAddressInput
): Promise<AddressDto> {
  if (!isValidObjectId(addressId)) {
    throw new AppError("Address not found", 404);
  }

  // Promoting to default has to unset the others first — done as its own
  // update so the positional $set below stays a single atomic write.
  if (patch.isDefault === true) {
    const owns = await User.exists({ _id: userId, "addresses._id": addressId });
    if (!owns) {
      throw new AppError("Address not found", 404);
    }
    await User.updateOne({ _id: userId }, { $set: { "addresses.$[].isDefault": false } });
  }

  const $set: Record<string, unknown> = {};
  for (const key of [
    "label",
    "receiverName",
    "receiverPhone",
    "houseNo",
    "building",
    "area",
    "landmark",
    "city",
    "state",
    "pincode",
    "isDefault",
  ] as const) {
    if (patch[key] !== undefined) {
      $set[`addresses.$.${key}`] = patch[key];
    }
  }

  // If any component of the derived one-liners changed, recompute both from
  // the patched value merged over the stored one.
  const lineParts = ["houseNo", "building", "area", "landmark"] as const;
  if (lineParts.some((k) => patch[k] !== undefined)) {
    const current = await getAddressOrThrow(userId, addressId);
    const { line1, line2 } = deriveAddressLines({
      houseNo: patch.houseNo ?? current.houseNo,
      building: patch.building ?? current.building,
      area: patch.area ?? current.area,
      landmark: patch.landmark ?? current.landmark,
    });
    $set["addresses.$.line1"] = line1;
    $set["addresses.$.line2"] = line2 ?? "";
  }

  const result = await User.updateOne({ _id: userId, "addresses._id": addressId }, { $set });
  if (result.matchedCount === 0) {
    throw new AppError("Address not found", 404);
  }

  return getAddressOrThrow(userId, addressId);
}

// Removing the current default leaves the book with no default, so the
// oldest remaining address is promoted — same "there is always exactly one
// default when the book is non-empty" invariant createAddress establishes.
export async function deleteAddress(userId: string, addressId: string): Promise<void> {
  if (!isValidObjectId(addressId)) {
    throw new AppError("Address not found", 404);
  }

  const user = await User.findById(userId).select("addresses").lean();
  if (!user) {
    throw new AppError("Not authenticated", 401);
  }
  const target = (user.addresses ?? []).find((a) => a._id!.toString() === addressId);
  if (!target) {
    throw new AppError("Address not found", 404);
  }

  await User.updateOne({ _id: userId }, { $pull: { addresses: { _id: addressId } } });

  if (target.isDefault) {
    const remaining = (user.addresses ?? []).filter((a) => a._id!.toString() !== addressId);
    if (remaining.length > 0) {
      await User.updateOne(
        { _id: userId, "addresses._id": remaining[0]._id },
        { $set: { "addresses.$.isDefault": true } }
      );
    }
  }
}

export async function setDefaultAddress(userId: string, addressId: string): Promise<AddressDto> {
  if (!isValidObjectId(addressId)) {
    throw new AppError("Address not found", 404);
  }

  const owns = await User.exists({ _id: userId, "addresses._id": addressId });
  if (!owns) {
    throw new AppError("Address not found", 404);
  }

  await User.updateOne({ _id: userId }, { $set: { "addresses.$[].isDefault": false } });
  await User.updateOne(
    { _id: userId, "addresses._id": addressId },
    { $set: { "addresses.$.isDefault": true } }
  );

  return getAddressOrThrow(userId, addressId);
}

// Shared by checkout, which snapshots the address onto the order — the
// address book entry can be edited or deleted afterwards without rewriting
// order history (see Order.model.ts's header comment).
export async function getAddressOrThrow(userId: string, addressId: string): Promise<AddressDto> {
  if (!isValidObjectId(addressId)) {
    throw new AppError("Address not found", 404);
  }
  const user = await User.findById(userId).select("addresses").lean();
  const address = (user?.addresses ?? []).find((a) => a._id!.toString() === addressId);
  if (!address) {
    throw new AppError("Address not found", 404);
  }
  return toDto(address);
}
