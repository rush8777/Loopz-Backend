import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { auditLogs, sites, siteStylePresets, siteThemes, themeCaptureRequests } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { siteThemeTokensSchema, themeCapturePayloadSchema } from "../lib/themes/validation.js";
import { VISUAL_PRESETS, presetTokens } from "../lib/themes/presets.js";
import { runEntitlementTransaction } from "../db/transaction.js";
import { editScopeSchema, editTheme, fallbackTheme } from "../lib/themes/designSystem.js";
import { designResponse, providerSignal, recordThemeAiUsage, runThemeImport, snapshotImportedDesign, themeAiUsageAvailable, type ImportProposal } from "../lib/themes/designJobs.js";
import type { AiProvider } from "../lib/ai/providers/index.js";

export const THEME_CAPTURE_TTL_MS = 5 * 60 * 1000;

function siteOrigin(domain: string | null): string | null {
  if (!domain) return null;
  try { return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin; }
  catch { return null; }
}

async function siteInOrg(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  return site?.orgId === orgId ? site : null;
}

function captureStatus(capture: typeof themeCaptureRequests.$inferSelect, now = new Date()) {
  return {
    id: capture.id,
    status: capture.completedAt ? "received" as const : capture.expiresAt <= now ? "expired" as const : capture.errorCode === "origin_mismatch" ? "origin_mismatch" as const : "pending" as const,
    expiresAt: capture.expiresAt,
    receivedAt: capture.completedAt,
    errorCode: capture.errorCode,
  };
}

export function registerThemeRoutes(app: FastifyInstance, db: Db, provider: AiProvider | null = null) {
  app.get("/orgs/:orgId/sites/:siteId/style-presets", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await siteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const presets = await db.select().from(siteStylePresets).where(eq(siteStylePresets.siteId, site.id)).orderBy(desc(siteStylePresets.updatedAt));
    return reply.send({ presets: presets.map(preset => ({ ...preset, createdAt: preset.createdAt.toISOString(), updatedAt: preset.updatedAt.toISOString() })) });
  });

  app.post("/orgs/:orgId/sites/:siteId/style-presets", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(80), tokens: siteThemeTokensSchema, sourceCaptureId: z.string().min(1).max(100).optional(),
      sourcePresetId: z.string().min(1).max(100).optional(), sourceFallback: z.boolean().optional() }).strict()
      .refine(value => !value.sourceCaptureId || !value.sourcePresetId).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const { siteId } = request.params as { siteId: string }; const site = await siteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    let { sourceCaptureId } = parsed.data;
    let sourceDesign: ImportProposal | undefined;
    if (sourceCaptureId) {
      const [source] = await db.select().from(themeCaptureRequests).where(and(eq(themeCaptureRequests.siteId, site.id), eq(themeCaptureRequests.id, sourceCaptureId))).limit(1);
      sourceDesign = source?.completedAt ? snapshotImportedDesign(source, parsed.data.sourceFallback) : undefined;
      if (!sourceDesign) return reply.code(409).send({ error: "theme_design_required" });
    }
    if (parsed.data.sourcePresetId) {
      const [source] = await db.select().from(siteStylePresets).where(and(eq(siteStylePresets.id, parsed.data.sourcePresetId), eq(siteStylePresets.siteId, site.id))).limit(1);
      if (!source) return reply.code(404).send({ error: "style_preset_not_found" });
      sourceCaptureId = source.sourceCaptureId ?? undefined;
      sourceDesign = source.sourceDesign ?? undefined;
    }
    try {
      const created = await runEntitlementTransaction(db, async tx => {
        const existing = await tx.select({ id: siteStylePresets.id }).from(siteStylePresets).where(eq(siteStylePresets.siteId, site.id)).limit(20);
        if (existing.length >= 20) return null;
        const [preset] = await tx.insert(siteStylePresets).values({ siteId: site.id, name: parsed.data.name, tokens: parsed.data.tokens, sourceCaptureId, sourceDesign, createdBy: request.user!.id }).returning();
        await tx.insert(auditLogs).values({ orgId: site.orgId, userId: request.user!.id, action: "site_style_preset.created", detail: { siteId: site.publicId, presetId: preset.id } });
        return preset;
      });
      if (!created) return reply.code(409).send({ error: "style_preset_limit" });
      return reply.code(201).send({ preset: { ...created, createdAt: created.createdAt.toISOString(), updatedAt: created.updatedAt.toISOString() } });
    } catch { return reply.code(409).send({ error: "style_preset_name_exists" }); }
  });

  app.patch("/orgs/:orgId/sites/:siteId/style-presets/:presetId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(80).optional(), tokens: siteThemeTokensSchema.optional(), expectedUpdatedAt: z.iso.datetime().optional() }).strict()
      .refine(value => value.name !== undefined || value.tokens !== undefined).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const { siteId, presetId } = request.params as { siteId: string; presetId: string }; const site = await siteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [preset] = await db.select().from(siteStylePresets).where(and(eq(siteStylePresets.id, presetId), eq(siteStylePresets.siteId, site.id))).limit(1);
    if (!preset) return reply.code(404).send({ error: "style_preset_not_found" });
    const { expectedUpdatedAt, ...changes } = parsed.data;
    const expected = expectedUpdatedAt ? eq(siteStylePresets.updatedAt, new Date(expectedUpdatedAt)) : undefined;
    try {
      const [updated] = await db.update(siteStylePresets).set({ ...changes, updatedAt: new Date(Math.max(Date.now(), preset.updatedAt.getTime() + 1)) })
        .where(and(eq(siteStylePresets.id, presetId), eq(siteStylePresets.siteId, site.id), expected)).returning();
      if (!updated) return reply.code(409).send({ error: "style_preset_conflict" });
      return reply.send({ preset: { ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() } });
    }
    catch { return reply.code(409).send({ error: "style_preset_name_exists" }); }
  });

  app.delete("/orgs/:orgId/sites/:siteId/style-presets/:presetId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId, presetId } = request.params as { siteId: string; presetId: string }; const site = await siteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [preset] = await db.select().from(siteStylePresets).where(and(eq(siteStylePresets.id, presetId), eq(siteStylePresets.siteId, site.id))).limit(1);
    if (!preset) return reply.code(404).send({ error: "style_preset_not_found" });
    await db.delete(siteStylePresets).where(eq(siteStylePresets.id, preset.id));
    await db.insert(auditLogs).values({ orgId: site.orgId, userId: request.user!.id, action: "site_style_preset.deleted", detail: { siteId: site.publicId, presetId: preset.id } });
    return reply.code(204).send();
  });

  app.put("/orgs/:orgId/sites/:siteId/theme/default", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const parsed = z.discriminatedUnion("source", [
      z.object({ source: z.literal("preset"), preset: z.enum(["minimal", "modern", "soft", "dark"]) }).strict(),
      z.object({ source: z.literal("saved"), presetId: z.string().min(1).max(100) }).strict(),
      z.object({ source: z.literal("none") }).strict(),
    ]).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const { siteId } = request.params as { siteId: string };
    const site = await siteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const selection = parsed.data;
    const result = await runEntitlementTransaction(db, async tx => {
      let tokens: unknown = selection.source === "preset" ? presetTokens(selection.preset) : null;
      if (selection.source === "saved") {
        const [preset] = await tx.select({ tokens: siteStylePresets.tokens }).from(siteStylePresets)
          .where(and(eq(siteStylePresets.id, selection.presetId), eq(siteStylePresets.siteId, site.id))).limit(1);
        if (!preset) return null;
        tokens = preset.tokens;
      }
      const now = new Date();
      const update = { activeTokens: tokens, activeUpdatedAt: tokens ? now : null, updatedAt: now };
      await tx.insert(siteThemes).values({ siteId: site.id, ...update })
        .onConflictDoUpdate({ target: siteThemes.siteId, set: update });
      await tx.insert(auditLogs).values({ orgId: site.orgId, userId: request.user!.id, action: "site_theme.activated", detail: { siteId: site.publicId, ...selection } });
      return { active: tokens ? { tokens, updatedAt: now } : null };
    });
    return result ? reply.send(result) : reply.code(404).send({ error: "style_preset_not_found" });
  });

  app.get("/orgs/:orgId/sites/:siteId/theme", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await siteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [theme] = await db.select().from(siteThemes).where(eq(siteThemes.siteId, site.id)).limit(1);
    const [capture] = await db.select().from(themeCaptureRequests).where(eq(themeCaptureRequests.siteId, site.id)).orderBy(desc(themeCaptureRequests.createdAt)).limit(1);
    return reply.send({
      active: theme?.activeTokens ? { tokens: theme.activeTokens, updatedAt: theme.activeUpdatedAt } : null,
      candidate: theme?.candidateTokens ? { captureId: theme.candidateCaptureId, tokens: theme.candidateTokens, evidence: theme.candidateEvidence, origin: theme.candidateOrigin, capturedAt: theme.candidateCapturedAt } : null,
      capture: capture ? captureStatus(capture) : null,
      builtIn: VISUAL_PRESETS,
    });
  });

  app.post("/orgs/:orgId/sites/:siteId/theme-captures", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await siteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    if (!siteOrigin(site.domain)) return reply.code(409).send({ error: "site_domain_required" });
    const options = z.object({ explicit: z.boolean().optional() }).strict().safeParse(request.body ?? {});
    if (!options.success) return reply.code(400).send({ error: "invalid_body" });
    const now = new Date();
    const capture = await runEntitlementTransaction(db, async tx => {
      await tx.update(themeCaptureRequests).set({ expiresAt: now, errorCode: "superseded" }).where(and(eq(themeCaptureRequests.siteId, site.id), isNull(themeCaptureRequests.completedAt), gt(themeCaptureRequests.expiresAt, now)));
      const [row] = await tx.insert(themeCaptureRequests).values({ id: `themec_${nanoid(32)}`, siteId: site.id, explicitOnly: options.data.explicit === true, createdBy: request.user!.id, expiresAt: new Date(now.getTime() + THEME_CAPTURE_TTL_MS) }).returning();
      await tx.insert(auditLogs).values({ orgId: site.orgId, userId: request.user!.id, action: "site_theme.capture_requested", detail: { siteId: site.publicId, captureId: row.id } });
      return row;
    });
    return reply.code(201).send({ capture: captureStatus(capture, now) });
  });

  app.get("/orgs/:orgId/sites/:siteId/theme-captures/:captureId", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
    const { siteId, captureId } = request.params as { siteId: string; captureId: string };
    const site = await siteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [capture] = await db.select().from(themeCaptureRequests).where(and(eq(themeCaptureRequests.id, captureId), eq(themeCaptureRequests.siteId, site.id))).limit(1);
    if (!capture) return reply.code(404).send({ error: "theme_capture_not_found" });
    return reply.send({ capture: captureStatus(capture) });
  });

  const designPath = "/orgs/:orgId/sites/:siteId/theme-captures/:captureId/design";
  app.route({
    method: ["GET", "POST"], url: designPath,
    preHandler: [authenticate, requireOrgRole(db, "ADMIN")],
    config: { rateLimit: { max: 45, timeWindow: "1 minute" } },
    handler: async (request, reply) => {
      const { siteId, captureId } = request.params as { siteId: string; captureId: string };
      const orgId = request.membership!.orgId;
      const site = await siteInOrg(db, siteId, orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      const [capture] = await db.select().from(themeCaptureRequests).where(and(eq(themeCaptureRequests.id, captureId), eq(themeCaptureRequests.siteId, site.id))).limit(1);
      if (!capture?.completedAt) return reply.code(404).send({ error: "theme_capture_not_found" });
      let legacy;
      if (!capture.designEvidence) {
        const [row] = await db.select().from(siteThemes).where(and(eq(siteThemes.siteId, siteId), eq(siteThemes.candidateCaptureId, capture.id))).limit(1);
        const parsed = siteThemeTokensSchema.safeParse(row?.candidateTokens);
        if (parsed.success) legacy = parsed.data;
        if (!legacy && !capture.designJob) return reply.code(409).send({ error: "theme_candidate_required" });
      }
      if (request.method === "GET") return designResponse(capture, legacy);
      const body = z.object({ retry: z.boolean().optional() }).strict().safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      return runThemeImport({ db, scope: { orgId, siteId, userId: request.user!.id }, provider, capture, legacy, retry: body.data.retry === true, reply });
    },
  });

  app.post("/orgs/:orgId/sites/:siteId/theme-proposals", {
    preHandler: [authenticate, requireOrgRole(db, "ADMIN")],
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const orgId = request.membership!.orgId;
    if (!await siteInOrg(db, siteId, orgId)) return reply.code(404).send({ error: "site_not_found" });
    const parsed = z.object({
      tokens: siteThemeTokensSchema, request: z.string().trim().min(1).max(1200), scope: editScopeSchema,
      revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      history: z.array(z.object({ request: z.string().max(1200), reply: z.string().max(480) }).strict()).max(4).optional(),
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    if (!provider) return reply.code(503).send({ error: "ai_disabled" });
    if (!await themeAiUsageAvailable(db, orgId)) return reply.code(429).send({ error: "ai_daily_limit" });
    const abort = providerSignal(reply);
    const { tokens, request: prompt, scope, revision, history } = parsed.data;
    try {
      const result = await editTheme(provider, tokens, prompt, scope, abort.signal, history);
      await recordThemeAiUsage(db, { orgId, siteId, userId: request.user!.id }, result.result);
      abort.signal.throwIfAborted();
      return { revision, ...result.proposal() };
    } catch (error) {
      request.log.warn({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Theme proposal failed");
      return reply.code(abort.limit.aborted ? 504 : 502).send({ error: "theme_proposal_failed" });
    } finally { abort.cleanup(); }
  });

  app.put("/orgs/:orgId/sites/:siteId/theme", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const parsed = z.object({ captureId: z.string().min(1).max(100), tokens: siteThemeTokensSchema }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const { siteId } = request.params as { siteId: string };
    const site = await siteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    const [theme] = await db.select().from(siteThemes).where(eq(siteThemes.siteId, site.id)).limit(1);
    const [capture] = await db.select().from(themeCaptureRequests).where(and(eq(themeCaptureRequests.id, parsed.data.captureId), eq(themeCaptureRequests.siteId, site.id))).limit(1);
    if (!theme?.candidateTokens || theme.candidateCaptureId !== parsed.data.captureId || !capture?.completedAt) return reply.code(409).send({ error: "theme_candidate_required" });
    const now = new Date();
    const updated = await runEntitlementTransaction(db, async tx => {
      const [row] = await tx.update(siteThemes).set({ activeTokens: parsed.data.tokens, activeUpdatedAt: now, candidateTokens: null, candidateCaptureId: null, candidateEvidence: null, candidateOrigin: null, candidateCapturedAt: null, updatedAt: now })
        .where(and(eq(siteThemes.siteId, site.id), eq(siteThemes.candidateCaptureId, capture.id))).returning();
      if (!row) return null;
      await tx.insert(auditLogs).values({ orgId: site.orgId, userId: request.user!.id, action: "site_theme.activated", detail: { siteId: site.publicId, captureId: capture.id } });
      return row;
    });
    if (!updated) return reply.code(409).send({ error: "theme_candidate_required" });
    return reply.send({ active: { tokens: updated.activeTokens, updatedAt: updated.activeUpdatedAt }, candidate: null });
  });

  app.delete("/orgs/:orgId/sites/:siteId/theme-candidate", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
    const { siteId } = request.params as { siteId: string };
    const site = await siteInOrg(db, siteId, request.membership!.orgId);
    if (!site) return reply.code(404).send({ error: "site_not_found" });
    await db.update(siteThemes).set({ candidateTokens: null, candidateCaptureId: null, candidateEvidence: null, candidateOrigin: null, candidateCapturedAt: null, updatedAt: new Date() }).where(eq(siteThemes.siteId, site.id));
    await db.insert(auditLogs).values({ orgId: site.orgId, userId: request.user!.id, action: "site_theme.candidate_discarded", detail: { siteId: site.publicId } });
    return reply.code(204).send();
  });
}

export function registerPublicThemeRoutes(app: FastifyInstance, db: Db) {
  app.post("/public/sites/:siteId/theme-captures/:captureId", async (request, reply) => {
    const raw = JSON.stringify(request.body ?? {});
    if (raw.length > 32_000) return reply.code(413).send({ error: "theme_capture_too_large" });
    const parsed = themeCapturePayloadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_theme_capture", details: parsed.error.flatten() });
    const { siteId, captureId } = request.params as { siteId: string; captureId: string };
    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
    if (!site) return reply.code(404).send({ error: "theme_capture_not_found" });
    const [capture] = await db.select().from(themeCaptureRequests).where(and(eq(themeCaptureRequests.id, captureId), eq(themeCaptureRequests.siteId, site.id))).limit(1);
    if (!capture) return reply.code(404).send({ error: "theme_capture_not_found" });
    if (capture.completedAt) return reply.code(409).send({ error: "theme_capture_already_used" });
    if (capture.expiresAt <= new Date()) return reply.code(410).send({ error: "theme_capture_expired" });
    const expectedOrigin = siteOrigin(site.domain);
    const requestOrigin = request.headers.origin;
    if (!expectedOrigin || requestOrigin !== expectedOrigin) {
      await db.update(themeCaptureRequests).set({ errorCode: "origin_mismatch" }).where(eq(themeCaptureRequests.id, capture.id));
      return reply.code(403).send({ error: "origin_mismatch" });
    }
    const now = new Date();
    const evidence = "tokens" in parsed.data ? undefined : parsed.data.evidence;
    const tokens = "tokens" in parsed.data ? parsed.data.tokens : fallbackTheme(evidence);
    const accepted = await db.transaction(async tx => {
      const completed = await tx.update(themeCaptureRequests).set({ completedAt: now, errorCode: null, designEvidence: evidence }).where(and(eq(themeCaptureRequests.id, capture.id), isNull(themeCaptureRequests.completedAt), gt(themeCaptureRequests.expiresAt, now))).returning({ id: themeCaptureRequests.id });
      if (!completed.length) return false;
      await tx.insert(siteThemes).values({ siteId: site.id, candidateTokens: tokens, candidateCaptureId: capture.id, candidateEvidence: parsed.data.evidence, candidateOrigin: requestOrigin, candidateCapturedAt: now, updatedAt: now }).onConflictDoUpdate({ target: siteThemes.siteId, set: { candidateTokens: tokens, candidateCaptureId: capture.id, candidateEvidence: parsed.data.evidence, candidateOrigin: requestOrigin, candidateCapturedAt: now, updatedAt: now } });
      await tx.insert(auditLogs).values({ orgId: site.orgId, userId: capture.createdBy, action: "site_theme.candidate_received", detail: { siteId: site.publicId, captureId: capture.id, origin: requestOrigin } });
      return true;
    });
    if (!accepted) return reply.code(409).send({ error: "theme_capture_already_used" });
    return reply.code(201).send({ capture: { id: capture.id, status: "received", receivedAt: now } });
  });
}
