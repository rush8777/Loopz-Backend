import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { heatmapCaptureRequests, heatmapReferenceSnapshots, pageDefinitions, pageHeatmapStates, sessionEvents, sites } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { classifyHeatmapDevice } from "../lib/heatmaps/deviceClass.js";
import { matchesRules } from "../lib/pages/pageMatcher.js";
import type { PageRule } from "../lib/pages/types.js";

const deviceSchema = z.enum(["desktop", "tablet", "mobile"]);
const layerSchema = z.enum(["click", "hover", "cursor", "scroll", "rage_click"]);
const dateSchema = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() });
const snapshotSchema = z.object({
  pagePath: z.string().min(1).max(2000).refine((v) => v.startsWith("/")), deviceClass: deviceSchema,
  viewportWidth: z.number().int().positive().max(20000), viewportHeight: z.number().int().positive().max(200000),
  documentWidth: z.number().int().positive().max(20000), documentHeight: z.number().int().positive().max(200000),
  imageDataUrl: z.string().max(8_000_000).refine((v) => /^data:image\/(webp|png|jpeg);base64,/.test(v)),
});
type EventRow = typeof sessionEvents.$inferSelect;
type PageRow = typeof pageDefinitions.$inferSelect;

async function ownSite(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  return site?.orgId === orgId ? site : null;
}
function deviceFor(row: EventRow) {
  return ["desktop", "tablet", "mobile"].includes(row.deviceClass ?? "") ? row.deviceClass : row.viewportWidth ? classifyHeatmapDevice(row.viewportWidth) : null;
}
function matched(rows: EventRow[], page: PageRow) {
  const paths = new Map(rows.filter((r) => r.type === "page_view" && r.pageViewId && r.pagePath).map((r) => [r.pageViewId!, r.pagePath!]));
  return rows.filter((row) => {
    const path = row.pagePath ?? (row.pageViewId ? paths.get(row.pageViewId) : null);
    return Boolean(path && matchesRules(path, page.rules as PageRule[]));
  });
}
function ranged(rows: EventRow[], from?: string, to?: string) {
  const start = from ? Date.parse(from) : -Infinity, end = to ? Date.parse(to) : Infinity;
  return rows.filter((row) => row.timestamp.getTime() >= start && row.timestamp.getTime() <= end);
}
function currentSnapshot(rows: (typeof heatmapReferenceSnapshots.$inferSelect)[], page: PageRow) {
  return rows.find((row) => matchesRules(row.pagePath, page.rules as PageRule[]));
}
function metrics(rows: EventRow[], allRows: EventRow[]) {
  const visits = rows.filter((r) => r.type === "page_view"), clicks = rows.filter((r) => r.type === "click");
  const groups = new Map<string, number[]>();
  for (const row of rows) if (row.pageViewId) groups.set(row.pageViewId, [...(groups.get(row.pageViewId) ?? []), row.timestamp.getTime()]);
  const durations = [...groups.values()].map((times) => Math.max(...times) - Math.min(...times));
  const last = new Map<string, EventRow>();
  for (const row of allRows.filter((r) => r.type === "page_view")) if (!last.get(row.sessionId) || last.get(row.sessionId)!.timestamp < row.timestamp) last.set(row.sessionId, row);
  const dropoffs = visits.filter((visit) => last.get(visit.sessionId)?.pageViewId === visit.pageViewId).length;
  return { visits: visits.length, totalClicks: clicks.length, averageTimeMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0, dropOffRate: visits.length ? dropoffs / visits.length : 0 };
}
function topClicks(rows: EventRow[]) {
  const clicks = rows.filter((r) => r.type === "click"), groups = new Map<string, { selector: string; label: string | null; count: number }>();
  for (const click of clicks) if (click.selector) { const item = groups.get(click.selector); if (item) item.count++; else groups.set(click.selector, { selector: click.selector, label: click.elementLabel, count: 1 }); }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 20).map((item) => ({ ...item, percentage: clicks.length ? item.count / clicks.length : 0 }));
}
function reach(rows: EventRow[]) {
  const sessions = new Set(rows.filter((r) => r.type === "page_view").map((r) => r.sessionId)), deepest = new Map<string, number>();
  for (const row of rows.filter((r) => r.type === "scroll" && r.scrollPercent != null)) { sessions.add(row.sessionId); deepest.set(row.sessionId, Math.max(deepest.get(row.sessionId) ?? 0, row.scrollPercent!)); }
  return [25, 50, 75, 100].map((depth) => ({ depth, reached: sessions.size ? [...sessions].filter((id) => (deepest.get(id) ?? 0) >= depth).length / sessions.size : 0 }));
}
function latestPath(rows: EventRow[], page: PageRow) {
  return matched(rows, page).filter((r) => r.type === "page_view" && r.pagePath).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]?.pagePath ?? null;
}
function origin(domain: string | null) {
  if (!domain) return null;
  try { return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin; } catch { return null; }
}

export function registerHeatmapRoutes(app: FastifyInstance, db: Db) {
  app.get("/orgs/:orgId/sites/:siteId/heatmaps", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string }, site = await ownSite(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const query = dateSchema.safeParse(request.query); if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    const [pages, allRows, snapshots] = await Promise.all([db.select().from(pageDefinitions).where(eq(pageDefinitions.siteId, site.id)), db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id)), db.select().from(heatmapReferenceSnapshots).where(eq(heatmapReferenceSnapshots.siteId, site.id)).orderBy(desc(heatmapReferenceSnapshots.capturedAt))]);
    const rows = ranged(allRows, query.data.from, query.data.to);
    return reply.send({ heatmaps: pages.map((page) => { const pageRows = matched(rows, page), interactions = pageRows.filter((r) => ["click", "hover", "cursor", "scroll", "rage_click"].includes(r.type)), snapshot = currentSnapshot(snapshots, page), last = [...interactions].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]; return { id: page.id, name: page.name, heatmapEnabled: page.heatmapEnabled, interactions: interactions.length, clicks: pageRows.filter((r) => r.type === "click").length, lastActivityAt: last?.timestamp.toISOString() ?? null, referenceStatus: snapshot ? "ready" : "needed", referenceCapturedAt: snapshot?.capturedAt.toISOString() ?? null }; }) });
  });

  app.get("/orgs/:orgId/sites/:siteId/pages/:pageId/heatmap/states", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, pageId } = request.params as { siteId: string; pageId: string }, site = await ownSite(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [page] = await db.select().from(pageDefinitions).where(and(eq(pageDefinitions.id, pageId), eq(pageDefinitions.siteId, site.id))).limit(1); if (!page) return reply.code(404).send({ error: "page_not_found" });
    const states = await db.select().from(pageHeatmapStates).where(and(eq(pageHeatmapStates.siteId, site.id), eq(pageHeatmapStates.pageDefinitionId, pageId)));
    return reply.send({ states: [{ id: "default", name: "Default", selector: null }, ...states.map((s) => ({ id: s.id, name: s.name, selector: s.selector }))] });
  });
  app.post("/orgs/:orgId/sites/:siteId/pages/:pageId/heatmap/states", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, pageId } = request.params as { siteId: string; pageId: string }, site = await ownSite(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [page] = await db.select().from(pageDefinitions).where(and(eq(pageDefinitions.id, pageId), eq(pageDefinitions.siteId, site.id))).limit(1); if (!page) return reply.code(404).send({ error: "page_not_found" });
    const body = z.object({ name: z.string().min(1).max(120), selector: z.string().min(1).max(500) }).safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [state] = await db.insert(pageHeatmapStates).values({ siteId: site.id, pageDefinitionId: page.id, ...body.data }).returning(); return reply.code(201).send({ id: state.id, name: state.name, selector: state.selector });
  });

  app.get("/orgs/:orgId/sites/:siteId/pages/:pageId/heatmap", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, pageId } = request.params as { siteId: string; pageId: string }, site = await ownSite(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [page] = await db.select().from(pageDefinitions).where(and(eq(pageDefinitions.id, pageId), eq(pageDefinitions.siteId, site.id))).limit(1); if (!page) return reply.code(404).send({ error: "page_not_found" }); if (!page.heatmapEnabled) return reply.code(409).send({ error: "heatmap_disabled" });
    const query = dateSchema.extend({ stateId: z.string().default("default"), device: deviceSchema.default("desktop"), layer: layerSchema.default("click") }).safeParse(request.query); if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    if (query.data.stateId !== "default") { const [state] = await db.select().from(pageHeatmapStates).where(and(eq(pageHeatmapStates.id, query.data.stateId), eq(pageHeatmapStates.pageDefinitionId, page.id), eq(pageHeatmapStates.siteId, site.id))).limit(1); if (!state) return reply.code(404).send({ error: "state_not_found" }); }
    const allRows = await db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id));
    const pageRows = matched(ranged(allRows, query.data.from, query.data.to), page).filter((r) => deviceFor(r) === query.data.device && (query.data.stateId === "default" ? !r.heatmapStateId : r.heatmapStateId === query.data.stateId));
    const layerRows = pageRows.filter((r) => r.type === query.data.layer), points = new Map<string, { x?: number; y?: number; count: number }>();
    for (const row of layerRows) { const x = row.documentX ?? row.x ?? undefined, y = row.documentY ?? row.y ?? undefined, key = `${x}:${y}`, weight = row.type === "rage_click" ? row.rageClickCount ?? 1 : 1, item = points.get(key); if (item) item.count += weight; else points.set(key, { ...(x != null && { x }), ...(y != null && { y }), count: weight }); }
    const stateWhere = query.data.stateId === "default" ? isNull(heatmapReferenceSnapshots.pageStateId) : eq(heatmapReferenceSnapshots.pageStateId, query.data.stateId);
    const snapshot = currentSnapshot(await db.select().from(heatmapReferenceSnapshots).where(and(eq(heatmapReferenceSnapshots.siteId, site.id), eq(heatmapReferenceSnapshots.pageDefinitionId, page.id), eq(heatmapReferenceSnapshots.deviceClass, query.data.device), stateWhere)).orderBy(desc(heatmapReferenceSnapshots.capturedAt)), page);
    const path = latestPath(allRows, page), siteOrigin = origin(site.domain);
    return reply.send({ page: { id: page.id, name: page.name }, stateId: query.data.stateId, device: query.data.device, layer: query.data.layer, interactionCount: layerRows.length, points: [...points.values()], metrics: metrics(pageRows, allRows), topClickedElements: topClicks(pageRows), scrollReach: reach(pageRows), targetUrl: path && siteOrigin ? new URL(path, siteOrigin).toString() : null, snapshot: snapshot ? { imageDataUrl: snapshot.imageDataUrl, pagePath: snapshot.pagePath, viewportWidth: snapshot.viewportWidth, viewportHeight: snapshot.viewportHeight, documentWidth: snapshot.documentWidth, documentHeight: snapshot.documentHeight, capturedAt: snapshot.capturedAt.toISOString() } : null });
  });

  app.post("/orgs/:orgId/sites/:siteId/pages/:pageId/heatmap/capture-request", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, pageId } = request.params as { siteId: string; pageId: string }, site = await ownSite(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const body = z.object({ stateId: z.string().default("default"), device: deviceSchema, targetUrl: z.string().url().max(4000).optional() }).safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [page] = await db.select().from(pageDefinitions).where(and(eq(pageDefinitions.id, pageId), eq(pageDefinitions.siteId, site.id))).limit(1); if (!page || !page.heatmapEnabled) return reply.code(409).send({ error: "heatmap_disabled" });
    const stateId = body.data.stateId === "default" ? null : body.data.stateId; if (stateId) { const [state] = await db.select().from(pageHeatmapStates).where(and(eq(pageHeatmapStates.id, stateId), eq(pageHeatmapStates.siteId, site.id), eq(pageHeatmapStates.pageDefinitionId, page.id))).limit(1); if (!state) return reply.code(404).send({ error: "state_not_found" }); }
    const siteOrigin = origin(site.domain), path = latestPath(await db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id)), page); let target: URL | null = null;
    try { target = body.data.targetUrl ? new URL(body.data.targetUrl) : siteOrigin && path ? new URL(path, siteOrigin) : null; } catch { /* rejected below */ }
    if (!target || (siteOrigin && target.origin !== siteOrigin) || !matchesRules(target.pathname, page.rules as PageRule[])) return reply.code(400).send({ error: "target_url_unavailable" });
    const [capture] = await db.insert(heatmapCaptureRequests).values({ token: nanoid(32), siteId: site.id, pageDefinitionId: page.id, pageStateId: stateId, deviceClass: body.data.device, expiresAt: new Date(Date.now() + 15 * 60_000) }).returning();
    target.searchParams.set("__loopz_heatmap_capture", capture.token); return reply.code(201).send({ captureUrl: target.toString(), expiresAt: capture.expiresAt.toISOString(), requestId: capture.id });
  });
  app.get("/orgs/:orgId/sites/:siteId/pages/:pageId/heatmap/capture-request/:requestId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, pageId, requestId } = request.params as { siteId: string; pageId: string; requestId: string }, site = await ownSite(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [capture] = await db.select().from(heatmapCaptureRequests).where(and(eq(heatmapCaptureRequests.id, requestId), eq(heatmapCaptureRequests.siteId, site.id), eq(heatmapCaptureRequests.pageDefinitionId, pageId))).limit(1); if (!capture) return reply.code(404).send({ error: "capture_not_found" });
    return reply.send({ status: capture.usedAt ? "complete" : capture.expiresAt < new Date() ? "expired" : "pending" });
  });

  app.get("/public/sites/:siteId/heatmap-reference", async (request, reply) => {
    const { siteId } = request.params as { siteId: string }, query = z.object({ path: z.string().min(1).max(2000), device: deviceSchema }).safeParse(request.query); if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const pages = await db.select().from(pageDefinitions).where(and(eq(pageDefinitions.siteId, site.id), eq(pageDefinitions.heatmapEnabled, true))), page = pages.find((p) => matchesRules(query.data.path, p.rules as PageRule[])); if (!page) return reply.send({ capture: null });
    const snapshots = await db.select().from(heatmapReferenceSnapshots).where(and(eq(heatmapReferenceSnapshots.siteId, site.id), eq(heatmapReferenceSnapshots.pageDefinitionId, page.id), eq(heatmapReferenceSnapshots.deviceClass, query.data.device), isNull(heatmapReferenceSnapshots.pageStateId))); if (currentSnapshot(snapshots, page)) return reply.send({ capture: null });
    const requests = await db.select().from(heatmapCaptureRequests).where(and(eq(heatmapCaptureRequests.siteId, site.id), eq(heatmapCaptureRequests.pageDefinitionId, page.id), eq(heatmapCaptureRequests.deviceClass, query.data.device), isNull(heatmapCaptureRequests.pageStateId))); if (requests.some((r) => !r.usedAt && r.expiresAt > new Date())) return reply.send({ capture: null });
    const [capture] = await db.insert(heatmapCaptureRequests).values({ token: nanoid(32), siteId: site.id, pageDefinitionId: page.id, pageStateId: null, deviceClass: query.data.device, expiresAt: new Date(Date.now() + 5 * 60_000) }).returning(); return reply.send({ capture: { token: capture.token } });
  });
  app.get("/public/sites/:siteId/heatmap-captures/:token", async (request, reply) => {
    const { siteId, token } = request.params as { siteId: string; token: string }, [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1); if (!site) return reply.code(404).send({ error: "capture_not_found" });
    const [capture] = await db.select().from(heatmapCaptureRequests).where(and(eq(heatmapCaptureRequests.token, token), eq(heatmapCaptureRequests.siteId, site.id))).limit(1); if (!capture || capture.usedAt || capture.expiresAt < new Date()) return reply.code(404).send({ error: "capture_not_found" });
    const [page] = await db.select().from(pageDefinitions).where(and(eq(pageDefinitions.id, capture.pageDefinitionId), eq(pageDefinitions.siteId, site.id))).limit(1); if (!page) return reply.code(404).send({ error: "capture_not_found" });
    const state = capture.pageStateId ? (await db.select().from(pageHeatmapStates).where(and(eq(pageHeatmapStates.id, capture.pageStateId), eq(pageHeatmapStates.siteId, site.id), eq(pageHeatmapStates.pageDefinitionId, page.id))).limit(1))[0] : null;
    return reply.send({ valid: true, pageName: page.name, stateName: state?.name ?? "Default", device: capture.deviceClass });
  });
  app.post("/public/sites/:siteId/heatmap-snapshots/:token", { bodyLimit: 8_500_000 }, async (request, reply) => {
    const { siteId, token } = request.params as { siteId: string; token: string }, [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [capture] = await db.select().from(heatmapCaptureRequests).where(and(eq(heatmapCaptureRequests.token, token), eq(heatmapCaptureRequests.siteId, site.id))).limit(1); if (!capture || capture.usedAt || capture.expiresAt < new Date()) return reply.code(404).send({ error: "capture_not_found" });
    const body = snapshotSchema.safeParse(request.body); if (!body.success || body.data.deviceClass !== capture.deviceClass) return reply.code(400).send({ error: "invalid_snapshot" });
    const [page] = await db.select().from(pageDefinitions).where(and(eq(pageDefinitions.id, capture.pageDefinitionId), eq(pageDefinitions.siteId, site.id))).limit(1); if (!page || !matchesRules(body.data.pagePath, page.rules as PageRule[])) return reply.code(400).send({ error: "page_path_mismatch" });
    await db.insert(heatmapReferenceSnapshots).values({ siteId: site.id, pageDefinitionId: page.id, pageStateId: capture.pageStateId, ...body.data, capturedAt: new Date() }); await db.update(heatmapCaptureRequests).set({ usedAt: new Date() }).where(and(eq(heatmapCaptureRequests.id, capture.id), eq(heatmapCaptureRequests.siteId, site.id))); return reply.code(201).send({ ok: true });
  });
}
