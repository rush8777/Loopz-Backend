import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { trackedUserAliases, trackedUsers } from "../../db/schema.js";

/** Public delivery's legacy `trackedUserId` parameter is an EXTERNAL user ID.
 * An explicit identity always wins (including an unknown ID). Alias restoration
 * is only for requests without one. SDK logout/account switches rotate the
 * anonymous ID, so a logged-out visitor cannot inherit the previous alias. */
export async function resolveDeliveryUserId(db: Db, siteId: string, externalId?: string, anonymousId?: string | null): Promise<string | null> {
  if (externalId !== undefined) {
    const [user] = await db.select({ id: trackedUsers.id }).from(trackedUsers)
      .where(and(eq(trackedUsers.siteId, siteId), eq(trackedUsers.externalUserId, externalId))).limit(1);
    return user?.id ?? null;
  }
  if (!anonymousId) return null;
  const [alias] = await db.select({ id: trackedUsers.id }).from(trackedUserAliases)
    .innerJoin(trackedUsers, eq(trackedUsers.id, trackedUserAliases.trackedUserId))
    .where(and(eq(trackedUserAliases.siteId, siteId), eq(trackedUsers.siteId, siteId), eq(trackedUserAliases.anonymousId, anonymousId))).limit(1);
  return alias?.id ?? null;
}
