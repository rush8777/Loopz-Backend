import { matchesRules } from "../lib/pages/pageMatcher.js";
import { matchesExperienceAudience } from "../lib/experiences/audience.js";
import { resolveDeliveryUserId } from "../lib/identity/deliveryIdentity.js";
import { geoAgentDefinitionSchema } from "../lib/experiences/validation.js";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { and, count, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config.js";
import { runEntitlementTransaction } from "../db/transaction.js";
import { experienceEvents, experiences, geoAgentConversations as conversations, geoAgentTurns as turns, geoAgentUsage as usage, sites } from "../db/schema.js";
import { issueVisitorToken, loadPublishedAgent, verifyCustomerIdentity, visitorClaims, visitorIsEligible } from "../lib/geoAgent/access.js";
import { answerFromKnowledge } from "../lib/geoAgent/answer.js";
import { geoAgentConfig } from "../lib/geoAgent/config.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
const publicPath = "/public/sites/:siteId/geo-agent/:experienceId";
const adminPath = "/orgs/:orgId/sites/:siteId/experiences/:experienceId/geo-agent";
const MAX_TURNS = 40;
const RESERVATION = 24_000;
const TIMEOUT = 45_000;
const pageSchema = z.url().max(2000).refine(value => ["http:", "https:"].includes(new URL(value).protocol));
const questionSchema = z.string().trim().min(1).max(1000);
const requestIdSchema = z.uuid();
const day = (time) => time.toISOString().slice(0, 10);
const ndjson = "application/x-ndjson; charset=utf-8";
const expiresAt = (now) => new Date(now.getTime() + env.GEO_AGENT_RETENTION_DAYS * 86_400_000);
class GeoError extends Error {
    status;
    constructor(status, code) {
        super(code);
        this.status = status;
    }
}
function respondError(error, _request, reply) {
    if (error instanceof GeoError)
        return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError)
        return reply.code(400).send({ error: "invalid_geo_agent_request" });
    const status = error.statusCode ?? 500;
    return reply.code(status).send({ error: status < 500 ? "invalid_geo_agent_request" : "geo_agent_request_failed" });
}
function conversationScope(runtime, id, now = new Date()) {
    const { agent, claims } = runtime;
    return and(eq(conversations.id, id), eq(conversations.siteId, agent.site.id), eq(conversations.experienceId, agent.experience.id), eq(conversations.versionId, agent.version.id), eq(conversations.owner, claims.sub), gte(conversations.expiresAt, now));
}
async function loadConversation(db, runtime, id) {
    const [conversation] = await db.select().from(conversations).where(conversationScope(runtime, id)).limit(1);
    if (!conversation)
        throw new GeoError(404, "conversation_not_found");
    return conversation;
}
function streamItem(stream, data) {
    if (!stream.destroyed)
        stream.write(JSON.stringify(data) + "\n");
}
export function registerGeoAgentRoutes(app, db, provider, embedder) {
    app.register(async (routes) => {
        routes.setErrorHandler(respondError);
        routes.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "private, no-store"); });
        const active = new Map();
        routes.addHook("onClose", async () => { for (const controller of active.values())
            controller.abort(); });
        async function published(request, url) {
            const { siteId, experienceId } = request.params;
            const agent = await loadPublishedAgent(db, siteId, experienceId, url, request.headers.origin);
            if (!agent)
                throw new GeoError(404, "geo_agent_unavailable");
            return agent;
        }
        async function authorize(request) {
            const { url } = z.object({ url: pageSchema }).parse(request.query);
            const agent = await published(request, url);
            const claims = visitorClaims(request.headers.authorization, agent);
            if (!claims)
                throw new GeoError(401, "geo_agent_session_required");
            if (!await visitorIsEligible(db, agent, claims.identity))
                throw new GeoError(403, "geo_agent_ineligible");
            return { agent, claims };
        }
        async function event(runtime, eventType, eventId = randomUUID()) {
            const { agent, claims } = runtime;
            const id = createHash("sha256").update(JSON.stringify([agent.site.id, agent.experience.id, claims.sub, eventType, eventId])).digest("hex");
            await db.insert(experienceEvents).values({
                id: `geo_${id}`, siteId: agent.site.id, experienceId: agent.experience.id, versionId: agent.version.id,
                anonymousId: claims.sub, eventType, timestamp: new Date(),
            }).onConflictDoNothing();
        }
        routes.post("/session", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request) => {
            const { url, identityToken } = z.object({ url: pageSchema, identityToken: z.string().max(4000).optional() }).strict().parse(request.body);
            const agent = await published(request, url);
            const key = agent.definition.geoAgent.identityPublicKey;
            const identity = identityToken && key ? verifyCustomerIdentity(identityToken, key, agent.site.publicId) : null;
            if (identityToken && !identity)
                throw new GeoError(401, "invalid_visitor_identity");
            if (!await visitorIsEligible(db, agent, identity ?? undefined))
                throw new GeoError(403, "geo_agent_ineligible");
            return { token: issueVisitorToken(agent, identity ?? undefined), versionId: agent.version.id, verified: Boolean(identity) };
        });
        routes.post("/conversations", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
            const runtime = await authorize(request);
            const now = new Date();
            const [conversation] = await db.insert(conversations).values({
                id: randomUUID(), siteId: runtime.agent.site.id, experienceId: runtime.agent.experience.id,
                versionId: runtime.agent.version.id, owner: runtime.claims.sub, createdAt: now, updatedAt: now, expiresAt: expiresAt(now),
            }).returning({ id: conversations.id });
            await event(runtime, "geo_agent_conversation_started", conversation.id).catch(() => { });
            return reply.code(201).send({ conversationId: conversation.id });
        });
        routes.get("/conversations/:conversationId", async (request) => {
            const runtime = await authorize(request);
            const { conversationId } = request.params;
            const conversation = await loadConversation(db, runtime, conversationId);
            const messages = await db.select({ messageId: turns.id, question: turns.question, answer: turns.answer, feedback: turns.feedback })
                .from(turns).where(and(eq(turns.conversationId, conversation.id), eq(turns.status, "completed"))).orderBy(turns.createdAt).limit(MAX_TURNS);
            return { conversationId: conversation.id, messages };
        });
        routes.delete("/conversations/:conversationId", async (request, reply) => {
            const runtime = await authorize(request);
            const { conversationId } = request.params;
            const [deleted] = await db.delete(conversations).where(conversationScope(runtime, conversationId)).returning({ id: conversations.id });
            if (!deleted)
                throw new GeoError(404, "conversation_not_found");
            for (const [key, controller] of active)
                if (key.startsWith(`${deleted.id}/`))
                    controller.abort();
            await event(runtime, "geo_agent_conversation_deleted", deleted.id).catch(() => { });
            return reply.code(204).send();
        });
        routes.post("/conversations/:conversationId/messages", { config: { rateLimit: { max: 24, timeWindow: "1 minute" } } }, async (request, reply) => {
            const runtime = await authorize(request);
            const { conversationId } = request.params;
            const { question, requestId } = z.object({ question: questionSchema, requestId: requestIdSchema }).strict().parse(request.body);
            const { agent } = runtime;
            const now = new Date();
            const usageDay = day(now);
            const turn = await runEntitlementTransaction(db, async (tx) => {
                const [conversation] = await tx.select({ id: conversations.id }).from(conversations).where(conversationScope(runtime, conversationId, now));
                if (!conversation)
                    throw new GeoError(404, "conversation_not_found");
                await tx.update(turns).set({ status: "failed", updatedAt: now }).where(and(eq(turns.conversationId, conversation.id), eq(turns.status, "running"), lt(turns.updatedAt, new Date(now.getTime() - TIMEOUT * 2))));
                const [previous] = await tx.select().from(turns).where(and(eq(turns.conversationId, conversation.id), eq(turns.requestId, requestId)));
                if (previous?.question !== undefined && previous.question !== question)
                    throw new GeoError(409, "request_id_conflict");
                if (previous?.status === "completed")
                    return previous;
                const [running] = await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.conversationId, conversation.id), eq(turns.status, "running")));
                if (running)
                    throw new GeoError(409, "response_in_progress");
                const [{ total }] = await tx.select({ total: count() }).from(turns).where(eq(turns.conversationId, conversation.id));
                if ((!previous && total >= MAX_TURNS) || (previous && previous.attempt >= 3))
                    throw new GeoError(429, "conversation_limit");
                const [available] = await tx.insert(usage).values({ siteId: agent.site.id, day: usageDay, tokens: RESERVATION })
                    .onConflictDoUpdate({
                    target: [usage.siteId, usage.day], set: { tokens: sql `${usage.tokens} + ${RESERVATION}` },
                    setWhere: lte(usage.tokens, env.GEO_AGENT_DAILY_TOKEN_LIMIT - RESERVATION),
                }).returning({ tokens: usage.tokens });
                if (!available)
                    throw new GeoError(429, "geo_agent_daily_limit");
                await tx.update(conversations).set({ updatedAt: now, expiresAt: expiresAt(now) }).where(eq(conversations.id, conversation.id));
                if (previous) {
                    const [retry] = await tx.update(turns).set({ status: "running", attempt: previous.attempt + 1, reservedTokens: RESERVATION, updatedAt: now })
                        .where(eq(turns.id, previous.id)).returning();
                    return retry;
                }
                const [added] = await tx.insert(turns).values({
                    conversationId: conversation.id, siteId: agent.site.id, requestId, question, status: "running",
                    reservedTokens: RESERVATION, createdAt: now, updatedAt: now,
                }).returning();
                return added;
            });
            reply.header("X-Accel-Buffering", "no");
            if (turn.status === "completed") {
                const result = turn.answer;
                return reply.type(ndjson).send(JSON.stringify({ type: "complete", result }) + "\n");
            }
            const stream = new PassThrough();
            reply.type(ndjson).send(stream);
            const controller = new AbortController();
            const controllerKey = `${turn.conversationId}/${turn.requestId}`;
            active.set(controllerKey, controller);
            const onClose = () => { if (!reply.raw.writableFinished)
                controller.abort(); };
            reply.raw.once("close", onClose);
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT)]);
            const stillRunning = and(eq(turns.id, turn.id), eq(turns.attempt, turn.attempt), eq(turns.status, "running"));
            const timer = setInterval(() => {
                void db.select({ id: turns.id }).from(turns).where(stillRunning).limit(1)
                    .then(rows => { if (!rows.length)
                    controller.abort(); }).catch(() => controller.abort());
            }, 1800);
            timer.unref();
            const started = performance.now();
            let firstDeltaMs = null;
            streamItem(stream, { type: "started", schemaVersion: 1, conversationId: turn.conversationId, messageId: turn.id, requestId });
            void (async () => {
                try {
                    await event(runtime, "geo_agent_message_sent", turn.id).catch(() => { });
                    const recent = await db.select({ question: turns.question, answer: turns.answer }).from(turns).where(and(eq(turns.conversationId, turn.conversationId), eq(turns.status, "completed"))).orderBy(desc(turns.createdAt)).limit(4);
                    const history = recent.reverse().map(row => ({ question: row.question, message: row.answer.message }));
                    const result = await answerFromKnowledge({
                        db, scope: { orgId: agent.site.orgId, siteId: agent.site.id }, config: agent.definition.geoAgent, provider, embedder,
                        publicOnly: true, question, history, signal, skillAccess: { origin: agent.origin, verifiedIdentity: runtime.claims.identity }, onDelta(text) {
                            signal.throwIfAborted();
                            firstDeltaMs ??= Math.round(performance.now() - started);
                            streamItem(stream, { type: "delta", text });
                        },
                    });
                    signal.throwIfAborted();
                    const answer = { schemaVersion: 1, conversationId: turn.conversationId, messageId: turn.id, message: result.message, citations: result.citations, actions: [] };
                    const persisted = await runEntitlementTransaction(db, async (tx) => {
                        const [updated] = await tx.update(turns).set({
                            status: "completed", answer, usedTokens: result.tokens, retrievedCount: result.retrievedCount, skillDiagnostics: result.diagnostics,
                            provider: result.provider, model: result.model, latencyMs: Math.round(performance.now() - started),
                            firstDeltaMs, updatedAt: new Date(),
                        }).where(stillRunning).returning({ id: turns.id });
                        if (!updated)
                            return false;
                        await tx.update(usage).set({ tokens: sql `max(0, ${usage.tokens} - ${RESERVATION} + ${result.tokens})` })
                            .where(and(eq(usage.siteId, agent.site.id), eq(usage.day, usageDay)));
                        return true;
                    });
                    if (!persisted)
                        throw new GeoError(409, "response_cancelled");
                    await event(runtime, "geo_agent_response_completed", turn.id).catch(() => { });
                    streamItem(stream, { type: "citations", citations: result.citations });
                    streamItem(stream, { type: "complete", result: answer });
                }
                catch {
                    const aborted = controller.signal.aborted;
                    await db.update(turns).set({ status: aborted ? "cancelled" : "failed", updatedAt: new Date(), latencyMs: Math.round(performance.now() - started) })
                        .where(stillRunning).catch(() => { });
                    if (!aborted)
                        await event(runtime, "geo_agent_response_failed", `${turn.id}/${turn.attempt}`).catch(() => { });
                    streamItem(stream, { type: "error", code: aborted ? "response_cancelled" : signal.aborted ? "response_timeout" : "response_failed" });
                }
                finally {
                    clearInterval(timer);
                    if (active.get(controllerKey) === controller)
                        active.delete(controllerKey);
                    reply.raw.removeListener("close", onClose);
                    stream.end();
                }
            })();
            return reply;
        });
        routes.post("/conversations/:conversationId/messages/:requestId/cancel", async (request, reply) => {
            const runtime = await authorize(request);
            const { conversationId, requestId } = request.params;
            await loadConversation(db, runtime, conversationId);
            const [cancelled] = await db.update(turns).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(turns.conversationId, conversationId), eq(turns.requestId, requestId), eq(turns.status, "running"))).returning({ id: turns.id });
            if (cancelled)
                active.get(`${conversationId}/${requestId}`)?.abort();
            return reply.code(204).send();
        });
        routes.put("/conversations/:conversationId/messages/:requestId/feedback", async (request, reply) => {
            const runtime = await authorize(request);
            const { conversationId, requestId: messageId } = request.params;
            const { value } = z.object({ value: z.enum(["helpful", "unhelpful"]) }).strict().parse(request.body);
            await loadConversation(db, runtime, conversationId);
            const [updated] = await db.update(turns).set({ feedback: value }).where(and(eq(turns.id, messageId), eq(turns.conversationId, conversationId), eq(turns.status, "completed"))).returning({ id: turns.id });
            if (!updated)
                throw new GeoError(404, "message_not_found");
            await event(runtime, "geo_agent_feedback_submitted", `${messageId}/${value}`).catch(() => { });
            return reply.code(204).send();
        });
        routes.post("/events", async (request, reply) => {
            const runtime = await authorize(request);
            const { type, eventId } = z.object({
                type: z.enum(["launcher_impression", "opened", "closed", "citation_clicked", "conversation_reset"]),
                eventId: requestIdSchema.optional(),
            }).strict().parse(request.body);
            await event(runtime, `geo_agent_${type}`, eventId);
            return reply.code(204).send();
        });
    }, { prefix: publicPath });
    const admin = [authenticate, requireOrgRole(db, "ADMIN")];
    async function adminAgent(params) {
        const [row] = await db.select({ id: experiences.id, domain: sites.domain, publicId: sites.publicId }).from(experiences).innerJoin(sites, eq(experiences.siteId, sites.id))
            .where(and(eq(sites.id, params.siteId), eq(sites.orgId, params.orgId), eq(experiences.id, params.experienceId), eq(experiences.widgetType, "geo_agent"))).limit(1);
        if (!row)
            throw new GeoError(404, "geo_agent_unavailable");
        return row;
    }
    app.post(`${adminPath}/preview`, { preHandler: admin, errorHandler: respondError, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
        const params = request.params;
        const site = await adminAgent(params);
        const { config, question, evaluation } = z.object({
            config: geoAgentConfig, question: questionSchema,
            evaluation: z.object({
                mode: z.enum(["admin", "visitor"]),
                url: pageSchema.optional(),
                identityToken: z.string().max(4000).optional(),
                priorQuestion: questionSchema.optional(),
                targeting: geoAgentDefinitionSchema.shape.targeting.optional(),
            }).strict().optional(),
        }).strict().parse(request.body);
        let origin;
        let verifiedIdentity;
        let permitted = true;
        if (site.domain) {
            try {
                origin = new URL(/^https?:\/\//i.test(site.domain) ? site.domain : `https://${site.domain}`).origin;
            }
            catch { /* A guide's origin restrictions remain in force. */ }
        }
        if (evaluation?.mode === "visitor") {
            if (!evaluation.url || !evaluation.targeting)
                throw new GeoError(400, "preview_visitor_context_required");
            const page = new URL(evaluation.url);
            const { targeting } = evaluation;
            const now = Date.now();
            const identityToken = evaluation.identityToken;
            if (identityToken) {
                verifiedIdentity = config.identityPublicKey ? verifyCustomerIdentity(identityToken, config.identityPublicKey, site.publicId) ?? undefined : undefined;
                if (!verifiedIdentity)
                    throw new GeoError(401, "invalid_visitor_identity");
            }
            permitted = config.enabled && config.showLauncher && !!origin && page.origin === origin
                && (!targeting.allowedOrigins?.length || targeting.allowedOrigins.includes(page.origin))
                && (!targeting.pageRules.length || matchesRules(page.pathname + page.search + page.hash, targeting.pageRules))
                && (!targeting.schedule?.startsAt || Date.parse(targeting.schedule.startsAt) <= now)
                && (!targeting.schedule?.endsAt || now < Date.parse(targeting.schedule.endsAt));
            if (targeting.audience.type !== "all") {
                const internalId = verifiedIdentity ? await resolveDeliveryUserId(db, params.siteId, verifiedIdentity) : null;
                permitted &&= !!internalId && await matchesExperienceAudience(db, params.siteId, internalId, targeting.audience);
            }
        }
        const result = await answerFromKnowledge({
            db, scope: params, config: permitted ? config : { ...config, sourceIds: [] }, question, provider, embedder,
            publicOnly: true, history: evaluation?.priorQuestion ? [{ question: evaluation.priorQuestion, message: "" }] : [],
            skillAccess: { origin, verifiedIdentity, inspect: true, permitted }, signal: AbortSignal.timeout(TIMEOUT), onDelta() { },
        });
        return { message: result.message, citations: result.citations, decision: result.diagnostics?.recommendation,
            candidates: result.candidates, documentation: result.documentation, retrievalMs: result.retrievalMs, permitted };
    });
    app.get(`${adminPath}/metrics`, { preHandler: admin, errorHandler: respondError }, async (request) => {
        const params = request.params;
        await adminAgent(params);
        const scope = and(eq(conversations.siteId, params.siteId), eq(conversations.experienceId, params.experienceId));
        const [[people], [messages]] = await Promise.all([
            db.select({ conversations: count(), visitors: sql `count(distinct ${conversations.owner})` }).from(conversations).where(scope),
            db.select({
                messages: count(), responses: sql `count(case when ${turns.status} = 'completed' then 1 end)`,
                failed: sql `count(case when ${turns.status} = 'failed' then 1 end)`,
                helpful: sql `count(case when ${turns.feedback} = 'helpful' then 1 end)`,
                unhelpful: sql `count(case when ${turns.feedback} = 'unhelpful' then 1 end)`,
                answeredWithKnowledge: sql `count(case when ${turns.status} = 'completed' and ${turns.retrievedCount} > 0 then 1 end)`,
                tokens: sql `coalesce(sum(${turns.usedTokens}), 0)`,
                skillRecommendations: sql `count(case when json_extract(${turns.skillDiagnostics}, '$.recommendation.decision') = 'recommend_skill' then 1 end)`,
                skillClarifications: sql `count(case when json_extract(${turns.skillDiagnostics}, '$.recommendation.decision') = 'clarify' then 1 end)`,
                skillNoMatches: sql `count(case when json_extract(${turns.skillDiagnostics}, '$.recommendation.decision') = 'insufficient_evidence' then 1 end)`,
                averageSkillRetrievalMs: sql `avg(json_extract(${turns.skillDiagnostics}, '$.retrievalMs'))`,
                averageLatencyMs: sql `round(avg(${turns.latencyMs}))`,
                averageFirstDeltaMs: sql `round(avg(${turns.firstDeltaMs}))`,
            }).from(turns).innerJoin(conversations, eq(turns.conversationId, conversations.id)).where(scope),
        ]);
        return { ...people, ...messages };
    });
    let cleanup;
    app.addHook("onReady", async () => {
        const prune = () => db.delete(conversations).where(lt(conversations.expiresAt, new Date())).catch(() => { });
        await prune();
        cleanup = setInterval(prune, 3_600_000);
        cleanup.unref();
    });
    app.addHook("onClose", async () => clearInterval(cleanup));
}
//# sourceMappingURL=geo-agent.js.map