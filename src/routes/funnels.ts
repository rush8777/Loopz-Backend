import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, like, desc, sql, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sites, funnels, pageDefinitions } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { createFunnelSchema, updateFunnelSchema, conversionWindowToMinutes } from "../lib/funnels/validation.js";
import { evaluateFunnel, getFunnelStepUsers } from "../lib/funnels/evaluator.js";
import { eventExistsForSite } from "../lib/events/eventQueries.js";
import type { FunnelStep } from "../lib/funnels/types.js";

async function loadSiteInOrg(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site || site.orgId !== orgId) return null;
  return site;
}

async function loadFunnelInSite(db: Db, siteId: string, funnelId: string) {
  const [row] = await db.select().from(funnels).where(eq(funnels.id, funnelId)).limit(1);
  if (!row || row.siteId !== siteId) return null;
  return row;
}

/**
 * Validates that every event/page step actually refers to something
 * real for this site (task brief section 25) - a funnel step
 * referencing a typo'd event name or another site's Page would
 * silently evaluate to zero users forever, which is worse than
 * rejecting it up front.
 */
async function validateStepReferences(db: Db, siteId: string, steps: FunnelStep[]): Promise<string | null> {
  const eventNames = [...new Set(steps.filter((s): s is Extract<FunnelStep, { type: "event" }> => s.type === "event").map((s) => s.eventName))];
  for (const name of eventNames) {
    if (!(await eventExistsForSite(db, siteId, name))) return `Unknown event: ${name}`;
  }

  const pageIds = [...new Set(steps.filter((s): s is Extract<FunnelStep, { type: "page" }> => s.type === "page").map((s) => s.pageId))];
  if (pageIds.length > 0) {
    const rows = await db.select({ id: pageDefinitions.id }).from(pageDefinitions).where(and(eq(pageDefinitions.siteId, siteId), inArray(pageDefinitions.id, pageIds)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of pageIds) if (!found.has(id)) return `Unknown page: ${id}`;
  }

  return null;
}

function serializeFunnel(row: typeof funnels.$inferSelect) {
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    description: row.description,
    steps: row.steps as FunnelStep[],
    conversionWindowMinutes: row.conversionWindowMinutes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const listQuerySchema = z.object({
  search: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const rangeQuerySchema = z.object({
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  segmentId: z.string().min(1).max(64).optional(),
});

const stepUsersQuerySchema = rangeQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Default analysis window when the caller doesn't specify one - matches
// routes/events.ts's DEFAULT_RANGE_DAYS and task brief section 8's
// suggested default.
const DEFAULT_RANGE_DAYS = 30;
function resolveRange(since?: Date, until?: Date): { since: Date; until: Date } {
  const resolvedUntil = until ?? new Date();
  const resolvedSince = since ?? new Date(resolvedUntil.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { since: resolvedSince, until: resolvedUntil };
}

export function registerFunnelRoutes(app: FastifyInstance, db: Db) {
  /** Funnel list - each row's step count/overall conversion computed over the default 30-day window (task brief section 11), same per-item evaluator-call pattern as Segments' list endpoint. */
  app.get("/orgs/:orgId/sites/:siteId/funnels", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });

    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    const { search, limit, offset } = parsed.data;

    const conditions = [eq(funnels.siteId, site.id)];
    if (search) conditions.push(like(funnels.name, `%${search}%`));
    const where = and(...conditions);

    const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(funnels).where(where);
    const rows = await db.select().from(funnels).where(where).orderBy(desc(funnels.updatedAt)).limit(limit).offset(offset);

    const range = resolveRange();
    const withSummaries = await Promise.all(
      rows.map(async (row) => {
        const steps = row.steps as FunnelStep[];
        const result = await evaluateFunnel(db, site.id, steps, range, row.conversionWindowMinutes);
        return { ...serializeFunnel(row), stepCount: steps.length, overallConversion: result.overallConversion, totalUsers: result.totalUsers };
      })
    );

    return reply.send({ funnels: withSummaries, total, limit, offset });
  });

  app.post("/orgs/:orgId/sites/:siteId/funnels", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });

    const parsed = createFunnelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

    const referenceError = await validateStepReferences(db, site.id, parsed.data.steps);
    if (referenceError) return reply.code(400).send({ error: "invalid_step_reference", message: referenceError });

    const [row] = await db
      .insert(funnels)
      .values({
        siteId: site.id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        steps: parsed.data.steps,
        conversionWindowMinutes: parsed.data.conversionWindow ? conversionWindowToMinutes(parsed.data.conversionWindow) : undefined,
      })
      .returning();

    return reply.code(201).send(serializeFunnel(row));
  });

  app.get("/orgs/:orgId/sites/:siteId/funnels/:funnelId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, funnelId } = request.params as { siteId: string; funnelId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });

    const row = await loadFunnelInSite(db, site.id, funnelId);
    if (!row) return reply.code(404).send({ error: "funnel_not_found" });

    return reply.send(serializeFunnel(row));
  });

  /**
   * Full analysis (task brief section 14) - date range and an
   * optional saved-Segment filter (section 17) are analysis-time
   * parameters, not saved on the funnel, exactly like the date range
   * already is - the detail page re-requests this whenever either
   * changes.
   */
  app.get(
    "/orgs/:orgId/sites/:siteId/funnels/:funnelId/analyze",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, funnelId } = request.params as { siteId: string; funnelId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const row = await loadFunnelInSite(db, site.id, funnelId);
      if (!row) return reply.code(404).send({ error: "funnel_not_found" });

      const parsed = rangeQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      const range = resolveRange(parsed.data.since, parsed.data.until);

      const result = await evaluateFunnel(db, site.id, row.steps as FunnelStep[], range, row.conversionWindowMinutes, {
        segmentId: parsed.data.segmentId,
      });
      return reply.send({ ...result, since: range.since.toISOString(), until: range.until.toISOString() });
    }
  );

  /** User-level inspection at a single step (task brief section 18) - hydrated identities the frontend links to the existing User Profile / Anonymous Visitor pages. */
  app.get(
    "/orgs/:orgId/sites/:siteId/funnels/:funnelId/steps/:stepIndex/users",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, funnelId, stepIndex } = request.params as { siteId: string; funnelId: string; stepIndex: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const row = await loadFunnelInSite(db, site.id, funnelId);
      if (!row) return reply.code(404).send({ error: "funnel_not_found" });

      const index = Number(stepIndex);
      if (!Number.isInteger(index) || index < 0) return reply.code(400).send({ error: "invalid_step_index" });

      const parsed = stepUsersQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      const range = resolveRange(parsed.data.since, parsed.data.until);

      const { users, total } = await getFunnelStepUsers(db, site.id, row.steps as FunnelStep[], range, row.conversionWindowMinutes, index, {
        segmentId: parsed.data.segmentId,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      return reply.send({ users, total, limit: parsed.data.limit, offset: parsed.data.offset });
    }
  );

  app.patch("/orgs/:orgId/sites/:siteId/funnels/:funnelId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, funnelId } = request.params as { siteId: string; funnelId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });

    const existing = await loadFunnelInSite(db, site.id, funnelId);
    if (!existing) return reply.code(404).send({ error: "funnel_not_found" });

    const parsed = updateFunnelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

    if (parsed.data.steps) {
      const referenceError = await validateStepReferences(db, site.id, parsed.data.steps);
      if (referenceError) return reply.code(400).send({ error: "invalid_step_reference", message: referenceError });
    }

    const { conversionWindow, ...rest } = parsed.data;
    const [updated] = await db
      .update(funnels)
      .set({
        ...rest,
        ...(conversionWindow ? { conversionWindowMinutes: conversionWindowToMinutes(conversionWindow) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(funnels.id, funnelId))
      .returning();

    return reply.send(serializeFunnel(updated));
  });

  app.delete("/orgs/:orgId/sites/:siteId/funnels/:funnelId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, funnelId } = request.params as { siteId: string; funnelId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });

    const existing = await loadFunnelInSite(db, site.id, funnelId);
    if (!existing) return reply.code(404).send({ error: "funnel_not_found" });

    await db.delete(funnels).where(eq(funnels.id, funnelId));
    return reply.code(204).send();
  });
}
