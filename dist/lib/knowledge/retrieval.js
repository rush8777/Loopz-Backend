import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { knowledgeChunks as chunks, knowledgeDocuments as documents, knowledgeSources as sources } from "../../db/schema.js";
import { validateVectors } from "./embeddings.js";
const commonWords = new Set(["how", "what", "when", "where", "would", "could", "should", "about", "the", "and", "that", "this", "are", "can", "does", "have", "with", "from", "into", "for", "you", "your", "find", "please", "need", "want", "help", "trying", "just", "show", "mine", "some", "tell"]);
export async function retrieveKnowledge(db, embedder, query) {
    if (query.sourceIds?.length === 0)
        return { matches: [], embeddingTokens: 0 };
    const scope = and(eq(sources.orgId, query.orgId), eq(sources.siteId, query.siteId), eq(sources.enabled, true), query.publicOnly ? eq(sources.visibility, "public") : undefined, query.sourceIds ? inArray(sources.id, query.sourceIds) : undefined, eq(documents.revision, sources.activeRevision), sql `NOT EXISTS (SELECT 1 FROM json_each(${sources.excludedKeys}) WHERE value = ${documents.key})`);
    const select = {
        documentId: documents.id, title: documents.title, url: documents.url, chunkId: chunks.id,
        sourceId: sources.id, heading: chunks.heading, content: chunks.content, key: documents.key,
    };
    const words = [...new Set((query.question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
            .filter(word => !commonWords.has(word))
            .map(word => word.length > 4 && !/(?:ss|us|is)$/.test(word)
            ? word.replace(/(?:ches|shes|xes|zes|sses|s)$/, ending => ending.slice(0, ending.length === 1 ? -1 : -2))
            : word))].slice(0, 16);
    const terms = words.map(word => sql `(CASE WHEN instr(lower(${documents.title} || ' ' || coalesce(${chunks.heading}, '')), ${word}) > 0 THEN 2.0 WHEN instr(lower(${chunks.content}), ${word}) > 0 THEN 1.0 ELSE 0.0 END)`);
    const lexical = sql `(${terms.length ? sql.join(terms, sql ` + `) : sql `0.0`})`;
    const limit = Math.min(query.topK * 4, 48);
    const model = sql `json_extract(${sources.embeddingKey}, '$[0]')`;
    let embeddingTokens = 0;
    let vector;
    if (embedder) {
        const [hasVector] = await db.select({ id: chunks.id }).from(sources)
            .innerJoin(documents, eq(documents.sourceId, sources.id))
            .innerJoin(chunks, eq(chunks.documentId, documents.id))
            .where(and(scope, sql `${model} = ${embedder.key} AND ${chunks.embedding} IS NOT NULL`)).limit(1);
        if (hasVector) {
            const { vectors, tokens } = await embedder.embed([query.question], query.signal ?? AbortSignal.timeout(25_000));
            validateVectors(vectors, 1, embedder.dimensions);
            embeddingTokens = tokens;
            vector = vectors[0];
        }
    }
    // Guard evaluation by model before calling the distance function on a stored vector.
    const similarity = vector ? sql `CASE WHEN ${model} = ${embedder.key} AND ${chunks.embedding} IS NOT NULL
      THEN 1.0 - vector_distance_cos(vector32(${chunks.embedding}), vector32(${JSON.stringify(vector)})) ELSE 0.0 END` : sql `0.0`;
    const base = () => db.select({ ...select, lexical, similarity }).from(sources)
        .innerJoin(documents, eq(documents.sourceId, sources.id))
        .innerJoin(chunks, eq(chunks.documentId, documents.id));
    const [keyword, semantic] = await Promise.all([
        terms.length ? base().where(and(scope, sql `${lexical} >= ${Math.min(2, words.length)}`))
            .orderBy(desc(lexical), chunks.id).limit(limit) : [],
        vector ? base().where(and(scope, sql `(${similarity}) >= 0.48`)).orderBy(desc(similarity), chunks.id).limit(limit) : [],
    ]);
    const ranked = new Map();
    function rank(rows, weight) {
        rows.forEach((row, index) => {
            const previous = ranked.get(row.chunkId);
            ranked.set(row.chunkId, { row, weight: (previous?.weight ?? 0) + weight / (12 + index) });
        });
    }
    rank(semantic, 1.25);
    rank(keyword, 1);
    const unique = new Set();
    const matches = [...ranked.values()].sort((a, b) => b.weight - a.weight)
        .filter(({ row }) => {
        const key = row.content.replace(/\s+/g, " ").trim();
        if (unique.has(key))
            return false;
        unique.add(key);
        return true;
    }).slice(0, query.topK)
        .map(({ row, weight }) => ({
        chunkId: row.chunkId, documentId: row.documentId, sourceId: row.sourceId,
        title: row.title, heading: row.heading, content: row.content, url: row.url, score: weight,
    }));
    return { matches, embeddingTokens };
}
//# sourceMappingURL=retrieval.js.map