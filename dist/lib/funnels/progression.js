import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { sessionEvents } from "../../db/schema.js";
import { canonicalIdentityExpr } from "../analytics/identity.js";
import { resolveMatchedPagePaths } from "../pages/resolveMatchedPagePaths.js";
const identityExpr = canonicalIdentityExpr;
const MAX_ROWS_PER_STEP = 50_000;
async function fetchStepTimestamps(db, siteId, step, since, until) {
    const result = new Map();
    const baseConditions = [eq(sessionEvents.siteId, siteId), gte(sessionEvents.timestamp, since), lte(sessionEvents.timestamp, until)];
    if (step.type === "event") {
        baseConditions.push(eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, step.eventName));
    }
    else {
        const matchedPaths = await resolveMatchedPagePaths(db, siteId, step.pageId);
        if (!matchedPaths || matchedPaths.length === 0)
            return result;
        baseConditions.push(eq(sessionEvents.type, "page_view"), inArray(sessionEvents.pagePath, matchedPaths));
    }
    const rows = await db.select({ identity: identityExpr, timestamp: sessionEvents.timestamp }).from(sessionEvents).where(and(...baseConditions)).orderBy(sessionEvents.timestamp).limit(MAX_ROWS_PER_STEP);
    for (const row of rows) {
        if (!row.identity)
            continue;
        const timestamps = result.get(row.identity);
        if (timestamps)
            timestamps.push(row.timestamp.getTime());
        else
            result.set(row.identity, [row.timestamp.getTime()]);
    }
    return result;
}
/** The shared ordered-funnel matcher. Both Funnel analysis and Segment funnel
 * cohorts call this exact implementation so their membership semantics cannot
 * drift. */
export async function computeFunnelProgression(db, siteId, steps, range, windowMinutes, allowedIdentities) {
    if (steps.length === 0)
        return [];
    const windowMs = windowMinutes * 60 * 1000;
    const firstStepMap = await fetchStepTimestamps(db, siteId, steps[0], range.since, range.until);
    const laterStepMaps = await Promise.all(steps.slice(1).map((step) => fetchStepTimestamps(db, siteId, step, range.since, new Date(range.until.getTime() + windowMs))));
    const results = [];
    for (const [identity, timestamps] of firstStepMap) {
        if (allowedIdentities && !allowedIdentities.has(identity))
            continue;
        const anchor = timestamps[0];
        const stepTimestamps = [anchor];
        let cursor = anchor;
        let broken = false;
        for (const stepMap of laterStepMaps) {
            if (broken) {
                stepTimestamps.push(null);
                continue;
            }
            const next = stepMap.get(identity)?.find((timestamp) => timestamp > cursor && timestamp <= anchor + windowMs);
            if (next === undefined) {
                broken = true;
                stepTimestamps.push(null);
            }
            else {
                stepTimestamps.push(next);
                cursor = next;
            }
        }
        results.push({ identity, stepTimestamps });
    }
    return results;
}
//# sourceMappingURL=progression.js.map