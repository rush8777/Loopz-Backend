import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { auditLogs, sites, siteThemes, themeCaptureRequests } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { siteThemeTokensSchema, themeCapturePayloadSchema } from "../lib/themes/validation.js";
export const THEME_CAPTURE_TTL_MS = 5 * 60 * 1000;
function siteOrigin(domain) {
    if (!domain)
        return null;
    try {
        return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin;
    }
    catch {
        return null;
    }
}
async function siteInOrg(db, siteId, orgId) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    return site?.orgId === orgId ? site : null;
}
function captureStatus(capture, now = new Date()) {
    return {
        id: capture.id,
        status: capture.completedAt ? "received" : capture.expiresAt <= now ? "expired" : capture.errorCode === "origin_mismatch" ? "origin_mismatch" : "pending",
        expiresAt: capture.expiresAt,
        receivedAt: capture.completedAt,
        errorCode: capture.errorCode,
    };
}
export function registerThemeRoutes(app, db) {
    app.get("/orgs/:orgId/sites/:siteId/theme", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await siteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const [theme] = await db.select().from(siteThemes).where(eq(siteThemes.siteId, site.id)).limit(1);
        const [capture] = await db.select().from(themeCaptureRequests).where(eq(themeCaptureRequests.siteId, site.id)).orderBy(desc(themeCaptureRequests.createdAt)).limit(1);
        return reply.send({
            active: theme?.activeTokens ? { tokens: theme.activeTokens, updatedAt: theme.activeUpdatedAt } : null,
            candidate: theme?.candidateTokens ? { captureId: theme.candidateCaptureId, tokens: theme.candidateTokens, evidence: theme.candidateEvidence, origin: theme.candidateOrigin, capturedAt: theme.candidateCapturedAt } : null,
            capture: capture ? captureStatus(capture) : null,
        });
    });
    app.post("/orgs/:orgId/sites/:siteId/theme-captures", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await siteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        if (!siteOrigin(site.domain))
            return reply.code(409).send({ error: "site_domain_required" });
        const now = new Date();
        await db.update(themeCaptureRequests).set({ expiresAt: now, errorCode: "superseded" }).where(and(eq(themeCaptureRequests.siteId, site.id), isNull(themeCaptureRequests.completedAt), gt(themeCaptureRequests.expiresAt, now)));
        const [capture] = await db.insert(themeCaptureRequests).values({ id: `themec_${nanoid(32)}`, siteId: site.id, createdBy: request.user.id, expiresAt: new Date(now.getTime() + THEME_CAPTURE_TTL_MS) }).returning();
        await db.insert(auditLogs).values({ orgId: site.orgId, userId: request.user.id, action: "site_theme.capture_requested", detail: { siteId: site.publicId, captureId: capture.id } });
        return reply.code(201).send({ capture: captureStatus(capture, now) });
    });
    app.get("/orgs/:orgId/sites/:siteId/theme-captures/:captureId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId, captureId } = request.params;
        const site = await siteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const [capture] = await db.select().from(themeCaptureRequests).where(and(eq(themeCaptureRequests.id, captureId), eq(themeCaptureRequests.siteId, site.id))).limit(1);
        if (!capture)
            return reply.code(404).send({ error: "theme_capture_not_found" });
        return reply.send({ capture: captureStatus(capture) });
    });
    app.put("/orgs/:orgId/sites/:siteId/theme", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const parsed = z.object({ captureId: z.string().min(1).max(100), tokens: siteThemeTokensSchema }).strict().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const { siteId } = request.params;
        const site = await siteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const [theme] = await db.select().from(siteThemes).where(eq(siteThemes.siteId, site.id)).limit(1);
        const [capture] = await db.select().from(themeCaptureRequests).where(and(eq(themeCaptureRequests.id, parsed.data.captureId), eq(themeCaptureRequests.siteId, site.id))).limit(1);
        if (!theme?.candidateTokens || theme.candidateCaptureId !== parsed.data.captureId || !capture?.completedAt)
            return reply.code(409).send({ error: "theme_candidate_required" });
        const now = new Date();
        const [updated] = await db.update(siteThemes).set({ activeTokens: parsed.data.tokens, activeUpdatedAt: now, candidateTokens: null, candidateCaptureId: null, candidateEvidence: null, candidateOrigin: null, candidateCapturedAt: null, updatedAt: now }).where(eq(siteThemes.siteId, site.id)).returning();
        await db.insert(auditLogs).values({ orgId: site.orgId, userId: request.user.id, action: "site_theme.activated", detail: { siteId: site.publicId, captureId: capture.id } });
        return reply.send({ active: { tokens: updated.activeTokens, updatedAt: updated.activeUpdatedAt }, candidate: null });
    });
    app.delete("/orgs/:orgId/sites/:siteId/theme-candidate", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await siteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        await db.update(siteThemes).set({ candidateTokens: null, candidateCaptureId: null, candidateEvidence: null, candidateOrigin: null, candidateCapturedAt: null, updatedAt: new Date() }).where(eq(siteThemes.siteId, site.id));
        await db.insert(auditLogs).values({ orgId: site.orgId, userId: request.user.id, action: "site_theme.candidate_discarded", detail: { siteId: site.publicId } });
        return reply.code(204).send();
    });
}
export function registerPublicThemeRoutes(app, db) {
    app.post("/public/sites/:siteId/theme-captures/:captureId", async (request, reply) => {
        const raw = JSON.stringify(request.body ?? {});
        if (raw.length > 32_000)
            return reply.code(413).send({ error: "theme_capture_too_large" });
        const parsed = themeCapturePayloadSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_theme_capture", details: parsed.error.flatten() });
        const { siteId, captureId } = request.params;
        const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
        if (!site)
            return reply.code(404).send({ error: "theme_capture_not_found" });
        const [capture] = await db.select().from(themeCaptureRequests).where(and(eq(themeCaptureRequests.id, captureId), eq(themeCaptureRequests.siteId, site.id))).limit(1);
        if (!capture)
            return reply.code(404).send({ error: "theme_capture_not_found" });
        if (capture.completedAt)
            return reply.code(409).send({ error: "theme_capture_already_used" });
        if (capture.expiresAt <= new Date())
            return reply.code(410).send({ error: "theme_capture_expired" });
        const expectedOrigin = siteOrigin(site.domain);
        const requestOrigin = request.headers.origin;
        if (!expectedOrigin || requestOrigin !== expectedOrigin) {
            await db.update(themeCaptureRequests).set({ errorCode: "origin_mismatch" }).where(eq(themeCaptureRequests.id, capture.id));
            return reply.code(403).send({ error: "origin_mismatch" });
        }
        const now = new Date();
        const accepted = await db.transaction(async (tx) => {
            const completed = await tx.update(themeCaptureRequests).set({ completedAt: now, errorCode: null }).where(and(eq(themeCaptureRequests.id, capture.id), isNull(themeCaptureRequests.completedAt), gt(themeCaptureRequests.expiresAt, now))).returning({ id: themeCaptureRequests.id });
            if (!completed.length)
                return false;
            await tx.insert(siteThemes).values({ siteId: site.id, candidateTokens: parsed.data.tokens, candidateCaptureId: capture.id, candidateEvidence: parsed.data.evidence, candidateOrigin: requestOrigin, candidateCapturedAt: now, updatedAt: now }).onConflictDoUpdate({ target: siteThemes.siteId, set: { candidateTokens: parsed.data.tokens, candidateCaptureId: capture.id, candidateEvidence: parsed.data.evidence, candidateOrigin: requestOrigin, candidateCapturedAt: now, updatedAt: now } });
            await tx.insert(auditLogs).values({ orgId: site.orgId, userId: capture.createdBy, action: "site_theme.candidate_received", detail: { siteId: site.publicId, captureId: capture.id, origin: requestOrigin } });
            return true;
        });
        if (!accepted)
            return reply.code(409).send({ error: "theme_capture_already_used" });
        return reply.code(201).send({ capture: { id: capture.id, status: "received", receivedAt: now } });
    });
}
//# sourceMappingURL=themes.js.map