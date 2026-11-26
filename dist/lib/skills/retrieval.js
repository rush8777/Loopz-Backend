import { and, eq, inArray, sql } from "drizzle-orm";
import { env } from "../../config.js";
import { agentSkills, experiences, experienceVersions, sites } from "../../db/schema.js";
import { matchesExperienceAudience } from "../experiences/audience.js";
import { guideDefinitionSchema } from "../experiences/validation.js";
import { resolveDeliveryUserId } from "../identity/deliveryIdentity.js";
import { validateVectors } from "../knowledge/embeddings.js";
import { skillRecommendation } from "./contracts.js";
import { rankSkills } from "./ranking.js";
import { skillScope } from "./registry.js";
const guidanceLimit = 5;
function availableBase(db, scope, ids) {
    return and(skillScope(scope), inArray(agentSkills.id, ids), eq(agentSkills.enabled, true), eq(agentSkills.indexState, "ready"), inArray(agentSkills.guideId, db.select({ id: experiences.id }).from(experiences)
        .innerJoin(sites, and(eq(sites.id, experiences.siteId), eq(sites.orgId, scope.orgId)))
        .innerJoin(experienceVersions, and(eq(experienceVersions.id, experiences.publishedVersionId), eq(experienceVersions.experienceId, experiences.id), eq(experienceVersions.state, "published")))
        .where(and(eq(experiences.siteId, scope.siteId), eq(experiences.kind, "guide"), eq(experiences.status, "published"), eq(experiences.publishedVersionId, agentSkills.guideVersionId)))));
}
async function excludeGuide(metadata, definition, access, audience) {
    if (access.permitted === false)
        return "widget_targeting";
    if (metadata.preconditions.length)
        return "unverified_preconditions";
    const parsed = guideDefinitionSchema.safeParse(definition);
    if (!parsed.success)
        return "invalid_guide";
    const target = parsed.data.targeting;
    const now = Date.now();
    if (target.schedule?.startsAt && now < Date.parse(target.schedule.startsAt) ||
        target.schedule?.endsAt && now >= Date.parse(target.schedule.endsAt))
        return "outside_schedule";
    if (target.allowedOrigins?.length && (!access.origin || !target.allowedOrigins.includes(access.origin)))
        return "origin_restricted";
    if (target.audience.type !== "all" && !access.verifiedIdentity)
        return "verified_identity_required";
    if (!await audience(target.audience))
        return "audience_restricted";
    return undefined;
}
async function checkEligibility(db, scope, skills, access) {
    if (!skills.length)
        return new Map();
    const definitions = await db.select({ id: agentSkills.id, revision: agentSkills.revision, definition: experienceVersions.definition })
        .from(agentSkills).innerJoin(experienceVersions, eq(experienceVersions.id, agentSkills.guideVersionId))
        .where(availableBase(db, scope, skills.map(skill => skill.id)));
    const byId = new Map(definitions.map(row => [row.id, row]));
    const outcomes = new Map();
    const memberships = new Map();
    let resolved;
    const audience = async (target) => {
        if (target.type === "all")
            return true;
        const key = JSON.stringify(target);
        if (!memberships.has(key)) {
            resolved ??= resolveDeliveryUserId(db, scope.siteId, access.verifiedIdentity);
            memberships.set(key, resolved.then(user => user ? matchesExperienceAudience(db, scope.siteId, user, target) : false));
        }
        return memberships.get(key);
    };
    for (const skill of skills) {
        const current = byId.get(skill.id);
        outcomes.set(skill.id, current?.revision !== skill.versionId
            ? "guide_unavailable"
            : await excludeGuide(skill.metadata, current.definition, access, audience).catch(() => "eligibility_unverified"));
    }
    return outcomes;
}
export async function skillStillEligible(db, scope, skill, access) {
    const result = await checkEligibility(db, scope, [skill], access);
    return result.has(skill.id) && !result.get(skill.id);
}
export async function retrieveSkills(db, scope, ids, question, access, embedder, signal) {
    const started = performance.now();
    const where = ids.length ? availableBase(db, scope, ids) : undefined;
    let embeddingTokens = 0;
    let degraded = false;
    let vector;
    if (where && embedder && access.permitted !== false) {
        try {
            const [modelMatch] = await db.select({ id: agentSkills.id }).from(agentSkills)
                .where(and(where, eq(agentSkills.embeddingKey, embedder.key))).limit(1);
            if (modelMatch) {
                const result = await embedder.embed([question], AbortSignal.any([signal, AbortSignal.timeout(2200)]));
                embeddingTokens = result.tokens;
                validateVectors(result.vectors, 1, embedder.dimensions);
                vector = result.vectors[0];
            }
        }
        catch {
            signal.throwIfAborted();
            degraded = true;
        }
    }
    const rows = async (includeVectors) => {
        const similarity = vector && includeVectors ? sql `CASE
      WHEN ${agentSkills.embeddingKey} = ${embedder.key} AND ${agentSkills.embedding} IS NOT NULL
      THEN 1.0 - vector_distance_cos(vector32(${agentSkills.embedding}), vector32(${JSON.stringify(vector)}))
      ELSE NULL END` : sql `NULL`;
        return where ? db.select({ id: agentSkills.id, versionId: agentSkills.revision, metadata: agentSkills.metadata, similarity })
            .from(agentSkills).where(where).limit(500) : [];
    };
    const matches = await rows(true).catch(error => {
        if (!vector)
            throw error;
        degraded = true;
        return rows(false);
    });
    signal.throwIfAborted();
    const shortlist = rankSkills(question, matches.map(row => ({ ...row, name: row.metadata.name })), env.GEO_SKILL_MAX_CANDIDATES).ranked;
    const outcomes = await checkEligibility(db, scope, shortlist, access);
    const eligible = shortlist.filter(skill => outcomes.has(skill.id) && !outcomes.get(skill.id));
    const { ranked, decision } = rankSkills(question, eligible, guidanceLimit, env.GEO_SKILL_RELEVANCE_THRESHOLD);
    const recommendation = skillRecommendation.parse(decision);
    const selected = recommendation.decision === "recommend_skill"
        ? ranked.find(skill => skill.id === recommendation.skillId && skill.versionId === recommendation.skillVersionId) : undefined;
    const candidates = access.inspect ? shortlist.slice(0, 16).map(skill => ({
        id: skill.id, name: skill.name, score: Math.round(skill.score * 1000) / 1000,
        eligible: !outcomes.get(skill.id), reason: outcomes.get(skill.id),
    })) : [];
    if (access.inspect && ids.length) {
        const current = new Set(matches.map(row => row.id));
        const missing = ids.filter(id => !current.has(id));
        if (missing.length) {
            const unavailable = await db.select({ id: agentSkills.id, metadata: agentSkills.metadata, enabled: agentSkills.enabled, state: agentSkills.indexState })
                .from(agentSkills).where(and(skillScope(scope), inArray(agentSkills.id, missing))).limit(16);
            for (const skill of unavailable)
                candidates.push({
                    id: skill.id, name: skill.metadata.name, score: 0, eligible: false,
                    reason: !skill.enabled ? "disabled" : skill.state !== "ready" ? `index_${skill.state}` : "guide_unavailable",
                });
        }
    }
    return { selected, recommendation, candidates, eligibleCount: eligible.length, retrievalMs: Math.round(performance.now() - started), embeddingTokens, degraded };
}
//# sourceMappingURL=retrieval.js.map