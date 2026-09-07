import { User } from "../../database/models";

// One-time, idempotent index reconciliation for the `users` collection.
//
// The `phone` field used to be `{ required: true, unique: true }` — which
// created a NON-sparse `phone_1` unique index. Now that Google sign-in can
// create an account with no phone, `phone` is `{ unique: true, sparse: true }`.
// Mongoose only ever *adds* missing indexes; it never alters an existing one,
// so without this the old non-sparse index survives and the SECOND phone-less
// user fails with `E11000 dup key: { phone: null }`.
//
// Runs in exactly one process (primary / single-process — same rule as the
// background jobs), after the DB connection is up.
export async function ensureUserAuthIndexes(): Promise<void> {
  const collection = User.collection;

  let existing: Awaited<ReturnType<typeof collection.indexes>>;
  try {
    existing = await collection.indexes();
  } catch {
    // Collection doesn't exist yet (fresh DB) — Mongoose will create the
    // correct indexes from the schema on first write. Nothing to fix.
    return;
  }

  const phoneIndex = existing.find(
    (ix) => ix.name === "phone_1" || (Object.keys(ix.key).length === 1 && ix.key.phone === 1)
  );

  // Drop the legacy non-sparse phone index so it can be recreated sparse.
  // (A sparse one already present is left alone.)
  if (phoneIndex?.name && phoneIndex.sparse !== true) {
    await collection.dropIndex(phoneIndex.name);
    console.log(`[auth] dropped legacy non-sparse index ${phoneIndex.name} on users`);
  }

  // Only ADDS indexes the schema declares and the collection is missing
  // (phone_1 sparse, googleId_1 sparse-unique) — never drops anything, so a
  // hand-added index elsewhere on `users` is untouched.
  await User.createIndexes();
  console.log("[auth] user auth indexes ensured (phone / googleId sparse-unique)");
}
