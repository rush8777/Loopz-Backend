import { env } from "../../config.js";
import { KnowledgeError } from "./contracts.js";

export interface KnowledgeEmbedder {
  readonly key: string;
  readonly dimensions: number;
  embed(texts: string[], signal: AbortSignal): Promise<{ vectors: number[][]; tokens: number }>;
}

export function createKnowledgeEmbedder(): KnowledgeEmbedder | null {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = env.KNOWLEDGE_EMBEDDING_MODEL;
  const dimensions = env.KNOWLEDGE_EMBEDDING_DIMENSIONS;
  return {
    key: `openai:${model}:${dimensions}:${env.KNOWLEDGE_EMBEDDING_VERSION}`,
    dimensions,
    async embed(texts, signal) {
      try {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ input: texts, model, dimensions }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new KnowledgeError("embedding_request_failed", response.status >= 500 || response.status === 429);
        }
        const output = await response.json() as { data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } };
        const vectors = output.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
        validateVectors(vectors, texts.length, dimensions);
        return { vectors, tokens: output.usage?.total_tokens ?? 0 };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof KnowledgeError) throw error;
        throw new KnowledgeError("embedding_network_error", true);
      }
    },
  };
}

export function validateVectors(vectors: number[][], expected: number, dimensions: number) {
  if (vectors.length !== expected || vectors.some(vector => !Array.isArray(vector) || vector.length !== dimensions
    || vector.some(value => !Number.isFinite(value)) || vector.every(value => value === 0))) {
    throw new KnowledgeError("invalid_embedding");
  }
}
