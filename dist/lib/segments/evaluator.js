import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { sessionEvents, trackedUserAliases, trackedUsers, trackedUserProperties, pageDefinitions } from "../../db/schema.js";
import { matchesRules } from "../pages/pageMatcher.js";
import { loadPagePathStats } from "../pages/pageAggregation.js";
import { isGroup } from "./types.js";
const identityExpr = sql `coalesce(${trackedUserAliases.trackedUserId}, ${sessionEvents.anonymousId})`;
function windowSince(window) {
    if (!window)
        return undefined;
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
async function getKnownIdentities(db, siteId) {
    const [trackedRows, eventRows] = await Promise.all([
        db.select({ id: trackedUsers.id }).from(trackedUsers).where(eq(trackedUsers.siteId, siteId)),
        db
            .selectDistinct({ identity: identityExpr })
            .from(sessionEvents)
            .leftJoin(trackedUserAliases, and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId)))
            .where(eq(sessionEvents.siteId, siteId)),
    ]);
    const identities = new Set(trackedRows.map((r) => r.id));
    for (const r of eventRows)
        if (r.identity)
            identities.add(r.identity);
    return identities;
}
// ---------------------------------------------------------------------------
// Condition A: custom event occurrence
async function resolveEventCondition(db, siteId, c, universe) {
    const since = windowSince(c.timeWindow);
    const conditions = [eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, c.eventName)];
    if (since)
        conditions.push(gte(sessionEvents.timestamp, since));
    const rows = await db
        .selectDistinct({ identity: identityExpr })
        .from(sessionEvents)
        .leftJoin(trackedUserAliases, and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId)))
        .where(and(...conditions));
    const performed = new Set(rows.map((r) => r.identity).filter((x) => !!x));
    if (c.operator === "performed")
        return performed;
    const all = await universe();
    const notPerformed = new Set();
    for (const id of all)
        if (!performed.has(id))
            notPerformed.add(id);
    return notPerformed;
}
// ---------------------------------------------------------------------------
// Condition B: user property
/** Value comparison against a stored (string-serialized) property, following the same valueType-driven coercion routes/tracked-users.ts's deserializeValue already uses. */
function compareProperty(rawValue, valueType, operator, target) {
    if (operator === "greater_than" || operator === "less_than" || operator === "greater_than_or_equal" || operator === "less_than_or_equal") {
        const left = valueType === "number" ? Number(rawValue) : Number.NaN;
        const right = typeof target === "number" ? target : Number(target);
        if (Number.isNaN(left) || Number.isNaN(right))
            return false;
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
async function resolvePropertyCondition(db, siteId, c) {
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
    if (c.operator === "exists")
        return withProperty;
    if (c.operator === "not_exists") {
        const allUsers = await db.select({ id: trackedUsers.id }).from(trackedUsers).where(eq(trackedUsers.siteId, siteId));
        return new Set(allUsers.map((u) => u.id).filter((id) => !withProperty.has(id)));
    }
    const matches = new Set();
    for (const r of rows) {
        if (compareProperty(r.value, r.valueType, c.operator, c.value))
            matches.add(r.trackedUserId);
    }
    return matches;
}
// ---------------------------------------------------------------------------
// Condition C: page visited
/** Resolves a Page's rules (task brief section 3C: reuse the page-definition system, not a second page-tracking model) to the concrete pagePaths currently matching it - same pattern routes/pages.ts already uses for its own metrics. */
async function resolveMatchedPaths(db, siteId, pageId) {
    const [page] = await db.select().from(pageDefinitions).where(eq(pageDefinitions.id, pageId)).limit(1);
    if (!page || page.siteId !== siteId)
        return null; // dangling/cross-site reference - treated as "matches nobody" by the caller
    const pathStats = await loadPagePathStats(db, siteId);
    return pathStats.map((p) => p.pagePath).filter((p) => matchesRules(p, page.rules));
}
async function resolvePageCondition(db, siteId, c, universe) {
    const matchedPaths = await resolveMatchedPaths(db, siteId, c.pageId);
    if (matchedPaths === null || matchedPaths.length === 0) {
        return c.operator === "visited" ? new Set() : await universe();
    }
    const since = windowSince(c.timeWindow);
    const conditions = [eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "page_view"), inArray(sessionEvents.pagePath, matchedPaths)];
    if (since)
        conditions.push(gte(sessionEvents.timestamp, since));
    const rows = await db
        .selectDistinct({ identity: identityExpr })
        .from(sessionEvents)
        .leftJoin(trackedUserAliases, and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId)))
        .where(and(...conditions));
    const visited = new Set(rows.map((r) => r.identity).filter((x) => !!x));
    if (c.operator === "visited")
        return visited;
    const all = await universe();
    const notVisited = new Set();
    for (const id of all)
        if (!visited.has(id))
            notVisited.add(id);
    return notVisited;
}
// ---------------------------------------------------------------------------
// Group combination
async function resolveCondition(db, siteId, c, universe) {
    switch (c.type) {
        case "event":
            return resolveEventCondition(db, siteId, c, universe);
        case "user_property":
            return resolvePropertyCondition(db, siteId, c);
        case "page":
            return resolvePageCondition(db, siteId, c, universe);
    }
}
function intersect(sets) {
    if (sets.length === 0)
        return new Set();
    const [first, ...rest] = sets;
    const result = new Set();
    for (const id of first) {
        if (rest.every((s) => s.has(id)))
            result.add(id);
    }
    return result;
}
function union(sets) {
    const result = new Set();
    for (const s of sets)
        for (const id of s)
            result.add(id);
    return result;
}
async function resolveNode(db, siteId, node, universe) {
    return isGroup(node) ? resolveGroup(db, siteId, node, universe) : resolveCondition(db, siteId, node, universe);
}
async function resolveGroup(db, siteId, group, universe) {
    const sets = await Promise.all(group.conditions.map((node) => resolveNode(db, siteId, node, universe)));
    return group.logic === "and" ? intersect(sets) : union(sets);
}
/**
 * Resolves a segment definition to the set of currently-matching
 * identity keys. The single entry point every consumer (segments
 * routes, and eventually Funnels/Experiences) should call.
 */
export async function evaluateSegment(db, siteId, definition) {
    let cached = null;
    const universe = async () => {
        if (!cached)
            cached = await getKnownIdentities(db, siteId);
        return cached;
    };
    return resolveGroup(db, siteId, definition, universe);
}
/** Server-side count only (task brief section 8) - never fetches the full member set to the browser just to count it. */
export async function getSegmentAudienceCount(db, siteId, definition) {
    const ids = await evaluateSegment(db, siteId, definition);
    return ids.size;
}
/** Paginated, hydrated membership (task brief section 14) - resolves each identity key to either a tracked user (identified) or a bare anonymousId row, never loading the full unbounded set into memory for display. */
export async function getSegmentMembers(db, siteId, definition, opts) {
    const allIds = [...(await evaluateSegment(db, siteId, definition))];
    const total = allIds.length;
    const page = allIds.slice(opts.offset, opts.offset + opts.limit);
    if (page.length === 0)
        return { members: [], total };
    const trackedRows = await db.select().from(trackedUsers).where(and(eq(trackedUsers.siteId, siteId), inArray(trackedUsers.id, page)));
    const trackedById = new Map(trackedRows.map((r) => [r.id, r]));
    const anonymousIds = page.filter((id) => !trackedById.has(id));
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
    const members = page.map((id) => {
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
    return { members, total };
}
//# sourceMappingURL=evaluator.js.map