import { and, eq, gte } from "drizzle-orm";
import { aiProviderUsage, experiences, experienceVersions, guideCaptureCheckpoints, memberships, sites } from "../db/schema.js";
import { env } from "../config.js";
import { hasAtLeastRole, isValidRole } from "../lib/roles.js";
import { assertSubscriptionActive } from "../lib/entitlements/service.js";
import { sendEntitlementError } from "../lib/entitlements/http.js";
import { DraftWriteError, saveExperienceDraft } from "../lib/experiences/draftWrites.js";
import { isPendingGuideCapture } from "../lib/experiences/guideCaptureContract.js";
import { captureApplyRequestSchema, captureCheckpointSchema, captureCheckpointWriteSchema, captureCompileRequestSchema, capturePlanRequestSchema, capturePreviewTicket, compileCapturedGuide, matchesCaptureTicket, parseCapturePlan, requestCapturePlan } from "../lib/experiences/guideCapture.js";
import { guideDefinitionSchema } from "../lib/experiences/validation.js";
const base = "/public/experience-editor/:sessionId/guide-capture";
export function registerGuideCaptureRoutes(app, db, provider, validateAccess) {
    const access = async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const session = await validateAccess(request);
        if (!session || session.id !== request.params.sessionId) {
            reply.code(401).send({ error: "invalid_editor_access" });
            return null;
        }
        const [[experience], [site], [draft], [checkpoint]] = await Promise.all([
            db.select().from(experiences).where(and(eq(experiences.id, session.experienceId), eq(experiences.siteId, session.siteId))).limit(1),
            db.select().from(sites).where(eq(sites.id, session.siteId)).limit(1),
            db.select().from(experienceVersions).where(and(eq(experienceVersions.experienceId, session.experienceId), eq(experienceVersions.state, "draft"))).limit(1),
            db.select().from(guideCaptureCheckpoints).where(and(eq(guideCaptureCheckpoints.experienceId, session.experienceId), eq(guideCaptureCheckpoints.editorSessionId, session.id))).limit(1),
        ]);
        if (!experience || !site || experience.createdBy !== session.dashboardUserId || !checkpoint) {
            reply.code(403).send({ error: "capture_session_unavailable", message: "Reopen Guided Capture from the dashboard to continue." });
            return null;
        }
        if (experience.kind !== "guide" || experience.builderMode !== "onsite" || !draft || !isPendingGuideCapture(draft.definition)) {
            reply.code(409).send({ error: "builder_mode_mismatch" });
            return null;
        }
        const [member] = await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.orgId, site.orgId), eq(memberships.userId, session.dashboardUserId))).limit(1);
        if (!member || !isValidRole(member.role) || !hasAtLeastRole(member.role, "ADMIN")) {
            reply.code(403).send({ error: "invalid_editor_access" });
            return null;
        }
        try {
            await assertSubscriptionActive(db, site.orgId);
        }
        catch (error) {
            sendEntitlementError(reply, error);
            return null;
        }
        return { session, experience, site, draft, checkpoint };
    };
    app.get(base, async (request, reply) => {
        const context = await access(request, reply);
        if (!context)
            return;
        return { ...captureCheckpointSchema.parse(context.checkpoint.checkpoint), checkpointRevision: context.checkpoint.revision, revision: context.draft.revision };
    });
    app.put(base, async (request, reply) => {
        const context = await access(request, reply);
        if (!context)
            return;
        const parsed = captureCheckpointWriteSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_capture", message: "A captured element has an unsupported selector or page path." });
        const { checkpointRevision, ...checkpoint } = parsed.data;
        const [saved] = await db.update(guideCaptureCheckpoints).set({ checkpoint, revision: checkpointRevision + 1 })
            .where(and(eq(guideCaptureCheckpoints.experienceId, context.experience.id), eq(guideCaptureCheckpoints.editorSessionId, context.session.id), eq(guideCaptureCheckpoints.revision, checkpointRevision)))
            .returning({ checkpointRevision: guideCaptureCheckpoints.revision });
        if (!saved)
            return reply.code(409).send({ error: "capture_conflict", message: "The checkpoint changed. Reopen Guided Capture to recover the latest selections." });
        return saved;
    });
    app.post(`${base}/plan`, { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (request, reply) => {
        const context = await access(request, reply);
        if (!context)
            return;
        if (!provider)
            return reply.code(503).send({ error: "ai_disabled", message: "Geo is not configured on the backend." });
        const input = capturePlanRequestSchema.safeParse(request.body);
        if (!input.success)
            return reply.code(400).send({ error: "invalid_plan_request" });
        if (input.data.revision !== context.draft.revision || input.data.checkpointRevision !== context.checkpoint.revision) {
            return reply.code(409).send({ error: "capture_conflict", message: "The guide or capture changed. Refresh the checkpoint and generate a new plan." });
        }
        const { targets, observations } = captureCheckpointSchema.parse(context.checkpoint.checkpoint);
        if (!targets.length)
            return reply.code(400).send({ error: "capture_empty" });
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        const used = await db.select({ tokens: aiProviderUsage.totalTokens }).from(aiProviderUsage)
            .where(and(eq(aiProviderUsage.orgId, context.site.orgId), gte(aiProviderUsage.createdAt, dayStart)));
        if (used.reduce((sum, row) => sum + row.tokens, 0) >= env.AI_DAILY_TOKEN_LIMIT) {
            return reply.code(429).send({ error: "ai_daily_limit", message: "This workspace reached its daily AI usage limit." });
        }
        const disconnected = new AbortController();
        const abort = () => disconnected.abort();
        reply.raw.once("close", abort);
        const deadline = AbortSignal.timeout(env.EDITOR_AI_DEADLINE_MS);
        try {
            const result = await requestCapturePlan(provider, input.data.prompt, targets, AbortSignal.any([disconnected.signal, deadline]), observations);
            await db.insert(aiProviderUsage).values({
                orgId: context.site.orgId, siteId: context.site.id, userId: context.session.dashboardUserId,
                provider: result.provider, model: result.model, ...result.usage,
            });
            try {
                return { plan: parseCapturePlan(result.text, targets, observations) };
            }
            catch {
                return reply.code(502).send({ error: "invalid_plan", message: "Geo returned an invalid guide plan. Your capture is saved. Try planning again." });
            }
        }
        catch {
            if (disconnected.signal.aborted)
                return;
            return reply.code(deadline.aborted ? 504 : 502).send({ error: "guide_plan_failed", message: "Geo could not complete the plan. Your captured elements are saved." });
        }
        finally {
            reply.raw.removeListener("close", abort);
        }
    });
    for (const action of ["preview", "apply"]) {
        app.post(`${base}/${action}`, async (request, reply) => {
            const context = await access(request, reply);
            if (!context)
                return;
            const input = (action === "apply" ? captureApplyRequestSchema : captureCompileRequestSchema).safeParse(request.body);
            if (!input.success)
                return reply.code(400).send({ error: "invalid_plan", message: "Check the guide plan for incomplete or unsupported values." });
            const { revision, checkpointRevision, plan } = input.data;
            if (revision !== context.draft.revision || checkpointRevision !== context.checkpoint.revision) {
                return reply.code(409).send({ error: "capture_conflict", message: "The guide or capture changed. Refresh the checkpoint and generate a new preview." });
            }
            const { targets } = captureCheckpointSchema.parse(context.checkpoint.checkpoint);
            if (!targets.length)
                return reply.code(400).send({ error: "capture_empty" });
            let definition;
            try {
                definition = compileCapturedGuide(guideDefinitionSchema.parse(context.draft.definition), plan, targets);
            }
            catch (error) {
                return reply.code(400).send({ error: "invalid_plan", message: error instanceof Error ? error.message : "The generated guide is invalid." });
            }
            const previewTicket = capturePreviewTicket(env.JWT_SECRET, [context.site.orgId, context.site.id, context.experience.id, context.session.id], [revision, checkpointRevision], definition);
            if (action === "preview")
                return { definition, previewTicket };
            if (!("previewTicket" in input.data) || !matchesCaptureTicket(input.data.previewTicket, previewTicket)) {
                return reply.code(409).send({ error: "stale_preview", message: "Preview the current plan before applying it." });
            }
            try {
                const saved = await saveExperienceDraft(db, context.site, context.experience, context.draft, definition, revision, { sessionId: context.session.id, checkpointRevision });
                return { version: { id: saved.id, versionNumber: saved.versionNumber, revision: saved.revision, definition: saved.definition } };
            }
            catch (error) {
                if (error instanceof DraftWriteError)
                    return reply.code(error.status).send({ error: error.message, message: "The guide could not be applied. Refresh the capture if the draft changed." });
                return sendEntitlementError(reply, error);
            }
        });
    }
}
//# sourceMappingURL=guide-capture.js.map