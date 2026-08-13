import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { organizations, memberships, sites, users, auditLogs } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { generateSitePublicId } from "../lib/ids.js";

const createSiteSchema = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().max(300).optional(),
});

const addMemberSchema = z.object({
  email: z.string().email(),
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

export function registerOrgRoutes(app: FastifyInstance, db: Db) {
  app.get("/orgs", { preHandler: authenticate }, async (request, reply) => {
    const rows = await db
      .select({ orgId: organizations.id, name: organizations.name, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.orgId, organizations.id))
      .where(eq(memberships.userId, request.user!.id));
    return reply.send({ organizations: rows });
  });

  app.get(
    "/orgs/:orgId/members",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const rows = await db
        .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.orgId, request.membership!.orgId));
      return reply.send({ members: rows });
    }
  );

  app.post(
    "/orgs/:orgId/members",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const parsed = addMemberSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      const { email, role } = parsed.data;
      const orgId = request.membership!.orgId;

      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (!user) {
        // No invite-by-email-to-unregistered-user flow yet - that's a
        // reasonable v2 (send an email, create a pending invite row).
        return reply.code(404).send({ error: "user_not_found_must_have_account" });
      }

      const [existing] = await db
        .select()
        .from(memberships)
        .where(eq(memberships.userId, user.id))
        .limit(1);
      if (existing && existing.orgId === orgId) {
        return reply.code(409).send({ error: "already_a_member" });
      }

      await db.insert(memberships).values({ userId: user.id, orgId, role });
      await db.insert(auditLogs).values({
        orgId,
        userId: request.user!.id,
        action: "member.added",
        detail: { targetUserId: user.id, role },
      });

      return reply.code(201).send({ userId: user.id, email: user.email, role });
    }
  );

  app.get(
    "/orgs/:orgId/sites",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const rows = await db.select().from(sites).where(eq(sites.orgId, request.membership!.orgId));
      return reply.send({
        sites: rows.map((s) => ({
          id: s.id,
          siteId: s.publicId,
          name: s.name,
          domain: s.domain,
          publicConfig: s.publicConfig,
        })),
      });
    }
  );

  app.post(
    "/orgs/:orgId/sites",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const parsed = createSiteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      const orgId = request.membership!.orgId;
      const publicId = generateSitePublicId();

      const [site] = await db
        .insert(sites)
        .values({ orgId, publicId, name: parsed.data.name, domain: parsed.data.domain, publicConfig: {} })
        .returning();

      await db.insert(auditLogs).values({
        orgId,
        userId: request.user!.id,
        action: "site.created",
        detail: { siteId: site.publicId },
      });

      return reply.code(201).send({ id: site.id, siteId: site.publicId, name: site.name, domain: site.domain });
    }
  );

  // The write side of Site.publicConfig - the ONLY way this JSON blob
  // gets mutated. Deliberately parsed through publicConfigSchema (an
  // allowlist) rather than accepting an arbitrary object, since this
  // exact JSON is what re-serves unauthenticated on GET /public/config.
  app.patch(
    "/orgs/:orgId/sites/:siteId/config",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const parsed = publicConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      const { siteId } = request.params as { siteId: string };
      const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
      if (!site || site.orgId !== request.membership!.orgId) {
        return reply.code(404).send({ error: "site_not_found" });
      }

      const merged = { ...(site.publicConfig as object), ...parsed.data };
      await db.update(sites).set({ publicConfig: merged, updatedAt: new Date() }).where(eq(sites.id, site.id));

      return reply.send({ siteId: site.publicId, publicConfig: merged });
    }
  );
}
