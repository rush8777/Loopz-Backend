import { z } from "zod";
import { and, eq, max, sql } from "drizzle-orm";
import { organizations, memberships, sites, users, auditLogs, sessionEvents } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { generateSitePublicId } from "../lib/ids.js";
const domainSchema = z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((value) => {
    try {
        const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
        return (url.protocol === "http:" || url.protocol === "https:") && url.pathname === "/" && !url.search && !url.hash;
    }
    catch {
        return false;
    }
}, "domain must be an http(s) origin, without a path");
const createSiteSchema = z.object({
    name: z.string().trim().min(1).max(200),
    domain: domainSchema.optional(),
});
const updateSiteSchema = z
    .object({
    name: z.string().trim().min(1).max(200).optional(),
    domain: domainSchema.nullable().optional(),
})
    .refine((value) => value.name !== undefined || value.domain !== undefined, "at least one field is required");
const updateOrganizationSchema = z.object({ name: z.string().trim().min(1).max(200) });
const updateMemberSchema = z.object({ role: z.enum(["ADMIN", "MEMBER", "VIEWER"]) });
const addMemberSchema = z.object({
    email: z.string().trim().email(),
    role: z.enum(["ADMIN", "MEMBER", "VIEWER"]), // adding another OWNER goes through a separate, deliberately harder-to-reach flow
});
// Publishable, non-sensitive subset of Site config that ships to the
// SDK via the public config endpoint. Deliberately a small explicit
// allowlist - never spread an entire DB row into a public response.
const publicConfigSchema = z.object({
    sessionReplay: z
        .object({
        enabled: z.boolean().optional(),
    })
        .partial()
        .optional(),
});
export function registerOrgRoutes(app, db) {
    app.get("/orgs", { preHandler: authenticate }, async (request, reply) => {
        const rows = await db
            .select({ orgId: organizations.id, name: organizations.name, role: memberships.role })
            .from(memberships)
            .innerJoin(organizations, eq(memberships.orgId, organizations.id))
            .where(eq(memberships.userId, request.user.id));
        return reply.send({ organizations: rows });
    });
    app.patch("/orgs/:orgId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const parsed = updateOrganizationSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const orgId = request.membership.orgId;
        const [organization] = await db
            .update(organizations)
            .set({ name: parsed.data.name, updatedAt: new Date() })
            .where(eq(organizations.id, orgId))
            .returning();
        if (!organization)
            return reply.code(404).send({ error: "org_not_found" });
        await db.insert(auditLogs).values({
            orgId,
            userId: request.user.id,
            action: "organization.updated",
            detail: { name: organization.name },
        });
        return reply.send({ orgId: organization.id, name: organization.name, role: request.membership.role });
    });
    app.get("/orgs/:orgId/members", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const rows = await db
            .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role, joinedAt: memberships.createdAt })
            .from(memberships)
            .innerJoin(users, eq(memberships.userId, users.id))
            .where(eq(memberships.orgId, request.membership.orgId));
        return reply.send({ members: rows });
    });
    app.post("/orgs/:orgId/members", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const parsed = addMemberSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        }
        const email = parsed.data.email.trim().toLowerCase();
        const { role } = parsed.data;
        const orgId = request.membership.orgId;
        const [user] = await db.select().from(users).where(sql `lower(${users.email}) = ${email}`).limit(1);
        if (!user) {
            // No invite-by-email-to-unregistered-user flow yet - that's a
            // reasonable v2 (send an email, create a pending invite row).
            return reply.code(404).send({ error: "user_not_found_must_have_account" });
        }
        const [existing] = await db
            .select()
            .from(memberships)
            .where(and(eq(memberships.userId, user.id), eq(memberships.orgId, orgId)))
            .limit(1);
        if (existing) {
            return reply.code(409).send({ error: "already_a_member" });
        }
        await db.insert(memberships).values({ userId: user.id, orgId, role });
        await db.insert(auditLogs).values({
            orgId,
            userId: request.user.id,
            action: "member.added",
            detail: { targetUserId: user.id, role },
        });
        return reply.code(201).send({ userId: user.id, email: user.email, role });
    });
    app.patch("/orgs/:orgId/members/:userId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const parsed = updateMemberSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const { userId } = request.params;
        const orgId = request.membership.orgId;
        const [membership] = await db
            .select()
            .from(memberships)
            .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
            .limit(1);
        if (!membership)
            return reply.code(404).send({ error: "member_not_found" });
        if (membership.role === "OWNER")
            return reply.code(409).send({ error: "owner_membership_locked" });
        if (userId === request.user.id)
            return reply.code(409).send({ error: "cannot_modify_self" });
        const [updated] = await db
            .update(memberships)
            .set({ role: parsed.data.role })
            .where(eq(memberships.id, membership.id))
            .returning();
        await db.insert(auditLogs).values({
            orgId,
            userId: request.user.id,
            action: "member.role_updated",
            detail: { targetUserId: userId, previousRole: membership.role, role: updated.role },
        });
        return reply.send({ userId, role: updated.role });
    });
    app.delete("/orgs/:orgId/members/:userId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { userId } = request.params;
        const orgId = request.membership.orgId;
        const [membership] = await db
            .select()
            .from(memberships)
            .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
            .limit(1);
        if (!membership)
            return reply.code(404).send({ error: "member_not_found" });
        if (membership.role === "OWNER")
            return reply.code(409).send({ error: "owner_membership_locked" });
        if (userId === request.user.id)
            return reply.code(409).send({ error: "cannot_remove_self" });
        await db.delete(memberships).where(eq(memberships.id, membership.id));
        await db.insert(auditLogs).values({
            orgId,
            userId: request.user.id,
            action: "member.removed",
            detail: { targetUserId: userId, role: membership.role },
        });
        return reply.code(204).send();
    });
    app.get("/orgs/:orgId/sites", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const rows = await db.select().from(sites).where(eq(sites.orgId, request.membership.orgId));
        return reply.send({
            sites: rows.map((s) => ({
                id: s.id,
                siteId: s.publicId,
                name: s.name,
                domain: s.domain,
                publicConfig: s.publicConfig,
            })),
        });
    });
    app.post("/orgs/:orgId/sites", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const parsed = createSiteSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        }
        const orgId = request.membership.orgId;
        const publicId = generateSitePublicId();
        const [site] = await db
            .insert(sites)
            .values({ orgId, publicId, name: parsed.data.name, domain: parsed.data.domain, publicConfig: {} })
            .returning();
        await db.insert(auditLogs).values({
            orgId,
            userId: request.user.id,
            action: "site.created",
            detail: { siteId: site.publicId },
        });
        return reply.code(201).send({ id: site.id, siteId: site.publicId, name: site.name, domain: site.domain });
    });
    /** Site origin is a tenant setting, used to validate visual-builder URLs. */
    app.patch("/orgs/:orgId/sites/:siteId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const parsed = updateSiteSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const { siteId } = request.params;
        const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
        if (!site || site.orgId !== request.membership.orgId)
            return reply.code(404).send({ error: "site_not_found" });
        const updates = {
            ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
            ...(parsed.data.domain !== undefined ? { domain: parsed.data.domain } : {}),
            updatedAt: new Date(),
        };
        const [updated] = await db
            .update(sites)
            .set(updates)
            .where(eq(sites.id, site.id))
            .returning();
        await db.insert(auditLogs).values({
            orgId: site.orgId,
            userId: request.user.id,
            action: "site.updated",
            detail: { siteId: site.publicId, name: updated.name, domain: updated.domain },
        });
        return reply.send({ id: updated.id, siteId: updated.publicId, name: updated.name, domain: updated.domain });
    });
    app.get("/orgs/:orgId/sites/:siteId/status", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId } = request.params;
        const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
        if (!site || site.orgId !== request.membership.orgId)
            return reply.code(404).send({ error: "site_not_found" });
        const [eventStatus] = await db
            .select({ lastEventAt: max(sessionEvents.timestamp) })
            .from(sessionEvents)
            .where(eq(sessionEvents.siteId, site.id));
        return reply.send({
            hasReceivedEvents: Boolean(eventStatus?.lastEventAt),
            lastEventAt: eventStatus?.lastEventAt ?? null,
            siteId: site.publicId,
            domain: site.domain,
        });
    });
    // The write side of Site.publicConfig - the ONLY way this JSON blob
    // gets mutated. Deliberately parsed through publicConfigSchema (an
    // allowlist) rather than accepting an arbitrary object, since this
    // exact JSON is what re-serves unauthenticated on GET /public/config.
    app.patch("/orgs/:orgId/sites/:siteId/config", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const parsed = publicConfigSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        }
        const { siteId } = request.params;
        const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
        if (!site || site.orgId !== request.membership.orgId) {
            return reply.code(404).send({ error: "site_not_found" });
        }
        const merged = { ...site.publicConfig, ...parsed.data };
        await db.update(sites).set({ publicConfig: merged, updatedAt: new Date() }).where(eq(sites.id, site.id));
        return reply.send({ siteId: site.publicId, publicConfig: merged });
    });
}
//# sourceMappingURL=orgs.js.map