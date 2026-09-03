import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { experienceEditorSessions, experienceImpressions, experiences, experienceVersions, segments, sites, trackedUsers } from "../db/schema.js";
import { env } from "../config.js";
import { signEditorAccessToken, verifyEditorAccessToken } from "../lib/auth.js";
import { definitionSchemaFor, impressionSchema, manifestQuerySchema, updateDraftSchema } from "../lib/experiences/validation.js";
import { matchesRules } from "../lib/pages/pageMatcher.js";
import { evaluateSegment } from "../lib/segments/evaluator.js";
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
async function resolveTrackedUserId(db, siteId, externalId) {
    if (!externalId)
        return null;
    const [user] = await db.select().from(trackedUsers).where(and(eq(trackedUsers.siteId, siteId), eq(trackedUsers.externalUserId, externalId))).limit(1);
    return user?.id ?? null;
}
function withoutPrivateTargeting(definition) {
    const { targeting: _targeting, ...presentation } = definition;
    return presentation;
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
        return session;
    }
    catch {
        return null;
    }
}
export function registerPublicExperienceRoutes(app, db) {
    app.get("/public/sites/:siteId/experiences", async (request, reply) => {
        const { siteId } = request.params;
        const query = manifestQuerySchema.safeParse(request.query);
        if (!query.success)
            return reply.code(400).send({ error: "invalid_query", details: query.error.flatten() });
        const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        let pagePath;
        try {
            const url = new URL(query.data.url);
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
            const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, experience.publishedVersionId)).limit(1);
            if (!version || version.state !== "published")
                continue;
            const checked = definitionSchemaFor(experience.kind).safeParse(version.definition);
            if (!checked.success)
                continue;
            const definition = checked.data;
            const target = definition.targeting;
            if (target.pageRules.length > 0 && !matchesRules(pagePath, target.pageRules))
                continue;
            if (target.trigger.type === "custom_event" && query.data.trigger !== target.trigger.eventName)
                continue;
            if (target.trigger.type === "page_load" && query.data.trigger)
                continue;
            if (target.audience.type === "segment") {
                const [segment] = await db.select().from(segments).where(eq(segments.id, target.audience.segmentId)).limit(1);
                if (!segment || segment.siteId !== site.id)
                    continue;
                const members = await evaluateSegment(db, site.id, segment.definition);
                if (!members.has(identityKey))
                    continue;
            }
            const impressions = await db.select().from(experienceImpressions).where(and(eq(experienceImpressions.siteId, site.id), eq(experienceImpressions.experienceId, experience.id)));
            const personImpressions = impressions.filter((item) => item.anonymousId === query.data.anonymousId || (trackedUserId && item.trackedUserId === trackedUserId));
            if (target.frequency.mode === "once" && personImpressions.length > 0)
                continue;
            if (target.frequency.mode === "once_per_session" && personImpressions.some((item) => item.sessionId === query.data.sessionId))
                continue;
            if (target.frequency.maxImpressions && personImpressions.length >= target.frequency.maxImpressions)
                continue;
            if (target.frequency.cooldownHours && personImpressions.some((item) => item.shownAt.getTime() > Date.now() - target.frequency.cooldownHours * 3600000))
                continue;
            eligible.push({ id: experience.id, versionId: version.id, kind: experience.kind, widgetType: experience.widgetType, priority: target.priority, definition: withoutPrivateTargeting(definition) });
        }
        eligible.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
        reply.header("Cache-Control", "private, no-store");
        return reply.send({ experiences: eligible });
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
        if (parsed.data.event === "shown") {
            const trackedUserId = await resolveTrackedUserId(db, site.id, parsed.data.trackedUserId);
            const [impression] = await db.insert(experienceImpressions).values({
                siteId: site.id, experienceId: experience.id, versionId: version.id,
                anonymousId: parsed.data.anonymousId ?? null, trackedUserId, sessionId: parsed.data.sessionId ?? null,
                pageViewId: parsed.data.pageViewId ?? null, shownAt: new Date(),
            }).returning();
            return reply.code(201).send({ impressionId: impression.id });
        }
        if (!parsed.data.impressionId)
            return reply.code(400).send({ error: "impression_id_required" });
        const [impression] = await db.select().from(experienceImpressions).where(eq(experienceImpressions.id, parsed.data.impressionId)).limit(1);
        if (!impression || impression.siteId !== site.id || impression.experienceId !== experience.id)
            return reply.code(404).send({ error: "impression_not_found" });
        const now = new Date();
        await db.update(experienceImpressions).set({
            ...(parsed.data.event === "dismissed" ? { dismissedAt: now } : {}),
            ...(parsed.data.event === "completed" ? { completedAt: now } : {}),
            ...(parsed.data.event === "action" ? { metadata: { action: parsed.data.action } } : {}),
        }).where(eq(experienceImpressions.id, impression.id));
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
        return reply.send({ experience: { id: experience.id, name: experience.name, kind: experience.kind, widgetType: experience.widgetType }, version: { id: draft.id, versionNumber: draft.versionNumber, definition: draft.definition } });
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
        const definition = definitionSchemaFor(experience.kind).safeParse(parsed.data.definition);
        if (!definition.success)
            return reply.code(400).send({ error: "invalid_definition", details: definition.error.flatten() });
        const versions = await db.select().from(experienceVersions).where(eq(experienceVersions.experienceId, experience.id));
        const draft = versions.find((item) => item.state === "draft");
        if (!draft)
            return reply.code(404).send({ error: "draft_not_found" });
        await db.update(experienceVersions).set({ definition: definition.data }).where(eq(experienceVersions.id, draft.id));
        await db.update(experiences).set({ updatedAt: new Date() }).where(eq(experiences.id, experience.id));
        return reply.send({ version: { id: draft.id, versionNumber: draft.versionNumber, definition: definition.data } });
    });
}
//# sourceMappingURL=public-experiences.js.map