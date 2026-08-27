import { eq, and, inArray, sql, desc, asc } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { trackedUserAliases, sessionEvents, sessionReplayEvents } from "../../db/schema.js";

/**
 * The read/aggregation core of the User Profile layer (task brief
 * section 17): every function here computes its answer at query time
 * from the existing `session_events` log, joined through
 * `tracked_user_aliases`. Nothing in this file writes or duplicates
 * event data - it only resolves "which anonymousIds/sessions belong to
 * this tracked user" and formats what's already there.
 */

/** All anonymousIds that currently resolve to this tracked user - the join key into session_events. */
export async function getAliasAnonymousIds(db: Db, siteId: string, trackedUserId: string): Promise<string[]> {
  const rows = await db
    .select({ anonymousId: trackedUserAliases.anonymousId })
    .from(trackedUserAliases)
    .where(and(eq(trackedUserAliases.siteId, siteId), eq(trackedUserAliases.trackedUserId, trackedUserId)));
  return rows.map((r) => r.anonymousId);
}

export interface ProfileStats {
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  sessionCount: number;
  pageViewCount: number;
  eventCount: number;
  totalActiveTimeMs: number;
  firstPage: string | null;
  lastPage: string | null;
}

const EMPTY_STATS: ProfileStats = {
  firstSeenAt: null,
  lastSeenAt: null,
  sessionCount: 0,
  pageViewCount: 0,
  eventCount: 0,
  totalActiveTimeMs: 0,
  firstPage: null,
  lastPage: null,
};

/**
 * Automatically-derived profile statistics (task brief section 7) -
 * never sent by the SDK, always computed from session_events. Cursor
 * samples count toward eventCount/totalActiveTimeMs (they're real
 * signal for "how much of the page did they interact with") but never
 * appear as their own timeline entries - see listActivity below.
 */
export async function computeProfileStats(db: Db, siteId: string, anonymousIds: string[]): Promise<ProfileStats> {
  if (anonymousIds.length === 0) return EMPTY_STATS;

  const [totals] = await db
    .select({
      eventCount: sql<number>`count(*)`,
      pageViewCount: sql<number>`sum(case when ${sessionEvents.type} = 'page_view' then 1 else 0 end)`,
      firstSeen: sql<number | null>`min(${sessionEvents.timestamp})`,
      lastSeen: sql<number | null>`max(${sessionEvents.timestamp})`,
      sessionCount: sql<number>`count(distinct ${sessionEvents.sessionId})`,
    })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.siteId, siteId), inArray(sessionEvents.anonymousId, anonymousIds)));

  if (!totals || totals.eventCount === 0) return EMPTY_STATS;

  // "Active time" proxy: per session, last event minus first event,
  // summed across sessions. There's no explicit session-duration
  // concept in this schema (see sessions.ts's own durationMs, computed
  // the same way) - reusing that convention here rather than inventing
  // a new one.
  const perSession = await db
    .select({
      sessionId: sessionEvents.sessionId,
      firstTs: sql<number>`min(${sessionEvents.timestamp})`,
      lastTs: sql<number>`max(${sessionEvents.timestamp})`,
    })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.siteId, siteId), inArray(sessionEvents.anonymousId, anonymousIds)))
    .groupBy(sessionEvents.sessionId);
  const totalActiveTimeMs = perSession.reduce((sum, s) => sum + Math.max(0, s.lastTs - s.firstTs), 0);

  const [firstPageRow] = await db
    .select({ pagePath: sessionEvents.pagePath })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.siteId, siteId),
        inArray(sessionEvents.anonymousId, anonymousIds),
        eq(sessionEvents.type, "page_view")
      )
    )
    .orderBy(asc(sessionEvents.timestamp))
    .limit(1);

  const [lastPageRow] = await db
    .select({ pagePath: sessionEvents.pagePath })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.siteId, siteId),
        inArray(sessionEvents.anonymousId, anonymousIds),
        eq(sessionEvents.type, "page_view")
      )
    )
    .orderBy(desc(sessionEvents.timestamp))
    .limit(1);

  return {
    firstSeenAt: totals.firstSeen != null ? new Date(totals.firstSeen) : null,
    lastSeenAt: totals.lastSeen != null ? new Date(totals.lastSeen) : null,
    sessionCount: totals.sessionCount,
    pageViewCount: totals.pageViewCount ?? 0,
    eventCount: totals.eventCount,
    totalActiveTimeMs,
    firstPage: firstPageRow?.pagePath ?? null,
    lastPage: lastPageRow?.pagePath ?? null,
  };
}

export interface ActivityItem {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  title: string;
  metadata: Record<string, unknown>;
}

/**
 * Chronological, human-readable activity feed (task brief sections 8-9)
 * - deterministic titles from session_events, deliberately excluding
 * `cursor` (raw telemetry, never a standalone timeline entry - same
 * "meaningful, not every cursor sample" principle the behavioral-events
 * layer already applies elsewhere in this codebase).
 */
export async function listActivity(
  db: Db,
  siteId: string,
  anonymousIds: string[],
  opts: { limit: number; offset: number }
): Promise<{ activities: ActivityItem[]; total: number }> {
  if (anonymousIds.length === 0) return { activities: [], total: 0 };

  const where = and(
    eq(sessionEvents.siteId, siteId),
    inArray(sessionEvents.anonymousId, anonymousIds),
    sql`${sessionEvents.type} != 'cursor'`
  );

  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(sessionEvents).where(where);

  const rows = await db
    .select()
    .from(sessionEvents)
    .where(where)
    .orderBy(desc(sessionEvents.timestamp))
    .limit(opts.limit)
    .offset(opts.offset);

  return {
    activities: rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      type: r.type,
      timestamp: r.timestamp.toISOString(),
      title: activityTitle(r),
      metadata: {
        selector: r.selector,
        elementLabel: r.elementLabel,
        elementRole: r.elementRole,
        pagePath: r.pagePath,
        durationMs: r.durationMs,
        scrollPercent: r.scrollPercent,
      },
    })),
    total,
  };
}

function activityTitle(r: typeof sessionEvents.$inferSelect): string {
  const target = r.elementLabel ?? r.selector ?? "an element";
  switch (r.type) {
    case "page_view":
      return r.pagePath ? `Viewed ${r.pagePath}` : "Viewed a page";
    case "click":
      return `Clicked ${target}`;
    case "hover":
      return r.durationMs != null ? `Hovered ${target} for ${(r.durationMs / 1000).toFixed(1)}s` : `Hovered ${target}`;
    case "scroll":
      return r.scrollPercent != null ? `Scrolled to ${r.scrollPercent}%` : "Scrolled";
    default:
      return r.type;
  }
}

export interface ProfileSessionSummary {
  sessionId: string;
  eventCount: number;
  firstSeen: string;
  lastSeen: string;
  durationMs: number;
  hasReplay: boolean;
}

/** Sessions belonging to this tracked user - same shape/convention as routes/sessions.ts's list, scoped through the alias resolution instead of a raw siteId filter. */
export async function listSessionsForTrackedUser(
  db: Db,
  siteId: string,
  anonymousIds: string[],
  opts: { limit: number; offset: number }
): Promise<{ sessions: ProfileSessionSummary[]; total: number }> {
  if (anonymousIds.length === 0) return { sessions: [], total: 0 };

  const [{ total }] = await db
    .select({ total: sql<number>`count(distinct ${sessionEvents.sessionId})` })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.siteId, siteId), inArray(sessionEvents.anonymousId, anonymousIds)));

  const rows = await db
    .select({
      sessionId: sessionEvents.sessionId,
      eventCount: sql<number>`count(*)`,
      firstSeen: sql<number>`min(${sessionEvents.timestamp})`,
      lastSeen: sql<number>`max(${sessionEvents.timestamp})`,
    })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.siteId, siteId), inArray(sessionEvents.anonymousId, anonymousIds)))
    .groupBy(sessionEvents.sessionId)
    .orderBy(desc(sql`max(${sessionEvents.timestamp})`))
    .limit(opts.limit)
    .offset(opts.offset);

  const sessionIds = rows.map((r) => r.sessionId);
  const replaySessionIds = new Set(
    sessionIds.length === 0
      ? []
      : (
          await db
            .selectDistinct({ sessionId: sessionReplayEvents.sessionId })
            .from(sessionReplayEvents)
            .where(and(eq(sessionReplayEvents.siteId, siteId), inArray(sessionReplayEvents.sessionId, sessionIds)))
        ).map((r) => r.sessionId)
  );

  return {
    sessions: rows.map((r) => ({
      sessionId: r.sessionId,
      eventCount: r.eventCount,
      firstSeen: new Date(r.firstSeen).toISOString(),
      lastSeen: new Date(r.lastSeen).toISOString(),
      durationMs: r.lastSeen - r.firstSeen,
      hasReplay: replaySessionIds.has(r.sessionId),
    })),
    total,
  };
}
