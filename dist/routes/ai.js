import { and, asc, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config.js";
import { runEntitlementTransaction } from "../db/transaction.js";
import { aiConversations, aiMessages, aiPendingApprovals, aiProviderUsage, aiToolExecutions, sites } from "../db/schema.js";
import { buildAiContext } from "../lib/ai/context.js";
import { runAiTurn } from "../lib/ai/orchestrator.js";
import { createConfiguredAiProvider } from "../lib/ai/providers/index.js";
import { previewProposal, saveApprovedProposal, validateProposalReferences } from "../lib/ai/resourceCreation.js";
import { aiProposalSchema } from "../lib/ai/skills/registry.js";
import { sendEntitlementError } from "../lib/entitlements/http.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
const createConversationSchema = z.object({ title: z.string().trim().min(1).max(120).optional() });
const sendMessageSchema = z.object({ content: z.string().trim().min(1).max(8000) });
function iso(date) { return date.toISOString(); }
function conversationJson(row) { return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }; }
function messageJson(row, approval) {
    return {
        id: row.id, role: row.role, content: row.content, evidence: row.evidence ?? [], proposal: row.proposal ?? null, createdAt: iso(row.createdAt),
        approval: approval ? { id: approval.id, status: approval.status, resourceType: approval.resourceType, resourceId: approval.resourceId, decidedAt: approval.decidedAt?.toISOString() ?? null } : null,
    };
}
async function loadConversation(db, input) {
    const [row] = await db.select().from(aiConversations).where(and(eq(aiConversations.id, input.id), eq(aiConversations.orgId, input.orgId), eq(aiConversations.siteId, input.siteId), eq(aiConversations.userId, input.userId))).limit(1);
    return row ?? null;
}
export function registerAiRoutes(app, db, providerOverride) {
    const provider = providerOverride === undefined ? createConfiguredAiProvider() : providerOverride;
    const requireScopedSite = async (request, reply) => {
        const { orgId, siteId } = request.params;
        const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
    };
    const viewer = [authenticate, requireOrgRole(db, "VIEWER"), requireScopedSite];
    const admin = [authenticate, requireOrgRole(db, "ADMIN"), requireScopedSite];
    app.get("/orgs/:orgId/sites/:siteId/ai/status", { preHandler: viewer }, async () => ({
        enabled: Boolean(provider), provider: provider?.name ?? null, model: provider?.model ?? null,
        capabilities: ["analytics", "events", "sessions", "surveys", "experiences", "dashboard_proposals", "segment_proposals", "funnel_proposals"],
    }));
    app.get("/orgs/:orgId/sites/:siteId/ai/conversations", { preHandler: viewer }, async (request) => {
        const { orgId, siteId } = request.params;
        const rows = await db.select().from(aiConversations).where(and(eq(aiConversations.orgId, orgId), eq(aiConversations.siteId, siteId), eq(aiConversations.userId, request.user.id))).orderBy(desc(aiConversations.updatedAt)).limit(50);
        return { conversations: rows.map(conversationJson) };
    });
    app.post("/orgs/:orgId/sites/:siteId/ai/conversations", { preHandler: viewer }, async (request, reply) => {
        const parsed = createConversationSchema.safeParse(request.body ?? {});
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const { orgId, siteId } = request.params;
        const [row] = await db.insert(aiConversations).values({ orgId, siteId, userId: request.user.id, title: parsed.data.title ?? "New conversation" }).returning();
        return reply.code(201).send(conversationJson(row));
    });
    app.get("/orgs/:orgId/sites/:siteId/ai/conversations/:conversationId", { preHandler: viewer }, async (request, reply) => {
        const { orgId, siteId, conversationId } = request.params;
        const conversation = await loadConversation(db, { id: conversationId, orgId, siteId, userId: request.user.id });
        if (!conversation)
            return reply.code(404).send({ error: "conversation_not_found" });
        const [messages, approvals] = await Promise.all([
            db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(asc(aiMessages.createdAt)),
            db.select().from(aiPendingApprovals).where(eq(aiPendingApprovals.conversationId, conversationId)),
        ]);
        const approvalByMessage = new Map(approvals.map(approval => [approval.messageId, approval]));
        return { conversation: conversationJson(conversation), messages: messages.map(message => messageJson(message, approvalByMessage.get(message.id))) };
    });
    app.delete("/orgs/:orgId/sites/:siteId/ai/conversations/:conversationId", { preHandler: viewer }, async (request, reply) => {
        const { orgId, siteId, conversationId } = request.params;
        const conversation = await loadConversation(db, { id: conversationId, orgId, siteId, userId: request.user.id });
        if (!conversation)
            return reply.code(404).send({ error: "conversation_not_found" });
        await db.delete(aiConversations).where(eq(aiConversations.id, conversationId));
        return reply.code(204).send();
    });
    app.post("/orgs/:orgId/sites/:siteId/ai/conversations/:conversationId/messages", {
        preHandler: viewer,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    }, async (request, reply) => {
        if (!provider)
            return reply.code(503).send({ error: "ai_disabled", message: "Movcues AI is not configured on the backend." });
        const parsed = sendMessageSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const { orgId, siteId, conversationId } = request.params;
        const conversation = await loadConversation(db, { id: conversationId, orgId, siteId, userId: request.user.id });
        if (!conversation)
            return reply.code(404).send({ error: "conversation_not_found" });
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        const usageRows = await db.select({ totalTokens: aiProviderUsage.totalTokens }).from(aiProviderUsage).where(and(eq(aiProviderUsage.orgId, orgId), gte(aiProviderUsage.createdAt, dayStart)));
        const usedToday = usageRows.reduce((total, row) => total + row.totalTokens, 0);
        if (usedToday >= env.AI_DAILY_TOKEN_LIMIT)
            return reply.code(429).send({ error: "ai_daily_limit", message: "This workspace reached its daily AI usage limit." });
        const now = new Date();
        const [userMessage] = await db.insert(aiMessages).values({ conversationId, role: "user", content: parsed.data.content, createdAt: now }).returning();
        if (conversation.title === "New conversation")
            await db.update(aiConversations).set({ title: parsed.data.content.slice(0, 72), updatedAt: now }).where(eq(aiConversations.id, conversationId));
        const [execution] = await db.insert(aiToolExecutions).values({ conversationId, messageId: userMessage.id, toolName: "product_context_and_reasoning", status: "running", inputSummary: { promptLength: parsed.data.content.length }, startedAt: now }).returning();
        try {
            const context = await buildAiContext(db, orgId, siteId, parsed.data.content, env.AI_MAX_CONTEXT_CHARS);
            if (!context)
                return reply.code(404).send({ error: "site_not_found" });
            const historyRows = await db.select({ role: aiMessages.role, content: aiMessages.content }).from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(desc(aiMessages.createdAt)).limit(12);
            const history = historyRows.reverse().map(item => ({ role: item.role === "assistant" ? "assistant" : "user", content: item.content }));
            const result = await runAiTurn({ provider, prompt: parsed.data.content, history, contextJson: context.contextJson });
            let proposal = result.proposal;
            let preview = null;
            if (proposal) {
                const validated = aiProposalSchema.safeParse(proposal);
                if (!validated.success)
                    proposal = undefined;
                else
                    preview = await previewProposal(db, siteId, validated.data);
            }
            const completedAt = new Date();
            const [assistantMessage] = await db.insert(aiMessages).values({ conversationId, role: "assistant", content: result.markdown, evidence: context.evidence, proposal: proposal ?? null, createdAt: completedAt }).returning();
            let approval;
            if (proposal)
                [approval] = await db.insert(aiPendingApprovals).values({ conversationId, messageId: assistantMessage.id, orgId, siteId, requestedBy: request.user.id, resourceType: proposal.type, proposal, idempotencyKey: conversationId + ":" + assistantMessage.id + ":" + proposal.type }).returning();
            await Promise.all([
                db.update(aiToolExecutions).set({ messageId: assistantMessage.id, status: "completed", outputSummary: { evidenceSources: context.evidence.length, proposalType: proposal?.type ?? null }, completedAt }).where(eq(aiToolExecutions.id, execution.id)),
                db.insert(aiProviderUsage).values({ orgId, siteId, userId: request.user.id, conversationId, provider: result.generation.provider, model: result.generation.model, promptTokens: result.generation.usage.promptTokens, completionTokens: result.generation.usage.completionTokens, totalTokens: result.generation.usage.totalTokens, createdAt: completedAt }),
                db.update(aiConversations).set({ updatedAt: completedAt }).where(eq(aiConversations.id, conversationId)),
            ]);
            return { userMessage: messageJson(userMessage), assistantMessage: messageJson(assistantMessage, approval), preview };
        }
        catch (error) {
            const code = error instanceof Error ? error.message.slice(0, 120) : "ai_generation_failed";
            await db.update(aiToolExecutions).set({ status: "failed", errorCode: code, completedAt: new Date() }).where(eq(aiToolExecutions.id, execution.id));
            request.log.error({ err: error, conversationId }, "AI turn failed");
            return reply.code(502).send({ error: "ai_generation_failed", message: "Movcues AI could not complete this request. Your message was preserved; please retry." });
        }
    });
    app.post("/orgs/:orgId/sites/:siteId/ai/approvals/:approvalId/approve", { preHandler: admin }, async (request, reply) => {
        const { orgId, siteId, approvalId } = request.params;
        const [approval] = await db.select().from(aiPendingApprovals).where(and(eq(aiPendingApprovals.id, approvalId), eq(aiPendingApprovals.orgId, orgId), eq(aiPendingApprovals.siteId, siteId), eq(aiPendingApprovals.requestedBy, request.user.id))).limit(1);
        if (!approval)
            return reply.code(404).send({ error: "approval_not_found" });
        if (approval.status === "approved")
            return { approval: { id: approval.id, status: approval.status, resourceId: approval.resourceId }, resource: { id: approval.resourceId, path: resourcePath(approval.resourceType, approval.resourceId) } };
        if (approval.status !== "pending")
            return reply.code(409).send({ error: "approval_already_decided" });
        const parsedProposal = aiProposalSchema.safeParse(approval.proposal);
        if (!parsedProposal.success)
            return reply.code(409).send({ error: "invalid_stored_proposal" });
        const referenceError = await validateProposalReferences(db, siteId, parsedProposal.data);
        if (referenceError)
            return reply.code(409).send({ error: "stale_proposal", message: referenceError });
        try {
            const resource = await runEntitlementTransaction(db, async (tx) => {
                const [fresh] = await tx.select().from(aiPendingApprovals).where(and(eq(aiPendingApprovals.id, approvalId), eq(aiPendingApprovals.status, "pending"))).limit(1);
                if (!fresh)
                    return null;
                const created = await saveApprovedProposal(tx, { orgId, siteId, userId: request.user.id, proposal: parsedProposal.data });
                await tx.update(aiPendingApprovals).set({ status: "approved", resourceId: created.id, decidedAt: new Date() }).where(eq(aiPendingApprovals.id, approvalId));
                return created;
            });
            if (!resource)
                return reply.code(409).send({ error: "approval_already_decided" });
            return { approval: { id: approval.id, status: "approved", resourceId: resource.id }, resource };
        }
        catch (error) {
            return sendEntitlementError(reply, error);
        }
    });
    app.post("/orgs/:orgId/sites/:siteId/ai/approvals/:approvalId/reject", { preHandler: admin }, async (request, reply) => {
        const { orgId, siteId, approvalId } = request.params;
        const [row] = await db.update(aiPendingApprovals).set({ status: "rejected", decidedAt: new Date() }).where(and(eq(aiPendingApprovals.id, approvalId), eq(aiPendingApprovals.orgId, orgId), eq(aiPendingApprovals.siteId, siteId), eq(aiPendingApprovals.requestedBy, request.user.id), eq(aiPendingApprovals.status, "pending"))).returning();
        if (!row)
            return reply.code(404).send({ error: "pending_approval_not_found" });
        return { approval: { id: row.id, status: row.status } };
    });
}
function resourcePath(type, id) {
    if (type === "dashboard")
        return "/dashboard/" + id;
    if (type === "segment")
        return "/segments/" + id;
    return "/observe/funnels/" + id;
}
//# sourceMappingURL=ai.js.map