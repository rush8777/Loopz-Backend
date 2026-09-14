import { and, eq } from "drizzle-orm";
import { sites } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { analyticsCatalog } from "../lib/analytics/catalog.js";
import { AnalyticsError, executeAnalyticsQuery, executeDrilldown } from "../lib/analytics/queryService.js";
import { analyticsBatchSchema, analyticsQuerySchema, drilldownSchema } from "../lib/analytics/validation.js";
async function resolveSite(db, siteId, orgId) { const [site] = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1); return site; }
function failure(reply, error) { if (error instanceof AnalyticsError)
    return reply.code(error.status).send({ error: error.code, message: error.message }); throw error; }
export function registerAnalyticsRoutes(app, db) {
    const preHandler = [authenticate, requireOrgRole(db, "VIEWER")];
    app.get("/orgs/:orgId/sites/:siteId/analytics/catalog", { preHandler }, async (request, reply) => { const { siteId } = request.params; if (!(await resolveSite(db, siteId, request.membership.orgId)))
        return reply.code(404).send({ error: "site_not_found" }); return analyticsCatalog(); });
    app.post("/orgs/:orgId/sites/:siteId/analytics/query", { preHandler }, async (request, reply) => { const { siteId } = request.params; if (!(await resolveSite(db, siteId, request.membership.orgId)))
        return reply.code(404).send({ error: "site_not_found" }); const parsed = analyticsQuerySchema.safeParse(request.body); if (!parsed.success)
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() }); try {
        return await executeAnalyticsQuery(db, siteId, parsed.data.filters, parsed.data.query);
    }
    catch (error) {
        return failure(reply, error);
    } });
    app.post("/orgs/:orgId/sites/:siteId/analytics/query/batch", { preHandler }, async (request, reply) => { const { siteId } = request.params; if (!(await resolveSite(db, siteId, request.membership.orgId)))
        return reply.code(404).send({ error: "site_not_found" }); const parsed = analyticsBatchSchema.safeParse(request.body); if (!parsed.success)
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() }); const results = []; for (const item of parsed.data.queries) {
        try {
            results.push({ requestId: item.requestId, status: "ok", ...(await executeAnalyticsQuery(db, siteId, parsed.data.filters, item.query)) });
        }
        catch (error) {
            if (error instanceof AnalyticsError)
                results.push({ requestId: item.requestId, status: "error", error: error.code, message: error.message });
            else
                throw error;
        }
    } return { results }; });
    app.post("/orgs/:orgId/sites/:siteId/analytics/drilldown", { preHandler }, async (request, reply) => { const { siteId } = request.params; if (!(await resolveSite(db, siteId, request.membership.orgId)))
        return reply.code(404).send({ error: "site_not_found" }); const parsed = drilldownSchema.safeParse(request.body); if (!parsed.success)
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() }); try {
        return await executeDrilldown(db, siteId, parsed.data.filters, parsed.data.query, parsed.data.selection);
    }
    catch (error) {
        return failure(reply, error);
    } });
}
//# sourceMappingURL=analytics.js.map