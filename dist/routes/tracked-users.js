import { z } from "zod";
import { eq, and, or, like, sql, desc, inArray } from "drizzle-orm";
import { sites, trackedUsers, trackedUserProperties, trackedUserAliases, sessionEvents } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { getAliasAnonymousIds, computeProfileStats, listActivity, listSessionsForTrackedUser } from "../lib/identity/profile.js";
import { getLatestEnvironmentContext, getEnvironmentContextsForSessions } from "../lib/identity/environmentContext.js";
async function loadSiteInOrg(db, siteId, orgId) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site || site.orgId !== orgId)
        return null;
    return site;
}
async function loadTrackedUserInSite(db, siteId, userId) {
    const [user] = await db
        .select()
        .from(trackedUsers)
        .where(and(eq(trackedUsers.id, userId), eq(trackedUsers.siteId, siteId)))
        .limit(1);
    return user ?? null;
}
async function propertiesFor(db, trackedUserId) {
    const rows = await db
        .select()
        .from(trackedUserProperties)
        .where(eq(trackedUserProperties.trackedUserId, trackedUserId));
    return rows.map((p) => ({
        name: p.name,
        value: deserializeValue(p.value, p.valueType),
        valueType: p.valueType,
        source: p.source,
        firstSeenAt: p.firstSeenAt.toISOString(),
        lastSeenAt: p.lastSeenAt.toISOString(),
    }));
}
function deserializeValue(value, valueType) {
    switch (valueType) {
        case "number":
            return Number(value);
        case "boolean":
            return value === "true";
        case "null":
            return null;
        case "object":
            try {
                return JSON.parse(value);
            }
            catch {
                return value;
            }
        default:
            return value;
    }
}
const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    search: z.string().min(1).max(200).optional(),
});
export function registerTrackedUserRoutes(app, db) {
    /**
     * Users list for the dashboard's Users page. Search matches either
     * the customer's own external user id or any property value (name,
     * email, etc) - deliberately simple substring matching for MVP, per
     * task brief section 12 ("do not implement an unnecessarily complex
     * search engine").
     */
    app.get("/orgs/:orgId/sites/:siteId/users", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const parsed = listQuerySchema.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
        }
        const { limit, offset, search } = parsed.data;
        let matchingIds = null;
        if (search) {
            const term = `%${search}%`;
            const matches = await db
                .select({ id: trackedUsers.id })
                .from(trackedUsers)
                .leftJoin(trackedUserProperties, eq(trackedUserProperties.trackedUserId, trackedUsers.id))
                .where(and(eq(trackedUsers.siteId, site.id), or(like(trackedUsers.externalUserId, term), like(trackedUserProperties.value, term))));
            matchingIds = [...new Set(matches.map((m) => m.id))];
            if (matchingIds.length === 0) {
                return reply.send({ users: [], total: 0, limit, offset });
            }
        }
        const where = matchingIds
            ? and(eq(trackedUsers.siteId, site.id), inArray(trackedUsers.id, matchingIds))
            : eq(trackedUsers.siteId, site.id);
        const [{ total }] = await db.select({ total: sql `count(*)` }).from(trackedUsers).where(where);
        const rows = await db
            .select()
            .from(trackedUsers)
            .where(where)
            .orderBy(desc(trackedUsers.lastSeenAt))
            .limit(limit)
            .offset(offset);
        // Session counts for this page of users, computed in one grouped
        // query rather than one round trip per row.
        const userIds = rows.map((r) => r.id);
        const sessionCounts = new Map();
        if (userIds.length > 0) {
            const counts = await db
                .select({
                trackedUserId: trackedUserAliases.trackedUserId,
                sessionCount: sql `count(distinct ${sessionEvents.sessionId})`,
            })
                .from(trackedUserAliases)
                .innerJoin(sessionEvents, and(eq(sessionEvents.anonymousId, trackedUserAliases.anonymousId), eq(sessionEvents.siteId, site.id)))
                .where(and(eq(trackedUserAliases.siteId, site.id), inArray(trackedUserAliases.trackedUserId, userIds)))
                .groupBy(trackedUserAliases.trackedUserId);
            for (const c of counts)
                sessionCounts.set(c.trackedUserId, c.sessionCount);
        }
        const propsByUser = new Map();
        for (const row of rows) {
            propsByUser.set(row.id, await propertiesFor(db, row.id));
        }
        // anonymousIds per user, for the same task-brief-22 response shape as the detail endpoint below.
        const aliasesByUser = new Map();
        if (userIds.length > 0) {
            const aliasRows = await db
                .select({ trackedUserId: trackedUserAliases.trackedUserId, anonymousId: trackedUserAliases.anonymousId })
                .from(trackedUserAliases)
                .where(and(eq(trackedUserAliases.siteId, site.id), inArray(trackedUserAliases.trackedUserId, userIds)));
            for (const a of aliasRows) {
                const list = aliasesByUser.get(a.trackedUserId) ?? [];
                list.push(a.anonymousId);
                aliasesByUser.set(a.trackedUserId, list);
            }
        }
        return reply.send({
            users: rows.map((r) => ({
                id: r.id,
                identityType: "identified",
                isAnonymous: false,
                externalUserId: r.externalUserId,
                anonymousIds: aliasesByUser.get(r.id) ?? [],
                firstSeenAt: r.firstSeenAt.toISOString(),
                lastSeenAt: r.lastSeenAt.toISOString(),
                sessionCount: sessionCounts.get(r.id) ?? 0,
                properties: Object.fromEntries((propsByUser.get(r.id) ?? []).map((p) => [p.name, p.value])),
            })),
            total,
            limit,
            offset,
        });
    });
    /** Identity + properties + automatic stats for one tracked user - the Overview tab. */
    app.get("/orgs/:orgId/sites/:siteId/users/:userId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, userId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const user = await loadTrackedUserInSite(db, site.id, userId);
        if (!user)
            return reply.code(404).send({ error: "user_not_found" });
        const anonymousIds = await getAliasAnonymousIds(db, site.id, user.id);
        const stats = await computeProfileStats(db, site.id, anonymousIds);
        const properties = await propertiesFor(db, user.id);
        const environment = await getLatestEnvironmentContext(db, site.id, anonymousIds);
        return reply.send({
            id: user.id,
            identityType: "identified",
            isAnonymous: false,
            externalUserId: user.externalUserId,
            anonymousIds,
            firstSeenAt: user.firstSeenAt.toISOString(),
            lastSeenAt: user.lastSeenAt.toISOString(),
            firstIdentifiedAt: user.firstIdentifiedAt.toISOString(),
            lastIdentifiedAt: user.lastIdentifiedAt.toISOString(),
            properties,
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
    /** Properties only - dynamic, whatever identify() has sent for this user (task brief section 14). */
    app.get("/orgs/:orgId/sites/:siteId/users/:userId/properties", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, userId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const user = await loadTrackedUserInSite(db, site.id, userId);
        if (!user)
            return reply.code(404).send({ error: "user_not_found" });
        return reply.send({ properties: await propertiesFor(db, user.id) });
    });
    /** Chronological activity timeline - paginated, most-recent first. */
    app.get("/orgs/:orgId/sites/:siteId/users/:userId/activity", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, userId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const user = await loadTrackedUserInSite(db, site.id, userId);
        if (!user)
            return reply.code(404).send({ error: "user_not_found" });
        const parsed = listQuerySchema.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
        }
        const { limit, offset } = parsed.data;
        const anonymousIds = await getAliasAnonymousIds(db, site.id, user.id);
        const { activities, total } = await listActivity(db, site.id, anonymousIds, { limit, offset });
        return reply.send({ activities, total, limit, offset });
    });
    /** Sessions belonging to this tracked user, resolved via anonymousId aliases - anonymous activity before identification included. */
    app.get("/orgs/:orgId/sites/:siteId/users/:userId/sessions", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, userId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const user = await loadTrackedUserInSite(db, site.id, userId);
        if (!user)
            return reply.code(404).send({ error: "user_not_found" });
        const parsed = listQuerySchema.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
        }
        const { limit, offset } = parsed.data;
        const anonymousIds = await getAliasAnonymousIds(db, site.id, user.id);
        const { sessions, total } = await listSessionsForTrackedUser(db, site.id, anonymousIds, { limit, offset });
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
//# sourceMappingURL=tracked-users.js.map