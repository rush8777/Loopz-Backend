import { sql } from "drizzle-orm";
import { sessionEvents, trackedUserAliases } from "../../db/schema.js";

/** Canonical visitor identity used by every event-derived aggregate. */
export const canonicalIdentityExpr = sql<string>`coalesce(${trackedUserAliases.trackedUserId}, ${sessionEvents.anonymousId})`;
