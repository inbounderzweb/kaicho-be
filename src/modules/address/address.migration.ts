import { User, Order } from "../../database/models";

// One-time, idempotent backfill of the structured address fields
// (houseNo / building / area / landmark / receiverName / receiverPhone)
// introduced alongside the two-line `line1` / `line2` shape.
//
// Coarse on purpose: the whole old `line1` becomes `houseNo`, `line2`
// (falling back to `line1`, then `city`) becomes `area`. No attempt to parse
// a house number out of free text — a plausible-but-wrong split is worse
// than an honest one the user tidies on their next edit. `line1` / `line2`
// themselves are left untouched (still the compat fields).
//
// Runs in one process (primary / single-process, same rule as the auth
// index reconciliation) after the DB connection is up.

const cap = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);

export async function backfillStructuredAddresses(): Promise<void> {
  await backfillUserAddresses();
  await backfillOrderAddresses();
}

async function backfillUserAddresses(): Promise<void> {
  const cursor = User.find({
    "addresses.0": { $exists: true },
    addresses: { $elemMatch: { houseNo: { $exists: false } } },
  })
    .select("firstName lastName phone addresses")
    .cursor();

  let updated = 0;
  for await (const user of cursor) {
    const receiverName = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Customer";
    const receiverPhone = user.phone ?? "";

    let changed = false;
    for (const a of user.addresses ?? []) {
      if (a.houseNo) continue;
      a.houseNo = cap(a.line1, 60) || cap(a.city, 60) || "—";
      a.area = cap(a.line2 || a.line1, 120) || cap(a.city, 120) || a.houseNo;
      if (!a.receiverName) a.receiverName = receiverName;
      if (!a.receiverPhone) a.receiverPhone = receiverPhone;
      changed = true;
    }
    if (changed) {
      await user.save();
      updated += 1;
    }
  }
  if (updated > 0) console.log(`[address] backfilled structured fields on ${updated} user address book(s)`);
}

async function backfillOrderAddresses(): Promise<void> {
  const cursor = Order.find({ "shippingAddress.houseNo": { $exists: false } })
    .select("shippingAddress userId")
    .populate<{ userId: { firstName?: string; lastName?: string; phone?: string } | null }>(
      "userId",
      "firstName lastName phone"
    )
    .cursor();

  let updated = 0;
  for await (const order of cursor) {
    const s = order.shippingAddress;
    if (!s || s.houseNo) continue;

    const u = order.userId as { firstName?: string; lastName?: string; phone?: string } | null;
    s.houseNo = cap(s.line1, 60) || cap(s.city, 60) || "—";
    s.area = cap(s.line2 || s.line1, 120) || cap(s.city, 120) || s.houseNo;
    if (!s.receiverName) s.receiverName = [u?.firstName, u?.lastName].filter(Boolean).join(" ") || "Customer";
    if (!s.receiverPhone) s.receiverPhone = u?.phone ?? "";

    order.markModified("shippingAddress");
    await order.save();
    updated += 1;
  }
  if (updated > 0) console.log(`[address] backfilled structured fields on ${updated} order shipping address(es)`);
}
