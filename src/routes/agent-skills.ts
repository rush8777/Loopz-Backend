import type { FastifyInstance } from "fastify";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config.js";
import { type Db } from "../db/client.js";
import { agentSkills, aiProviderUsage, experiences, experienceVersions, sites } from "../db/schema.js";
import { runEntitlementTransaction } from "../db/transaction.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { guideDefinitionSchema } from "../lib/experiences/validation.js";
import { type AiProvider } from "../lib/ai/providers/types.js";
import { skillRegistration } from "../lib/skills/contracts.js";
import { defaultSkillMetadata, entryPathForGuide, suggestSkillMetadata } from "../lib/skills/metadata.js";
import { currentGuide, listSkills, registerSkill, skillScope } from "../lib/skills/registry.js";

const prefix = "/orgs/:orgId/sites/:siteId/agent-skills";
type Params = { orgId: string; siteId: string; guideId: string };

export function registerAgentSkills(app: FastifyInstance, db: Db, provider: AiProvider | null) {
  const preHandler = [authenticate, requireOrgRole(db, "ADMIN")];
  const siteExists = async ({ orgId, siteId }: Params) => (await db.select({ id: sites.id }).from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1)).length === 1;
  app.get(prefix, { preHandler }, async (request, reply) => {
    const params = request.params as Params;
    if (!await siteExists(params)) return reply.code(404).send({ error: "site_not_found" });
    return { skills: await listSkills(db, params) };
  });

  app.put(`${prefix}/:guideId`, { preHandler, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const scope = request.params as Params;
    const input = z.object({ guideVersionId: z.string().min(1).max(64), expectedRevision: z.string().uuid().nullable(), skill: skillRegistration }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_skill_metadata" });
    const status = await runEntitlementTransaction(db, async tx => {
      const current = await currentGuide(tx, scope, scope.guideId);
      const [existing] = await tx.select({ revision: agentSkills.revision, guideVersionId: agentSkills.guideVersionId }).from(agentSkills)
        .where(and(skillScope(scope), eq(agentSkills.guideId, scope.guideId))).limit(1);
      if (input.data.skill.enabled && !current) return 404;
      if (!input.data.skill.enabled && !existing) return 404;
      const versionId = current?.version.id ?? existing!.guideVersionId;
      if (versionId !== input.data.guideVersionId || input.data.expectedRevision !== (existing?.revision ?? null)) return 409;
      const parsed = guideDefinitionSchema.safeParse(current?.version.definition);
      if (input.data.skill.enabled && !parsed.success) return 400;
      await registerSkill(tx, { orgId: scope.orgId, siteId: scope.siteId }, scope.guideId, versionId, input.data.skill,
        parsed.success ? entryPathForGuide(parsed.data, current!.guide.buildUrl) : null);
      return 200;
    });
    if (status !== 200) return reply.code(status).send({ error: status === 409 ? "skill_revision_changed" : "guide_unavailable" });
    return { skill: (await listSkills(db, scope)).find(skill => skill.guideId === scope.guideId) ?? null };
  });

  app.post(`${prefix}/:guideId/suggest`, { preHandler, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { orgId, siteId, guideId } = request.params as Params;
    if (!await siteExists(request.params as Params)) return reply.code(404).send({ error: "site_not_found" });
    const input = z.object({ versionId: z.string().max(64), revision: z.number().int().positive() }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_skill_request" });
    const [row] = await db.select({ name: experiences.name, version: experienceVersions }).from(experiences)
      .innerJoin(experienceVersions, eq(experiences.id, experienceVersions.experienceId))
      .where(and(eq(experiences.siteId, siteId), eq(experiences.id, guideId), eq(experiences.kind, "guide"),
        eq(experienceVersions.id, input.data.versionId), eq(experienceVersions.revision, input.data.revision))).limit(1);
    const guide = guideDefinitionSchema.safeParse(row?.version.definition);
    if (!row || !guide.success) return reply.code(409).send({ error: "reviewed_draft_changed" });
    const fallback = defaultSkillMetadata(row.name, guide.data);
    if (!provider) return { metadata: fallback, method: "manual", issue: "provider_unavailable" };
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    const reserved = 5000;
    const usageId = await runEntitlementTransaction(db, async tx => {
      const [usage] = await tx.select({ tokens: sql<number>`coalesce(sum(${aiProviderUsage.totalTokens}), 0)` }).from(aiProviderUsage)
        .where(and(eq(aiProviderUsage.orgId, orgId), gte(aiProviderUsage.createdAt, day)));
      if (Number(usage.tokens) + reserved > env.AI_DAILY_TOKEN_LIMIT) return null;
      const [record] = await tx.insert(aiProviderUsage).values({
        orgId, siteId, userId: request.user!.id, provider: provider.name, model: provider.model,
        promptTokens: reserved, completionTokens: 0, totalTokens: reserved,
      }).returning({ id: aiProviderUsage.id });
      return record.id;
    });
    if (!usageId) return { metadata: fallback, method: "manual", issue: "ai_daily_limit" };
    try {
      const suggestion = await suggestSkillMetadata(provider, row.name, guide.data, AbortSignal.timeout(18_000));
      const usage = suggestion.result.usage;
      await db.update(aiProviderUsage).set({ promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens })
        .where(eq(aiProviderUsage.id, usageId));
      if (suggestion.metadata) return { metadata: suggestion.metadata, method: "ai" };
    } catch { /* Preserve the reservation when provider usage is unknown. */ }
    return { metadata: fallback, method: "manual", issue: "metadata_generation_failed" };
  });
}
