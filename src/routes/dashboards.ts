import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cuid, dashboardCards, dashboards, funnels, segments, sites } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { cardConfigurationSchema, dashboardCreateSchema, dashboardUpdateSchema } from "../lib/analytics/validation.js";

async function siteInOrg(db: Db, siteId: string, orgId: string) { const [site] = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1); return site; }
async function dashboardInSite(db: Db, dashboardId: string, siteId: string) { const [row] = await db.select().from(dashboards).where(and(eq(dashboards.id, dashboardId), eq(dashboards.siteId, siteId))).limit(1); return row; }
const iso = (d: Date) => d.toISOString();
function cardJson(row: typeof dashboardCards.$inferSelect) { const configuration = cardConfigurationSchema.parse(row.configuration); return { ...row, configuration, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }; }
function dashboardJson(row: typeof dashboards.$inferSelect) { return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }; }
async function invalidReference(db: Db, siteId: string, cards: { configuration: { kind: string; funnelId?: string; cohort?: { type: string; segmentIds?: string[] }; breakdown?: { dimension: string; segmentIds?: string[] } } }[]) {
  const funnelIds = cards.flatMap((card) => card.configuration.kind === "funnel" && card.configuration.funnelId ? [card.configuration.funnelId] : []);
  const segmentIds = cards.flatMap((card) => card.configuration.kind === "retention" && card.configuration.cohort?.type === "segments" ? card.configuration.cohort.segmentIds ?? [] : card.configuration.kind === "metric" && card.configuration.breakdown?.dimension === "segment" ? card.configuration.breakdown.segmentIds ?? [] : []);
  if (funnelIds.length) { const found = await db.select({ id: funnels.id }).from(funnels).where(and(eq(funnels.siteId, siteId), inArray(funnels.id, funnelIds))); if (new Set(found.map((r) => r.id)).size !== new Set(funnelIds).size) return "funnel_not_found"; }
  if (segmentIds.length) { const found = await db.select({ id: segments.id }).from(segments).where(and(eq(segments.siteId, siteId), inArray(segments.id, segmentIds))); if (new Set(found.map((r) => r.id)).size !== new Set(segmentIds).size) return "segment_not_found"; }
  return null;
}

export function registerDashboardRoutes(app: FastifyInstance, db: Db) {
  app.get("/orgs/:orgId/sites/:siteId/dashboards", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string }; const site = await siteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const rows = await db.select({ dashboard: dashboards, cardCount: sql<number>`count(${dashboardCards.id})` }).from(dashboards).leftJoin(dashboardCards, eq(dashboardCards.dashboardId, dashboards.id)).where(eq(dashboards.siteId, siteId)).groupBy(dashboards.id).orderBy(desc(dashboards.updatedAt));
    return { dashboards: rows.map((r) => ({ ...dashboardJson(r.dashboard), cardCount: r.cardCount })) };
  });

  app.post("/orgs/:orgId/sites/:siteId/dashboards", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string }; const site = await siteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const parsed = dashboardCreateSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const referenceError = await invalidReference(db, siteId, parsed.data.cards); if (referenceError) return reply.code(400).send({ error: referenceError });
    const dashboardId = cuid("dsh"), now = new Date();
    db.transaction((tx) => {
      tx.insert(dashboards).values({ id: dashboardId, siteId, name: parsed.data.name, description: parsed.data.description ?? null, createdBy: request.user!.id, createdAt: now, updatedAt: now }).run();
      if (parsed.data.cards.length) tx.insert(dashboardCards).values(parsed.data.cards.map((card, position) => ({ id: cuid("dsc"), dashboardId, title: card.title, cardType: card.cardType, width: card.width, position, configuration: card.configuration, createdAt: now, updatedAt: now }))).run();
    });
    const row = await dashboardInSite(db, dashboardId, siteId); const cards = await db.select().from(dashboardCards).where(eq(dashboardCards.dashboardId, dashboardId)).orderBy(asc(dashboardCards.position));
    return reply.code(201).send({ ...dashboardJson(row!), cards: cards.map(cardJson) });
  });

  app.get("/orgs/:orgId/sites/:siteId/dashboards/:dashboardId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, dashboardId } = request.params as { siteId: string; dashboardId: string }; const site = await siteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await dashboardInSite(db, dashboardId, siteId); if (!row) return reply.code(404).send({ error: "dashboard_not_found" });
    const cards = await db.select().from(dashboardCards).where(eq(dashboardCards.dashboardId, dashboardId)).orderBy(asc(dashboardCards.position));
    return { ...dashboardJson(row), cards: cards.map(cardJson) };
  });

  app.patch("/orgs/:orgId/sites/:siteId/dashboards/:dashboardId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, dashboardId } = request.params as { siteId: string; dashboardId: string }; const site = await siteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const existing = await dashboardInSite(db, dashboardId, siteId); if (!existing) return reply.code(404).send({ error: "dashboard_not_found" });
    const parsed = dashboardUpdateSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    if (parsed.data.cards) { const referenceError = await invalidReference(db, siteId, parsed.data.cards); if (referenceError) return reply.code(400).send({ error: referenceError }); }
    const oldCards = await db.select().from(dashboardCards).where(eq(dashboardCards.dashboardId, dashboardId)); const oldById = new Map(oldCards.map((c) => [c.id, c]));
    const supplied = parsed.data.cards?.map((c) => c.id).filter((id): id is string => Boolean(id)) ?? [];
    if (supplied.some((id) => !oldById.has(id))) return reply.code(400).send({ error: "foreign_card_id" });
    const now = new Date();
    db.transaction((tx) => {
      tx.update(dashboards).set({ ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}), ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}), updatedAt: now }).where(eq(dashboards.id, dashboardId)).run();
      if (parsed.data.cards) {
        tx.delete(dashboardCards).where(eq(dashboardCards.dashboardId, dashboardId)).run();
        if (parsed.data.cards.length) tx.insert(dashboardCards).values(parsed.data.cards.map((card, position) => ({ id: card.id ?? cuid("dsc"), dashboardId, title: card.title, cardType: card.cardType, width: card.width, position, configuration: card.configuration, createdAt: card.id ? oldById.get(card.id)!.createdAt : now, updatedAt: now }))).run();
      }
    });
    const row = await dashboardInSite(db, dashboardId, siteId); const cards = await db.select().from(dashboardCards).where(eq(dashboardCards.dashboardId, dashboardId)).orderBy(asc(dashboardCards.position));
    return { ...dashboardJson(row!), cards: cards.map(cardJson) };
  });

  app.delete("/orgs/:orgId/sites/:siteId/dashboards/:dashboardId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, dashboardId } = request.params as { siteId: string; dashboardId: string }; const site = await siteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await dashboardInSite(db, dashboardId, siteId); if (!row) return reply.code(404).send({ error: "dashboard_not_found" });
    await db.delete(dashboards).where(eq(dashboards.id, dashboardId)); return reply.code(204).send();
  });
}
