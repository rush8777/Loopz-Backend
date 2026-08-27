import { eq, and, sql, desc, like, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { sessionEvents, trackedUserAliases, trackedUsers } from "../../db/schema.js";

/**
 * Anonymous visitor discovery - the counterpart to the tracked-user
 * layer for identities that haven't been identify()'d yet.
 *
 * Deliberately no new identity table: an anonymous visitor's "identity"
 * is just the anonymousId the SDK already generates, and its
 * sessions/activity already live in `session_events` (every row has
 * carried `anonymousId` since the tracked-user layer was built - see
 * profile.ts). What's new here is purely a *query*: "which
 * anonymousIds on this site have never been claimed by a
 * tracked_user_aliases row" - i.e. genuinely still-anonymous visitors,
 * as opposed to ones identify() has since resolved.
 */

async function getClaimedAnonymousIds(db: Db, siteId: string): Promise<string[]> {
  const rows = await db
    .select({ anonymousId: trackedUserAliases.anonymousId })
    .from(trackedUserAliases)
    .where(eq(trackedUserAliases.siteId, siteId));
  return rows.map((r) => r.anonymousId);
}

export interface AnonymousVisitorSummary {
  anonymousId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sessionCount: number;
  pageViewCount: number;
  eventCount: number;
}

/**
 * Unclaimed anonymousIds for a site, most-recently-active first.
 * Search matches the anonymousId itself (task brief section 21 -
 * anonymous visitors have no name/email to search by, only the id).
 */
export async function listAnonymousVisitors(
  db: Db,
  siteId: string,
  opts: { limit: number; offset: number; search?: string }
): Promise<{ visitors: AnonymousVisitorSummary[]; total: number }> {
  const claimed = await getClaimedAnonymousIds(db, siteId);

  const conditions = [eq(sessionEvents.siteId, siteId), sql`${sessionEvents.anonymousId} is not null`];
  if (claimed.length > 0) conditions.push(notInArray(sessionEvents.anonymousId, claimed));
  if (opts.search) conditions.push(like(sessionEvents.anonymousId, `%${opts.search}%`));
  const where = and(...conditions);

  const [{ total }] = await db
    .select({ total: sql<number>`count(distinct ${sessionEvents.anonymousId})` })
    .from(sessionEvents)
    .where(where);
  if (total === 0) return { visitors: [], total: 0 };

  const rows = await db
    .select({
      anonymousId: sessionEvents.anonymousId,
      firstSeen: sql<number>`min(${sessionEvents.timestamp})`,
      lastSeen: sql<number>`max(${sessionEvents.timestamp})`,
      sessionCount: sql<number>`count(distinct ${sessionEvents.sessionId})`,
      eventCount: sql<number>`count(*)`,
      pageViewCount: sql<number>`sum(case when ${sessionEvents.type} = 'page_view' then 1 else 0 end)`,
    })
    .from(sessionEvents)
    .where(where)
    .groupBy(sessionEvents.anonymousId)
    .orderBy(desc(sql`max(${sessionEvents.timestamp})`))
    .limit(opts.limit)
    .offset(opts.offset);

  return {
    visitors: rows.map((r) => ({
      anonymousId: r.anonymousId as string,
      firstSeenAt: new Date(r.firstSeen).toISOString(),
      lastSeenAt: new Date(r.lastSeen).toISOString(),
      sessionCount: r.sessionCount,
      pageViewCount: r.pageViewCount ?? 0,
      eventCount: r.eventCount,
    })),
    total,
  };
}

export interface AnonymousIdentityState {
  /** Whether this anonymousId has ever been seen on this site at all (site-scoping/404 check). */
  exists: boolean;
  /**
   * Non-null once identify() has claimed this anonymousId - the
   * identified user it now belongs to. A resolved anonymousId's raw
   * events are untouched and still queryable directly (task brief
   * section 17), but it's no longer an independent active identity:
   * callers should treat this as "redirect to the identified profile"
   * rather than "show an anonymous profile".
   */
  resolved: { trackedUserId: string; externalUserId: string } | null;
}

export async function resolveAnonymousIdentityState(
  db: Db,
  siteId: string,
  anonymousId: string
): Promise<AnonymousIdentityState> {
  const [seen] = await db
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.anonymousId, anonymousId)))
    .limit(1);
  if (!seen) return { exists: false, resolved: null };

  const [alias] = await db
    .select({ trackedUserId: trackedUserAliases.trackedUserId })
    .from(trackedUserAliases)
    .where(and(eq(trackedUserAliases.siteId, siteId), eq(trackedUserAliases.anonymousId, anonymousId)))
    .limit(1);
  if (!alias) return { exists: true, resolved: null };

  const [user] = await db
    .select({ externalUserId: trackedUsers.externalUserId })
    .from(trackedUsers)
    .where(eq(trackedUsers.id, alias.trackedUserId))
    .limit(1);

  return {
    exists: true,
    resolved: user ? { trackedUserId: alias.trackedUserId, externalUserId: user.externalUserId } : null,
  };
}
