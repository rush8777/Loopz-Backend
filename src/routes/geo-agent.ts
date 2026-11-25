import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, count, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config.js";
import type { Db } from "../db/client.js";
import { runEntitlementTransaction } from "../db/transaction.js";
import { experienceEvents, experiences, geoAgentConversations as conversations, geoAgentTurns as turns, geoAgentUsage as usage, sites } from "../db/schema.js";
import { type AiProvider } from "../lib/ai/providers/types.js";
import { type KnowledgeEmbedder } from "../lib/knowledge/embeddings.js";
import { issueVisitorToken, loadPublishedAgent, type PublishedGeoAgent, type VisitorClaims, verifyCustomerIdentity, visitorClaims, visitorIsEligible } from "../lib/geoAgent/access.js";
import { answerFromKnowledge, type GeoAgentAnswer } from "../lib/geoAgent/answer.js";
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
const day = (time: Date) => time.toISOString().slice(0, 10);
type PublicParams = { siteId: string; experienceId: string; conversationId?: string; requestId?: string };
type AdminParams = { orgId: string; siteId: string; experienceId: string };
type Runtime = { agent: PublishedGeoAgent; claims: VisitorClaims };
const ndjson = "application/x-ndjson; charset=utf-8";
const expiresAt = (now: Date) => new Date(now.getTime() + env.GEO_AGENT_RETENTION_DAYS * 86_400_000);

class GeoError extends Error {
  constructor(readonly status: number, code: string) { super(code); }
}

function respondError(error: unknown, _request: FastifyRequest, reply: import("fastify").FastifyReply) {
  if (error instanceof GeoError) return reply.code(error.status).send({ error: error.message });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid_geo_agent_request" });
  const status = (error as { statusCode?: number }).statusCode ?? 500;
  return reply.code(status).send({ error: status < 500 ? "invalid_geo_agent_request" : "geo_agent_request_failed" });
}

function conversationScope(runtime: Runtime, id: string, now = new Date()) {
  const { agent, claims } = runtime;
  return and(eq(conversations.id, id), eq(conversations.siteId, agent.site.id), eq(conversations.experienceId, agent.experience.id),
    eq(conversations.versionId, agent.version.id), eq(conversations.owner, claims.sub), gte(conversations.expiresAt, now));
}

async function loadConversation(db: Db, runtime: Runtime, id: string) {
  const [conversation] = await db.select().from(conversations).where(conversationScope(runtime, id)).limit(1);
  if (!conversation) throw new GeoError(404, "conversation_not_found");
  return conversation;
}

function streamItem(stream: PassThrough, data: object) {
  if (!stream.destroyed) stream.write(JSON.stringify(data) + "\n");
}

export function registerGeoAgentRoutes(
  app: FastifyInstance, db: Db, provider: AiProvider | null, embedder: KnowledgeEmbedder | null,
) {
  app.register(async routes => {
    routes.setErrorHandler(respondError);
    routes.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "private, no-store"); });
    const active = new Map<string, AbortController>();
    routes.addHook("onClose", async () => { for (const controller of active.values()) controller.abort(); });

    async function published(request: FastifyRequest, url: string) {
      const { siteId, experienceId } = request.params as PublicParams;
      const agent = await loadPublishedAgent(db, siteId, experienceId, url, request.headers.origin);
      if (!agent) throw new GeoError(404, "geo_agent_unavailable");
      return agent;
    }
    async function authorize(request: FastifyRequest): Promise<Runtime> {
      const { url } = z.object({ url: pageSchema }).parse(request.query);
      const agent = await published(request, url);
      const claims = visitorClaims(request.headers.authorization, agent);
      if (!claims) throw new GeoError(401, "geo_agent_session_required");
      if (!await visitorIsEligible(db, agent, claims.identity)) throw new GeoError(403, "geo_agent_ineligible");
      return { agent, claims };
    }
    async function event(runtime: Runtime, eventType: string, eventId: string = randomUUID()) {
      const { agent, claims } = runtime;
      const id = createHash("sha256").update(JSON.stringify([agent.site.id, agent.experience.id, claims.sub, eventType, eventId])).digest("hex");
      await db.insert(experienceEvents).values({
        id: `geo_${id}`, siteId: agent.site.id, experienceId: agent.experience.id, versionId: agent.version.id,
        anonymousId: claims.sub, eventType, timestamp: new Date(),
      }).onConflictDoNothing();
    }

    routes.post("/session", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async request => {
      const { url, identityToken } = z.object({ url: pageSchema, identityToken: z.string().max(4000).optional() }).strict().parse(request.body);
      const agent = await published(request, url);
      const key = agent.definition.geoAgent.identityPublicKey;
      const identity = identityToken && key ? verifyCustomerIdentity(identityToken, key, agent.site.publicId) : null;
      if (identityToken && !identity) throw new GeoError(401, "invalid_visitor_identity");
      if (!await visitorIsEligible(db, agent, identity ?? undefined)) throw new GeoError(403, "geo_agent_ineligible");
      return { token: issueVisitorToken(agent, identity ?? undefined), versionId: agent.version.id, verified: Boolean(identity) };
    });

    routes.post("/conversations", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
      const runtime = await authorize(request);
      const now = new Date();
      const [conversation] = await db.insert(conversations).values({
        id: randomUUID(), siteId: runtime.agent.site.id, experienceId: runtime.agent.experience.id,
        versionId: runtime.agent.version.id, owner: runtime.claims.sub, createdAt: now, updatedAt: now, expiresAt: expiresAt(now),
      }).returning({ id: conversations.id });
      await event(runtime, "geo_agent_conversation_started", conversation.id).catch(() => {});
      return reply.code(201).send({ conversationId: conversation.id });
    });

    routes.get("/conversations/:conversationId", async request => {
      const runtime = await authorize(request);
      const { conversationId } = request.params as PublicParams;
      const conversation = await loadConversation(db, runtime, conversationId!);
      const messages = await db.select({ messageId: turns.id, question: turns.question, answer: turns.answer, feedback: turns.feedback })
        .from(turns).where(and(eq(turns.conversationId, conversation.id), eq(turns.status, "completed"))).orderBy(turns.createdAt).limit(MAX_TURNS);
      return { conversationId: conversation.id, messages };
    });

    routes.delete("/conversations/:conversationId", async (request, reply) => {
      const runtime = await authorize(request);
      const { conversationId } = request.params as PublicParams;
      const [deleted] = await db.delete(conversations).where(conversationScope(runtime, conversationId!)).returning({ id: conversations.id });
      if (!deleted) throw new GeoError(404, "conversation_not_found");
      for (const [key, controller] of active) if (key.startsWith(`${deleted.id}/`)) controller.abort();
      await event(runtime, "geo_agent_conversation_deleted", deleted.id).catch(() => {});
      return reply.code(204).send();
    });

    routes.post("/conversations/:conversationId/messages", { config: { rateLimit: { max: 24, timeWindow: "1 minute" } } }, async (request, reply) => {
      const runtime = await authorize(request);
      const { conversationId } = request.params as PublicParams;
      const { question, requestId } = z.object({ question: questionSchema, requestId: requestIdSchema }).strict().parse(request.body);
      const { agent } = runtime;
      const now = new Date();
      const usageDay = day(now);
      const turn = await runEntitlementTransaction(db, async tx => {
        const [conversation] = await tx.select({ id: conversations.id }).from(conversations).where(conversationScope(runtime, conversationId!, now));
        if (!conversation) throw new GeoError(404, "conversation_not_found");
        await tx.update(turns).set({ status: "failed", updatedAt: now }).where(and(
          eq(turns.conversationId, conversation.id), eq(turns.status, "running"),
          lt(turns.updatedAt, new Date(now.getTime() - TIMEOUT * 2)),
        ));
        const [previous] = await tx.select().from(turns).where(and(eq(turns.conversationId, conversation.id), eq(turns.requestId, requestId)));
        if (previous?.question !== undefined && previous.question !== question) throw new GeoError(409, "request_id_conflict");
        if (previous?.status === "completed") return previous;
        const [running] = await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.conversationId, conversation.id), eq(turns.status, "running")));
        if (running) throw new GeoError(409, "response_in_progress");
        const [{ total }] = await tx.select({ total: count() }).from(turns).where(eq(turns.conversationId, conversation.id));
        if ((!previous && total >= MAX_TURNS) || (previous && previous.attempt >= 3)) throw new GeoError(429, "conversation_limit");
        const [available] = await tx.insert(usage).values({ siteId: agent.site.id, day: usageDay, tokens: RESERVATION })
          .onConflictDoUpdate({
            target: [usage.siteId, usage.day], set: { tokens: sql`${usage.tokens} + ${RESERVATION}` },
            setWhere: lte(usage.tokens, env.GEO_AGENT_DAILY_TOKEN_LIMIT - RESERVATION),
          }).returning({ tokens: usage.tokens });
        if (!available) throw new GeoError(429, "geo_agent_daily_limit");
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
        const result = turn.answer as GeoAgentAnswer;
        return reply.type(ndjson).send(JSON.stringify({ type: "complete", result }) + "\n");
      }
      const stream = new PassThrough();
      reply.type(ndjson).send(stream);
      const controller = new AbortController();
      const controllerKey = `${turn.conversationId}/${turn.requestId}`;
      active.set(controllerKey, controller);
      const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
      reply.raw.once("close", onClose);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT)]);
      const stillRunning = and(eq(turns.id, turn.id), eq(turns.attempt, turn.attempt), eq(turns.status, "running"));
      const timer = setInterval(() => {
        void db.select({ id: turns.id }).from(turns).where(stillRunning).limit(1)
          .then(rows => { if (!rows.length) controller.abort(); }).catch(() => controller.abort());
      }, 1800);
      timer.unref();
      const started = performance.now();
      let firstDeltaMs: number | null = null;
      streamItem(stream, { type: "started", schemaVersion: 1, conversationId: turn.conversationId, messageId: turn.id, requestId });
      void (async () => {
        try {
          await event(runtime, "geo_agent_message_sent", turn.id).catch(() => {});
          const recent = await db.select({ question: turns.question, answer: turns.answer }).from(turns).where(and(
            eq(turns.conversationId, turn.conversationId), eq(turns.status, "completed"),
          )).orderBy(desc(turns.createdAt)).limit(4);
          const history = recent.reverse().map(row => ({ question: row.question, message: (row.answer as GeoAgentAnswer).message }));
          const result = await answerFromKnowledge({
            db, scope: { orgId: agent.site.orgId, siteId: agent.site.id }, config: agent.definition.geoAgent, provider, embedder,
            publicOnly: true, question, history, signal, onDelta(text) {
              signal.throwIfAborted();
              firstDeltaMs ??= Math.round(performance.now() - started);
              streamItem(stream, { type: "delta", text });
            },
          });
          signal.throwIfAborted();
          const answer: GeoAgentAnswer = { schemaVersion: 1, conversationId: turn.conversationId, messageId: turn.id, message: result.message, citations: result.citations, actions: [] };
          const persisted = await runEntitlementTransaction(db, async tx => {
            const [updated] = await tx.update(turns).set({
              status: "completed", answer, usedTokens: result.tokens, retrievedCount: result.retrievedCount,
              provider: result.provider, model: result.model, latencyMs: Math.round(performance.now() - started),
              firstDeltaMs, updatedAt: new Date(),
            }).where(stillRunning).returning({ id: turns.id });
            if (!updated) return false;
            await tx.update(usage).set({ tokens: sql`max(0, ${usage.tokens} - ${RESERVATION} + ${result.tokens})` })
              .where(and(eq(usage.siteId, agent.site.id), eq(usage.day, usageDay)));
            return true;
          });
          if (!persisted) throw new GeoError(409, "response_cancelled");
          await event(runtime, "geo_agent_response_completed", turn.id).catch(() => {});
          streamItem(stream, { type: "citations", citations: result.citations });
          streamItem(stream, { type: "complete", result: answer });
        } catch {
          const aborted = controller.signal.aborted;
          await db.update(turns).set({ status: aborted ? "cancelled" : "failed", updatedAt: new Date(), latencyMs: Math.round(performance.now() - started) })
            .where(stillRunning).catch(() => {});
          if (!aborted) await event(runtime, "geo_agent_response_failed", `${turn.id}/${turn.attempt}`).catch(() => {});
          streamItem(stream, { type: "error", code: aborted ? "response_cancelled" : signal.aborted ? "response_timeout" : "response_failed" });
        } finally {
          clearInterval(timer);
          if (active.get(controllerKey) === controller) active.delete(controllerKey);
          reply.raw.removeListener("close", onClose);
          stream.end();
        }
      })();
      return reply;
    });

    routes.post("/conversations/:conversationId/messages/:requestId/cancel", async (request, reply) => {
      const runtime = await authorize(request);
      const { conversationId, requestId } = request.params as PublicParams;
      await loadConversation(db, runtime, conversationId!);
      const [cancelled] = await db.update(turns).set({ status: "cancelled", updatedAt: new Date() }).where(and(
        eq(turns.conversationId, conversationId!), eq(turns.requestId, requestId!), eq(turns.status, "running"),
      )).returning({ id: turns.id });
      if (cancelled) active.get(`${conversationId}/${requestId}`)?.abort();
      return reply.code(204).send();
    });

    routes.put("/conversations/:conversationId/messages/:requestId/feedback", async (request, reply) => {
      const runtime = await authorize(request);
      const { conversationId, requestId: messageId } = request.params as PublicParams;
      const { value } = z.object({ value: z.enum(["helpful", "unhelpful"]) }).strict().parse(request.body);
      await loadConversation(db, runtime, conversationId!);
      const [updated] = await db.update(turns).set({ feedback: value }).where(and(
        eq(turns.id, messageId!), eq(turns.conversationId, conversationId!), eq(turns.status, "completed"),
      )).returning({ id: turns.id });
      if (!updated) throw new GeoError(404, "message_not_found");
      await event(runtime, "geo_agent_feedback_submitted", `${messageId}/${value}`).catch(() => {});
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
  async function adminAgent(params: AdminParams) {
    const [row] = await db.select({ id: experiences.id }).from(experiences).innerJoin(sites, eq(experiences.siteId, sites.id))
      .where(and(eq(sites.id, params.siteId), eq(sites.orgId, params.orgId), eq(experiences.id, params.experienceId), eq(experiences.widgetType, "geo_agent"))).limit(1);
    if (!row) throw new GeoError(404, "geo_agent_unavailable");
  }
  app.post(`${adminPath}/preview`, { preHandler: admin, errorHandler: respondError, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async request => {
    const params = request.params as AdminParams;
    await adminAgent(params);
    const { config, question } = z.object({ config: geoAgentConfig, question: questionSchema }).strict().parse(request.body);
    const result = await answerFromKnowledge({
      db, scope: params, config, question, provider, embedder, publicOnly: true, history: [], signal: AbortSignal.timeout(TIMEOUT), onDelta() {},
    });
    return { message: result.message, citations: result.citations };
  });
  app.get(`${adminPath}/metrics`, { preHandler: admin, errorHandler: respondError }, async request => {
    const params = request.params as AdminParams;
    await adminAgent(params);
    const scope = and(eq(conversations.siteId, params.siteId), eq(conversations.experienceId, params.experienceId));
    const [[people], [messages]] = await Promise.all([
      db.select({ conversations: count(), visitors: sql<number>`count(distinct ${conversations.owner})` }).from(conversations).where(scope),
      db.select({
        messages: count(), responses: sql<number>`count(case when ${turns.status} = 'completed' then 1 end)`,
        failed: sql<number>`count(case when ${turns.status} = 'failed' then 1 end)`,
        helpful: sql<number>`count(case when ${turns.feedback} = 'helpful' then 1 end)`,
        unhelpful: sql<number>`count(case when ${turns.feedback} = 'unhelpful' then 1 end)`,
        answeredWithKnowledge: sql<number>`count(case when ${turns.status} = 'completed' and ${turns.retrievedCount} > 0 then 1 end)`,
        tokens: sql<number>`coalesce(sum(${turns.usedTokens}), 0)`,
        averageLatencyMs: sql<number | null>`round(avg(${turns.latencyMs}))`,
        averageFirstDeltaMs: sql<number | null>`round(avg(${turns.firstDeltaMs}))`,
      }).from(turns).innerJoin(conversations, eq(turns.conversationId, conversations.id)).where(scope),
    ]);
    return { ...people, ...messages };
  });

  let cleanup: ReturnType<typeof setInterval> | undefined;
  app.addHook("onReady", async () => {
    const prune = () => db.delete(conversations).where(lt(conversations.expiresAt, new Date())).catch(() => {});
    await prune();
    cleanup = setInterval(prune, 3_600_000);
    cleanup.unref();
  });
  app.addHook("onClose", async () => clearInterval(cleanup));
}
