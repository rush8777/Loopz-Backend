import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, like, desc, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sites, segments } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { createSegmentSchema, updateSegmentSchema, previewSegmentSchema } from "../lib/segments/validation.js";
import { getSegmentAudienceCount, getSegmentMembers } from "../lib/segments/evaluator.js";
import type { SegmentDefinition } from "../lib/segments/types.js";

/** Loads a site and verifies it belongs to the authenticated org - the same 404-not-403 principle used throughout (see pages.ts/tracked-users.ts). */
async function loadSiteInOrg(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site || site.orgId !== orgId) return null;
  return site;
}

async function loadSegmentInSite(db: Db, siteId: string, segmentId: string) {
  const [row] = await db.select().from(segments).where(eq(segments.id, segmentId)).limit(1);
  if (!row || row.siteId !== siteId) return null;
  return row;
}

function serializeSegment(row: typeof segments.$inferSelect, audienceCount: number) {
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    description: row.description,
    definition: row.definition as SegmentDefinition,
    audienceCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const listQuerySchema = z.object({
  search: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const membersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerSegmentRoutes(app: FastifyInstance, db: Db) {
  /** Segments list - searched server-side by name (task brief section 16), not loaded in full then filtered client-side. */
  app.get(
    "/orgs/:orgId/sites/:siteId/segments",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      const { search, limit, offset } = parsed.data;

      const conditions = [eq(segments.siteId, site.id)];
      if (search) conditions.push(like(segments.name, `%${search}%`));
      const where = and(...conditions);

      const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(segments).where(where);

      const rows = await db.select().from(segments).where(where).orderBy(desc(segments.updatedAt)).limit(limit).offset(offset);

      // Audience count per segment - each is its own evaluator run (task
      // brief section 8's server-side count), fine at the segment-catalog
      // scale this targets (tens of saved segments per site, same
      // "list-scale, not row-scale" precedent as pages.ts's per-Page metrics).
      const segmentsWithCounts = await Promise.all(
        rows.map(async (row) => serializeSegment(row, await getSegmentAudienceCount(db, site.id, row.definition as SegmentDefinition)))
      );

      return reply.send({ segments: segmentsWithCounts, total, limit, offset });
    }
  );

  /** Create a segment. Definition is validated (never trusted from the frontend) before it's persisted. */
  app.post(
    "/orgs/:orgId/sites/:siteId/segments",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const parsed = createSegmentSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

      const [row] = await db
        .insert(segments)
        .values({
          siteId: site.id,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          definition: parsed.data.definition,
        })
        .returning();

      const audienceCount = await getSegmentAudienceCount(db, site.id, row.definition as SegmentDefinition);
      return reply.code(201).send(serializeSegment(row, audienceCount));
    }
  );

  /**
   * Evaluate/count a definition before saving (task brief section 9) -
   * the builder's live audience preview. Deliberately not persisted;
   * this is purely a read against the evaluator with a candidate
   * definition that may not exist as a saved segment yet.
   */
  app.post(
    "/orgs/:orgId/sites/:siteId/segments/preview",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const parsed = previewSegmentSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

      const audienceCount = await getSegmentAudienceCount(db, site.id, parsed.data.definition);
      return reply.send({ audienceCount });
    }
  );

  app.get(
    "/orgs/:orgId/sites/:siteId/segments/:segmentId",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, segmentId } = request.params as { siteId: string; segmentId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const row = await loadSegmentInSite(db, site.id, segmentId);
      if (!row) return reply.code(404).send({ error: "segment_not_found" });

      const audienceCount = await getSegmentAudienceCount(db, site.id, row.definition as SegmentDefinition);
      return reply.send(serializeSegment(row, audienceCount));
    }
  );

  /** Paginated, hydrated membership (task brief section 14) - links back to the existing User Profile page (section 15), not a segment-specific user view. */
  app.get(
    "/orgs/:orgId/sites/:siteId/segments/:segmentId/members",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, segmentId } = request.params as { siteId: string; segmentId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const row = await loadSegmentInSite(db, site.id, segmentId);
      if (!row) return reply.code(404).send({ error: "segment_not_found" });

      const parsed = membersQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      const { limit, offset } = parsed.data;

      const { members, total } = await getSegmentMembers(db, site.id, row.definition as SegmentDefinition, { limit, offset });
      return reply.send({ members, total, limit, offset });
    }
  );

  app.patch(
    "/orgs/:orgId/sites/:siteId/segments/:segmentId",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const { siteId, segmentId } = request.params as { siteId: string; segmentId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const existing = await loadSegmentInSite(db, site.id, segmentId);
      if (!existing) return reply.code(404).send({ error: "segment_not_found" });

      const parsed = updateSegmentSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

      const [updated] = await db
        .update(segments)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(segments.id, segmentId))
        .returning();

      const audienceCount = await getSegmentAudienceCount(db, site.id, updated.definition as SegmentDefinition);
      return reply.send(serializeSegment(updated, audienceCount));
    }
  );

  /**
   * Deletion (task brief section 17). V1 has no other system
   * referencing a segment yet, so this is a plain delete - the
   * dangling-reference concern the brief flags is left for whichever
   * future system (Experiences) introduces the first real reference.
   */
  app.delete(
    "/orgs/:orgId/sites/:siteId/segments/:segmentId",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const { siteId, segmentId } = request.params as { siteId: string; segmentId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const existing = await loadSegmentInSite(db, site.id, segmentId);
      if (!existing) return reply.code(404).send({ error: "segment_not_found" });

      await db.delete(segments).where(eq(segments.id, segmentId));
      return reply.code(204).send();
    }
  );
}
