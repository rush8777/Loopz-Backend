import { and, eq, inArray, sql } from "drizzle-orm";
import { sessionEvents, trackedUsers } from "../../db/schema.js";
/**
 * Resolves a page of identity keys into display-ready summaries -
 * either an identified tracked user or a bare anonymous visitor.
 * Shared by Segments (member list) and Funnels (per-step user list),
 * both of which link the result back to the *same* existing User
 * Profile / Anonymous Visitor pages (see task briefs for each: "reuse
 * the existing User Profile page, do not create a segment/funnel-
 * specific one") rather than each re-deriving this hydration.
 */
export async function hydrateIdentities(db, siteId, ids) {
    if (ids.length === 0)
        return [];
    const trackedRows = await db.select().from(trackedUsers).where(and(eq(trackedUsers.siteId, siteId), inArray(trackedUsers.id, ids)));
    const trackedById = new Map(trackedRows.map((r) => [r.id, r]));
    const anonymousIds = ids.filter((id) => !trackedById.has(id));
    const anonymousLastSeen = new Map();
    if (anonymousIds.length > 0) {
        const rows = await db
            .select({ anonymousId: sessionEvents.anonymousId, lastSeen: sql `max(${sessionEvents.timestamp})` })
            .from(sessionEvents)
            .where(and(eq(sessionEvents.siteId, siteId), inArray(sessionEvents.anonymousId, anonymousIds)))
            .groupBy(sessionEvents.anonymousId);
        for (const r of rows)
            if (r.anonymousId)
                anonymousLastSeen.set(r.anonymousId, r.lastSeen);
    }
    return ids.map((id) => {
        const tu = trackedById.get(id);
        if (tu) {
            return {
                identityType: "identified",
                trackedUserId: tu.id,
                externalUserId: tu.externalUserId,
                anonymousId: null,
                lastSeenAt: tu.lastSeenAt.toISOString(),
            };
        }
        const lastSeen = anonymousLastSeen.get(id);
        return {
            identityType: "anonymous",
            trackedUserId: null,
            externalUserId: null,
            anonymousId: id,
            lastSeenAt: lastSeen != null ? new Date(lastSeen).toISOString() : null,
        };
    });
}
//# sourceMappingURL=hydrate.js.map