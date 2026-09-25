import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { checklistStates, experienceEvents, experienceImpressions, experienceVersions, experiences, segments, sites, trackedUsers } from "../db/schema.js";
import { checklistProgress, completeChecklistItemFromClick, currentChecklistDefinition, getOrCreateChecklistState, refreshChecklist, type ChecklistIdentity } from "../lib/experiences/checklistProgress.js";
import { checklistDefinitionSchema, guideDefinitionSchema } from "../lib/experiences/validation.js";
import type { ChecklistExperienceDefinition, ExperienceTargeting } from "../lib/experiences/types.js";
import { matchesRules } from "../lib/pages/pageMatcher.js";
import { evaluateSegment } from "../lib/segments/evaluator.js";
import type { SegmentDefinition } from "../lib/segments/types.js";

const identitySchema = {
  url: z.url().max(2000), anonymousId: z.string().min(1).max(200), trackedUserId: z.string().min(1).max(200).optional(), sessionId: z.string().min(1).max(200), pageViewId: z.string().min(1).max(200).optional(), timestamp: z.number().int().positive().default(() => Date.now()),
};
const actionSchema = z.object({ ...identitySchema, versionId: z.string().min(1).max(64), impressionId: z.string().min(1).max(64).optional(), action: z.enum(["shown", "open", "collapse", "dismiss", "item_click", "completion_acknowledged"]), itemId: z.string().min(1).max(64).optional() }).strict().superRefine((value, ctx) => { if (value.action === "item_click" && !value.itemId) ctx.addIssue({ code: "custom", path: ["itemId"], message: "itemId is required" }); });
const refreshSchema = z.object({ ...identitySchema, versionId: z.string().min(1).max(64) }).strict();
const launchSchema = z.object({ ...identitySchema, source: z.enum(["api", "checklist"]), checklistExperienceId: z.string().min(1).max(64).optional(), itemId: z.string().min(1).max(64).optional() }).strict().superRefine((value, ctx) => { if (value.source === "checklist" && (!value.checklistExperienceId || !value.itemId)) ctx.addIssue({ code: "custom", path: ["checklistExperienceId"], message: "Checklist launch context is required" }); });

async function trackedIdentity(db: Db, siteId: string, anonymousId: string, externalId?: string): Promise<ChecklistIdentity> {
  if (!externalId) return { anonymousId, trackedUserId: null };
  const [user] = await db.select().from(trackedUsers).where(and(eq(trackedUsers.siteId, siteId), eq(trackedUsers.externalUserId, externalId))).limit(1);
  return { anonymousId, trackedUserId: user?.id ?? null };
}

function checkedUrl(urlValue: string, siteDomain: string | null): URL | null {
  try { const url = new URL(urlValue); if (siteDomain) { const origin = new URL(/^https?:\/\//i.test(siteDomain) ? siteDomain : `https://${siteDomain}`).origin; if (url.origin !== origin) return null; } return url; } catch { return null; }
}

async function audienceMatches(db: Db, siteId: string, identityKey: string, audience: ExperienceTargeting["audience"]) {
  if (audience.type === "all") return true;
  const conditions = audience.type === "segment" ? [{ segmentId: audience.segmentId, operator: "matches" as const }] : audience.conditions;
  const values = await Promise.all(conditions.map(async condition => { const [segment] = await db.select().from(segments).where(eq(segments.id, condition.segmentId)).limit(1); if (!segment || segment.siteId !== siteId) return false; const member = (await evaluateSegment(db, siteId, segment.definition as SegmentDefinition)).has(identityKey); return condition.operator === "matches" ? member : !member; }));
  return audience.type === "segment_rules" && audience.logic === "any" ? values.some(Boolean) : values.every(Boolean);
}

function available(definition: Pick<ChecklistExperienceDefinition, "targeting">, url: URL) {
  const target = definition.targeting; const now = new Date();
  if (target.schedule?.startsAt && now < new Date(target.schedule.startsAt)) return false;
  if (target.schedule?.endsAt && now >= new Date(target.schedule.endsAt)) return false;
  if (target.allowedOrigins?.length && !target.allowedOrigins.includes(url.origin)) return false;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return !target.pageRules.length || matchesRules(path, target.pageRules);
}

export async function deliveredChecklist(db: Db, site: typeof sites.$inferSelect, input: { url: string; anonymousId: string; trackedUserId?: string; sessionId: string; pageViewId?: string }) {
  const url = checkedUrl(input.url, site.domain); if (!url) return null;
  const identity = await trackedIdentity(db, site.id, input.anonymousId, input.trackedUserId); const identityKey = identity.trackedUserId ?? identity.anonymousId;
  const rows = (await db.select().from(experiences).where(and(eq(experiences.siteId, site.id), eq(experiences.status, "published"), eq(experiences.kind, "checklist")))).filter(row => row.publishedVersionId);
  const candidates: Array<{ experience: typeof experiences.$inferSelect; version: typeof experienceVersions.$inferSelect; definition: ChecklistExperienceDefinition }> = [];
  for (const experience of rows) {
    const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, experience.publishedVersionId!)).limit(1); if (!version || version.state !== "published") continue;
    const parsed = checklistDefinitionSchema.safeParse(version.definition); if (!parsed.success || !available(parsed.data, url) || !await audienceMatches(db, site.id, identityKey, parsed.data.targeting.audience)) continue;
    const progress = await refreshChecklist(db, { siteId: site.id, experienceId: experience.id, versionId: version.id, definition: parsed.data, identity, sessionId: input.sessionId, pageViewId: input.pageViewId });
    if (progress.dismissed || progress.completionAcknowledged) continue;
    candidates.push({ experience, version, definition: parsed.data });
  }
  candidates.sort((a, b) => b.definition.targeting.priority - a.definition.targeting.priority || a.experience.id.localeCompare(b.experience.id));
  const candidate = candidates[0]; if (!candidate) return null;
  const state = await getOrCreateChecklistState(db, site.id, candidate.experience.id, identity, candidate.definition.behavior.initialState === "collapsed");
  const progress = await checklistProgress(db, state, candidate.definition); const { targeting: _targeting, ...definition } = candidate.definition;
  return { id: candidate.experience.id, versionId: candidate.version.id, kind: "checklist" as const, priority: candidate.definition.targeting.priority, definition, progress };
}

export function registerPublicChecklistRoutes(app: FastifyInstance, db: Db) {
  app.post("/public/sites/:siteId/checklists/:experienceId/refresh", async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string }; const body = refreshSchema.safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1); if (!site || !checkedUrl(body.data.url, site.domain)) return reply.code(404).send({ error: "checklist_not_found" });
    const current = await currentChecklistDefinition(db, site.id, experienceId); if (!current || current.version.id !== body.data.versionId) return reply.code(404).send({ error: "checklist_not_found" });
    const parsed = checklistDefinitionSchema.safeParse(current.definition); if (!parsed.success) return reply.code(409).send({ error: "invalid_checklist" });
    const identity = await trackedIdentity(db, site.id, body.data.anonymousId, body.data.trackedUserId);
    if (!available(parsed.data, new URL(body.data.url)) || !await audienceMatches(db, site.id, identity.trackedUserId ?? identity.anonymousId, parsed.data.targeting.audience)) return reply.code(409).send({ error: "checklist_unavailable" });
    return reply.send(await refreshChecklist(db, { siteId: site.id, experienceId, versionId: current.version.id, definition: parsed.data, identity, sessionId: body.data.sessionId, pageViewId: body.data.pageViewId }));
  });

  app.post("/public/sites/:siteId/checklists/:experienceId/actions", async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string }; const body = actionSchema.safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1); const url = site && checkedUrl(body.data.url, site.domain); if (!site || !url) return reply.code(404).send({ error: "checklist_not_found" });
    const current = await currentChecklistDefinition(db, site.id, experienceId); if (!current || current.version.id !== body.data.versionId) return reply.code(404).send({ error: "checklist_not_found" });
    const parsed = checklistDefinitionSchema.safeParse(current.definition); if (!parsed.success || !available(parsed.data, url)) return reply.code(409).send({ error: "checklist_unavailable" });
    const identity = await trackedIdentity(db, site.id, body.data.anonymousId, body.data.trackedUserId); if (!await audienceMatches(db, site.id, identity.trackedUserId ?? identity.anonymousId, parsed.data.targeting.audience)) return reply.code(409).send({ error: "checklist_unavailable" }); const state = await getOrCreateChecklistState(db, site.id, experienceId, identity, parsed.data.behavior.initialState === "collapsed"); const now = new Date(body.data.timestamp);
    const before = await checklistProgress(db, state, parsed.data);
    if (body.data.action === "dismiss" && !parsed.data.behavior.dismissible) return reply.code(409).send({ error: "dismissal_disabled" });
    if (body.data.action === "completion_acknowledged" && !before.complete) return reply.code(409).send({ error: "checklist_incomplete" });
    if (body.data.action === "item_click") {
      const result = await completeChecklistItemFromClick(db, { siteId: site.id, experienceId, versionId: current.version.id, definition: parsed.data, identity, itemId: body.data.itemId!, sessionId: body.data.sessionId, pageViewId: body.data.pageViewId });
      if ("error" in result) return reply.code(result.error === "item_locked" ? 409 : 404).send({ error: result.error });
      return reply.send(result);
    }
    const eventType = { shown: "checklist_shown", open: "checklist_opened", collapse: "checklist_collapsed", dismiss: "checklist_dismissed", completion_acknowledged: "checklist_completion_acknowledged" }[body.data.action];
    let impressionId = body.data.impressionId;
    if (body.data.action === "shown") {
      const [impression] = await db.insert(experienceImpressions).values({ siteId: site.id, experienceId, versionId: current.version.id, anonymousId: identity.anonymousId, trackedUserId: identity.trackedUserId, sessionId: body.data.sessionId, pageViewId: body.data.pageViewId ?? null, shownAt: now }).returning(); impressionId = impression.id;
    }
    await db.update(checklistStates).set({ ...(body.data.action === "shown" ? { lastShownAt: now } : {}), ...(body.data.action === "open" ? { isCollapsed: false, lastOpenedAt: now } : {}), ...(body.data.action === "collapse" ? { isCollapsed: true } : {}), ...(body.data.action === "dismiss" ? { dismissedAt: now } : {}), ...(body.data.action === "completion_acknowledged" ? { completionAcknowledgedAt: now } : {}), updatedAt: now }).where(eq(checklistStates.id, state.id));
    await db.insert(experienceEvents).values({ siteId: site.id, experienceId, versionId: current.version.id, impressionId: impressionId ?? null, eventType, anonymousId: identity.anonymousId, trackedUserId: identity.trackedUserId, sessionId: body.data.sessionId, pageViewId: body.data.pageViewId ?? null, timestamp: now });
    if (body.data.action === "dismiss" && impressionId) await db.update(experienceImpressions).set({ dismissedAt: now }).where(eq(experienceImpressions.id, impressionId));
    return reply.send({ impressionId, progress: await checklistProgress(db, { ...state, isCollapsed: body.data.action === "open" ? false : body.data.action === "collapse" ? true : state.isCollapsed, dismissedAt: body.data.action === "dismiss" ? now : state.dismissedAt, completionAcknowledgedAt: body.data.action === "completion_acknowledged" ? now : state.completionAcknowledgedAt }, parsed.data) });
  });

  app.post("/public/sites/:siteId/experiences/:experienceId/launch", async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string }; const body = launchSchema.safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1); const url = site && checkedUrl(body.data.url, site.domain); if (!site || !url) return reply.code(404).send({ error: "experience_not_found" });
    const [experience] = await db.select().from(experiences).where(and(eq(experiences.id, experienceId), eq(experiences.siteId, site.id), eq(experiences.kind, "guide"), eq(experiences.status, "published"))).limit(1); if (!experience?.publishedVersionId) return reply.code(404).send({ error: "experience_not_found" });
    const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, experience.publishedVersionId)).limit(1); const parsed = version && guideDefinitionSchema.safeParse(version.definition); if (!version || version.state !== "published" || !parsed || !parsed.success) return reply.code(404).send({ error: "experience_not_found" });
    const target = parsed.data.targeting; const now = new Date(); if ((target.schedule?.startsAt && now < new Date(target.schedule.startsAt)) || (target.schedule?.endsAt && now >= new Date(target.schedule.endsAt)) || (target.allowedOrigins?.length && !target.allowedOrigins.includes(url.origin))) return reply.code(409).send({ error: "experience_unavailable" });
    if (body.data.source === "checklist") {
      const source = await currentChecklistDefinition(db, site.id, body.data.checklistExperienceId!); const sourceDefinition = source && checklistDefinitionSchema.safeParse(source.definition); if (!source || !sourceDefinition || !sourceDefinition.success || !available(sourceDefinition.data, url)) return reply.code(409).send({ error: "checklist_unavailable" });
      const itemIndex = sourceDefinition.data.items.findIndex(item => item.id === body.data.itemId && item.action.type === "launch_guide" && item.action.experienceId === experience.id); if (itemIndex < 0) return reply.code(409).send({ error: "invalid_launch_context" });
      const identity = await trackedIdentity(db, site.id, body.data.anonymousId, body.data.trackedUserId); if (!await audienceMatches(db, site.id, identity.trackedUserId ?? identity.anonymousId, sourceDefinition.data.targeting.audience)) return reply.code(409).send({ error: "checklist_unavailable" }); const state = await getOrCreateChecklistState(db, site.id, source.experience.id, identity, sourceDefinition.data.behavior.initialState === "collapsed"); const progress = await checklistProgress(db, state, sourceDefinition.data); if (progress.items[itemIndex]?.state === "locked" || progress.dismissed || progress.completionAcknowledged) return reply.code(409).send({ error: "checklist_unavailable" });
    }
    const { targeting: _targeting, ...definition } = parsed.data;
    return reply.send({ id: experience.id, versionId: version.id, kind: "guide", widgetType: null, priority: target.priority, interruptPolicy: "interrupt", definition, launchContext: { source: body.data.source, sourceExperienceId: body.data.checklistExperienceId, sourceItemId: body.data.itemId } });
  });
}
