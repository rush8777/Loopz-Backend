import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { env } from "../../config.js";
import { knowledgeSources as sources, knowledgeDocuments as documents, knowledgeChunks as chunks, knowledgeSyncJobs as jobs } from "../../db/schema.js";
import { KnowledgeError, sourceInput } from "./contracts.js";
import { validateVectors } from "./embeddings.js";
import { chunkDocument, documentHash } from "./extract.js";
import { createKnowledgeFetcher } from "./http.js";
import { readSource } from "./sources.js";
const MAX_ATTEMPTS = 3;
const LEASE_MS = 90_000;
const BATCH = 16;
const MAX_CHUNKS = 2400;
export const activeJob = inArray(jobs.status, ["queued", "processing"]);
export function enqueueSync(db, sourceId, now = new Date()) {
    return db.insert(jobs).values({ sourceId, status: "queued", runAt: now, createdAt: now, updatedAt: now })
        .onConflictDoNothing().returning();
}
export function cancelSync(db, sourceId, now = new Date()) {
    return db.update(jobs).set({ status: "cancelled", leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(eq(jobs.sourceId, sourceId), activeJob)).returning();
}
function readyAt(source, now) {
    return source.syncHours ? new Date(now.getTime() + source.syncHours * 3_600_000) : null;
}
export async function processKnowledgeJob(db, embedder, shutdown, fetcher = createKnowledgeFetcher(), clock = () => new Date()) {
    const now = clock();
    await db.update(jobs).set({
        status: "failed", errorCode: "sync_interrupted", updatedAt: now, leaseOwner: null, leaseUntil: null,
    }).where(and(eq(jobs.status, "processing"), lte(jobs.leaseUntil, now), sql `${jobs.attempts} >= ${MAX_ATTEMPTS}`));
    const scheduled = await db.select().from(sources)
        .where(and(eq(sources.enabled, true), isNotNull(sources.nextSyncAt), lte(sources.nextSyncAt, now)))
        .orderBy(sources.nextSyncAt).limit(10);
    for (const source of scheduled)
        await db.transaction(async (transaction) => {
            const [updated] = await transaction.update(sources).set({ nextSyncAt: readyAt(source, now) })
                .where(and(eq(sources.id, source.id), eq(sources.generation, source.generation), eq(sources.enabled, true), lte(sources.nextSyncAt, now))).returning();
            if (updated)
                await enqueueSync(transaction, source.id, now);
        });
    if (shutdown.aborted)
        return false;
    const candidate = db.select({ id: jobs.id }).from(jobs).innerJoin(sources, eq(sources.id, jobs.sourceId))
        .where(and(eq(sources.enabled, true), or(and(eq(jobs.status, "queued"), lte(jobs.runAt, now)), and(eq(jobs.status, "processing"), lte(jobs.leaseUntil, now))))).orderBy(asc(jobs.runAt), asc(jobs.createdAt)).limit(1);
    // Selection and lease acquisition run as one statement across all worker processes.
    const owner = randomUUID();
    const [job] = await db.update(jobs).set({
        status: "processing", leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS),
        attempts: sql `${jobs.attempts} + 1`, updatedAt: now, completed: 0, total: 0, errorCode: null,
    }).where(eq(jobs.id, candidate)).returning();
    if (!job)
        return false;
    const owns = and(eq(jobs.id, job.id), eq(jobs.leaseOwner, owner), eq(jobs.status, "processing"));
    const watchdog = new AbortController();
    const signal = AbortSignal.any([shutdown, watchdog.signal, AbortSignal.timeout(7 * 60_000)]);
    let heartbeatRunning = false;
    const renew = async () => {
        const time = clock();
        const [current] = await db.update(jobs).set({ leaseUntil: new Date(time.getTime() + LEASE_MS), updatedAt: time })
            .where(and(owns, sql `${jobs.leaseUntil} > ${time.getTime()}`)).returning({ id: jobs.id });
        if (!current)
            watchdog.abort(new KnowledgeError("sync_cancelled"));
    };
    const heartbeat = setInterval(() => {
        if (heartbeatRunning || signal.aborted)
            return;
        heartbeatRunning = true;
        void renew().catch(() => watchdog.abort(new KnowledgeError("sync_interrupted", true)))
            .finally(() => { heartbeatRunning = false; });
    }, 1500);
    heartbeat.unref();
    try {
        const [source] = await db.select().from(sources).where(and(eq(sources.id, job.sourceId), eq(sources.enabled, true)));
        if (!source)
            throw new KnowledgeError("sync_cancelled");
        const config = sourceInput.parse(sourceDetails(source));
        const progress = async (completed, total) => {
            signal.throwIfAborted();
            const [updated] = await db.update(jobs).set({ completed, total, updatedAt: clock() }).where(owns).returning({ id: jobs.id });
            if (!updated)
                throw new KnowledgeError("sync_cancelled");
        };
        const discovered = await readSource(config, fetcher, signal, progress, env.KNOWLEDGE_FILE_MAX_BYTES);
        const embeddingKey = JSON.stringify([embedder?.key ?? "keyword", env.KNOWLEDGE_CHUNK_WORDS, env.KNOWLEDGE_CHUNK_OVERLAP]);
        const oldDocuments = source.activeRevision && source.embeddingKey === embeddingKey
            ? await db.select().from(documents).where(and(eq(documents.sourceId, source.id), eq(documents.revision, source.activeRevision))) : [];
        const oldByHash = new Map(oldDocuments.map(document => [document.contentHash, document]));
        const prepared = [];
        const needingEmbeddings = [];
        let chunkCount = 0;
        const revision = randomUUID();
        for (const document of discovered) {
            signal.throwIfAborted();
            const contentHash = documentHash(document);
            const existing = oldByHash.get(contentHash);
            const id = `kd_${randomUUID()}`;
            const rows = existing
                ? (await db.select().from(chunks).where(eq(chunks.documentId, existing.id)).orderBy(chunks.position))
                    .map(chunk => ({ documentId: id, position: chunk.position, heading: chunk.heading, content: chunk.content, embedding: chunk.embedding }))
                : chunkDocument(document, env.KNOWLEDGE_CHUNK_WORDS, env.KNOWLEDGE_CHUNK_OVERLAP).map((chunk, position) => ({ ...chunk, position, documentId: id, embedding: null }));
            chunkCount += rows.length;
            if (chunkCount > MAX_CHUNKS)
                throw new KnowledgeError("source_chunk_limit");
            if (embedder && !existing)
                for (const row of rows) {
                    needingEmbeddings.push({ row, text: [document.title, row.heading, row.content].filter(Boolean).join("\n") });
                }
            prepared.push({ doc: { id, sourceId: source.id, revision, key: document.key, title: document.title, url: document.url, contentHash, createdAt: clock() }, chunks: rows });
        }
        for (let offset = 0; embedder && offset < needingEmbeddings.length; offset += BATCH) {
            signal.throwIfAborted();
            const batch = needingEmbeddings.slice(offset, offset + BATCH);
            const response = await embedder.embed(batch.map(item => item.text), signal);
            validateVectors(response.vectors, batch.length, embedder.dimensions);
            batch.forEach((item, index) => { item.row.embedding = response.vectors[index]; });
            await db.update(jobs).set({ embeddingTokens: sql `${jobs.embeddingTokens} + ${response.tokens}` }).where(owns);
        }
        signal.throwIfAborted();
        await db.transaction(async (transaction) => {
            const time = clock();
            const [owned] = await transaction.update(jobs).set({
                status: "succeeded", completed: discovered.length, total: discovered.length, leaseOwner: null, leaseUntil: null, updatedAt: time,
            }).where(and(owns, sql `${jobs.leaseUntil} > ${time.getTime()}`)).returning({ id: jobs.id });
            if (!owned)
                throw new KnowledgeError("sync_cancelled");
            const [activated] = await transaction.update(sources).set({
                activeRevision: revision, embeddingKey, lastSyncedAt: time, updatedAt: time, nextSyncAt: readyAt(source, time),
            }).where(and(eq(sources.id, source.id), eq(sources.generation, source.generation), eq(sources.enabled, true))).returning({ id: sources.id });
            if (!activated)
                throw new KnowledgeError("sync_cancelled");
            for (const entry of prepared) {
                await transaction.insert(documents).values(entry.doc);
                for (let offset = 0; offset < entry.chunks.length; offset += BATCH) {
                    await transaction.insert(chunks).values(entry.chunks.slice(offset, offset + BATCH));
                }
            }
            await transaction.delete(documents).where(and(eq(documents.sourceId, source.id), ne(documents.revision, revision)));
        });
    }
    catch (error) {
        const time = clock();
        const failure = watchdog.signal.aborted ? watchdog.signal.reason : error;
        const retry = job.attempts < MAX_ATTEMPTS && (shutdown.aborted || signal.aborted || !(failure instanceof KnowledgeError) || failure.retryable);
        const status = failure instanceof KnowledgeError && failure.code === "sync_cancelled" ? "cancelled" : retry ? "queued" : "failed";
        await db.update(jobs).set({
            status, leaseOwner: null, leaseUntil: null, updatedAt: time,
            runAt: new Date(time.getTime() + 15_000 * 2 ** job.attempts),
            errorCode: failure instanceof KnowledgeError ? failure.code : "sync_interrupted",
        }).where(owns);
    }
    finally {
        clearInterval(heartbeat);
    }
    return true;
}
export function sourceDetails(source) {
    return { type: source.type, name: source.name, config: source.config, visibility: source.visibility, syncHours: source.syncHours };
}
export function startKnowledgeWorker(db, embedder) {
    const controller = new AbortController();
    let timer;
    let task;
    const run = () => {
        if (controller.signal.aborted)
            return;
        task = (async () => {
            let processed = false;
            try {
                processed = await processKnowledgeJob(db, embedder, controller.signal);
            }
            catch {
                console.error("knowledge_worker_iteration_failed");
            }
            if (!controller.signal.aborted) {
                timer = setTimeout(run, processed ? 25 : 3000);
                timer.unref();
            }
        })();
    };
    run();
    return async () => {
        controller.abort();
        clearTimeout(timer);
        await task;
    };
}
//# sourceMappingURL=jobs.js.map