import { and, eq, gte, lte, like, desc, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { sessionEvents, trackedUserAliases, trackedUsers, patterns } from "../../db/schema.js";
function dateRangeConditions(range) {
    const conditions = [];
    if (range.since)
        conditions.push(gte(sessionEvents.timestamp, range.since));
    if (range.until)
        conditions.push(lte(sessionEvents.timestamp, range.until));
    return conditions;
}
/** Identity-resolved "who" behind a session_events row - a tracked user if an alias claims this anonymousId, else the bare anonymousId. See the module doc comment above. */
const identityExpr = sql `coalesce(${trackedUserAliases.trackedUserId}, ${sessionEvents.anonymousId})`;
/** Whether this event name has ever occurred for this site, regardless of any date range - the existence check the :eventName sub-routes 404 on. Deliberately unfiltered by date: a real event with zero occurrences in the *selected* range should render an empty state, not a 404 - see routes/events.ts. */
export async function eventExistsForSite(db, siteId, eventName) {
    const [row] = await db
        .select({ id: sessionEvents.id })
        .from(sessionEvents)
        .where(and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, eventName)))
        .limit(1);
    return !!row;
}
/** Distinct custom event names for a site, most-frequent first - the Event Explorer's primary list. Discovered dynamically from session_events; nothing here is hard-coded. */
export async function listEventDefinitions(db, siteId, opts) {
    const conditions = [eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), ...dateRangeConditions(opts)];
    if (opts.search)
        conditions.push(like(sessionEvents.eventName, `%${opts.search}%`));
    const where = and(...conditions);
    const [{ total }] = await db
        .select({ total: sql `count(distinct ${sessionEvents.eventName})` })
        .from(sessionEvents)
        .where(where);
    if (total === 0)
        return { events: [], total: 0 };
    const rows = await db
        .select({
        name: sessionEvents.eventName,
        occurrences: sql `count(*)`,
        uniqueUsers: sql `count(distinct ${identityExpr})`,
        sessions: sql `count(distinct ${sessionEvents.sessionId})`,
        firstSeen: sql `min(${sessionEvents.timestamp})`,
        lastSeen: sql `max(${sessionEvents.timestamp})`,
    })
        .from(sessionEvents)
        .leftJoin(trackedUserAliases, and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId)))
        .where(where)
        .groupBy(sessionEvents.eventName)
        .orderBy(desc(sql `count(*)`))
        .limit(opts.limit)
        .offset(opts.offset);
    return {
        events: rows.map((r) => ({
            name: r.name,
            occurrences: r.occurrences,
            uniqueUsers: r.uniqueUsers,
            sessions: r.sessions,
            firstSeenAt: new Date(r.firstSeen).toISOString(),
            lastSeenAt: new Date(r.lastSeen).toISOString(),
        })),
        total,
    };
}
const EMPTY_SUMMARY = (name) => ({
    name,
    occurrences: 0,
    uniqueUsers: 0,
    sessions: 0,
    firstSeenAt: null,
    lastSeenAt: null,
});
export async function getEventSummary(db, siteId, eventName, range) {
    const where = and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, eventName), ...dateRangeConditions(range));
    const [row] = await db
        .select({
        occurrences: sql `count(*)`,
        uniqueUsers: sql `count(distinct ${identityExpr})`,
        sessions: sql `count(distinct ${sessionEvents.sessionId})`,
        firstSeen: sql `min(${sessionEvents.timestamp})`,
        lastSeen: sql `max(${sessionEvents.timestamp})`,
    })
        .from(sessionEvents)
        .leftJoin(trackedUserAliases, and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId)))
        .where(where);
    if (!row || row.occurrences === 0)
        return EMPTY_SUMMARY(eventName);
    return {
        name: eventName,
        occurrences: row.occurrences,
        uniqueUsers: row.uniqueUsers,
        sessions: row.sessions,
        firstSeenAt: row.firstSeen != null ? new Date(row.firstSeen).toISOString() : null,
        lastSeenAt: row.lastSeen != null ? new Date(row.lastSeen).toISOString() : null,
    };
}
const MAX_TIMESERIES_DAYS = 400; // defensive cap - an arbitrarily wide custom range shouldn't build an unbounded array
/** Daily occurrence counts across [since, until], zero-filled for days with no occurrences so the chart has no gaps. */
export async function getEventTimeseries(db, siteId, eventName, range) {
    const dayExpr = sql `strftime('%Y-%m-%d', ${sessionEvents.timestamp} / 1000, 'unixepoch')`;
    const rows = await db
        .select({ day: dayExpr, count: sql `count(*)` })
        .from(sessionEvents)
        .where(and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, eventName), gte(sessionEvents.timestamp, range.since), lte(sessionEvents.timestamp, range.until)))
        .groupBy(dayExpr);
    const byDay = new Map(rows.map((r) => [r.day, r.count]));
    const points = [];
    const cursor = new Date(Date.UTC(range.since.getUTCFullYear(), range.since.getUTCMonth(), range.since.getUTCDate()));
    const end = new Date(Date.UTC(range.until.getUTCFullYear(), range.until.getUTCMonth(), range.until.getUTCDate()));
    for (let i = 0; cursor <= end && i < MAX_TIMESERIES_DAYS; i++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        const key = cursor.toISOString().slice(0, 10);
        points.push({ date: key, count: byDay.get(key) ?? 0 });
    }
    return points;
}
const PROPERTY_SAMPLE_CAP = 5000; // bounded server-side sample, not the whole table - see module doc comment
const TOP_CATEGORICAL_VALUES = 8;
function classifyValue(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    if (typeof value === "object")
        return "object";
    if (typeof value === "number")
        return "number";
    if (typeof value === "boolean")
        return "boolean";
    return "string";
}
function median(sortedNums) {
    const n = sortedNums.length;
    if (n === 0)
        return 0;
    const mid = Math.floor(n / 2);
    return n % 2 === 0 ? (sortedNums[mid - 1] + sortedNums[mid]) / 2 : sortedNums[mid];
}
/**
 * Summarizes one property across the values observed for it: numbers
 * get min/median/max, strings/booleans get a top-N value/percent
 * breakdown (with the remainder rolled into a synthetic "Other" row so
 * percentages still sum to ~100), and arrays/objects/null-only
 * properties just get a sample count - the occurrence detail drawer's
 * expandable JSON view is where their actual shape is inspected, not
 * this summary table (task constraint: avoid rendering huge nested
 * objects directly into the table). When a property's observed values
 * are a mix of kinds, the *majority* kind (excluding null) drives which
 * summary shape is produced; values of other kinds are excluded from
 * that summary rather than crashing or coercing oddly.
 */
function summarizeProperty(name, values) {
    const counts = new Map();
    for (const v of values) {
        const kind = classifyValue(v);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    let dominant = "null";
    let best = -1;
    for (const [kind, count] of counts) {
        if (kind === "null")
            continue;
        if (count > best) {
            best = count;
            dominant = kind;
        }
    }
    if (dominant === "number") {
        const nums = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
        return { name, type: "number", sampleCount: nums.length, min: nums[0], max: nums[nums.length - 1], median: median(nums) };
    }
    if (dominant === "string" || dominant === "boolean") {
        const matching = values.filter((v) => classifyValue(v) === dominant).map((v) => String(v));
        const freq = new Map();
        for (const s of matching)
            freq.set(s, (freq.get(s) ?? 0) + 1);
        const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
        const top = sorted.slice(0, TOP_CATEGORICAL_VALUES);
        const topTotal = top.reduce((sum, [, c]) => sum + c, 0);
        const otherCount = matching.length - topTotal;
        const pct = (c) => Math.round((c / matching.length) * 1000) / 10;
        const entries = top.map(([value, count]) => ({ value, count, percent: pct(count) }));
        if (otherCount > 0)
            entries.push({ value: "Other", count: otherCount, percent: pct(otherCount) });
        return { name, type: dominant, sampleCount: matching.length, values: entries };
    }
    // array, object, or null-only
    return { name, type: dominant, sampleCount: values.length };
}
export async function getEventPropertySummary(db, siteId, eventName, range) {
    const where = and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, eventName), ...dateRangeConditions(range));
    const [{ total }] = await db.select({ total: sql `count(*)` }).from(sessionEvents).where(where);
    if (total === 0)
        return { properties: [], sampledOccurrences: 0, totalOccurrences: 0 };
    const rows = await db
        .select({ properties: sessionEvents.eventProperties })
        .from(sessionEvents)
        .where(where)
        .orderBy(desc(sessionEvents.timestamp))
        .limit(PROPERTY_SAMPLE_CAP);
    const byKey = new Map();
    for (const row of rows) {
        const props = row.properties;
        if (!props)
            continue;
        for (const [key, value] of Object.entries(props)) {
            const list = byKey.get(key);
            if (list)
                list.push(value);
            else
                byKey.set(key, [value]);
        }
    }
    const properties = [...byKey.entries()]
        .map(([name, values]) => summarizeProperty(name, values))
        .sort((a, b) => a.name.localeCompare(b.name));
    return { properties, sampledOccurrences: rows.length, totalOccurrences: total };
}
function selectOccurrenceColumns(pageViewRows) {
    return {
        id: sessionEvents.id,
        timestamp: sessionEvents.timestamp,
        sessionId: sessionEvents.sessionId,
        anonymousId: sessionEvents.anonymousId,
        trackedUserId: trackedUserAliases.trackedUserId,
        externalUserId: trackedUsers.externalUserId,
        pagePath: pageViewRows.pagePath,
        properties: sessionEvents.eventProperties,
    };
}
function toOccurrence(r) {
    return {
        id: r.id,
        timestamp: r.timestamp.toISOString(),
        sessionId: r.sessionId,
        anonymousId: r.anonymousId,
        trackedUserId: r.trackedUserId,
        externalUserId: r.externalUserId,
        pagePath: r.pagePath,
        properties: r.properties,
    };
}
export async function listEventOccurrences(db, siteId, eventName, opts) {
    const where = and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, eventName), ...dateRangeConditions(opts));
    const [{ total }] = await db.select({ total: sql `count(*)` }).from(sessionEvents).where(where);
    if (total === 0)
        return { occurrences: [], total: 0 };
    // Self-join to the page_view row sharing this event's pageViewId - see the module doc comment on page attribution.
    const pageViewRows = alias(sessionEvents, "event_explorer_page_view");
    const rows = await db
        .select(selectOccurrenceColumns(pageViewRows))
        .from(sessionEvents)
        .leftJoin(trackedUserAliases, and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId)))
        .leftJoin(trackedUsers, eq(trackedUsers.id, trackedUserAliases.trackedUserId))
        .leftJoin(pageViewRows, and(eq(pageViewRows.siteId, sessionEvents.siteId), eq(pageViewRows.pageViewId, sessionEvents.pageViewId), eq(pageViewRows.type, "page_view")))
        .where(where)
        .orderBy(desc(sessionEvents.timestamp))
        .limit(opts.limit)
        .offset(opts.offset);
    return { occurrences: rows.map(toOccurrence), total };
}
/** One occurrence by id, scoped to (siteId, eventName) - backs the occurrence detail drawer. Same shape/joins as listEventOccurrences, just filtered to a single row. */
export async function getEventOccurrence(db, siteId, eventName, occurrenceId) {
    const pageViewRows = alias(sessionEvents, "event_explorer_page_view");
    const [row] = await db
        .select(selectOccurrenceColumns(pageViewRows))
        .from(sessionEvents)
        .leftJoin(trackedUserAliases, and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId)))
        .leftJoin(trackedUsers, eq(trackedUsers.id, trackedUserAliases.trackedUserId))
        .leftJoin(pageViewRows, and(eq(pageViewRows.siteId, sessionEvents.siteId), eq(pageViewRows.pageViewId, sessionEvents.pageViewId), eq(pageViewRows.type, "page_view")))
        .where(and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, eventName), eq(sessionEvents.id, occurrenceId)))
        .limit(1);
    return row ? toOccurrence(row) : null;
}
export async function getEventUsers(db, siteId, eventName, opts) {
    const where = and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, eventName), ...dateRangeConditions(opts));
    const [{ total }] = await db
        .select({ total: sql `count(distinct ${identityExpr})` })
        .from(sessionEvents)
        .leftJoin(trackedUserAliases, and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId)))
        .where(where);
    if (total === 0)
        return { users: [], total: 0 };
    const rows = await db
        .select({
        trackedUserId: trackedUserAliases.trackedUserId,
        externalUserId: trackedUsers.externalUserId,
        anonymousId: sql `max(${sessionEvents.anonymousId})`,
        occurrences: sql `count(*)`,
        firstSeen: sql `min(${sessionEvents.timestamp})`,
        lastSeen: sql `max(${sessionEvents.timestamp})`,
    })
        .from(sessionEvents)
        .leftJoin(trackedUserAliases, and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId)))
        .leftJoin(trackedUsers, eq(trackedUsers.id, trackedUserAliases.trackedUserId))
        .where(where)
        .groupBy(identityExpr, trackedUserAliases.trackedUserId, trackedUsers.externalUserId)
        .orderBy(desc(sql `max(${sessionEvents.timestamp})`))
        .limit(opts.limit)
        .offset(opts.offset);
    return {
        users: rows.map((r) => ({
            identityType: r.trackedUserId ? "identified" : "anonymous",
            trackedUserId: r.trackedUserId,
            externalUserId: r.externalUserId,
            anonymousId: r.anonymousId,
            occurrences: r.occurrences,
            firstSeenAt: new Date(r.firstSeen).toISOString(),
            lastSeenAt: new Date(r.lastSeen).toISOString(),
        })),
        total,
    };
}
export async function getEventSessions(db, siteId, eventName, opts) {
    const where = and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, eventName), ...dateRangeConditions(opts));
    const [{ total }] = await db
        .select({ total: sql `count(distinct ${sessionEvents.sessionId})` })
        .from(sessionEvents)
        .where(where);
    if (total === 0)
        return { sessions: [], total: 0 };
    const rows = await db
        .select({
        sessionId: sessionEvents.sessionId,
        anonymousId: sql `max(${sessionEvents.anonymousId})`,
        occurrences: sql `count(*)`,
        firstSeen: sql `min(${sessionEvents.timestamp})`,
        lastSeen: sql `max(${sessionEvents.timestamp})`,
    })
        .from(sessionEvents)
        .where(where)
        .groupBy(sessionEvents.sessionId)
        .orderBy(desc(sql `max(${sessionEvents.timestamp})`))
        .limit(opts.limit)
        .offset(opts.offset);
    return {
        sessions: rows.map((r) => ({
            sessionId: r.sessionId,
            anonymousId: r.anonymousId,
            occurrences: r.occurrences,
            firstSeenAt: new Date(r.firstSeen).toISOString(),
            lastSeenAt: new Date(r.lastSeen).toISOString(),
        })),
        total,
    };
}
const MAX_PAGES_BREAKDOWN = 50; // small, non-paginated breakdown - defensively capped, not a full pagination surface per the task brief
export async function getEventPages(db, siteId, eventName, range) {
    const pageViewRows = alias(sessionEvents, "event_explorer_page_view");
    const where = and(eq(sessionEvents.siteId, siteId), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, eventName), ...dateRangeConditions(range));
    const rows = await db
        .select({ pagePath: pageViewRows.pagePath, occurrences: sql `count(*)` })
        .from(sessionEvents)
        .leftJoin(pageViewRows, and(eq(pageViewRows.siteId, sessionEvents.siteId), eq(pageViewRows.pageViewId, sessionEvents.pageViewId), eq(pageViewRows.type, "page_view")))
        .where(where)
        .groupBy(pageViewRows.pagePath)
        .orderBy(desc(sql `count(*)`))
        .limit(MAX_PAGES_BREAKDOWN);
    return rows.map((r) => ({ pagePath: r.pagePath, occurrences: r.occurrences }));
}
/** Patterns whose steps reference this event name via a "custom" verb step (see patterns/matcher.ts). Small per-site pattern count, so a single fetch-and-filter in JS is simpler and just as fast as trying to query into the JSON steps column. */
export async function getEventPatternReferences(db, siteId, eventName) {
    const rows = await db
        .select({ id: patterns.id, name: patterns.name, steps: patterns.steps })
        .from(patterns)
        .where(eq(patterns.siteId, siteId));
    return rows
        .filter((r) => r.steps.some((s) => s.verb === "custom" && s.eventName === eventName))
        .map((r) => ({ id: r.id, name: r.name }));
}
//# sourceMappingURL=eventQueries.js.map