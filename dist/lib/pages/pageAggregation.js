import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { sessionEvents } from "../../db/schema.js";
export const EMPTY_PAGE_METRICS = { views: 0, uniqueVisitors: 0, uniqueSessions: 0, lastSeenAt: null };
/**
 * Every distinct pagePath this site has recorded a `page_view` for,
 * with a raw view count - the universe of URLs Page rules get matched
 * against. Cheap: one grouped query, no per-Page work yet.
 */
export async function loadPagePathStats(db, siteId) {
    const rows = await db
        .select({
        pagePath: sessionEvents.pagePath,
        views: sql `count(*)`,
        lastSeenAt: sql `max(${sessionEvents.timestamp})`,
    })
        .from(sessionEvents)
        .where(and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "page_view"), isNotNull(sessionEvents.pagePath)))
        .groupBy(sessionEvents.pagePath);
    return rows.map((r) => ({ pagePath: r.pagePath, views: r.views, lastSeenAt: new Date(r.lastSeenAt) }));
}
/**
 * Full-precision metrics (distinct visitors/sessions, not just a view
 * count) for exactly the pagePaths a Page's rules matched. Queried
 * fresh per Page rather than derived from `loadPagePathStats` so a
 * visitor who appears under two different matched paths is only
 * counted once - summing per-path unique counts would double-count
 * them. One query per Page; fine at the Page-catalog scale this
 * targets (tens, not thousands, of tagged Pages per site).
 */
export async function computeMatchedMetrics(db, siteId, matchedPaths) {
    if (matchedPaths.length === 0)
        return EMPTY_PAGE_METRICS;
    const [row] = await db
        .select({
        views: sql `count(*)`,
        uniqueVisitors: sql `count(distinct ${sessionEvents.anonymousId})`,
        uniqueSessions: sql `count(distinct ${sessionEvents.sessionId})`,
        lastSeenAt: sql `max(${sessionEvents.timestamp})`,
    })
        .from(sessionEvents)
        .where(and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "page_view"), inArray(sessionEvents.pagePath, matchedPaths)));
    if (!row || row.views === 0)
        return EMPTY_PAGE_METRICS;
    return { views: row.views, uniqueVisitors: row.uniqueVisitors, uniqueSessions: row.uniqueSessions, lastSeenAt: new Date(row.lastSeenAt) };
}
//# sourceMappingURL=pageAggregation.js.map