import { z } from "zod";
import { eq } from "drizzle-orm";
import { sites, sessionEvents } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { extractSessionFeatures, toVector, NUMERIC_FEATURE_KEYS } from "../lib/analysis/features.js";
import { standardize, kmeans } from "../lib/analysis/kmeans.js";
import { findSimilarSessions } from "../lib/analysis/sequenceSimilarity.js";
async function loadSiteInOrg(db, siteId, orgId) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site || site.orgId !== orgId)
        return null;
    return site;
}
/** Groups a flat event-log query result back into per-session ordered event lists. */
function groupBySession(rows) {
    const bySession = new Map();
    for (const row of rows) {
        const list = bySession.get(row.sessionId) ?? [];
        list.push({
            type: row.type,
            timestamp: row.timestamp.getTime(),
            element: row.selector ? { selector: row.selector } : undefined,
            durationMs: row.durationMs ?? undefined,
            scrollPercent: row.scrollPercent ?? undefined,
        });
        bySession.set(row.sessionId, list);
    }
    return bySession;
}
const clusterRequestSchema = z.object({
    k: z.number().int().min(2).max(20).default(4),
    goal: z.object({ type: z.enum(["page_view", "hover", "click", "scroll"]), selector: z.string().optional() }).optional(),
    minSessions: z.number().int().positive().max(10000).default(2),
});
const similarSessionsRequestSchema = z.object({
    referenceTokens: z.array(z.string()).min(1).max(50),
    threshold: z.number().min(0).max(1).default(0.6),
});
export function registerAnalysisRoutes(app, db) {
    /**
     * Clusters this site's sessions by aggregate behavioral shape (not
     * exact step sequence - see extractSessionFeatures) and reports the
     * conversion rate per cluster. This is the "discover archetypes
     * without predefining a pattern" capability: nothing here requires a
     * pattern to have been authored first.
     */
    app.post("/orgs/:orgId/sites/:siteId/analysis/cluster", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const parsed = clusterRequestSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        }
        const { k, goal, minSessions } = parsed.data;
        const rows = await db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id));
        const bySession = groupBySession(rows);
        if (bySession.size < minSessions) {
            return reply.code(200).send({
                totalSessions: bySession.size,
                clusters: [],
                note: `not enough sessions to cluster (have ${bySession.size}, need at least ${minSessions})`,
            });
        }
        const features = [...bySession.entries()].map(([sessionId, events]) => extractSessionFeatures(sessionId, events, goal));
        const vectors = features.map(toVector);
        const { standardized } = standardize(vectors);
        const result = kmeans(standardized, k, { seed: 42 });
        const clusters = Array.from({ length: result.centroids.length }, (_, clusterIndex) => {
            const memberIndices = result.assignments
                .map((c, i) => (c === clusterIndex ? i : -1))
                .filter((i) => i !== -1);
            const members = memberIndices.map((i) => features[i]);
            const conversionRate = members.length > 0 ? members.filter((m) => m.converted).length / members.length : 0;
            const avg = (key) => members.length > 0 ? members.reduce((s, m) => s + m[key], 0) / members.length : 0;
            return {
                clusterId: clusterIndex,
                sessionCount: members.length,
                conversionRate,
                averages: Object.fromEntries(NUMERIC_FEATURE_KEYS.map((key) => [key, avg(key)])),
                sampleSessionIds: members.slice(0, 5).map((m) => m.sessionId),
            };
        }).sort((a, b) => b.conversionRate - a.conversionRate);
        return reply.send({ totalSessions: features.length, clusters });
    });
    /**
     * Fuzzy sequence matching: scores every session against a reference
     * action-token sequence by edit distance, regardless of exact step
     * count. This is the direct answer to "a customer can do the same
     * exact thing with more or fewer steps" - the strict FSM pattern
     * matcher intentionally does not handle that; this endpoint does.
     */
    app.post("/orgs/:orgId/sites/:siteId/analysis/similar-sessions", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const parsed = similarSessionsRequestSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        }
        const rows = await db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id));
        const bySession = groupBySession(rows);
        const sessions = [...bySession.entries()].map(([sessionId, events]) => ({
            sessionId,
            actionTokens: extractSessionFeatures(sessionId, events).actionTokens,
        }));
        const matches = findSimilarSessions(sessions, parsed.data.referenceTokens, parsed.data.threshold);
        return reply.send({ matches: matches.slice(0, 100) });
    });
}
//# sourceMappingURL=analysis.js.map