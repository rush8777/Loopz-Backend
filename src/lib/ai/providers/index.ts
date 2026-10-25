import { env } from "../../../config.js";
import { OpenAiProvider } from "./openai.js";
import type { AiProvider } from "./types.js";
import { VertexAiProvider } from "./vertex.js";

export function createConfiguredAiProvider(): AiProvider | null {
  if (!env.AI_ENABLED) return null;
  if (env.AI_PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
    return new OpenAiProvider(env.OPENAI_MODEL, env.OPENAI_API_KEY);
  }
  if (!env.VERTEX_PROJECT) throw new Error("VERTEX_PROJECT is required");
  return new VertexAiProvider(env.VERTEX_MODEL, env.VERTEX_PROJECT, env.VERTEX_LOCATION);
}

export type { AiProvider, AiGenerateInput, AiGenerateResult } from "./types.js";
