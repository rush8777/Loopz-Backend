import { and, eq, gte, sql } from "drizzle-orm";
import { env } from "../../config.js";
import { aiProviderUsage, themeCaptureRequests } from "../../db/schema.js";
import { fallbackTheme, generateTheme } from "./designSystem.js";
const timeoutMs = 42_000;
export function providerSignal(reply) {
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded)
        controller.abort(); };
    reply.raw.once("close", abort);
    const limit = AbortSignal.timeout(timeoutMs);
    return {
        signal: AbortSignal.any([limit, controller.signal]),
        disconnected: controller.signal,
        limit,
        cleanup: () => reply.raw.off("close", abort),
    };
}
export async function themeAiUsageAvailable(db, orgId) {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [usage] = await db.select({ tokens: sql `coalesce(sum(${aiProviderUsage.totalTokens}), 0)` })
        .from(aiProviderUsage).where(and(eq(aiProviderUsage.orgId, orgId), gte(aiProviderUsage.createdAt, dayStart)));
    return (usage?.tokens ?? 0) < env.AI_DAILY_TOKEN_LIMIT;
}
export async function recordThemeAiUsage(db, scope, result) {
    await db.insert(aiProviderUsage).values({
        ...scope, provider: result.provider, model: result.model,
        promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, totalTokens: result.usage.totalTokens,
    });
}
export function designResponse(capture, legacy) {
    const job = capture.designJob;
    if (job?.status === "ready")
        return { status: "ready", proposal: job.proposal };
    if (job?.status === "failed")
        return { status: "failed", reason: job.reason, fallback: job.fallback ?? fallbackTheme(capture.designEvidence ?? undefined, legacy) };
    if (job?.status === "working" && job.startedAt > Date.now() - timeoutMs - 15_000)
        return { status: "working" };
    return { status: "awaiting_generation" };
}
export function snapshotImportedDesign(capture, fallbackSelected = false) {
    const job = capture.designJob;
    if (job?.status === "ready" && !fallbackSelected)
        return job.proposal;
    if (job?.status !== "ready" && job?.status !== "failed")
        return;
    return {
        tokens: job.fallback ?? fallbackTheme(capture.designEvidence ?? undefined),
        explanation: "This design uses the captured styling and Movcues’ component defaults.",
        assumptions: [],
    };
}
export async function runThemeImport(input) {
    const { db, scope, provider, capture, legacy, retry, reply } = input;
    const prior = designResponse(capture, legacy);
    if (prior.status === "ready" || prior.status === "working" || prior.status === "failed" && !retry)
        return prior;
    const startedAt = Date.now();
    const id = crypto.randomUUID();
    const ownsCapture = and(eq(themeCaptureRequests.id, capture.id), eq(themeCaptureRequests.siteId, scope.siteId));
    const [claimed] = await db.update(themeCaptureRequests).set({ designJob: { status: "working", id, startedAt } }).where(and(ownsCapture, sql `(${themeCaptureRequests.designJob} IS NULL OR
      (json_extract(${themeCaptureRequests.designJob}, '$.status') = 'working' AND json_extract(${themeCaptureRequests.designJob}, '$.startedAt') <= ${startedAt - timeoutMs - 15_000}) OR
      (json_extract(${themeCaptureRequests.designJob}, '$.status') = 'failed' AND ${retry ? 1 : 0} = 1))`)).returning();
    if (!claimed) {
        const [latest] = await db.select().from(themeCaptureRequests).where(ownsCapture).limit(1);
        return latest ? designResponse(latest, legacy) : { status: "awaiting_generation" };
    }
    const abort = providerSignal(reply);
    const fallback = fallbackTheme(claimed.designEvidence ?? undefined, legacy);
    let job = { status: "failed", reason: "provider_error", fallback };
    try {
        if (!provider)
            job = { status: "failed", reason: "unavailable", fallback };
        else if (!await themeAiUsageAvailable(db, scope.orgId))
            job = { status: "failed", reason: "daily_limit", fallback };
        else {
            const generated = await generateTheme(provider, fallback, claimed.designEvidence ?? undefined, abort.signal);
            await recordThemeAiUsage(db, scope, generated.result);
            abort.signal.throwIfAborted();
            try {
                job = { status: "ready", proposal: generated.proposal(), fallback };
            }
            catch {
                job = { status: "failed", reason: "invalid_design", fallback };
            }
        }
    }
    catch (error) {
        if (abort.disconnected.aborted)
            job = null;
        else if (abort.limit.aborted)
            job = { status: "failed", reason: "timeout", fallback };
        else
            reply.request.log.warn({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Theme generation failed");
    }
    finally {
        abort.cleanup();
        await db.update(themeCaptureRequests).set({ designJob: job }).where(and(ownsCapture, sql `json_extract(${themeCaptureRequests.designJob}, '$.id') = ${id}`));
    }
    return designResponse({ ...claimed, designJob: job }, legacy);
}
//# sourceMappingURL=designJobs.js.map