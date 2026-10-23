import { AppError } from "../../common/errors";

// What a saved address must contain before an order may ship to it. The create
// schema enforces this for new addresses; older subdocuments (saved before the
// structured fields existed) can lack some, so checkout re-checks the address it
// is actually about to use instead of trusting that "an address exists".

interface AddressLike {
  receiverName?: string | null;
  receiverPhone?: string | null;
  houseNo?: string | null;
  area?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
}

const text = (value: string | null | undefined) => (value ?? "").trim();

/** Human-readable names of the missing or invalid fields (empty = complete). */
export function findAddressProblems(address: AddressLike): string[] {
  const problems: string[] = [];
  if (text(address.receiverName).length < 2) problems.push("receiver name");
  if (!/^[6-9]\d{9}$/.test(text(address.receiverPhone).replace(/\D/g, ""))) problems.push("a valid mobile number");
  if (!text(address.houseNo)) problems.push("house / flat number");
  if (text(address.area).length < 3) problems.push("street / area");
  if (text(address.city).length < 2) problems.push("city");
  if (text(address.state).length < 2) problems.push("state");
  if (!/^[1-9][0-9]{5}$/.test(text(address.pincode))) problems.push("a valid 6-digit pincode");
  return problems;
}

/** Throws a 422 (code ADDRESS_INCOMPLETE) when the address can't be shipped to. */
export function assertAddressComplete(address: AddressLike): void {
  const problems = findAddressProblems(address);
  if (problems.length === 0) return;
  throw new AppError(
    `Your delivery address is missing ${problems.join(", ")}. Please update it or choose another address.`,
    422,
    true,
    { code: "ADDRESS_INCOMPLETE", missing: problems }
  );
}
