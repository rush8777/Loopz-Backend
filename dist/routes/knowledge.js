import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config.js";
import { sites, knowledgeSources as sources, knowledgeDocuments as documents, knowledgeSyncJobs as jobs } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { KnowledgeError, retrievalInput, sourceInput } from "../lib/knowledge/contracts.js";
import { activeJob, cancelSync, enqueueSync, sourceDetails } from "../lib/knowledge/jobs.js";
import { retrieveKnowledge } from "../lib/knowledge/retrieval.js";
import { validateSource } from "../lib/knowledge/sources.js";
const path = "/orgs/:orgId/sites/:siteId/knowledge";
const SOURCE_LIMIT = 30;
const BODY_LIMIT = Math.ceil(env.KNOWLEDGE_FILE_MAX_BYTES / 3) * 4 + 512_000;
const patchInput = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    visibility: z.enum(["private", "public"]).optional(),
    enabled: z.boolean().optional(),
    syncHours: z.number().int().min(6).max(720).nullable().optional(),
    config: z.unknown().optional(),
}).strict();
const listFields = {
    id: sources.id, orgId: sources.orgId, siteId: sources.siteId, name: sources.name,
    type: sources.type, visibility: sources.visibility, enabled: sources.enabled,
    activeRevision: sources.activeRevision, syncHours: sources.syncHours,
    lastSyncedAt: sources.lastSyncedAt, nextSyncAt: sources.nextSyncAt, updatedAt: sources.updatedAt,
};
const jobFields = {
    id: jobs.id, status: jobs.status, attempts: jobs.attempts, completed: jobs.completed, total: jobs.total,
    errorCode: jobs.errorCode, embeddingTokens: jobs.embeddingTokens, updatedAt: jobs.updatedAt,
};
function present(source, documentCount, job) {
    const { activeRevision, orgId: _org, siteId: _site, ...publicFields } = source;
    const status = !source.enabled ? "disabled" : job?.status === "queued" || job?.status === "processing" || job?.status === "failed"
        ? job.status : activeRevision ? "ready" : "idle";
    return { ...publicFields, documentCount, status, job: job ?? null };
}
function editableConfig(source) {
    const config = source.config;
    return "filename" in config ? { filename: config.filename } : config;
}
function runAt(syncHours, now) {
    return syncHours ? new Date(now.getTime() + syncHours * 3_600_000) : null;
}
const scope = ({ orgId, siteId }) => and(eq(sources.orgId, orgId), eq(sources.siteId, siteId));
const sourceFilter = (params) => and(scope(params), eq(sources.id, params.sourceId));
const documentFilter = (source) => and(eq(documents.sourceId, source.id), eq(documents.revision, source.activeRevision ?? ""));
export function registerKnowledgeRoutes(app, db, embedder) {
    app.register(async (routes) => {
        routes.addHook("preHandler", authenticate);
        routes.addHook("preHandler", requireOrgRole(db, "ADMIN"));
        routes.addHook("preHandler", async (request, reply) => {
            const { orgId, siteId } = request.params;
            const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1);
            if (!site)
                return reply.code(404).send({ error: "site_not_found" });
        });
        routes.setErrorHandler((error, _request, reply) => {
            if (error instanceof KnowledgeError)
                return reply.code(error.retryable ? 503 : 400).send({ error: error.code });
            if (error instanceof z.ZodError)
                return reply.code(400).send({ error: "invalid_knowledge_input", details: error.flatten() });
            const status = error.statusCode ?? 500;
            return reply.code(status).send({ error: status < 500 ? "invalid_knowledge_request" : "knowledge_request_failed" });
        });
        const findSource = (params) => db.query.knowledgeSources.findFirst({ where: sourceFilter(params) });
        const latestJob = async (sourceId) => (await db.select(jobFields).from(jobs)
            .where(eq(jobs.sourceId, sourceId)).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(1))[0];
        const summary = async (source) => {
            const [[total], job] = await Promise.all([
                db.select({ total: count() }).from(documents).where(documentFilter(source)), latestJob(source.id),
            ]);
            return present(source, total.total, job);
        };
        routes.get("/sources", async (request) => {
            const rows = await db.select(listFields).from(sources).where(scope(request.params)).orderBy(desc(sources.updatedAt));
            return { sources: await Promise.all(rows.map(summary)) };
        });
        routes.post("/sources", { bodyLimit: BODY_LIMIT, config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (request, reply) => {
            const params = request.params;
            const input = sourceInput.parse(request.body);
            validateSource(input, env.KNOWLEDGE_FILE_MAX_BYTES);
            const now = new Date();
            const source = await db.transaction(async (transaction) => {
                const [{ total }] = await transaction.select({ total: count() }).from(sources).where(scope(params));
                if (total >= SOURCE_LIMIT)
                    return null;
                const [row] = await transaction.insert(sources).values({
                    ...input, orgId: params.orgId, siteId: params.siteId, nextSyncAt: runAt(input.syncHours, now), createdAt: now, updatedAt: now,
                }).returning(listFields);
                await enqueueSync(transaction, row.id, now);
                return row;
            });
            if (!source)
                return reply.code(409).send({ error: "knowledge_source_limit" });
            return reply.code(201).send({ source: await summary(source) });
        });
        routes.get("/sources/:sourceId", async (request, reply) => {
            const source = await findSource(request.params);
            if (!source)
                return reply.code(404).send({ error: "source_not_found" });
            return { source: { ...await summary(source), config: editableConfig(source) } };
        });
        routes.patch("/sources/:sourceId", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const params = request.params;
            const patch = patchInput.parse(request.body);
            const now = new Date();
            const updated = await db.transaction(async (transaction) => {
                const [source] = await transaction.select().from(sources).where(sourceFilter(params));
                if (!source)
                    return null;
                const { enabled = source.enabled, ...changes } = patch;
                const updatedInput = sourceInput.parse({ ...sourceDetails(source), ...changes });
                validateSource(updatedInput, env.KNOWLEDGE_FILE_MAX_BYTES);
                const reindex = patch.config !== undefined && JSON.stringify(updatedInput.config) !== JSON.stringify(source.config);
                if (reindex || !enabled)
                    await cancelSync(transaction, source.id, now);
                const [row] = await transaction.update(sources).set({
                    ...updatedInput, enabled, updatedAt: now, nextSyncAt: enabled ? runAt(updatedInput.syncHours, now) : null,
                    generation: reindex || !enabled ? source.generation + 1 : source.generation,
                }).where(sourceFilter(params)).returning();
                if (enabled && (reindex || (!source.enabled && !source.activeRevision)))
                    await enqueueSync(transaction, source.id, now);
                return row;
            });
            if (!updated)
                return reply.code(404).send({ error: "source_not_found" });
            return { source: { ...await summary(updated), config: editableConfig(updated) } };
        });
        routes.delete("/sources/:sourceId", async (request, reply) => {
            const [source] = await db.delete(sources).where(sourceFilter(request.params)).returning({ id: sources.id });
            return source ? reply.code(204).send() : reply.code(404).send({ error: "source_not_found" });
        });
        routes.post("/sources/:sourceId/sync", { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } }, async (request, reply) => {
            const params = request.params;
            const result = await db.transaction(async (transaction) => {
                const [source] = await transaction.select({ id: sources.id, enabled: sources.enabled }).from(sources).where(sourceFilter(params));
                if (!source)
                    return null;
                if (!source.enabled)
                    return false;
                const [created] = await enqueueSync(transaction, source.id);
                if (created)
                    return { id: created.id, status: created.status };
                const [current] = await transaction.select({ id: jobs.id, status: jobs.status }).from(jobs).where(and(eq(jobs.sourceId, source.id), activeJob));
                return current;
            });
            if (result === null)
                return reply.code(404).send({ error: "source_not_found" });
            if (!result)
                return reply.code(409).send({ error: "source_disabled" });
            return reply.code(202).send({ job: result });
        });
        routes.get("/sources/:sourceId/jobs/:jobId", async (request, reply) => {
            const params = request.params;
            const [job] = await db.select(jobFields).from(jobs).innerJoin(sources, eq(jobs.sourceId, sources.id))
                .where(and(sourceFilter(params), eq(jobs.id, params.jobId))).limit(1);
            return job ? { job } : reply.code(404).send({ error: "job_not_found" });
        });
        routes.post("/sources/:sourceId/jobs/:jobId/cancel", async (request, reply) => {
            const params = request.params;
            const permittedSource = db.select({ id: sources.id }).from(sources).where(sourceFilter(params));
            const [job] = await db.update(jobs).set({ status: "cancelled", leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
                .where(and(eq(jobs.sourceId, permittedSource), eq(jobs.id, params.jobId), activeJob)).returning(jobFields);
            return job ? { job } : reply.code(404).send({ error: "active_job_not_found" });
        });
        routes.get("/sources/:sourceId/documents", async (request, reply) => {
            const source = await findSource(request.params);
            if (!source)
                return reply.code(404).send({ error: "source_not_found" });
            const rows = await db.select({ id: documents.id, key: documents.key, title: documents.title, url: documents.url })
                .from(documents).where(documentFilter(source)).orderBy(documents.title);
            return { documents: rows.map(({ key, ...document }) => ({ ...document, excluded: source.excludedKeys.includes(key) })) };
        });
        routes.patch("/sources/:sourceId/documents/:documentId", async (request, reply) => {
            const params = request.params;
            const { excluded } = z.object({ excluded: z.boolean() }).strict().parse(request.body);
            const updated = await db.transaction(async (transaction) => {
                const [source] = await transaction.select().from(sources).where(sourceFilter(params));
                if (!source)
                    return null;
                const [document] = await transaction.select({ key: documents.key }).from(documents)
                    .where(and(documentFilter(source), eq(documents.id, params.documentId))).limit(1);
                if (!document)
                    return null;
                const excludedKeys = new Set(source.excludedKeys);
                if (excluded)
                    excludedKeys.add(document.key);
                else
                    excludedKeys.delete(document.key);
                if (excludedKeys.size > 500)
                    throw new KnowledgeError("excluded_document_limit");
                await transaction.update(sources).set({ excludedKeys: [...excludedKeys], updatedAt: new Date() }).where(sourceFilter(params));
                return { excluded };
            });
            return updated ?? reply.code(404).send({ error: "document_not_found" });
        });
        routes.post("/retrieve", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
            const { orgId, siteId } = request.params;
            const result = await retrieveKnowledge(db, embedder, { orgId, siteId, ...retrievalInput.parse(request.body) });
            return { matches: result.matches };
        });
    }, { prefix: path });
}
//# sourceMappingURL=knowledge.js.map