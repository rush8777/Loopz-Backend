import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { experienceEditorSessions, experienceEvents, experienceImpressions, experiences, experienceVersions, segments, sites, surveyResponses, trackedUsers } from "../db/schema.js";
import { env } from "../config.js";
import { signEditorAccessToken, verifyEditorAccessToken } from "../lib/auth.js";
import { createSurveyResponseSchema, definitionSchemaFor, impressionSchema, manifestQuerySchema, updateDraftSchema, updateSurveyResponseSchema } from "../lib/experiences/validation.js";
import type { ExperienceDefinition, ExperienceKind, ExperienceTargeting, SurveyAnswers, SurveyConfig, WidgetType } from "../lib/experiences/types.js";
import { widgetSizeIsValid } from "../lib/experiences/widgetSizing.js";
import { matchesRules } from "../lib/pages/pageMatcher.js";
import { evaluateSegment } from "../lib/segments/evaluator.js";
import type { SegmentDefinition } from "../lib/segments/types.js";
import { deliveredChecklist } from "./public-checklists.js";

function rawTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function requestOrigin(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (!origin || Array.isArray(origin)) return null;
  try { return new URL(origin).origin; } catch { return null; }
}

async function resolveTrackedUserId(db: Db, siteId: string, externalId?: string): Promise<string | null> {
  if (!externalId) return null;
  const [user] = await db.select().from(trackedUsers).where(and(eq(trackedUsers.siteId, siteId), eq(trackedUsers.externalUserId, externalId))).limit(1);
  return user?.id ?? null;
}

async function matchesAudience(db: Db, siteId: string, identityKey: string, audience: ExperienceTargeting["audience"]): Promise<boolean> {
  if (audience.type === "all") return true;
  const conditions = audience.type === "segment" ? [{ segmentId: audience.segmentId, operator: "matches" as const }] : audience.conditions;
  const results = await Promise.all(conditions.map(async (condition) => {
    const [segment] = await db.select().from(segments).where(eq(segments.id, condition.segmentId)).limit(1);
    if (!segment || segment.siteId !== siteId) return false;
    const member = (await evaluateSegment(db, siteId, segment.definition as SegmentDefinition)).has(identityKey);
    return condition.operator === "matches" ? member : !member;
  }));
  return audience.type === "segment_rules" && audience.logic === "any" ? results.some(Boolean) : results.every(Boolean);
}

function withoutPrivateTargeting(definition: ExperienceDefinition) {
  const { targeting: _targeting, ...presentation } = definition;
  return presentation;
}

function surveyAnswerError(survey: SurveyConfig, answers: SurveyAnswers, requireRequired: boolean): string | null {
  const questions = survey.steps.flatMap(step => step.questions);
  const byId = new Map(questions.map(question => [question.id, question]));
  for (const id of Object.keys(answers)) if (!byId.has(id)) return "unknown_question_id";
  for (const question of questions) {
    const answer = answers[question.id];
    const missing = answer === undefined || answer === "" || (Array.isArray(answer) && answer.length === 0);
    if (missing) { if (requireRequired && question.required) return `required:${question.id}`; continue; }
    if (question.type === "single_choice") {
      if (typeof answer !== "string" || !question.options.some(option => option.id === answer)) return `invalid_choice:${question.id}`;
    } else if (question.type === "multiple_choice") {
      if (!Array.isArray(answer) || new Set(answer).size !== answer.length || answer.some(value => !question.options.some(option => option.id === value))) return `invalid_choices:${question.id}`;
    } else if (question.type === "short_text" || question.type === "long_text") {
      if (typeof answer !== "string" || answer.length > (question.maxLength ?? 10_000)) return `invalid_text:${question.id}`;
    } else if (question.type === "rating") {
      if (typeof answer !== "number" || !Number.isInteger(answer) || answer < question.min || answer > question.max) return `invalid_rating:${question.id}`;
    } else if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer > 10) return `invalid_nps:${question.id}`;
  }
  return null;
}

async function validateEditorAccess(request: FastifyRequest, db: Db) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const payload = verifyEditorAccessToken(header.slice(7), env.JWT_SECRET);
    const origin = requestOrigin(request);
    if (!origin || origin !== payload.origin) return null;
    const [session] = await db.select().from(experienceEditorSessions).where(eq(experienceEditorSessions.id, payload.sub)).limit(1);
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.allowedOrigin !== origin || !session.usedAt) return null;
    return session;
  } catch {
    return null;
  }
}

export function registerPublicExperienceRoutes(app: FastifyInstance, db: Db) {
  app.get("/public/sites/:siteId/experiences", async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const query = manifestQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query", details: query.error.flatten() });
    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    let pagePath: string; let requestUrl: URL;
    try {
      const url = new URL(query.data.url); requestUrl = url;
      if (site.domain) {
        const siteOrigin = new URL(/^https?:\/\//i.test(site.domain) ? site.domain : `https://${site.domain}`).origin;
        if (url.origin !== siteOrigin) return reply.code(400).send({ error: "url_outside_site_domain" });
      }
      pagePath = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return reply.code(400).send({ error: "invalid_url" });
    }

    const trackedUserId = await resolveTrackedUserId(db, site.id, query.data.trackedUserId);
    const identityKey = trackedUserId ?? query.data.anonymousId;
    const rows = (await db.select().from(experiences).where(and(eq(experiences.siteId, site.id), eq(experiences.status, "published"))))
      .filter((row) => row.publishedVersionId);
    const eligible: Array<{ id: string; versionId: string; kind: string; widgetType: string | null; priority: number; interruptPolicy: "queue" | "interrupt"; impressionId?: string; definition: unknown }> = [];

    for (const experience of rows) {
      if (experience.kind === "checklist") continue;
      const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, experience.publishedVersionId!)).limit(1);
      if (!version || version.state !== "published") continue;
      const checked = definitionSchemaFor(experience.kind as ExperienceKind, experience.widgetType).safeParse(version.definition);
      if (!checked.success) continue;
      const definition = checked.data;
      const target = definition.targeting as ExperienceTargeting;
      const resumingGuide = experience.kind === "guide" && query.data.activeGuideId === experience.id && query.data.activeGuideVersionId === version.id;
      const now = new Date();
      if (target.schedule?.startsAt && now < new Date(target.schedule.startsAt)) continue;
      if (target.schedule?.endsAt && now >= new Date(target.schedule.endsAt)) continue;
      if (target.allowedOrigins?.length && !target.allowedOrigins.includes(requestUrl.origin)) continue;
      if (!resumingGuide && target.pageRules.length > 0 && !matchesRules(pagePath, target.pageRules)) continue;
      if (!resumingGuide && target.trigger.type === "custom_event" && query.data.trigger !== target.trigger.eventName) continue;
      if (!resumingGuide && target.trigger.type === "page_load" && query.data.trigger) continue;
      if (!resumingGuide && target.trigger.type === "manual") continue;
      if (!resumingGuide && !await matchesAudience(db, site.id, identityKey, target.audience)) continue;
      const impressions = await db.select().from(experienceImpressions).where(and(eq(experienceImpressions.siteId, site.id), eq(experienceImpressions.experienceId, experience.id)));
      const personImpressions = impressions.filter((item) => item.anonymousId === query.data.anonymousId || (trackedUserId && item.trackedUserId === trackedUserId));
      if (!resumingGuide && target.frequency.mode === "once" && personImpressions.length > 0) continue;
      if (!resumingGuide && target.frequency.mode === "once_per_session" && personImpressions.some((item) => item.sessionId === query.data.sessionId)) continue;
      if (!resumingGuide && target.frequency.maxImpressions && personImpressions.length >= target.frequency.maxImpressions) continue;
      if (!resumingGuide && target.frequency.cooldownHours && personImpressions.some((item) => item.shownAt.getTime() > Date.now() - target.frequency.cooldownHours! * 3600000)) continue;
      const activeImpression = resumingGuide ? personImpressions.find(item => item.versionId === version.id && item.sessionId === query.data.sessionId && !item.dismissedAt && !item.completedAt) : undefined;
      eligible.push({ id: experience.id, versionId: version.id, kind: experience.kind, widgetType: experience.widgetType, priority: target.priority, interruptPolicy: target.interruptPolicy ?? "queue", ...(activeImpression ? { impressionId: activeImpression.id } : {}), definition: withoutPrivateTargeting(definition) });
    }
    eligible.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const checklist = await deliveredChecklist(db, site, query.data);
    reply.header("Cache-Control", "private, no-store");
    return reply.send({ experiences: eligible, checklists: checklist ? [checklist] : [], hasChecklists: rows.some(row => row.kind === "checklist") });
  });

  app.post("/public/sites/:siteId/experience-events", async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const parsed = impressionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [experience] = await db.select().from(experiences).where(eq(experiences.id, parsed.data.experienceId)).limit(1);
    const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, parsed.data.versionId)).limit(1);
    if (!experience || experience.siteId !== site.id || !version || version.experienceId !== experience.id || experience.publishedVersionId !== version.id) {
      return reply.code(404).send({ error: "experience_not_found" });
    }
    const eventType = parsed.data.eventType ?? (parsed.data.event === "shown" ? "experience_shown" : parsed.data.event === "dismissed" ? (experience.kind === "guide" ? "guide_dismissed" : experience.widgetType === "survey" ? "survey_abandoned" : "widget_dismissed") : parsed.data.event === "completed" ? (experience.kind === "guide" ? "guide_completed" : experience.widgetType === "survey" ? "survey_submitted" : "widget_interacted") : "widget_interacted");
    if (parsed.data.event === "shown") {
      const trackedUserId = await resolveTrackedUserId(db, site.id, parsed.data.trackedUserId);
      const [impression] = await db.insert(experienceImpressions).values({
        siteId: site.id, experienceId: experience.id, versionId: version.id,
        anonymousId: parsed.data.anonymousId ?? null, trackedUserId, sessionId: parsed.data.sessionId ?? null,
        pageViewId: parsed.data.pageViewId ?? null, shownAt: new Date(), metadata: parsed.data.launchContext ?? null,
      }).returning();
      await db.insert(experienceEvents).values({
        siteId: site.id, experienceId: experience.id, versionId: version.id, impressionId: impression.id,
        eventType, anonymousId: parsed.data.anonymousId ?? null, trackedUserId,
        sessionId: parsed.data.sessionId ?? null, pageViewId: parsed.data.pageViewId ?? null,
        timestamp: new Date(parsed.data.timestamp),
      });
      return reply.code(201).send({ impressionId: impression.id });
    }
    if (!parsed.data.impressionId) return reply.code(400).send({ error: "impression_id_required" });
    const [impression] = await db.select().from(experienceImpressions).where(eq(experienceImpressions.id, parsed.data.impressionId)).limit(1);
    if (!impression || impression.siteId !== site.id || impression.experienceId !== experience.id) return reply.code(404).send({ error: "impression_not_found" });
    const now = new Date();
    const impressionUpdate = {
      ...(parsed.data.event === "dismissed" ? { dismissedAt: now } : {}),
      ...(parsed.data.event === "completed" ? { completedAt: now } : {}),
      ...(parsed.data.event === "action" ? { metadata: { action: parsed.data.action } } : {}),
    };
    if (Object.keys(impressionUpdate).length) await db.update(experienceImpressions).set(impressionUpdate).where(eq(experienceImpressions.id, impression.id));
    const duplicate = eventType === "guide_step_shown"
      ? (await db.select({ id: experienceEvents.id }).from(experienceEvents).where(and(eq(experienceEvents.impressionId, impression.id), eq(experienceEvents.eventType, eventType), eq(experienceEvents.stepId, parsed.data.stepId!))).limit(1))[0]
      : null;
    if (!duplicate) await db.insert(experienceEvents).values({
      siteId: site.id, experienceId: experience.id, versionId: version.id, impressionId: impression.id,
      eventType, stepId: parsed.data.stepId ?? null, stepIndex: parsed.data.stepIndex ?? null,
      anonymousId: parsed.data.anonymousId ?? impression.anonymousId, trackedUserId: impression.trackedUserId,
      sessionId: parsed.data.sessionId ?? impression.sessionId, pageViewId: parsed.data.pageViewId ?? impression.pageViewId,
      durationMs: parsed.data.durationMs ?? null, action: parsed.data.action ?? null, timestamp: new Date(parsed.data.timestamp),
    });
    return reply.code(204).send();
  });

  app.post("/public/sites/:siteId/survey-responses", async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const parsed = createSurveyResponseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [experience] = await db.select().from(experiences).where(eq(experiences.id, parsed.data.experienceId)).limit(1);
    const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, parsed.data.versionId)).limit(1);
    const [impression] = await db.select().from(experienceImpressions).where(eq(experienceImpressions.id, parsed.data.impressionId)).limit(1);
    const trackedUserId = await resolveTrackedUserId(db, site.id, parsed.data.trackedUserId);
    if (!experience || experience.siteId !== site.id || experience.widgetType !== "survey" || experience.publishedVersionId !== version?.id || version.experienceId !== experience.id || version.state !== "published") return reply.code(404).send({ error: "survey_not_found" });
    if (!impression || impression.siteId !== site.id || impression.experienceId !== experience.id || impression.versionId !== version.id || impression.anonymousId !== parsed.data.anonymousId || impression.sessionId !== parsed.data.sessionId || impression.trackedUserId !== trackedUserId) return reply.code(404).send({ error: "impression_not_found" });
    const checked = definitionSchemaFor("widget", "survey").safeParse(version.definition);
    if (!checked.success || !("content" in checked.data) || !checked.data.survey) return reply.code(404).send({ error: "survey_not_found" });
    const [existing] = await db.select().from(surveyResponses).where(eq(surveyResponses.impressionId, impression.id)).limit(1);
    if (existing) return reply.send({ responseId: existing.id, currentStepId: existing.currentStepId, answers: existing.answers, submittedAt: existing.submittedAt?.toISOString() ?? null, abandonedAt: existing.abandonedAt?.toISOString() ?? null });
    const now = new Date(); const firstStepId = checked.data.survey.steps[0].id;
    const [created] = await db.insert(surveyResponses).values({ siteId: site.id, experienceId: experience.id, versionId: version.id, impressionId: impression.id, anonymousId: parsed.data.anonymousId, trackedUserId, sessionId: parsed.data.sessionId, currentStepId: firstStepId, answers: {}, startedAt: now, updatedAt: now }).returning();
    return reply.code(201).send({ responseId: created.id, currentStepId: created.currentStepId, answers: created.answers, submittedAt: null, abandonedAt: null });
  });

  app.patch("/public/sites/:siteId/survey-responses/:responseId", async (request, reply) => {
    const { siteId, responseId } = request.params as { siteId: string; responseId: string };
    const parsed = updateSurveyResponseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [response] = await db.select().from(surveyResponses).where(eq(surveyResponses.id, responseId)).limit(1);
    const trackedUserId = await resolveTrackedUserId(db, site.id, parsed.data.trackedUserId);
    if (!response || response.siteId !== site.id || response.experienceId !== parsed.data.experienceId || response.versionId !== parsed.data.versionId || response.impressionId !== parsed.data.impressionId || response.anonymousId !== parsed.data.anonymousId || response.sessionId !== parsed.data.sessionId || response.trackedUserId !== trackedUserId) return reply.code(404).send({ error: "survey_response_not_found" });
    const [experience] = await db.select().from(experiences).where(eq(experiences.id, response.experienceId)).limit(1);
    const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, response.versionId)).limit(1);
    if (!experience || experience.widgetType !== "survey" || experience.publishedVersionId !== version?.id || version.state !== "published") return reply.code(409).send({ error: "survey_not_published" });
    const checked = definitionSchemaFor("widget", "survey").safeParse(version.definition);
    const survey = checked.success && "content" in checked.data ? checked.data.survey : undefined;
    if (!survey) return reply.code(409).send({ error: "invalid_survey_definition" });
    if (parsed.data.currentStepId && !survey.steps.some(step => step.id === parsed.data.currentStepId)) return reply.code(400).send({ error: "invalid_step_id" });
    const answerError = surveyAnswerError(survey, parsed.data.answers, parsed.data.submitted === true);
    if (answerError) return reply.code(400).send({ error: "invalid_answers", detail: answerError });
    const now = new Date();
    await db.update(surveyResponses).set({ answers: parsed.data.answers, currentStepId: parsed.data.currentStepId ?? response.currentStepId, updatedAt: now, ...(parsed.data.submitted ? { submittedAt: response.submittedAt ?? now, abandonedAt: null } : {}), ...(parsed.data.abandoned && !response.submittedAt ? { abandonedAt: response.abandonedAt ?? now } : {}) }).where(eq(surveyResponses.id, response.id));
    return reply.code(204).send();
  });

  app.post("/public/experience-editor/exchange", async (request, reply) => {
    const token = typeof (request.body as { token?: unknown } | null)?.token === "string" ? (request.body as { token: string }).token : "";
    const origin = requestOrigin(request);
    if (!token || token.length > 200 || !origin) return reply.code(400).send({ error: "invalid_editor_session" });
    const [session] = await db.select().from(experienceEditorSessions).where(eq(experienceEditorSessions.tokenHash, rawTokenHash(token))).limit(1);
    if (!session || session.usedAt || session.revokedAt || session.expiresAt <= new Date() || session.allowedOrigin !== origin) return reply.code(401).send({ error: "invalid_or_expired_editor_session" });
    await db.update(experienceEditorSessions).set({ usedAt: new Date() }).where(eq(experienceEditorSessions.id, session.id));
    const accessToken = signEditorAccessToken({ sub: session.id, scope: "experience_editor", origin }, env.JWT_SECRET);
    return reply.send({ sessionId: session.id, accessToken, expiresAt: session.expiresAt.toISOString() });
  });

  app.get("/public/experience-editor/:sessionId/draft", async (request, reply) => {
    const session = await validateEditorAccess(request, db);
    const { sessionId } = request.params as { sessionId: string };
    if (!session || session.id !== sessionId) return reply.code(401).send({ error: "invalid_editor_access" });
    const [experience] = await db.select().from(experiences).where(eq(experiences.id, session.experienceId)).limit(1);
    const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, session.experienceId));
    const draft = versions.find((item) => item.state === "draft");
    if (!experience || !draft) return reply.code(404).send({ error: "draft_not_found" });
    return reply.send({ experience: { id: experience.id, name: experience.name, kind: experience.kind, widgetType: experience.widgetType }, version: { id: draft.id, versionNumber: draft.versionNumber, definition: draft.definition } });
  });

  app.patch("/public/experience-editor/:sessionId/draft", async (request, reply) => {
    const session = await validateEditorAccess(request, db);
    const { sessionId } = request.params as { sessionId: string };
    if (!session || session.id !== sessionId) return reply.code(401).send({ error: "invalid_editor_access" });
    const [experience] = await db.select().from(experiences).where(eq(experiences.id, session.experienceId)).limit(1);
    if (!experience) return reply.code(404).send({ error: "experience_not_found" });
    const parsed = updateDraftSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.definition === undefined) return reply.code(400).send({ error: "invalid_body" });
    const definition = definitionSchemaFor(experience.kind as ExperienceKind, experience.widgetType).safeParse(parsed.data.definition);
    if (!definition.success) return reply.code(400).send({ error: "invalid_definition", details: { ...definition.error.flatten(), issues: definition.error.issues } });
    if (experience.kind === "widget" && experience.widgetType && !widgetSizeIsValid(experience.widgetType as WidgetType, definition.data)) return reply.code(400).send({ error: "invalid_widget_size" });
    const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, experience.id));
    const draft = versions.find((item) => item.state === "draft");
    if (!draft) return reply.code(404).send({ error: "draft_not_found" });
    await db.update(experienceVersions).set({ definition: definition.data }).where(eq(experienceVersions.id, draft.id));
    await db.update(experiences).set({ updatedAt: new Date() }).where(eq(experiences.id, experience.id));
    return reply.send({ version: { id: draft.id, versionNumber: draft.versionNumber, definition: definition.data } });
  });
}
