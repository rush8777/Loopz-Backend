import { and, eq, inArray } from "drizzle-orm";
import { pageDefinitions, segments as segmentsTable } from "../../db/schema.js";
import { evaluateSegment } from "../segments/evaluator.js";
import { hydrateIdentities } from "../identity/hydrate.js";
import { funnelStepLabel } from "./types.js";
import { canonicalIdentityExpr } from "../analytics/identity.js";
import { computeFunnelProgression } from "./progression.js";
/**
 * The Funnel Evaluation Engine (task brief section 20) -
 * `evaluateFunnel(db, siteId, steps, range, options)`. Route handlers
 * (routes/funnels.ts) are thin wrappers around this, same
 * "reusable service, not route logic" precedent as
 * lib/segments/evaluator.ts and lib/events/eventQueries.ts.
 *
 * Reuses rather than re-derives (task brief section 21):
 * - Identity resolution: the exact `identityExpr` coalesce over
 *   `tracked_user_aliases` used by Segments and the Event Explorer.
 * - Page steps: `resolveMatchedPagePaths`, imported directly from
 *   lib/segments/evaluator.ts, not reimplemented here.
 * - Segment filtering (task brief section 17): calls
 *   `evaluateSegment` from lib/segments/evaluator.ts as-is - this
 *   file never modifies or duplicates that evaluator.
 * - Result hydration (task brief section 18): `hydrateIdentities`,
 *   shared with Segments' member list, so both link back to the same
 *   existing User Profile / Anonymous Visitor pages.
 *
 * No `funnel_results` table (task brief section 22): every call
 * recomputes progression from current session_events data.
 */
const identityExpr = canonicalIdentityExpr;
// Defensive cap on rows pulled per step for in-memory sequence matching -
// keeps a single funnel evaluation bounded even for a very high-volume
// event. A real high-scale implementation would push the ordering/window
// logic into SQL (window functions); V1 keeps this in JS for clarity, and
// this cap is the honest acknowledgment of that tradeoff (see the
// "Performance" note in the final report).
export { computeFunnelProgression } from "./progression.js";
function round1(n) {
    return Math.round(n * 10) / 10;
}
export function summarizeFunnel(steps, stepLabels, progression) {
    const counts = steps.map((_, i) => progression.reduce((n, row) => n + (row.stepTimestamps[i] !== null ? 1 : 0), 0));
    const totalUsers = counts[0] ?? 0;
    const stepResults = steps.map((step, i) => {
        const users = counts[i];
        const previousUsers = i === 0 ? users : counts[i - 1];
        return {
            index: i,
            type: step.type,
            label: stepLabels[i],
            eventName: step.type === "event" ? step.eventName : undefined,
            pageId: step.type === "page" ? step.pageId : undefined,
            users,
            conversionFromStart: totalUsers === 0 ? 0 : round1((users / totalUsers) * 100),
            conversionFromPrevious: i === 0 ? 100 : previousUsers === 0 ? 0 : round1((users / previousUsers) * 100),
            droppedBeforeNext: i < steps.length - 1 ? Math.max(0, users - counts[i + 1]) : 0,
        };
    });
    const convertedUsers = counts[counts.length - 1] ?? 0;
    return {
        steps: stepResults,
        totalUsers,
        convertedUsers,
        overallConversion: totalUsers === 0 ? 0 : round1((convertedUsers / totalUsers) * 100),
    };
}
const MAX_TREND_DAYS = 120; // same defensive-cap spirit as eventQueries.ts's MAX_TIMESERIES_DAYS
function toUtcDay(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}
export function computeFunnelTrend(progression, range, stepCount) {
    const byDay = new Map();
    for (const row of progression) {
        const day = toUtcDay(row.stepTimestamps[0]);
        const bucket = byDay.get(day) ?? { started: 0, converted: 0 };
        bucket.started += 1;
        if (stepCount > 0 && row.stepTimestamps[stepCount - 1] !== null)
            bucket.converted += 1;
        byDay.set(day, bucket);
    }
    const points = [];
    const cursor = new Date(Date.UTC(range.since.getUTCFullYear(), range.since.getUTCMonth(), range.since.getUTCDate()));
    const end = new Date(Date.UTC(range.until.getUTCFullYear(), range.until.getUTCMonth(), range.until.getUTCDate()));
    for (let i = 0; cursor.getTime() <= end.getTime() && i < MAX_TREND_DAYS; i++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        const day = cursor.toISOString().slice(0, 10);
        const bucket = byDay.get(day);
        const started = bucket?.started ?? 0;
        const converted = bucket?.converted ?? 0;
        points.push({ date: day, startedUsers: started, convertedUsers: converted, conversion: started === 0 ? 0 : round1((converted / started) * 100) });
    }
    return points;
}
async function resolveStepLabels(db, siteId, steps) {
    const pageIds = steps.filter((s) => s.type === "page" && !s.label).map((s) => s.pageId);
    const pageNames = new Map();
    if (pageIds.length > 0) {
        const rows = await db
            .select({ id: pageDefinitions.id, name: pageDefinitions.name })
            .from(pageDefinitions)
            .where(and(eq(pageDefinitions.siteId, siteId), inArray(pageDefinitions.id, pageIds)));
        for (const r of rows)
            pageNames.set(r.id, r.name);
    }
    return steps.map((step) => {
        if (step.label)
            return step.label;
        if (step.type === "page")
            return pageNames.get(step.pageId) ?? funnelStepLabel(step);
        return funnelStepLabel(step);
    });
}
async function resolveAllowedIdentities(db, siteId, segmentId) {
    if (!segmentId)
        return undefined;
    const [row] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, segmentId)).limit(1);
    if (!row || row.siteId !== siteId)
        return new Set(); // dangling/cross-site segment reference - matches nobody rather than silently ignoring the filter
    return evaluateSegment(db, siteId, row.definition);
}
/** The single entry point for computing a funnel's conversion result over a date range - what routes/funnels.ts's analyze endpoint wraps. */
export async function evaluateFunnel(db, siteId, steps, range, windowMinutes, opts = {}) {
    if (steps.length === 0) {
        return { steps: [], totalUsers: 0, convertedUsers: 0, overallConversion: 0, trend: [] };
    }
    const [allowedIdentities, stepLabels] = await Promise.all([
        resolveAllowedIdentities(db, siteId, opts.segmentId),
        resolveStepLabels(db, siteId, steps),
    ]);
    const progression = await computeFunnelProgression(db, siteId, steps, range, windowMinutes, allowedIdentities);
    const summary = summarizeFunnel(steps, stepLabels, progression);
    const trend = computeFunnelTrend(progression, range, steps.length);
    return { ...summary, trend };
}
/** Paginated, hydrated user list for a single funnel step (task brief section 18) - links back to the existing User Profile / Anonymous Visitor pages via the same hydrateIdentities helper Segments uses. */
export async function getFunnelStepUsers(db, siteId, steps, range, windowMinutes, stepIndex, opts) {
    if (stepIndex < 0 || stepIndex >= steps.length)
        return { users: [], total: 0 };
    const allowedIdentities = await resolveAllowedIdentities(db, siteId, opts.segmentId);
    const progression = await computeFunnelProgression(db, siteId, steps, range, windowMinutes, allowedIdentities);
    const ids = progression.filter((row) => row.stepTimestamps[stepIndex] !== null).map((row) => row.identity);
    const total = ids.length;
    const page = ids.slice(opts.offset, opts.offset + opts.limit);
    const users = await hydrateIdentities(db, siteId, page);
    return { users, total };
}
//# sourceMappingURL=evaluator.js.map