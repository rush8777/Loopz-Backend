import { eq, and, desc, sql } from "drizzle-orm";
import { sites, patterns, patternMatches } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { createPatternSchema, updatePatternSchema } from "../lib/patterns/validation.js";
/** Loads a site and verifies it belongs to the authenticated org - the same 404-not-403 principle as everywhere else. */
async function loadSiteInOrg(db, siteId, orgId) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site || site.orgId !== orgId)
        return null;
    return site;
}
export function registerPatternRoutes(app, db) {
    app.post("/orgs/:orgId/sites/:siteId/patterns", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const parsed = createPatternSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        }
        // Step ids must be unique within a pattern - the matcher assumes this when reporting matchedSteps.
        const stepIds = parsed.data.steps.map((s) => s.id);
        if (new Set(stepIds).size !== stepIds.length) {
            return reply.code(400).send({ error: "duplicate_step_id" });
        }
        const [pattern] = await db
            .insert(patterns)
            .values({
            siteId: site.id,
            name: parsed.data.name,
            origin: "AUTHORED",
            status: "DRAFT", // patterns start paused-by-default, same "never live until explicitly enabled" principle as sessionReplay
            matchWindowMs: parsed.data.matchWindowMs,
            steps: parsed.data.steps,
            feedback: parsed.data.feedback,
        })
            .returning();
        return reply.code(201).send(serializePattern(pattern));
    });
    app.get("/orgs/:orgId/sites/:siteId/patterns", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const rows = await db.select().from(patterns).where(eq(patterns.siteId, site.id));
        const matchCountRows = await db
            .select({ patternId: patternMatches.patternId, count: sql `count(*)` })
            .from(patternMatches)
            .where(eq(patternMatches.siteId, site.id))
            .groupBy(patternMatches.patternId);
        const matchCounts = new Map(matchCountRows.map((r) => [r.patternId, r.count]));
        return reply.send({
            patterns: rows.map((row) => ({ ...serializePattern(row), matchCount: matchCounts.get(row.id) ?? 0 })),
        });
    });
    app.patch("/orgs/:orgId/sites/:siteId/patterns/:patternId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId, patternId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const [existing] = await db.select().from(patterns).where(eq(patterns.id, patternId)).limit(1);
        if (!existing || existing.siteId !== site.id)
            return reply.code(404).send({ error: "pattern_not_found" });
        const parsed = updatePatternSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        }
        if (parsed.data.steps) {
            const stepIds = parsed.data.steps.map((s) => s.id);
            if (new Set(stepIds).size !== stepIds.length) {
                return reply.code(400).send({ error: "duplicate_step_id" });
            }
        }
        const [updated] = await db
            .update(patterns)
            .set({ ...parsed.data, updatedAt: new Date() })
            .where(eq(patterns.id, patternId))
            .returning();
        return reply.send(serializePattern(updated));
    });
    app.delete("/orgs/:orgId/sites/:siteId/patterns/:patternId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId, patternId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const [existing] = await db.select().from(patterns).where(eq(patterns.id, patternId)).limit(1);
        if (!existing || existing.siteId !== site.id)
            return reply.code(404).send({ error: "pattern_not_found" });
        await db.delete(patterns).where(eq(patterns.id, patternId));
        return reply.code(204).send();
    });
    app.get("/orgs/:orgId/sites/:siteId/patterns/:patternId/matches", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, patternId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const rows = await db
            .select()
            .from(patternMatches)
            .where(and(eq(patternMatches.patternId, patternId), eq(patternMatches.siteId, site.id)))
            .orderBy(desc(patternMatches.matchedAt))
            .limit(200);
        return reply.send({
            matches: rows.map((m) => ({ sessionId: m.sessionId, matchedAt: m.matchedAt.toISOString() })),
        });
    });
}
function serializePattern(row) {
    return {
        id: row.id,
        siteId: row.siteId,
        name: row.name,
        origin: row.origin,
        status: row.status,
        matchWindowMs: row.matchWindowMs,
        steps: row.steps,
        feedback: row.feedback,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
//# sourceMappingURL=patterns.js.map