import { surveyPath } from "../lib/experiences/surveyLogic.js";
import { DraftWriteError, saveExperienceDraft } from "../lib/experiences/draftWrites.js";
import { sendEntitlementError } from "../lib/entitlements/http.js";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import { runInTransaction } from "../db/transaction.js";
import { aiConversations, aiMessages, aiProviderUsage, aiToolExecutions, experienceEditorSessions, experienceEvents, experienceImpressions, experiences, experienceVersions, segments, sites, siteStylePresets, siteThemes, surveyResponses, trackedUsers } from "../db/schema.js";
import { env } from "../config.js";
import { signEditorAccessToken, verifyEditorAccessToken } from "../lib/auth.js";
import { createSurveyResponseSchema, definitionSchemaFor, impressionSchema, manifestQuerySchema, updateDraftSchema, updateSurveyResponseSchema } from "../lib/experiences/validation.js";
import { widgetSizeIsValid } from "../lib/experiences/widgetSizing.js";
import { matchesRules } from "../lib/pages/pageMatcher.js";
import { evaluateSegment } from "../lib/segments/evaluator.js";
import { deliveredChecklist } from "./public-checklists.js";
import { getOrganizationSubscription, subscriptionIsActive } from "../lib/entitlements/subscription.js";
import { siteThemeTokensSchema } from "../lib/themes/validation.js";
import { editorAiRequestSchema, runEditorAiTurn, validateEditorProposalAgainstDraft } from "../lib/ai/editor.js";
import { createConfiguredAiProvider } from "../lib/ai/providers/index.js";
function rawTokenHash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}
function requestOrigin(request) {
    const origin = request.headers.origin;
    if (!origin || Array.isArray(origin))
        return null;
    try {
        return new URL(origin).origin;
    }
    catch {
        return null;
    }
}
function sameJson(left, right) {
    return isDeepStrictEqual(left, right);
}
/** GrapesJS experiences may still use the live session as a placement/targeting
 * companion, but that session must never become an alternate content builder. */
function grapesLiveEditorChangeAllowed(previous, next) {
    const previousCopy = structuredClone(previous);
    const nextCopy = structuredClone(next);
    if ("steps" in previousCopy && "steps" in nextCopy) {
        if (previousCopy.steps.length !== nextCopy.steps.length)
            return false;
        previousCopy.steps.forEach(step => { delete step.target; step.behavior = {}; });
        nextCopy.steps.forEach(step => { delete step.target; step.behavior = {}; });
        return sameJson(previousCopy, nextCopy);
    }
    if ("content" in previousCopy && "content" in nextCopy) {
        delete previousCopy.target;
        delete nextCopy.target;
        previousCopy.behavior = {};
        nextCopy.behavior = {};
        if (previousCopy.survey && nextCopy.survey) {
            previousCopy.survey.steps.forEach(step => { delete step.behavior; });
            nextCopy.survey.steps.forEach(step => { delete step.behavior; });
        }
        return sameJson(previousCopy, nextCopy);
    }
    return false;
}
async function resolveTrackedUserId(db, siteId, externalId) {
    if (!externalId)
        return null;
    const [user] = await db.select().from(trackedUsers).where(and(eq(trackedUsers.siteId, siteId), eq(trackedUsers.externalUserId, externalId))).limit(1);
    return user?.id ?? null;
}
async function matchesAudience(db, siteId, identityKey, audience) {
    if (audience.type === "all")
        return true;
    const conditions = audience.type === "segment" ? [{ segmentId: audience.segmentId, operator: "matches" }] : audience.conditions;
    const results = await Promise.all(conditions.map(async (condition) => {
        const [segment] = await db.select().from(segments).where(eq(segments.id, condition.segmentId)).limit(1);
        if (!segment || segment.siteId !== siteId)
            return false;
        const member = (await evaluateSegment(db, siteId, segment.definition)).has(identityKey);
        return condition.operator === "matches" ? member : !member;
    }));
    return audience.type === "segment_rules" && audience.logic === "any" ? results.some(Boolean) : results.every(Boolean);
}
function withoutPrivateTargeting(definition) {
    const { targeting: _targeting, ...presentation } = definition;
    return presentation;
}
function surveyAnswerError(survey, answers, requireRequired) {
    const path = surveyPath(survey, answers);
    const questions = survey.steps.flatMap(step => step.questions);
    const permitted = new Set(path.flatMap(index => survey.steps[index].questions.map(question => question.id)));
    if (requireRequired && Object.keys(answers).some(id => !permitted.has(id)))
        return "answer_on_skipped_step";
    const byId = new Map(questions.map(question => [question.id, question]));
    for (const id of Object.keys(answers))
        if (!byId.has(id))
            return "unknown_question_id";
    for (const question of questions) {
        const answer = answers[question.id];
        const missing = answer === undefined || answer === "" || (Array.isArray(answer) && answer.length === 0);
        if (missing) {
            if (requireRequired && permitted.has(question.id) && question.required)
                return `required:${question.id}`;
            continue;
        }
        if (question.type === "single_choice") {
            if (typeof answer !== "string" || !question.options.some(option => option.id === answer))
                return `invalid_choice:${question.id}`;
        }
        else if (question.type === "multiple_choice") {
            if (!Array.isArray(answer) || new Set(answer).size !== answer.length || answer.some(value => !question.options.some(option => option.id === value)))
                return `invalid_choices:${question.id}`;
        }
        else if (question.type === "short_text" || question.type === "long_text") {
            if (typeof answer !== "string" || answer.length > (question.maxLength ?? 10_000))
                return `invalid_text:${question.id}`;
        }
        else if (question.type === "rating") {
            if (typeof answer !== "number" || !Number.isInteger(answer) || answer < question.min || answer > question.max)
                return `invalid_rating:${question.id}`;
        }
        else if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer > 10)
            return `invalid_nps:${question.id}`;
    }
    return null;
}
/** Called inside a database write transaction; legacy SDK event posts share this dedupe. */
async function recordSurveyEvent(db, identity, eventType, stepId, stepIndex) {
    const [existing] = await db.select({ id: experienceEvents.id }).from(experienceEvents).where(and(eq(experienceEvents.impressionId, identity.impressionId), eq(experienceEvents.eventType, eventType), stepId ? eq(experienceEvents.stepId, stepId) : isNull(experienceEvents.stepId))).limit(1);
    if (!existing)
        await db.insert(experienceEvents).values({ ...identity, eventType, stepId: stepId ?? null, stepIndex: stepIndex ?? null, timestamp: new Date() });
}
async function validateEditorAccess(request, db) {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer "))
        return null;
    try {
        const payload = verifyEditorAccessToken(header.slice(7), env.JWT_SECRET);
        const origin = requestOrigin(request);
        if (!origin || origin !== payload.origin)
            return null;
        const [session] = await db.select().from(experienceEditorSessions).where(eq(experienceEditorSessions.id, payload.sub)).limit(1);
        if (!session || session.revokedAt || session.expiresAt <= new Date() || session.allowedOrigin !== origin || !session.usedAt)
            return null;
        const [experience] = await db.select().from(experiences).where(eq(experiences.id, session.experienceId)).limit(1);
        const [site] = await db.select().from(sites).where(eq(sites.id, session.siteId)).limit(1);
        if (!site || !experience || experience.siteId !== site.id)
            return null;
        return session;
    }
    catch {
        return null;
    }
}
export function registerPublicExperienceRoutes(app, db, providerOverride) {
    const aiProvider = providerOverride === undefined ? createConfiguredAiProvider() : providerOverride;
    app.get("/public/sites/:siteId/experiences", async (request, reply) => {
        const { siteId } = request.params;
        const query = manifestQuerySchema.safeParse(request.query);
        if (!query.success)
            return reply.code(400).send({ error: "invalid_query", details: query.error.flatten() });
        const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        if (!subscriptionIsActive(await getOrganizationSubscription(db, site.orgId))) {
            reply.header("Cache-Control", "private, no-store");
            return reply.send({ experiences: [], checklists: [], hasChecklists: false });
        }
        let pagePath;
        let requestUrl;
        try {
            const url = new URL(query.data.url);
            requestUrl = url;
            if (site.domain) {
                const siteOrigin = new URL(/^https?:\/\//i.test(site.domain) ? site.domain : `https://${site.domain}`).origin;
                if (url.origin !== siteOrigin)
                    return reply.code(400).send({ error: "url_outside_site_domain" });
            }
            pagePath = `${url.pathname}${url.search}${url.hash}`;
        }
        catch {
            return reply.code(400).send({ error: "invalid_url" });
        }
        const trackedUserId = await resolveTrackedUserId(db, site.id, query.data.trackedUserId);
        const identityKey = trackedUserId ?? query.data.anonymousId;
        const rows = (await db.select().from(experiences).where(and(eq(experiences.siteId, site.id), eq(experiences.status, "published"))))
            .filter((row) => row.publishedVersionId);
        const eligible = [];
        for (const experience of rows) {
            if (experience.kind === "checklist")
                continue;
            const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, experience.publishedVersionId)).limit(1);
            if (!version || version.state !== "published")
                continue;
            const checked = definitionSchemaFor(experience.kind, experience.widgetType).safeParse(version.definition);
            if (!checked.success)
                continue;
            const definition = checked.data;
            const target = definition.targeting;
            const resumingGuide = experience.kind === "guide" && query.data.activeGuideId === experience.id && query.data.activeGuideVersionId === version.id;
            const now = new Date();
            if (target.schedule?.startsAt && now < new Date(target.schedule.startsAt))
                continue;
            if (target.schedule?.endsAt && now >= new Date(target.schedule.endsAt))
                continue;
            if (target.allowedOrigins?.length && !target.allowedOrigins.includes(requestUrl.origin))
                continue;
            if (!resumingGuide && target.pageRules.length > 0 && !matchesRules(pagePath, target.pageRules))
                continue;
            const impressions = await db.select().from(experienceImpressions).where(and(eq(experienceImpressions.siteId, site.id), eq(experienceImpressions.experienceId, experience.id)));
            const personImpressions = impressions.filter((item) => item.anonymousId === query.data.anonymousId || (trackedUserId && item.trackedUserId === trackedUserId));
            const surveyImpression = experience.widgetType === "survey" ? personImpressions.find(item => item.versionId === version.id && item.sessionId === query.data.sessionId && item.anonymousId === query.data.anonymousId && !item.completedAt && !item.dismissedAt) : undefined;
            const resuming = resumingGuide || Boolean(surveyImpression);
            if (!resuming && target.trigger.type === "custom_event" && query.data.trigger !== target.trigger.eventName)
                continue;
            if (!resuming && target.trigger.type === "page_load" && query.data.trigger)
                continue;
            if (!resuming && target.trigger.type === "manual")
                continue;
            if (!resumingGuide && !await matchesAudience(db, site.id, identityKey, target.audience))
                continue;
            if (!resuming && target.frequency.mode === "once" && personImpressions.length > 0)
                continue;
            if (!resuming && target.frequency.mode === "once_per_session" && personImpressions.some((item) => item.sessionId === query.data.sessionId))
                continue;
            if (!resuming && target.frequency.maxImpressions && personImpressions.length >= target.frequency.maxImpressions)
                continue;
            if (!resuming && target.frequency.cooldownHours && personImpressions.some((item) => item.shownAt.getTime() > Date.now() - target.frequency.cooldownHours * 3600000))
                continue;
            const activeImpression = surveyImpression ?? (resumingGuide ? personImpressions.find(item => item.versionId === version.id && item.sessionId === query.data.sessionId && !item.dismissedAt && !item.completedAt) : undefined);
            eligible.push({ id: experience.id, versionId: version.id, kind: experience.kind, widgetType: experience.widgetType, priority: target.priority, interruptPolicy: target.interruptPolicy ?? "queue", ...(activeImpression ? { impressionId: activeImpression.id } : {}), definition: withoutPrivateTargeting(definition) });
        }
        eligible.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
        const checklist = await deliveredChecklist(db, site, query.data);
        reply.header("Cache-Control", "private, no-store");
        return reply.send({ experiences: eligible, checklists: checklist ? [checklist] : [], hasChecklists: rows.some(row => row.kind === "checklist") });
    });
    app.post("/public/sites/:siteId/experience-events", async (request, reply) => {
        const { siteId } = request.params;
        const parsed = impressionSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const [experience] = await db.select().from(experiences).where(eq(experiences.id, parsed.data.experienceId)).limit(1);
        const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, parsed.data.versionId)).limit(1);
        if (!experience || experience.siteId !== site.id || !version || version.experienceId !== experience.id || experience.publishedVersionId !== version.id) {
            return reply.code(404).send({ error: "experience_not_found" });
        }
        const eventType = experience.widgetType === "survey" && parsed.data.event === "completed" ? "survey_submitted" : experience.widgetType === "survey" && parsed.data.event === "dismissed" ? "survey_abandoned" : parsed.data.eventType ?? (parsed.data.event === "shown" ? "experience_shown" : parsed.data.event === "dismissed" ? (experience.kind === "guide" ? "guide_dismissed" : experience.widgetType === "survey" ? "survey_abandoned" : "widget_dismissed") : parsed.data.event === "completed" ? (experience.kind === "guide" ? "guide_completed" : experience.widgetType === "survey" ? "survey_submitted" : "widget_interacted") : "widget_interacted");
        if (parsed.data.event === "shown" && experience.widgetType === "survey" && parsed.data.anonymousId && parsed.data.sessionId) {
            const trackedUserId = await resolveTrackedUserId(db, site.id, parsed.data.trackedUserId);
            const result = await runInTransaction(db, async (tx) => {
                const [existing] = await tx.select().from(experienceImpressions).where(and(eq(experienceImpressions.siteId, site.id), eq(experienceImpressions.experienceId, experience.id), eq(experienceImpressions.versionId, version.id), eq(experienceImpressions.anonymousId, parsed.data.anonymousId), eq(experienceImpressions.sessionId, parsed.data.sessionId), isNull(experienceImpressions.completedAt), isNull(experienceImpressions.dismissedAt))).limit(1);
                const impression = existing ?? (await tx.insert(experienceImpressions).values({ siteId: site.id, experienceId: experience.id, versionId: version.id, anonymousId: parsed.data.anonymousId, trackedUserId, sessionId: parsed.data.sessionId, pageViewId: parsed.data.pageViewId ?? null, shownAt: new Date() }).returning())[0];
                await recordSurveyEvent(tx, { siteId: site.id, experienceId: experience.id, versionId: version.id, impressionId: impression.id, anonymousId: impression.anonymousId, trackedUserId: impression.trackedUserId, sessionId: impression.sessionId }, "experience_shown");
                return { impressionId: impression.id, created: !existing };
            });
            return reply.code(result.created ? 201 : 200).send({ impressionId: result.impressionId });
        }
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
        if (!parsed.data.impressionId)
            return reply.code(400).send({ error: "impression_id_required" });
        const [impression] = await db.select().from(experienceImpressions).where(eq(experienceImpressions.id, parsed.data.impressionId)).limit(1);
        if (!impression || impression.siteId !== site.id || impression.experienceId !== experience.id)
            return reply.code(404).send({ error: "impression_not_found" });
        if (experience.widgetType === "survey" && eventType.startsWith("survey_")) {
            if (impression.versionId !== version.id || impression.anonymousId !== parsed.data.anonymousId || impression.sessionId !== parsed.data.sessionId)
                return reply.code(404).send({ error: "impression_not_found" });
            const [response] = await db.select().from(surveyResponses).where(eq(surveyResponses.impressionId, impression.id)).limit(1);
            if (!response || (eventType === "survey_submitted" && !response.submittedAt) || (eventType === "survey_abandoned" && !response.abandonedAt))
                return reply.code(409).send({ error: "survey_state_not_saved" });
            await runInTransaction(db, tx => recordSurveyEvent(tx, { siteId: site.id, experienceId: experience.id, versionId: version.id, impressionId: impression.id, anonymousId: impression.anonymousId, trackedUserId: impression.trackedUserId, sessionId: impression.sessionId }, eventType, parsed.data.stepId, parsed.data.stepIndex));
            return reply.code(204).send();
        }
        const now = new Date();
        const impressionUpdate = {
            ...(parsed.data.event === "dismissed" ? { dismissedAt: now } : {}),
            ...(parsed.data.event === "completed" ? { completedAt: now } : {}),
            ...(parsed.data.event === "action" ? { metadata: { action: parsed.data.action } } : {}),
        };
        if (Object.keys(impressionUpdate).length)
            await db.update(experienceImpressions).set(impressionUpdate).where(eq(experienceImpressions.id, impression.id));
        const duplicate = eventType === "guide_step_shown"
            ? (await db.select({ id: experienceEvents.id }).from(experienceEvents).where(and(eq(experienceEvents.impressionId, impression.id), eq(experienceEvents.eventType, eventType), eq(experienceEvents.stepId, parsed.data.stepId))).limit(1))[0]
            : null;
        if (!duplicate)
            await db.insert(experienceEvents).values({
                siteId: site.id, experienceId: experience.id, versionId: version.id, impressionId: impression.id,
                eventType, stepId: parsed.data.stepId ?? null, stepIndex: parsed.data.stepIndex ?? null,
                anonymousId: parsed.data.anonymousId ?? impression.anonymousId, trackedUserId: impression.trackedUserId,
                sessionId: parsed.data.sessionId ?? impression.sessionId, pageViewId: parsed.data.pageViewId ?? impression.pageViewId,
                durationMs: parsed.data.durationMs ?? null, action: parsed.data.action ?? null, timestamp: new Date(parsed.data.timestamp),
            });
        return reply.code(204).send();
    });
    app.post("/public/sites/:siteId/survey-responses", async (request, reply) => {
        const { siteId } = request.params;
        const parsed = createSurveyResponseSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const [experience] = await db.select().from(experiences).where(eq(experiences.id, parsed.data.experienceId)).limit(1);
        const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, parsed.data.versionId)).limit(1);
        const [impression] = await db.select().from(experienceImpressions).where(eq(experienceImpressions.id, parsed.data.impressionId)).limit(1);
        const trackedUserId = await resolveTrackedUserId(db, site.id, parsed.data.trackedUserId);
        if (!experience || experience.siteId !== site.id || experience.widgetType !== "survey" || experience.publishedVersionId !== version?.id || version.experienceId !== experience.id || version.state !== "published")
            return reply.code(404).send({ error: "survey_not_found" });
        if (!impression || impression.siteId !== site.id || impression.experienceId !== experience.id || impression.versionId !== version.id || impression.anonymousId !== parsed.data.anonymousId || impression.sessionId !== parsed.data.sessionId || impression.trackedUserId !== trackedUserId)
            return reply.code(404).send({ error: "impression_not_found" });
        const checked = definitionSchemaFor("widget", "survey").safeParse(version.definition);
        if (!checked.success || !("content" in checked.data) || !checked.data.survey)
            return reply.code(404).send({ error: "survey_not_found" });
        const survey = checked.data.survey;
        const result = await runInTransaction(db, async (tx) => {
            const [created] = await tx.insert(surveyResponses).values({ siteId: site.id, experienceId: experience.id, versionId: version.id, impressionId: impression.id, anonymousId: parsed.data.anonymousId, trackedUserId, sessionId: parsed.data.sessionId, currentStepId: survey.steps[0].id, answers: {}, startedAt: new Date(), updatedAt: new Date() }).onConflictDoNothing({ target: surveyResponses.impressionId }).returning();
            const response = created ?? (await tx.select().from(surveyResponses).where(eq(surveyResponses.impressionId, impression.id)).limit(1))[0];
            await recordSurveyEvent(tx, { siteId: site.id, experienceId: experience.id, versionId: version.id, impressionId: impression.id, anonymousId: impression.anonymousId, trackedUserId: impression.trackedUserId, sessionId: impression.sessionId }, "survey_started");
            return { response, created: Boolean(created) };
        });
        const response = result.response;
        return reply.code(result.created ? 201 : 200).send({ responseId: response.id, currentStepId: response.currentStepId, answers: response.answers, submittedAt: response.submittedAt?.toISOString() ?? null, abandonedAt: response.abandonedAt?.toISOString() ?? null });
    });
    app.patch("/public/sites/:siteId/survey-responses/:responseId", async (request, reply) => {
        const { siteId, responseId } = request.params;
        const parsed = updateSurveyResponseSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const [response] = await db.select().from(surveyResponses).where(eq(surveyResponses.id, responseId)).limit(1);
        const trackedUserId = await resolveTrackedUserId(db, site.id, parsed.data.trackedUserId);
        if (!response || response.siteId !== site.id || response.experienceId !== parsed.data.experienceId || response.versionId !== parsed.data.versionId || response.impressionId !== parsed.data.impressionId || response.anonymousId !== parsed.data.anonymousId || response.sessionId !== parsed.data.sessionId || response.trackedUserId !== trackedUserId)
            return reply.code(404).send({ error: "survey_response_not_found" });
        const [experience] = await db.select().from(experiences).where(eq(experiences.id, response.experienceId)).limit(1);
        const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, response.versionId)).limit(1);
        if (!experience || experience.widgetType !== "survey" || experience.publishedVersionId !== version?.id || version.state !== "published")
            return reply.code(409).send({ error: "survey_not_published" });
        const checked = definitionSchemaFor("widget", "survey").safeParse(version.definition);
        const survey = checked.success && "content" in checked.data ? checked.data.survey : undefined;
        if (!survey)
            return reply.code(409).send({ error: "invalid_survey_definition" });
        if (parsed.data.currentStepId && !survey.steps.some(step => step.id === parsed.data.currentStepId))
            return reply.code(400).send({ error: "invalid_step_id" });
        const path = surveyPath(survey, parsed.data.answers);
        const current = parsed.data.currentStepId ?? response.currentStepId;
        if (!path.some(index => survey.steps[index].id === current) || (parsed.data.submitted && survey.steps[path.at(-1)].id !== current))
            return reply.code(400).send({ error: "invalid_response_path" });
        const currentIndex = survey.steps.findIndex(step => step.id === current);
        const priorRequiredMissing = path.filter(index => index < currentIndex).some(index => survey.steps[index].questions.some(question => question.required && (parsed.data.answers[question.id] === undefined || parsed.data.answers[question.id] === "" || (Array.isArray(parsed.data.answers[question.id]) && !parsed.data.answers[question.id].length))));
        if (!parsed.data.abandoned && priorRequiredMissing)
            return reply.code(400).send({ error: "required_prior_question" });
        const answerError = surveyAnswerError(survey, parsed.data.answers, parsed.data.submitted === true);
        if (answerError)
            return reply.code(400).send({ error: "invalid_answers", detail: answerError });
        const status = await runInTransaction(db, async (tx) => {
            const [fresh] = await tx.select().from(surveyResponses).where(eq(surveyResponses.id, response.id)).limit(1);
            if (fresh.submittedAt)
                return parsed.data.submitted && sameJson(fresh.answers, parsed.data.answers) ? 204 : 409;
            const now = new Date();
            await tx.update(surveyResponses).set({ answers: parsed.data.answers, currentStepId: parsed.data.currentStepId ?? fresh.currentStepId, updatedAt: now, ...(parsed.data.submitted ? { submittedAt: now, abandonedAt: null } : {}), ...(parsed.data.abandoned ? { abandonedAt: fresh.abandonedAt ?? now } : { abandonedAt: null }) }).where(eq(surveyResponses.id, fresh.id));
            const identity = { siteId: fresh.siteId, experienceId: fresh.experienceId, versionId: fresh.versionId, impressionId: fresh.impressionId, anonymousId: fresh.anonymousId, trackedUserId: fresh.trackedUserId, sessionId: fresh.sessionId };
            const from = survey.steps.findIndex(step => step.id === fresh.currentStepId);
            const to = survey.steps.findIndex(step => step.id === parsed.data.currentStepId);
            if (to > from && from >= 0)
                await recordSurveyEvent(tx, identity, "survey_step_completed", survey.steps[from].id, from);
            if (parsed.data.submitted || parsed.data.abandoned) {
                if (parsed.data.submitted && to >= 0)
                    await recordSurveyEvent(tx, identity, "survey_step_completed", survey.steps[to].id, to);
                await recordSurveyEvent(tx, identity, parsed.data.submitted ? "survey_submitted" : "survey_abandoned");
                await tx.update(experienceImpressions).set(parsed.data.submitted ? { completedAt: now } : { dismissedAt: fresh.abandonedAt ?? now }).where(eq(experienceImpressions.id, fresh.impressionId));
            }
            return 204;
        });
        if (status === 409)
            return reply.code(409).send({ error: "survey_already_submitted" });
        return reply.code(204).send();
    });
    app.post("/public/experience-editor/exchange", async (request, reply) => {
        const token = typeof request.body?.token === "string" ? request.body.token : "";
        const origin = requestOrigin(request);
        if (!token || token.length > 200 || !origin)
            return reply.code(400).send({ error: "invalid_editor_session" });
        const [session] = await db.select().from(experienceEditorSessions).where(eq(experienceEditorSessions.tokenHash, rawTokenHash(token))).limit(1);
        if (!session || session.usedAt || session.revokedAt || session.expiresAt <= new Date() || session.allowedOrigin !== origin)
            return reply.code(401).send({ error: "invalid_or_expired_editor_session" });
        await db.update(experienceEditorSessions).set({ usedAt: new Date() }).where(eq(experienceEditorSessions.id, session.id));
        const accessToken = signEditorAccessToken({ sub: session.id, scope: "experience_editor", origin }, env.JWT_SECRET);
        return reply.send({ sessionId: session.id, accessToken, expiresAt: session.expiresAt.toISOString() });
    });
    app.get("/public/experience-editor/:sessionId/draft", async (request, reply) => {
        const session = await validateEditorAccess(request, db);
        const { sessionId } = request.params;
        if (!session || session.id !== sessionId)
            return reply.code(401).send({ error: "invalid_editor_access" });
        const [experience] = await db.select().from(experiences).where(eq(experiences.id, session.experienceId)).limit(1);
        const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, session.experienceId));
        const draft = versions.find((item) => item.state === "draft");
        if (!experience || !draft)
            return reply.code(404).send({ error: "draft_not_found" });
        const [theme] = await db.select({ activeTokens: siteThemes.activeTokens }).from(siteThemes).where(eq(siteThemes.siteId, session.siteId)).limit(1);
        const stylePresets = await db.select({ id: siteStylePresets.id, name: siteStylePresets.name, tokens: siteStylePresets.tokens }).from(siteStylePresets).where(eq(siteStylePresets.siteId, session.siteId)).orderBy(desc(siteStylePresets.updatedAt)).limit(20);
        const references = {
            guides: experience.kind === "checklist" ? await db.select({ id: experiences.id, name: experiences.name, status: experiences.status }).from(experiences).where(and(eq(experiences.siteId, session.siteId), eq(experiences.kind, "guide"))).limit(200) : [],
            segments: experience.kind === "checklist" ? await db.select({ id: segments.id, name: segments.name }).from(segments).where(eq(segments.siteId, session.siteId)).limit(200) : [],
            stylePresets,
            siteTheme: theme?.activeTokens ?? null,
        };
        return reply.send({ references, experience: { id: experience.id, name: experience.name, kind: experience.kind, widgetType: experience.widgetType, builderMode: experience.builderMode }, version: { id: draft.id, versionNumber: draft.versionNumber, revision: draft.revision, definition: draft.definition } });
    });
    app.patch("/public/experience-editor/:sessionId/draft", async (request, reply) => {
        const session = await validateEditorAccess(request, db);
        const { sessionId } = request.params;
        if (!session || session.id !== sessionId)
            return reply.code(401).send({ error: "invalid_editor_access" });
        const [experience] = await db.select().from(experiences).where(eq(experiences.id, session.experienceId)).limit(1);
        if (!experience)
            return reply.code(404).send({ error: "experience_not_found" });
        const parsed = updateDraftSchema.safeParse(request.body);
        if (!parsed.success || parsed.data.definition === undefined)
            return reply.code(400).send({ error: "invalid_body" });
        const definition = definitionSchemaFor(experience.kind, experience.widgetType).safeParse(parsed.data.definition);
        if (!definition.success)
            return reply.code(400).send({ error: "invalid_definition", details: { ...definition.error.flatten(), issues: definition.error.issues } });
        if (experience.kind === "widget" && experience.widgetType && !widgetSizeIsValid(experience.widgetType, definition.data))
            return reply.code(400).send({ error: "invalid_widget_size" });
        const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, experience.id));
        const draft = versions.find((item) => item.state === "draft");
        if (!draft)
            return reply.code(404).send({ error: "draft_not_found" });
        if (draft.revision !== parsed.data.revision)
            return reply.code(409).send({ error: "draft_conflict", currentRevision: draft.revision });
        if (experience.builderMode === "grapesjs" && !grapesLiveEditorChangeAllowed(draft.definition, definition.data))
            return reply.code(409).send({ error: "builder_mode_mismatch" });
        const [site] = await db.select().from(sites).where(eq(sites.id, experience.siteId)).limit(1);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        try {
            const saved = await saveExperienceDraft(db, site, experience, draft, definition.data, parsed.data.revision);
            return reply.send({ version: { id: saved.id, versionNumber: saved.versionNumber, revision: saved.revision, definition: saved.definition } });
        }
        catch (error) {
            if (error instanceof DraftWriteError)
                return reply.code(error.status).send({ error: error.message });
            return sendEntitlementError(reply, error);
        }
    });
    app.post("/public/experience-editor/:sessionId/ai/chat", { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (request, reply) => {
        const session = await validateEditorAccess(request, db);
        const { sessionId } = request.params;
        if (!session || session.id !== sessionId)
            return reply.code(401).send({ error: "invalid_editor_access" });
        if (!aiProvider)
            return reply.code(503).send({ error: "ai_disabled", message: "Movcues AI is not configured on the backend." });
        const parsed = editorAiRequestSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const [experience] = await db.select().from(experiences).where(and(eq(experiences.id, session.experienceId), eq(experiences.siteId, session.siteId))).limit(1);
        const [site] = await db.select().from(sites).where(eq(sites.id, session.siteId)).limit(1);
        if (!experience || !site)
            return reply.code(404).send({ error: "experience_not_found" });
        if (experience.builderMode !== "onsite" || !["widget", "guide", "checklist"].includes(experience.kind))
            return reply.code(409).send({ error: "ai_editor_unsupported" });
        const guideContext = "guide" in parsed.data.context;
        const surveyContext = "steps" in parsed.data.context;
        const checklistContext = "checklist" in parsed.data.context;
        if (parsed.data.context.experience.id !== experience.id || parsed.data.context.experience.widgetType !== experience.widgetType || guideContext !== (experience.kind === "guide") || surveyContext !== (experience.widgetType === "survey") || checklistContext !== (experience.kind === "checklist"))
            return reply.code(409).send({ error: "stale_editor_context" });
        const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, experience.id));
        const draft = versions.find(item => item.state === "draft");
        if (!draft || draft.revision !== parsed.data.revision)
            return reply.code(409).send({ error: "draft_conflict", currentRevision: draft?.revision });
        const serverResources = checklistContext ? {
            guides: await db.select({ id: experiences.id, name: experiences.name, status: experiences.status }).from(experiences).where(and(eq(experiences.siteId, session.siteId), eq(experiences.kind, "guide"))).limit(200),
            segments: await db.select({ id: segments.id, name: segments.name }).from(segments).where(eq(segments.siteId, session.siteId)).limit(200),
        } : undefined;
        if (checklistContext)
            try {
                validateEditorProposalAgainstDraft(draft.definition, parsed.data, { summary: "Validate Checklist context", operations: [{ type: "update_checklist_behavior", patch: {} }] }, serverResources);
            }
            catch {
                return reply.code(409).send({ error: "stale_editor_context" });
            }
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        const usage = await db.select({ totalTokens: aiProviderUsage.totalTokens }).from(aiProviderUsage).where(and(eq(aiProviderUsage.orgId, site.orgId), gte(aiProviderUsage.createdAt, dayStart)));
        if (usage.reduce((total, row) => total + row.totalTokens, 0) >= env.AI_DAILY_TOKEN_LIMIT)
            return reply.code(429).send({ error: "ai_daily_limit", message: "This workspace reached its daily AI usage limit." });
        let conversation = parsed.data.conversationId ? (await db.select().from(aiConversations).where(and(eq(aiConversations.id, parsed.data.conversationId), eq(aiConversations.siteId, site.id), eq(aiConversations.userId, session.dashboardUserId))).limit(1))[0] : undefined;
        if (parsed.data.conversationId && !conversation)
            return reply.code(404).send({ error: "conversation_not_found" });
        if (!conversation)
            [conversation] = await db.insert(aiConversations).values({ orgId: site.orgId, siteId: site.id, userId: session.dashboardUserId, title: `Builder: ${experience.name}`.slice(0, 120) }).returning();
        const now = new Date();
        const [userMessage] = await db.insert(aiMessages).values({ conversationId: conversation.id, role: "user", content: parsed.data.prompt, createdAt: now }).returning();
        const [execution] = await db.insert(aiToolExecutions).values({
            conversationId: conversation.id,
            messageId: userMessage.id,
            toolName: "live_editor_generation",
            status: "running",
            inputSummary: { promptLength: parsed.data.prompt.length, revision: parsed.data.revision, selectionKind: parsed.data.context.selection.kind },
            startedAt: now,
        }).returning();
        try {
            const history = await db.select({ role: aiMessages.role, content: aiMessages.content }).from(aiMessages).where(eq(aiMessages.conversationId, conversation.id)).orderBy(desc(aiMessages.createdAt)).limit(10);
            const result = await runEditorAiTurn(aiProvider, parsed.data, history.reverse());
            if (result.proposal)
                validateEditorProposalAgainstDraft(draft.definition, parsed.data, result.proposal, serverResources);
            await Promise.all([
                db.insert(aiMessages).values({ conversationId: conversation.id, role: "assistant", content: result.markdown, proposal: result.proposal, createdAt: new Date() }),
                db.insert(aiProviderUsage).values({ orgId: site.orgId, siteId: site.id, userId: session.dashboardUserId, conversationId: conversation.id, provider: result.generation.provider, model: result.generation.model, promptTokens: result.generation.usage.promptTokens, completionTokens: result.generation.usage.completionTokens, totalTokens: result.generation.usage.totalTokens }),
                db.update(aiToolExecutions).set({ status: "completed", outputSummary: { proposalOperations: result.proposal?.operations.length ?? 0 }, completedAt: new Date() }).where(eq(aiToolExecutions.id, execution.id)),
                db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversation.id)),
            ]);
            return { conversationId: conversation.id, revision: draft.revision, markdown: result.markdown, proposal: result.proposal };
        }
        catch (error) {
            request.log.error({ err: error, sessionId }, "Editor AI turn failed");
            const failure = error instanceof Error && error.message.trim()
                ? error.message
                : "ai_generation_failed";
            await db.update(aiToolExecutions).set({ status: "failed", errorCode: failure, completedAt: new Date() }).where(eq(aiToolExecutions.id, execution.id));
            return reply.code(502).send({ error: "ai_generation_failed", conversationId: conversation.id, message: `AI request failed: ${failure}. Your message was preserved; please retry.` });
        }
    });
    app.post("/public/experience-editor/:sessionId/style-presets", async (request, reply) => {
        const session = await validateEditorAccess(request, db);
        const { sessionId } = request.params;
        if (!session || session.id !== sessionId)
            return reply.code(401).send({ error: "invalid_editor_access" });
        const parsed = z.object({ name: z.string().trim().min(1).max(80), tokens: siteThemeTokensSchema }).strict().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body" });
        const count = await db.select({ id: siteStylePresets.id }).from(siteStylePresets).where(eq(siteStylePresets.siteId, session.siteId));
        if (count.length >= 20)
            return reply.code(409).send({ error: "style_preset_limit" });
        try {
            const [preset] = await db.insert(siteStylePresets).values({ siteId: session.siteId, name: parsed.data.name, tokens: parsed.data.tokens, createdBy: session.dashboardUserId }).returning();
            return reply.code(201).send({ preset: { id: preset.id, name: preset.name, tokens: preset.tokens } });
        }
        catch {
            return reply.code(409).send({ error: "style_preset_name_exists" });
        }
    });
    app.patch("/public/experience-editor/:sessionId/style-presets/:presetId", async (request, reply) => {
        const session = await validateEditorAccess(request, db);
        const { sessionId, presetId } = request.params;
        if (!session || session.id !== sessionId)
            return reply.code(401).send({ error: "invalid_editor_access" });
        const parsed = z.object({ name: z.string().trim().min(1).max(80) }).strict().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body" });
        const [preset] = await db.select().from(siteStylePresets).where(and(eq(siteStylePresets.id, presetId), eq(siteStylePresets.siteId, session.siteId))).limit(1);
        if (!preset)
            return reply.code(404).send({ error: "style_preset_not_found" });
        try {
            const [updated] = await db.update(siteStylePresets).set({ name: parsed.data.name, updatedAt: new Date() }).where(eq(siteStylePresets.id, preset.id)).returning();
            return reply.send({ preset: { id: updated.id, name: updated.name, tokens: updated.tokens } });
        }
        catch {
            return reply.code(409).send({ error: "style_preset_name_exists" });
        }
    });
    app.delete("/public/experience-editor/:sessionId/style-presets/:presetId", async (request, reply) => {
        const session = await validateEditorAccess(request, db);
        const { sessionId, presetId } = request.params;
        if (!session || session.id !== sessionId)
            return reply.code(401).send({ error: "invalid_editor_access" });
        const [preset] = await db.select().from(siteStylePresets).where(and(eq(siteStylePresets.id, presetId), eq(siteStylePresets.siteId, session.siteId))).limit(1);
        if (!preset)
            return reply.code(404).send({ error: "style_preset_not_found" });
        await db.delete(siteStylePresets).where(eq(siteStylePresets.id, preset.id));
        return reply.code(204).send();
    });
}
//# sourceMappingURL=public-experiences.js.map