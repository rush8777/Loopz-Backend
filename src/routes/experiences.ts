import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { experienceEditorSessions, experiences, experienceVersions, pageDefinitions, segments, sites } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { createExperienceSchema, definitionSchemaFor, updateDraftSchema } from "../lib/experiences/validation.js";
import { guideStepRequiresTarget, type ExperienceDefinition, type ExperienceKind, type ExperienceTargeting, type WidgetType } from "../lib/experiences/types.js";
import { isChecklistDefinition } from "../lib/experiences/types.js";
import { initialChecklistDefinition, type ChecklistPreset } from "../lib/experiences/checklistPresets.js";
import { defaultWidgetSize, widgetSizeIsValid } from "../lib/experiences/widgetSizing.js";
import { getExperienceAnalytics, listExperienceAnalytics, listSurveyResponses } from "../lib/experiences/analytics.js";
import type { PageRule } from "../lib/pages/types.js";

const SUPPORTED_WIDGET_TYPES: WidgetType[] = ["anchored_card", "toast", "cursor_follow", "modal", "slideout", "hotspot", "banner", "survey"];

async function loadSiteInOrg(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  return site?.orgId === orgId ? site : null;
}

async function loadExperience(db: Db, siteId: string, experienceId: string) {
  const [row] = await db.select().from(experiences).where(eq(experiences.id, experienceId)).limit(1);
  return row?.siteId === siteId ? row : null;
}

async function experienceNameExists(db: Db, siteId: string, name: string, excludeId?: string) {
  const rows = await db.select({ id: experiences.id, name: experiences.name }).from(experiences).where(eq(experiences.siteId, siteId));
  const normalizedName = name.toLowerCase();
  return rows.some((row) => row.id !== excludeId && row.name.toLowerCase() === normalizedName);
}

function siteOrigin(domain: string | null): string | null {
  if (!domain) return null;
  try {
    return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin;
  } catch {
    return null;
  }
}

function urlBelongsToSite(url: string, domain: string | null): boolean {
  const origin = siteOrigin(domain);
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function deriveBuildUrl(domain: string | null, rules: PageRule[]): string | null {
  const origin = siteOrigin(domain);
  if (!origin) return null;
  const rule = rules.find((item) => item.kind === "include");
  if (!rule) return origin;
  const path = rule.value.replace(/\*/g, "").trim();
  return new URL(path.startsWith("/") ? path : "/", origin).toString();
}

const DEFAULT_DESIGN = {
  width: "md" as const,
  theme: { background: "#ffffff", foreground: "#111827", primary: "#2563eb", borderRadius: "md" as const },
};

function targeting(pageRules: PageRule[]): ExperienceTargeting {
  return { pageRules, audience: { type: "all" }, trigger: { type: "page_load" }, frequency: { mode: "once" }, priority: 0 };
}

function initialDefinition(kind: ExperienceKind, widgetType: WidgetType | null, pageRules: PageRule[]): ExperienceDefinition {
  if (kind === "checklist") return initialChecklistDefinition();
  const content = { heading: kind === "guide" ? "Welcome" : "A helpful message", body: "Add a concise message for your visitors." };
  if (kind === "guide") {
    return { steps: [{ id: "step_1", pattern: "anchored_card", content, behavior: { placement: "auto", alignment: "center", offset: 8, pointer: { enabled: true, size: 10 }, dismissible: true } }], design: DEFAULT_DESIGN, behavior: { layer: { mode: "auto" } }, targeting: targeting(pageRules) };
  }
  const definition: ExperienceDefinition = {
    content,
    design: { ...DEFAULT_DESIGN, size: defaultWidgetSize(widgetType!) },
    behavior: {
      dismissible: true,
      layer: { mode: "auto" },
      ...(widgetType === "toast" ? { toastPosition: "bottom-right" as const, autoDismissMs: null } : {}),
      ...(widgetType === "cursor_follow" ? { cursorOffset: { x: 16, y: 16 } } : {}),
      ...(widgetType === "anchored_card" || widgetType === "hotspot" ? { placement: "auto" as const, alignment: "center" as const, offset: 8 } : {}),
      ...(widgetType === "anchored_card" ? { pointer: { enabled: true, size: 10 } } : {}),
      ...(widgetType === "modal" || widgetType === "survey" ? { modalLayout: "center" as const, backdrop: true, backdropOpacity: 0.45, closeOnBackdrop: false } : {}),
      ...(widgetType === "slideout" ? { slideoutPosition: "bottom-right" as const, backdrop: false, backdropOpacity: 0.35, closeOnBackdrop: false } : {}),
      ...(widgetType === "banner" ? { bannerPosition: "top" as const } : {}),
      ...(widgetType === "hotspot" ? { hotspotStyle: "pulse" as const, hotspotColor: DEFAULT_DESIGN.theme.primary } : {}),
    },
    targeting: targeting(pageRules),
  };
  if (widgetType === "survey" && "content" in definition) {
    const firstId = `survey_step_${crypto.randomBytes(6).toString("hex")}`;
    const secondId = `survey_step_${crypto.randomBytes(6).toString("hex")}`;
    const ratingId = `question_${crypto.randomBytes(6).toString("hex")}`;
    const detailId = `question_${crypto.randomBytes(6).toString("hex")}`;
    definition.content = { heading: "How easy was it to complete this task?", body: "Your feedback helps us improve the experience." };
    definition.survey = {
      showProgress: true, allowBack: true, submitLabel: "Submit feedback",
      steps: [
        {
          id: firstId,
          content: { heading: "How easy was it to complete this task?", body: "Your feedback helps us improve the experience." },
          questions: [
            { id: ratingId, type: "rating", label: "How easy was it to complete this task?", required: true, min: 1, max: 5 },
            { id: detailId, type: "long_text", label: "What was the most challenging part?", required: false, placeholder: "Tell us more (optional)", maxLength: 2000 },
          ],
          builder: surveyStarter(firstId, ratingId, detailId, false),
        },
        {
          id: secondId,
          content: { heading: "Anything else to share?", body: "Add more questions here, or use this as a simple follow-up slide." },
          questions: [],
          builder: surveyStarter(secondId, null, null, true),
        },
      ],
    };
  }
  return definition;
}

function surveyStarter(stepId: string, ratingId: string | null, detailId: string | null, final: boolean) {
  const questions = ratingId && detailId ? `<div class="movecues-survey-question movecues-survey-question--rating" data-movecues-question-id="${ratingId}" data-movecues-question-type="rating"><p class="movecues-survey-question__label">How easy was it to complete this task? <span aria-hidden="true">*</span></p><div class="movecues-survey-options" role="group" aria-label="Rating">${[1,2,3,4,5].map(value => `<button type="button" class="movecues-survey-option" data-movecues-option-id="${value}" aria-pressed="false">${value}</button>`).join("")}</div></div><div class="movecues-survey-question movecues-survey-question--long_text" data-movecues-question-id="${detailId}" data-movecues-question-type="long_text"><label class="movecues-survey-question__label">What was the most challenging part?</label><textarea class="movecues-survey-input" data-movecues-question-input placeholder="Tell us more (optional)" maxlength="2000" aria-label="What was the most challenging part?"></textarea></div>` : `<p class="movecues-widget__body" data-movecues-content="body">Add more questions here, or use this as a simple follow-up slide.</p>`;
  const back = final ? `<button type="button" class="movecues-survey-button movecues-survey-button--back" data-movecues-survey-action="back">Back</button>` : "";
  const action = final ? "submit" : "next"; const label = final ? "Submit feedback" : "Next →";
  const html = `<section class="movecues-widget movecues-widget--survey" data-movecues-widget-type="survey" data-movecues-survey-step-id="${stepId}"><span class="movecues-widget__eyebrow">We'd love your feedback</span><h2 class="movecues-widget__heading" data-movecues-content="heading">${final ? "Anything else to share?" : "How easy was it to complete this task?"}</h2>${questions}<div class="movecues-survey-validation" role="status" aria-live="polite"></div><div class="movecues-survey-footer">${back}<div class="movecues-survey-progress" data-movecues-survey-progress><span>Step ${final ? 2 : 1} of 2</span><span class="movecues-survey-progress__track"><span data-movecues-survey-progress-bar></span></span></div><button type="button" class="movecues-survey-button" data-movecues-survey-action="${action}">${label}</button></div></section>`;
  const css = `.movecues-widget{box-sizing:border-box;width:100%;padding:36px;background:#fff;color:#111827;border:1px solid rgba(15,23,42,.1);border-radius:16px;font-family:ui-sans-serif,system-ui,sans-serif;box-shadow:0 24px 70px rgba(15,23,42,.22)}.movecues-widget .movecues-widget__eyebrow{display:block;margin-bottom:10px;color:#2563eb;font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}.movecues-widget .movecues-widget__heading{margin:0 0 26px;font-size:28px;line-height:1.2}.movecues-widget .movecues-widget__body{margin:0 0 28px;color:#64748b;line-height:1.6}.movecues-widget .movecues-survey-question{margin:0 0 24px}.movecues-widget .movecues-survey-question__label{display:block;margin:0 0 10px;font-size:14px;font-weight:650}.movecues-widget .movecues-survey-options{display:grid;grid-template-columns:repeat(5,minmax(44px,1fr));gap:9px}.movecues-widget .movecues-survey-option{min-height:46px;border:1px solid #dbe2ea;border-radius:10px;background:#fff;color:#334155;font:700 14px inherit;cursor:pointer}.movecues-widget .movecues-survey-option:hover,.movecues-widget .movecues-survey-option.is-selected{border-color:#2563eb;background:#eff6ff;color:#1d4ed8}.movecues-widget .movecues-survey-input{box-sizing:border-box;width:100%;min-height:110px;padding:12px 14px;resize:vertical;border:1px solid #dbe2ea;border-radius:10px;background:#fff;color:#111827;font:14px/1.5 inherit}.movecues-widget .movecues-survey-input:focus{outline:2px solid #bfdbfe;border-color:#2563eb}.movecues-widget .movecues-survey-validation{min-height:18px;color:#b91c1c;font-size:12px}.movecues-widget .movecues-survey-footer{display:flex;align-items:center;gap:12px;margin-top:10px}.movecues-widget .movecues-survey-progress{display:flex;flex:1;align-items:center;gap:12px;color:#64748b;font-size:12px}.movecues-widget .movecues-survey-progress__track{height:5px;flex:1;overflow:hidden;border-radius:99px;background:#e2e8f0}.movecues-widget [data-movecues-survey-progress-bar]{display:block;width:${final ? 100 : 50}%;height:100%;background:#2563eb}.movecues-widget .movecues-survey-button{border:0;border-radius:9px;padding:10px 16px;background:#2563eb;color:#fff;font:700 13px inherit;cursor:pointer}.movecues-widget .movecues-survey-button--back{background:#f1f5f9;color:#334155}@media(max-width:600px){.movecues-widget{padding:24px}.movecues-widget .movecues-widget__heading{font-size:23px}.movecues-widget .movecues-survey-footer{flex-wrap:wrap}.movecues-widget .movecues-survey-progress{order:-1;flex-basis:100%}}`;
  return { version: 1 as const, projectData: {}, html, css };
}

async function serializeExperience(db: Db, row: typeof experiences.$inferSelect) {
  const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, row.id)).orderBy(desc(experienceVersions.versionNumber));
  const draft = versions.find((version) => version.state === "draft") ?? null;
  const published = versions.find((version) => version.id === row.publishedVersionId) ?? null;
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    draftVersion: draft ? { ...draft, definition: draft.definition as ExperienceDefinition, createdAt: draft.createdAt.toISOString(), publishedAt: null } : null,
    publishedVersion: published ? { ...published, definition: published.definition as ExperienceDefinition, createdAt: published.createdAt.toISOString(), publishedAt: published.publishedAt?.toISOString() ?? null } : null,
  };
}

async function validateReferences(db: Db, siteId: string, definition: ExperienceDefinition, publishing = false): Promise<string | null> {
  for (const rule of definition.targeting.pageRules) {
    if (!rule.value.trim()) return "invalid_page_targeting";
  }
  if (definition.targeting.pageRules.length > 0 && !definition.targeting.pageRules.some((rule) => rule.kind === "include")) return "invalid_page_targeting";
  const audience = definition.targeting.audience;
  const segmentIds = audience.type === "segment" ? [audience.segmentId] : audience.type === "segment_rules" ? audience.conditions.map(condition => condition.segmentId) : [];
  if (isChecklistDefinition(definition)) for (const item of definition.items) if (item.completion.type === "segment") segmentIds.push(item.completion.segmentId);
  for (const segmentId of new Set(segmentIds)) { const [segment] = await db.select().from(segments).where(eq(segments.id, segmentId)).limit(1); if ((!segment && publishing) || (segment && segment.siteId !== siteId)) return "invalid_segment"; }
  if (isChecklistDefinition(definition)) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1); const origin = siteOrigin(site?.domain ?? null);
    for (const item of definition.items) if (item.action.type === "navigate" && /^https?:\/\//i.test(item.action.url) && (!origin || new URL(item.action.url).origin !== origin)) return "navigate_url_outside_site_domain";
    const completionGuideIds = new Set(definition.items.filter(item => item.completion.type === "guide_completed").map(item => (item.completion as { type: "guide_completed"; experienceId: string }).experienceId));
    const launchGuideIds = new Set(definition.items.filter(item => item.action.type === "launch_guide").map(item => (item.action as { type: "launch_guide"; experienceId: string }).experienceId));
    for (const guideId of new Set([...completionGuideIds, ...launchGuideIds])) {
      const [guide] = await db.select().from(experiences).where(eq(experiences.id, guideId)).limit(1);
      if ((!guide && publishing) || (guide && (guide.siteId !== siteId || guide.kind !== "guide"))) return "invalid_guide";
      if (publishing && guide && launchGuideIds.has(guideId) && (guide.status !== "published" || !guide.publishedVersionId)) return "guide_unavailable";
    }
  }
  return null;
}

function validatePublishRequirements(kind: ExperienceKind, widgetType: WidgetType | null, definition: ExperienceDefinition): string | null {
  if (kind === "guide") {
    if (!("steps" in definition) || definition.steps.some((step) => guideStepRequiresTarget(step) && !step.target)) return "target_required";
  } else if ((widgetType === "anchored_card" || widgetType === "hotspot") && (!("content" in definition) || !definition.target)) {
    return "target_required";
  }
  return null;
}

export function registerExperienceRoutes(app: FastifyInstance, db: Db) {
  const analyticsRangeSchema = z.object({ since: z.coerce.date().optional(), until: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
  const range = (value: { since?: Date; until?: Date }) => { const until = value.until ?? new Date(); return { since: value.since ?? new Date(until.getTime() - 30 * 86_400_000), until }; };

  app.get("/orgs/:orgId/sites/:siteId/experience-analytics", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string }; const site = await loadSiteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const parsed = analyticsRangeSchema.safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    return listExperienceAnalytics(db, site.id, range(parsed.data));
  });

  app.get("/orgs/:orgId/sites/:siteId/experiences/:experienceId/analytics", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string }; const site = await loadSiteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const parsed = analyticsRangeSchema.safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    const result = await getExperienceAnalytics(db, site.id, experienceId, range(parsed.data)); return result ? reply.send(result) : reply.code(404).send({ error: "experience_not_found" });
  });

  app.get("/orgs/:orgId/sites/:siteId/experiences/:experienceId/responses", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string }; const site = await loadSiteInOrg(db, siteId, request.membership!.orgId); if (!site) return reply.code(404).send({ error: "site_not_found" });
    const parsed = analyticsRangeSchema.safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    return listSurveyResponses(db, site.id, experienceId, range(parsed.data), parsed.data.limit, parsed.data.offset);
  });
  app.get("/orgs/:orgId/sites/:siteId/experiences", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const { kind, widgetType } = request.query as { kind?: string; widgetType?: string };
    if (kind && kind !== "guide" && kind !== "widget" && kind !== "checklist") return reply.code(400).send({ error: "invalid_kind" });
    if (widgetType && !SUPPORTED_WIDGET_TYPES.includes(widgetType as WidgetType)) return reply.code(400).send({ error: "invalid_widget_type" });
    if (widgetType && kind !== "widget") return reply.code(400).send({ error: "widget_type_requires_widget_kind" });
    const rows = await db.select().from(experiences).where(eq(experiences.siteId, site.id)).orderBy(desc(experiences.updatedAt));
    const filtered = rows.filter((row) => (!kind || row.kind === kind) && (!widgetType || row.widgetType === widgetType));
    return reply.send({ experiences: await Promise.all(filtered.map((row) => serializeExperience(db, row))) });
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const parsed = createExperienceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    if (await experienceNameExists(db, site.id, parsed.data.name)) return reply.code(409).send({ error: "experience_name_exists", message: "An experience with this name already exists." });

    let page: typeof pageDefinitions.$inferSelect | null = null;
    if (parsed.data.buildPageId) {
      [page] = await db.select().from(pageDefinitions).where(eq(pageDefinitions.id, parsed.data.buildPageId)).limit(1);
      if (!page || page.siteId !== site.id) return reply.code(400).send({ error: "invalid_build_page" });
    }
    const buildUrl = parsed.data.kind === "checklist" ? null : parsed.data.buildUrl ?? (page ? deriveBuildUrl(site.domain, page.rules as PageRule[]) : null);
    if (parsed.data.kind !== "checklist" && (!buildUrl || !urlBelongsToSite(buildUrl, site.domain))) return reply.code(400).send({ error: "build_url_outside_site_domain" });
    const initialPageRules = parsed.data.useBuildPageAsTarget
      ? page
        ? (page.rules as PageRule[])
        : [{ id: "build_page", kind: "include" as const, operator: "equals" as const, value: new URL(buildUrl!).pathname }]
      : [];
    const definition = parsed.data.kind === "checklist" ? initialChecklistDefinition(parsed.data.template as ChecklistPreset) : initialDefinition(parsed.data.kind, parsed.data.widgetType ?? null, initialPageRules);

    const [experience] = await db.insert(experiences).values({
      siteId: site.id,
      kind: parsed.data.kind,
      widgetType: parsed.data.kind === "widget" ? parsed.data.widgetType! : null,
      name: parsed.data.name,
      buildPageId: page?.id ?? null,
      buildUrl: buildUrl ?? null,
      createdBy: request.user!.id,
    }).returning();
    await db.insert(experienceVersions).values({ experienceId: experience.id, versionNumber: 1, state: "draft", definition, createdBy: request.user!.id });
    return reply.code(201).send(await serializeExperience(db, experience));
  });

  app.get("/orgs/:orgId/sites/:siteId/experiences/:experienceId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    return reply.send(await serializeExperience(db, row));
  });

  app.patch("/orgs/:orgId/sites/:siteId/experiences/:experienceId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    const parsed = updateDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    if (parsed.data.name && await experienceNameExists(db, site.id, parsed.data.name, row.id)) return reply.code(409).send({ error: "experience_name_exists", message: "An experience with this name already exists." });
    const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, row.id)).orderBy(desc(experienceVersions.versionNumber));
    const draft = versions.find((version) => version.state === "draft");
    if (!draft) return reply.code(409).send({ error: "draft_not_found" });
    if (parsed.data.definition !== undefined) {
      const definition = definitionSchemaFor(row.kind as ExperienceKind, row.widgetType).safeParse(parsed.data.definition);
      if (!definition.success) return reply.code(400).send({ error: "invalid_definition", details: { ...definition.error.flatten(), issues: definition.error.issues } });
      if (row.kind === "widget" && row.widgetType && !widgetSizeIsValid(row.widgetType as WidgetType, definition.data)) return reply.code(400).send({ error: "invalid_widget_size" });
      const referenceError = await validateReferences(db, site.id, definition.data, false);
      if (referenceError) return reply.code(400).send({ error: referenceError });
      await db.update(experienceVersions).set({ definition: definition.data }).where(eq(experienceVersions.id, draft.id));
    }
    const [updated] = await db.update(experiences).set({ ...(parsed.data.name ? { name: parsed.data.name } : {}), updatedAt: new Date() }).where(eq(experiences.id, row.id)).returning();
    return reply.send(await serializeExperience(db, updated));
  });

  app.delete("/orgs/:orgId/sites/:siteId/experiences/:experienceId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    await db.delete(experiences).where(eq(experiences.id, row.id));
    return reply.code(204).send();
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/publish", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, row.id)).orderBy(desc(experienceVersions.versionNumber));
    const draft = versions.find((version) => version.state === "draft");
    if (!draft) return reply.code(409).send({ error: "draft_not_found" });
    const checked = definitionSchemaFor(row.kind as ExperienceKind, row.widgetType).safeParse(draft.definition);
    if (!checked.success) return reply.code(400).send({ error: "invalid_definition", details: { ...checked.error.flatten(), issues: checked.error.issues } });
    if (row.kind === "widget" && row.widgetType && !widgetSizeIsValid(row.widgetType as WidgetType, checked.data)) return reply.code(400).send({ error: "invalid_widget_size" });
    const requirementError = validatePublishRequirements(row.kind as ExperienceKind, row.widgetType as WidgetType | null, checked.data);
    if (requirementError) return reply.code(400).send({ error: requirementError });
    const referenceError = await validateReferences(db, site.id, checked.data, true);
    if (referenceError) return reply.code(400).send({ error: referenceError });
    const now = new Date();
    await db.update(experienceVersions).set({ state: "published", publishedAt: now }).where(eq(experienceVersions.id, draft.id));
    await db.insert(experienceVersions).values({ experienceId: row.id, versionNumber: draft.versionNumber + 1, state: "draft", definition: checked.data, createdBy: request.user!.id });
    const [updated] = await db.update(experiences).set({ status: "published", publishedVersionId: draft.id, updatedAt: now }).where(eq(experiences.id, row.id)).returning();
    return reply.send(await serializeExperience(db, updated));
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/pause", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    const [updated] = await db.update(experiences).set({ status: "paused", updatedAt: new Date() }).where(eq(experiences.id, row.id)).returning();
    return reply.send(await serializeExperience(db, updated));
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/editor-sessions", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId } = request.params as { siteId: string; experienceId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const row = await loadExperience(db, site.id, experienceId);
    if (!row) return reply.code(404).send({ error: "experience_not_found" });
    if (row.kind === "checklist") return reply.code(400).send({ error: "checklist_live_editor_unsupported" });
    if (!row.buildUrl || !urlBelongsToSite(row.buildUrl, site.domain)) return reply.code(400).send({ error: "invalid_build_url" });
    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const [session] = await db.insert(experienceEditorSessions).values({ experienceId: row.id, siteId: site.id, dashboardUserId: request.user!.id, tokenHash, allowedOrigin: new URL(row.buildUrl).origin, expiresAt }).returning();
    const launch = new URL(row.buildUrl);
    launch.searchParams.set("movecues_editor_token", rawToken);
    return reply.code(201).send({ sessionId: session.id, launchUrl: launch.toString(), expiresAt: expiresAt.toISOString() });
  });

  app.post("/orgs/:orgId/sites/:siteId/experiences/:experienceId/editor-sessions/:sessionId/revoke", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, experienceId, sessionId } = request.params as { siteId: string; experienceId: string; sessionId: string };
    const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const experience = await loadExperience(db, site.id, experienceId);
    if (!experience) return reply.code(404).send({ error: "experience_not_found" });
    const [session] = await db.select().from(experienceEditorSessions).where(eq(experienceEditorSessions.id, sessionId)).limit(1);
    if (!session || session.experienceId !== experience.id) return reply.code(404).send({ error: "editor_session_not_found" });
    await db.update(experienceEditorSessions).set({ revokedAt: new Date() }).where(eq(experienceEditorSessions.id, session.id));
    return reply.code(204).send();
  });
}
