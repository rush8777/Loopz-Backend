import { z } from "zod";
import { eq } from "drizzle-orm";
import { sites } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { listAnonymousVisitors, resolveAnonymousIdentityState } from "../lib/identity/anonymousVisitors.js";
import { computeProfileStats, listActivity, listSessionsForTrackedUser } from "../lib/identity/profile.js";
import { getLatestEnvironmentContext, getEnvironmentContextsForSessions } from "../lib/identity/environmentContext.js";
async function loadSiteInOrg(db, siteId, orgId) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site || site.orgId !== orgId)
        return null;
    return site;
}
const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    search: z.string().min(1).max(200).optional(),
});
/**
 * Anonymous visitors - the "Anonymous" side of the Users area (task
 * brief section 7/20). Deliberately a sibling route tree to
 * tracked-users.ts rather than folded into it: an anonymousId and a
 * trackedUserId are different kinds of identifiers (the SDK's durable
 * anon id vs. the internal id for a resolved tracked_users row), and
 * keeping them as separate URL spaces avoids ever confusing the two
 * client-side. Both sides call into the same read model
 * (lib/identity/profile.ts) for stats/activity/sessions - see section
 * 10's instruction not to build a second activity pipeline.
 */
export function registerAnonymousUserRoutes(app, db) {
    /** Unclaimed anonymousIds only - once identify() claims one it moves to the identified Users list instead (section 17). */
    app.get("/orgs/:orgId/sites/:siteId/anonymous-users", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const parsed = listQuerySchema.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
        }
        const { limit, offset, search } = parsed.data;
        const { visitors, total } = await listAnonymousVisitors(db, site.id, { limit, offset, search });
        return reply.send({
            visitors: visitors.map((v) => ({ ...v, identityType: "anonymous", isAnonymous: true })),
            total,
            limit,
            offset,
        });
    });
    /**
     * Detail for one anonymousId. If it's since been claimed by
     * identify(), this returns a `resolved` pointer instead of profile
     * data - the caller (frontend) should follow it to the identified
     * user's profile rather than render this as a standalone identity.
     */
    app.get("/orgs/:orgId/sites/:siteId/anonymous-users/:anonymousId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, anonymousId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const state = await resolveAnonymousIdentityState(db, site.id, anonymousId);
        if (!state.exists)
            return reply.code(404).send({ error: "anonymous_visitor_not_found" });
        if (state.resolved) {
            return reply.send({
                identityType: "identified",
                isAnonymous: false,
                anonymousId,
                resolvedTo: state.resolved,
            });
        }
        const stats = await computeProfileStats(db, site.id, [anonymousId]);
        const environment = await getLatestEnvironmentContext(db, site.id, [anonymousId]);
        return reply.send({
            identityType: "anonymous",
            isAnonymous: true,
            anonymousId,
            userId: null,
            properties: {}, // anonymous visitors never have identify()-sourced properties, by definition
            stats: {
                firstSeenAt: stats.firstSeenAt?.toISOString() ?? null,
                lastSeenAt: stats.lastSeenAt?.toISOString() ?? null,
                sessionCount: stats.sessionCount,
                pageViewCount: stats.pageViewCount,
                eventCount: stats.eventCount,
                totalActiveTimeMs: stats.totalActiveTimeMs,
                firstPage: stats.firstPage,
                lastPage: stats.lastPage,
            },
            environment: environment
                ? {
                    browserName: environment.browserName,
                    browserVersion: environment.browserVersion,
                    osName: environment.osName,
                    osVersion: environment.osVersion,
                    deviceType: environment.deviceType,
                    language: environment.language,
                    timezone: environment.timezone,
                    screenWidth: environment.screenWidth,
                    screenHeight: environment.screenHeight,
                    referrer: environment.referrer,
                }
                : null,
        });
    });
    /** Same activity feed the identified profile uses, scoped to this one anonymousId - still queryable even after resolution (section 17/18: raw history is never deleted or double-counted). */
    app.get("/orgs/:orgId/sites/:siteId/anonymous-users/:anonymousId/activity", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, anonymousId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const state = await resolveAnonymousIdentityState(db, site.id, anonymousId);
        if (!state.exists)
            return reply.code(404).send({ error: "anonymous_visitor_not_found" });
        const parsed = listQuerySchema.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
        }
        const { limit, offset } = parsed.data;
        const { activities, total } = await listActivity(db, site.id, [anonymousId], { limit, offset });
        return reply.send({ activities, total, limit, offset });
    });
    app.get("/orgs/:orgId/sites/:siteId/anonymous-users/:anonymousId/sessions", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, anonymousId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const state = await resolveAnonymousIdentityState(db, site.id, anonymousId);
        if (!state.exists)
            return reply.code(404).send({ error: "anonymous_visitor_not_found" });
        const parsed = listQuerySchema.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
        }
        const { limit, offset } = parsed.data;
        const { sessions, total } = await listSessionsForTrackedUser(db, site.id, [anonymousId], { limit, offset });
        const contexts = await getEnvironmentContextsForSessions(db, site.id, sessions.map((s) => s.sessionId));
        const sessionsWithDevice = sessions.map((s) => {
            const ctx = contexts.get(s.sessionId);
            return {
                ...s,
                deviceType: ctx?.deviceType ?? null,
                browserName: ctx?.browserName ?? null,
                osName: ctx?.osName ?? null,
            };
        });
        return reply.send({ sessions: sessionsWithDevice, total, limit, offset });
    });
}
//# sourceMappingURL=anonymous-users.js.map