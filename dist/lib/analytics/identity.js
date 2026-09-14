import { sql } from "drizzle-orm";
import { sessionEvents } from "../../db/schema.js";
/**
 * Canonical historical identity used by every event-derived aggregate.
 *
 * `tracked_user_aliases` is deliberately absent: it represents the current
 * browser mapping and can be repointed after logout/account switching.  Old
 * rows without a snapshot stay anonymous rather than being guessed at from a
 * mutable alias.
 */
export const canonicalIdentityExpr = sql `coalesce(${sessionEvents.trackedUserId}, ${sessionEvents.anonymousId})`;
//# sourceMappingURL=identity.js.map