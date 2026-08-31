import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { sessionEvents, trackedUserAliases, trackedUsers, trackedUserProperties, pageDefinitions } from "../../db/schema.js";
import { matchesRules } from "../pages/pageMatcher.js";
import { loadPagePathStats } from "../pages/pageAggregation.js";
import type { PageRule } from "../pages/types.js";
import { hydrateIdentities, type IdentitySummary } from "../identity/hydrate.js";
import { isGroup } from "./types.js";
import type {
  EventCondition,
  PageCondition,
  SegmentCondition,
  SegmentDefinition,
  SegmentGroup,
  SegmentNode,
  SegmentTimeWindow,
  UserPropertyCondition,
} from "./types.js";

/**
 * The Segment Evaluation Engine (task brief section 5). This is the
 * one place segment membership is computed - `evaluateSegment` is the
 * `evaluateSegment(segmentDefinition, siteId)` the brief asks for, and
 * `routes/segments.ts` is a thin HTTP wrapper around it, same
 * "reusable service, not route logic" precedent as
 * `lib/events/eventQueries.ts` for the Event Explorer. Future callers
 * (Funnels, Experiences, Widgets, AI recommendations, Audience
 * targeting - brief section 5) import this module directly rather
 * than re-deriving segment matching.
 *
 * A "member" is identified by a single string key, computed exactly
 * the way `lib/events/eventQueries.ts`'s `identityExpr` already does:
 * a tracked user's `id` if `tracked_user_aliases` has claimed the
 * anonymousId behind an event, otherwise the bare anonymousId. This is
 * not a second identity system (task brief section 6) - it's the same
 * `tracked_user_aliases` resolution applied uniformly across every
 * condition type, so an anonymous visitor who later identifies is
 * treated as one person's history, not two.
 *
 * Nothing here is persisted (task brief section 7 - no
 * `segment_members` table): every call recomputes membership from
 * current `session_events`/`tracked_user_properties`/
 * `page_definitions` data, so membership always reflects the site's
 * current state.
 */

/** Either a tracked user's id, or a bare (never-identified) anonymousId. Same shape identityExpr produces in eventQueries.ts. */
export type IdentityKey = string;

const identityExpr = sql<string>`coalesce(${trackedUserAliases.trackedUserId}, ${sessionEvents.anonymousId})`;

function windowSince(window?: SegmentTimeWindow): Date | undefined {
  if (!window) return undefined;
  return new Date(Date.now() - window.value * 24 * 60 * 60 * 1000);
}

/**
 * The closed universe "not_performed"/"not_visited" conditions are
 * evaluated against: every identity (tracked user or bare anonymousId)
 * this site knows about. Without a bounded universe, "not performed"
 * would be unanswerable (there's no way to enumerate "everyone who
 * didn't do X" from an open world) - this is the same closed-world
 * assumption Pendo/Amplitude-style segment builders make.
 *
 * Two sources, unioned: every `tracked_users` row for the site (an
 * identified user may exist from `identify()` alone - identify()
 * identity resolution alone - identify() itself never writes a
 * `session_events` row (see routes/public-events.ts filtering
 * identify/session_start out of the events it persists) - so a
 * session_events-only scan would silently drop identified users who
 * haven't fired any other event yet), plus every distinct
 * identity `session_events` resolves to (covers anonymous visitors
 * who have never identified).
 */
async function getKnownIdentities(db: Db, siteId: string): Promise<Set<IdentityKey>> {
  const [trackedRows, eventRows] = await Promise.all([
    db.select({ id: trackedUsers.id }).from(trackedUsers).where(eq(trackedUsers.siteId, siteId)),
    db
      .selectDistinct({ identity: identityExpr })
      .from(sessionEvents)
      .leftJoin(
        trackedUserAliases,
        and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId))
      )
      .where(eq(sessionEvents.siteId, siteId)),
  ]);
  const identities = new Set<IdentityKey>(trackedRows.map((r) => r.id));
  for (const r of eventRows) if (r.identity) identities.add(r.identity);
  return identities;
}

type UniverseFn = () => Promise<Set<IdentityKey>>;

// ---------------------------------------------------------------------------
// Condition A: custom event occurrence

async function resolveEventCondition(db: Db, siteId: string, c: EventCondition, universe: UniverseFn): Promise<Set<IdentityKey>> {
  const since = windowSince(c.timeWindow);
  const conditions = [eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, c.eventName)];
  if (since) conditions.push(gte(sessionEvents.timestamp, since));

  const rows = await db
    .selectDistinct({ identity: identityExpr })
    .from(sessionEvents)
    .leftJoin(
      trackedUserAliases,
      and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId))
    )
    .where(and(...conditions));
  const performed = new Set(rows.map((r) => r.identity).filter((x): x is string => !!x));

  if (c.operator === "performed") return performed;
  const all = await universe();
  const notPerformed = new Set<IdentityKey>();
  for (const id of all) if (!performed.has(id)) notPerformed.add(id);
  return notPerformed;
}

// ---------------------------------------------------------------------------
// Condition B: user property

/** Value comparison against a stored (string-serialized) property, following the same valueType-driven coercion routes/tracked-users.ts's deserializeValue already uses. */
function compareProperty(rawValue: string, valueType: string, operator: UserPropertyCondition["operator"], target: unknown): boolean {
  if (operator === "greater_than" || operator === "less_than" || operator === "greater_than_or_equal" || operator === "less_than_or_equal") {
    const left = valueType === "number" ? Number(rawValue) : Number.NaN;
    const right = typeof target === "number" ? target : Number(target);
    if (Number.isNaN(left) || Number.isNaN(right)) return false;
    switch (operator) {
      case "greater_than":
        return left > right;
      case "less_than":
        return left < right;
      case "greater_than_or_equal":
        return left >= right;
      case "less_than_or_equal":
        return left <= right;
    }
  }

  const storedAsBoolean = valueType === "boolean" ? rawValue === "true" : null;

  switch (operator) {
    case "equals":
      return storedAsBoolean !== null && typeof target === "boolean" ? storedAsBoolean === target : String(rawValue) === String(target);
    case "not_equals":
      return storedAsBoolean !== null && typeof target === "boolean" ? storedAsBoolean !== target : String(rawValue) !== String(target);
    case "contains":
      return String(rawValue).toLowerCase().includes(String(target).toLowerCase());
    case "not_contains":
      return !String(rawValue).toLowerCase().includes(String(target).toLowerCase());
    default:
      return false;
  }
}

/** Property conditions only ever match *identified* tracked users - task brief section 3A only defines this for user properties, which anonymous visitors never have (see UserPropertyCondition's doc comment in types.ts). */
async function resolvePropertyCondition(db: Db, siteId: string, c: UserPropertyCondition): Promise<Set<IdentityKey>> {
  const rows = await db
    .select({
      trackedUserId: trackedUserProperties.trackedUserId,
      value: trackedUserProperties.value,
      valueType: trackedUserProperties.valueType,
    })
    .from(trackedUserProperties)
    .innerJoin(trackedUsers, eq(trackedUsers.id, trackedUserProperties.trackedUserId))
    .where(and(eq(trackedUsers.siteId, siteId), eq(trackedUserProperties.name, c.propertyName)));

  const withProperty = new Set(rows.map((r) => r.trackedUserId));

  if (c.operator === "exists") return withProperty;
  if (c.operator === "not_exists") {
    const allUsers = await db.select({ id: trackedUsers.id }).from(trackedUsers).where(eq(trackedUsers.siteId, siteId));
    return new Set(allUsers.map((u) => u.id).filter((id) => !withProperty.has(id)));
  }

  const matches = new Set<IdentityKey>();
  for (const r of rows) {
    if (compareProperty(r.value, r.valueType, c.operator, c.value)) matches.add(r.trackedUserId);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Condition C: page visited

/** Resolves a Page's rules (task brief section 3C: reuse the page-definition system, not a second page-tracking model) to the concrete pagePaths currently matching it - same pattern routes/pages.ts already uses for its own metrics. Exported for lib/funnels/evaluator.ts's page steps, so both features resolve a Page reference identically. */
export async function resolveMatchedPagePaths(db: Db, siteId: string, pageId: string): Promise<string[] | null> {
  const [page] = await db.select().from(pageDefinitions).where(eq(pageDefinitions.id, pageId)).limit(1);
  if (!page || page.siteId !== siteId) return null; // dangling/cross-site reference - treated as "matches nobody" by the caller
  const pathStats = await loadPagePathStats(db, siteId);
  return pathStats.map((p) => p.pagePath).filter((p) => matchesRules(p, page.rules as PageRule[]));
}

async function resolvePageCondition(db: Db, siteId: string, c: PageCondition, universe: UniverseFn): Promise<Set<IdentityKey>> {
  const matchedPaths = await resolveMatchedPagePaths(db, siteId, c.pageId);
  if (matchedPaths === null || matchedPaths.length === 0) {
    return c.operator === "visited" ? new Set() : await universe();
  }

  const since = windowSince(c.timeWindow);
  const conditions = [eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "page_view"), inArray(sessionEvents.pagePath, matchedPaths)];
  if (since) conditions.push(gte(sessionEvents.timestamp, since));

  const rows = await db
    .selectDistinct({ identity: identityExpr })
    .from(sessionEvents)
    .leftJoin(
      trackedUserAliases,
      and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId))
    )
    .where(and(...conditions));
  const visited = new Set(rows.map((r) => r.identity).filter((x): x is string => !!x));

  if (c.operator === "visited") return visited;
  const all = await universe();
  const notVisited = new Set<IdentityKey>();
  for (const id of all) if (!visited.has(id)) notVisited.add(id);
  return notVisited;
}

// ---------------------------------------------------------------------------
// Group combination

async function resolveCondition(db: Db, siteId: string, c: SegmentCondition, universe: UniverseFn): Promise<Set<IdentityKey>> {
  switch (c.type) {
    case "event":
      return resolveEventCondition(db, siteId, c, universe);
    case "user_property":
      return resolvePropertyCondition(db, siteId, c);
    case "page":
      return resolvePageCondition(db, siteId, c, universe);
  }
}

function intersect(sets: Set<IdentityKey>[]): Set<IdentityKey> {
  if (sets.length === 0) return new Set();
  const [first, ...rest] = sets;
  const result = new Set<IdentityKey>();
  for (const id of first) {
    if (rest.every((s) => s.has(id))) result.add(id);
  }
  return result;
}

function union(sets: Set<IdentityKey>[]): Set<IdentityKey> {
  const result = new Set<IdentityKey>();
  for (const s of sets) for (const id of s) result.add(id);
  return result;
}

async function resolveNode(db: Db, siteId: string, node: SegmentNode, universe: UniverseFn): Promise<Set<IdentityKey>> {
  return isGroup(node) ? resolveGroup(db, siteId, node, universe) : resolveCondition(db, siteId, node, universe);
}

async function resolveGroup(db: Db, siteId: string, group: SegmentGroup, universe: UniverseFn): Promise<Set<IdentityKey>> {
  const sets = await Promise.all(group.conditions.map((node) => resolveNode(db, siteId, node, universe)));
  return group.logic === "and" ? intersect(sets) : union(sets);
}

/**
 * Resolves a segment definition to the set of currently-matching
 * identity keys. The single entry point every consumer (segments
 * routes, and eventually Funnels/Experiences) should call.
 */
export async function evaluateSegment(db: Db, siteId: string, definition: SegmentDefinition): Promise<Set<IdentityKey>> {
  let cached: Set<IdentityKey> | null = null;
  const universe: UniverseFn = async () => {
    if (!cached) cached = await getKnownIdentities(db, siteId);
    return cached;
  };
  return resolveGroup(db, siteId, definition, universe);
}

/** Server-side count only (task brief section 8) - never fetches the full member set to the browser just to count it. */
export async function getSegmentAudienceCount(db: Db, siteId: string, definition: SegmentDefinition): Promise<number> {
  const ids = await evaluateSegment(db, siteId, definition);
  return ids.size;
}

export type SegmentMember = IdentitySummary;

/** Paginated, hydrated membership (task brief section 14) - resolves each identity key via the shared hydrateIdentities helper, never loading the full unbounded set into memory for display. */
export async function getSegmentMembers(
  db: Db,
  siteId: string,
  definition: SegmentDefinition,
  opts: { limit: number; offset: number }
): Promise<{ members: SegmentMember[]; total: number }> {
  const allIds = [...(await evaluateSegment(db, siteId, definition))];
  const total = allIds.length;
  const page = allIds.slice(opts.offset, opts.offset + opts.limit);
  const members = await hydrateIdentities(db, siteId, page);
  return { members, total };
}
