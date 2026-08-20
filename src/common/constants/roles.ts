// Single source of truth for valid roles. Adding a new role later (e.g.
// "manager", "support") is a one-line change here — the Mongoose enum
// validator and the TypeScript type both derive from this array, so nothing
// else in the backend hardcodes the list.
export const ROLES = ["user", "admin"] as const;

export type UserRole = (typeof ROLES)[number];
