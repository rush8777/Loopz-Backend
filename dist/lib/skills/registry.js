import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { agentSkills, experiences, experienceVersions, sites } from "../../db/schema.js";
import { validateVectors } from "../knowledge/embeddings.js";
export const skillScope = (scope) => and(eq(agentSkills.orgId, scope.orgId), eq(agentSkills.siteId, scope.siteId));
export const skillText = (metadata, entryPath) => [metadata.name, metadata.description, ...metadata.intentExamples, ...metadata.keywords, ...(entryPath ? [entryPath] : [])].join("\n");
const hashOf = (value) => createHash("sha256").update(value).digest("hex");
export async function currentGuide(db, scope, guideId) {
    const [row] = await db.select({ guide: experiences, version: experienceVersions }).from(experiences)
        .innerJoin(sites, and(eq(sites.id, experiences.siteId), eq(sites.orgId, scope.orgId)))
        .innerJoin(experienceVersions, and(eq(experienceVersions.id, experiences.publishedVersionId), eq(experienceVersions.experienceId, experiences.id)))
        .where(and(eq(experiences.id, guideId), eq(experiences.siteId, scope.siteId), eq(experiences.kind, "guide"), eq(experiences.status, "published"), eq(experienceVersions.state, "published"))).limit(1);
    return row;
}
/** Call in the same transaction that verified the current published pointer. */
export async function registerSkill(db, scope, guideId, versionId, registration, entryPath = null) {
    const where = and(skillScope(scope), eq(agentSkills.guideId, guideId));
    const [existing] = await db.select().from(agentSkills).where(where).limit(1);
    const now = new Date();
    if (!registration.enabled) {
        if (existing?.enabled) {
            await db.update(agentSkills).set({ enabled: false, revision: randomUUID(), leaseId: null, leaseUntil: null, updatedAt: now }).where(where);
        }
        return;
    }
    const metadata = registration.metadata;
    const contentHash = hashOf(skillText(metadata, entryPath));
    if (existing?.guideVersionId === versionId && existing.enabled && existing.indexState !== "failed"
        && JSON.stringify(existing.metadata) === JSON.stringify(metadata))
        return;
    const reusable = existing?.indexState === "ready" && existing.contentHash === contentHash;
    const data = {
        guideVersionId: versionId, entryPath, metadata, contentHash, enabled: true, revision: randomUUID(), updatedAt: now,
        indexState: reusable ? "ready" : "pending",
        embedding: reusable ? existing.embedding : null,
        embeddingKey: reusable ? existing.embeddingKey : null,
        leaseUntil: null, leaseId: null,
    };
    await db.insert(agentSkills).values({ ...data, ...scope, guideId, createdAt: now })
        .onConflictDoUpdate({ target: agentSkills.guideId, set: data, setWhere: where });
}
export async function listSkills(db, scope) {
    const rows = await db.select({
        id: agentSkills.id, revision: agentSkills.revision, guideId: agentSkills.guideId, guideVersionId: agentSkills.guideVersionId,
        metadata: agentSkills.metadata, entryPath: agentSkills.entryPath, enabled: agentSkills.enabled, state: agentSkills.indexState, updatedAt: agentSkills.updatedAt,
        guideState: experiences.status, currentVersion: experiences.publishedVersionId,
    }).from(agentSkills).innerJoin(experiences, eq(experiences.id, agentSkills.guideId))
        .where(skillScope(scope)).orderBy(asc(agentSkills.guideId)).limit(1000);
    return rows.map(({ guideState, currentVersion, ...skill }) => ({
        schemaVersion: 1, type: "guide", ...skill,
        status: !skill.enabled ? "disabled" : guideState !== "published" || currentVersion !== skill.guideVersionId ? "unavailable" : skill.state,
    }));
}
/** Claim one version with a lease. A late provider result cannot overwrite a new revision. */
export async function processSkillIndex(db, embedder, shutdown) {
    shutdown.throwIfAborted();
    const now = new Date();
    const needsVector = embedder ? and(eq(agentSkills.indexState, "ready"), or(isNull(agentSkills.embeddingKey), ne(agentSkills.embeddingKey, embedder.key))) : undefined;
    const pending = and(or(eq(agentSkills.indexState, "pending"), needsVector), eq(agentSkills.enabled, true), or(isNull(agentSkills.leaseUntil), lt(agentSkills.leaseUntil, now)));
    const next = db.select({ id: agentSkills.id }).from(agentSkills)
        .innerJoin(experiences, and(eq(experiences.id, agentSkills.guideId), eq(experiences.publishedVersionId, agentSkills.guideVersionId), eq(experiences.status, "published")))
        .where(pending).orderBy(asc(agentSkills.updatedAt)).limit(1);
    const leaseId = randomUUID();
    const [claimed] = await db.update(agentSkills).set({ leaseUntil: new Date(now.getTime() + 60_000), leaseId })
        .where(and(pending, inArray(agentSkills.id, next))).returning();
    if (!claimed)
        return false;
    const lease = and(eq(agentSkills.id, claimed.id), eq(agentSkills.revision, claimed.revision), eq(agentSkills.leaseId, leaseId));
    try {
        const result = embedder ? await embedder.embed([skillText(claimed.metadata, claimed.entryPath)], AbortSignal.any([shutdown, AbortSignal.timeout(20_000)])) : null;
        if (result && embedder)
            validateVectors(result.vectors, 1, embedder.dimensions);
        shutdown.throwIfAborted();
        await db.update(agentSkills).set({
            indexState: "ready", embedding: result?.vectors[0] ?? null, embeddingKey: embedder?.key ?? null,
            indexTokens: result?.tokens ?? 0, leaseUntil: null, leaseId: null, updatedAt: new Date(),
        }).where(lease);
    }
    catch {
        if (shutdown.aborted) {
            await db.update(agentSkills).set({ leaseUntil: null, leaseId: null }).where(lease);
        }
        else {
            await db.update(agentSkills).set({ indexState: "failed", leaseUntil: null, leaseId: null, updatedAt: new Date() }).where(lease);
        }
    }
    return true;
}
//# sourceMappingURL=registry.js.map