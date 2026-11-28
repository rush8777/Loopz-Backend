import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, lte, notInArray, or } from "drizzle-orm";
import { agentSkills, experiences, geoAgentConversations as conversations, geoAgentGuidance as sessions } from "../../db/schema.js";
import { matchesExperienceAudience } from "../experiences/audience.js";
import { guideStepRequiresTarget } from "../experiences/types.js";
import { guideDefinitionSchema } from "../experiences/validation.js";
import { resolveDeliveryUserId } from "../identity/deliveryIdentity.js";
import { matchesRules } from "../pages/pageMatcher.js";
import { currentGuide, skillScope } from "../skills/registry.js";
import { excludeGuide } from "../skills/retrieval.js";
import { guidanceDurationMs, liveGuidanceStates } from "./guidanceContract.js";
const fullPath = (url) => url.pathname + url.search + url.hash;
const route = (url) => url.pathname + (url.hash.startsWith("#/") ? url.hash.split("?", 1)[0] : "");
/** Navigation is restricted to a same-origin path with no query or non-routing fragment. */
export function safeEntryPath(input, origin) {
    if (!input || input.length > 1000 || !/^\/(?!\/)/.test(input) || /[\\\u0000-\u0020\u007f]/.test(input))
        return null;
    try {
        const url = new URL(input, origin);
        if (url.origin !== origin || url.username || url.password)
            return null;
        return route(url);
    }
    catch {
        return null;
    }
}
export function entryDecision(definition, page, capturedPath, buildUrl) {
    const first = definition.steps[0];
    if (!first)
        return null;
    const context = guideStepRequiresTarget(first) ? first.target?.targetContext : undefined;
    const targeting = definition.targeting;
    const canStart = (url) => (!targeting.pageRules.length || matchesRules(fullPath(url), targeting.pageRules)) &&
        (!context || context.pagePath === (context.match === "path" ? route(url) : fullPath(url)));
    if (canStart(page))
        return { mode: "here" };
    const buildPath = (() => {
        try {
            const url = buildUrl && new URL(buildUrl);
            return url && url.origin === page.origin ? route(url) : null;
        }
        catch {
            return null;
        }
    })();
    for (const candidate of [context?.pagePath, capturedPath, buildPath]) {
        const path = safeEntryPath(candidate, page.origin);
        if (path && canStart(new URL(path, page.origin)))
            return { mode: "navigate", path };
    }
    return null;
}
export async function resolveGuidanceGuide(db, scope, ref, selected, origin, identity) {
    if (!origin || !selected?.includes(ref.skillId))
        return null;
    const [skill] = await db.select().from(agentSkills).where(and(skillScope(scope), eq(agentSkills.id, ref.skillId), eq(agentSkills.revision, ref.skillRevision), eq(agentSkills.enabled, true), eq(agentSkills.indexState, "ready"))).limit(1);
    if (!skill)
        return null;
    const current = await currentGuide(db, scope, skill.guideId);
    if (!current || current.version.id !== skill.guideVersionId)
        return null;
    const parsed = guideDefinitionSchema.safeParse(current.version.definition);
    if (!parsed.success)
        return null;
    const reason = await excludeGuide(skill.metadata, parsed.data, { origin, verifiedIdentity: identity }, async (audience) => {
        if (audience.type === "all")
            return true;
        const user = await resolveDeliveryUserId(db, scope.siteId, identity);
        return !!user && matchesExperienceAudience(db, scope.siteId, user, audience);
    });
    return reason ? null : { ...current, skill, definition: parsed.data };
}
export function guideForRuntime(db, runtime, ref) {
    const { agent, claims } = runtime;
    return agent.definition.geoAgent.guidance?.enabled
        ? resolveGuidanceGuide(db, { orgId: agent.site.orgId, siteId: agent.site.id }, ref, agent.definition.geoAgent.skillIds, agent.origin, claims.identity)
        : null;
}
export function sessionScope(runtime, conversationId) {
    return and(eq(sessions.siteId, runtime.agent.site.id), eq(sessions.widgetId, runtime.agent.experience.id), eq(sessions.owner, runtime.claims.sub), eq(sessions.conversationId, conversationId));
}
export function sessionLive(session) {
    return liveGuidanceStates.includes(session.state) && session.expiresAt > new Date();
}
export async function createGuidance(db, runtime, conversationId, turnId, instanceId, guide) {
    const now = new Date();
    const currentConversations = db.select({ id: conversations.id }).from(conversations)
        .innerJoin(experiences, and(eq(experiences.id, conversations.experienceId), eq(experiences.publishedVersionId, conversations.versionId), eq(experiences.status, "published")))
        .where(and(eq(conversations.siteId, runtime.agent.site.id), eq(conversations.owner, runtime.claims.sub)));
    await db.update(sessions).set({ state: "expired", updatedAt: now }).where(and(eq(sessions.siteId, runtime.agent.site.id), eq(sessions.owner, runtime.claims.sub), inArray(sessions.state, liveGuidanceStates), or(lte(sessions.expiresAt, now), notInArray(sessions.conversationId, currentConversations))));
    const [previous] = await db.select().from(sessions).where(and(sessionScope(runtime, conversationId), eq(sessions.turnId, turnId))).limit(1);
    if (previous)
        return previous.instanceId === instanceId && sessionLive(previous) ? previous : null;
    const [session] = await db.insert(sessions).values({
        id: randomUUID(), conversationId, turnId, siteId: runtime.agent.site.id, widgetId: runtime.agent.experience.id,
        owner: runtime.claims.sub, skillId: guide.skill.id, skillRevision: guide.skill.revision, guideId: guide.guide.id, guideVersionId: guide.version.id,
        instanceId, state: "accepted", stepId: guide.definition.steps[0].id, createdAt: now, updatedAt: now,
        expiresAt: new Date(Math.min(now.getTime() + guidanceDurationMs, runtime.claims.exp * 1000)),
    }).onConflictDoNothing().returning();
    return session ?? null;
}
export async function latestGuidance(db, runtime, conversationId, activeOnly = false) {
    const { agent, claims } = runtime;
    const [row] = await db.select({ session: sessions }).from(sessions)
        .innerJoin(conversations, eq(sessions.conversationId, conversations.id))
        .where(and(eq(sessions.siteId, agent.site.id), eq(sessions.widgetId, agent.experience.id), eq(sessions.owner, claims.sub), eq(conversations.versionId, agent.version.id), activeOnly ? and(inArray(sessions.state, liveGuidanceStates), gt(sessions.expiresAt, new Date())) : eq(sessions.conversationId, conversationId)))
        .orderBy(desc(sessions.updatedAt)).limit(1);
    return row?.session;
}
export function guidanceStatus(session) {
    const state = sessionLive(session) ? session.state : liveGuidanceStates.includes(session.state) ? "expired" : session.state;
    return { id: session.id, messageId: session.turnId, state, failure: session.failure };
}
/** Delivery contains the original published runtime definition with private targeting removed. */
export function guidanceDelivery(session, guide) {
    const { targeting, ...definition } = guide.definition;
    return {
        experience: { id: guide.guide.id, versionId: guide.version.id, kind: "guide", widgetType: null,
            priority: targeting.priority, interruptPolicy: "queue", definition },
        stepId: session.stepId, sequence: session.sequence,
    };
}
//# sourceMappingURL=guidance.js.map