import { and, eq, inArray, isNotNull, gte, lte, sql } from "drizzle-orm";
import { sessionEvents } from "../../db/schema.js";
import { canonicalIdentityExpr } from "../analytics/identity.js";
export const EMPTY_PAGE_METRICS = { views: 0, uniqueVisitors: 0, uniqueSessions: 0, lastSeenAt: null };
/**
 * Every distinct pagePath this site has recorded a `page_view` for,
 * with a raw view count - the universe of URLs Page rules get matched
 * against. Cheap: one grouped query, no per-Page work yet.
 */
export async function loadPagePathStats(db, siteId, range = {}) {
    const conditions = [eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "page_view"), isNotNull(sessionEvents.pagePath)];
    if (range.since)
        conditions.push(gte(sessionEvents.timestamp, range.since));
    if (range.until)
        conditions.push(lte(sessionEvents.timestamp, range.until));
    const rows = await db
        .select({
        pagePath: sessionEvents.pagePath,
        views: sql `count(*)`,
        lastSeenAt: sql `max(${sessionEvents.timestamp})`,
    })
        .from(sessionEvents)
        .where(and(...conditions))
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
export async function computeMatchedMetrics(db, siteId, matchedPaths, range = {}) {
    if (matchedPaths.length === 0)
        return EMPTY_PAGE_METRICS;
    const conditions = [eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "page_view"), inArray(sessionEvents.pagePath, matchedPaths)];
    if (range.since)
        conditions.push(gte(sessionEvents.timestamp, range.since));
    if (range.until)
        conditions.push(lte(sessionEvents.timestamp, range.until));
    const [row] = await db
        .select({
        views: sql `count(*)`,
        uniqueVisitors: sql `count(distinct ${canonicalIdentityExpr})`,
        uniqueSessions: sql `count(distinct ${sessionEvents.sessionId})`,
        lastSeenAt: sql `max(${sessionEvents.timestamp})`,
    })
        .from(sessionEvents)
        .where(and(...conditions));
    if (!row || row.views === 0)
        return EMPTY_PAGE_METRICS;
    return { views: row.views, uniqueVisitors: row.uniqueVisitors, uniqueSessions: row.uniqueSessions, lastSeenAt: new Date(row.lastSeenAt) };
}
//# sourceMappingURL=pageAggregation.js.map