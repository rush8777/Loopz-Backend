import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { sessionEvents } from "../../db/schema.js";

/** One distinct pagePath's raw traffic, independent of any Page's rules - the row shape Untagged URLs and rule-preview both work from. */
export interface PagePathStats {
  pagePath: string;
  views: number;
  lastSeenAt: Date;
}

/** Aggregate metrics for the pagePaths a single Page's rules matched - what the Pages list/detail views show. */
export interface PageMetrics {
  views: number;
  uniqueVisitors: number;
  uniqueSessions: number;
  lastSeenAt: Date | null;
}

export const EMPTY_PAGE_METRICS: PageMetrics = { views: 0, uniqueVisitors: 0, uniqueSessions: 0, lastSeenAt: null };

/**
 * Every distinct pagePath this site has recorded a `page_view` for,
 * with a raw view count - the universe of URLs Page rules get matched
 * against. Cheap: one grouped query, no per-Page work yet.
 */
export async function loadPagePathStats(db: Db, siteId: string): Promise<PagePathStats[]> {
  const rows = await db
    .select({
      pagePath: sessionEvents.pagePath,
      views: sql<number>`count(*)`,
      lastSeenAt: sql<number>`max(${sessionEvents.timestamp})`,
    })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "page_view"), isNotNull(sessionEvents.pagePath)))
    .groupBy(sessionEvents.pagePath);

  return rows.map((r) => ({ pagePath: r.pagePath as string, views: r.views, lastSeenAt: new Date(r.lastSeenAt) }));
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
export async function computeMatchedMetrics(db: Db, siteId: string, matchedPaths: string[]): Promise<PageMetrics> {
  if (matchedPaths.length === 0) return EMPTY_PAGE_METRICS;

  const [row] = await db
    .select({
      views: sql<number>`count(*)`,
      uniqueVisitors: sql<number>`count(distinct ${sessionEvents.anonymousId})`,
      uniqueSessions: sql<number>`count(distinct ${sessionEvents.sessionId})`,
      lastSeenAt: sql<number>`max(${sessionEvents.timestamp})`,
    })
    .from(sessionEvents)
    .where(
      and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "page_view"), inArray(sessionEvents.pagePath, matchedPaths))
    );

  if (!row || row.views === 0) return EMPTY_PAGE_METRICS;
  return { views: row.views, uniqueVisitors: row.uniqueVisitors, uniqueSessions: row.uniqueSessions, lastSeenAt: new Date(row.lastSeenAt) };
}
