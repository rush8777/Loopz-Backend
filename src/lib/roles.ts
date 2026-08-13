export type MembershipRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

// Higher number = more privilege. Kept as a flat hierarchy (each role
// implies everything below it) - fine for an MVP; if per-site role
// overrides are needed later, this becomes a lookup keyed by (role,
// action) pairs instead of a single ordinal.
const ROLE_RANK: Record<MembershipRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function isValidRole(value: string): value is MembershipRole {
  return value in ROLE_RANK;
}

/** True if `actual` grants at least the privilege of `required`. */
export function hasAtLeastRole(actual: MembershipRole, required: MembershipRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
