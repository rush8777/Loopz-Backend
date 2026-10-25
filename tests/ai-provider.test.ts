import { describe, expect, it, vi } from "vitest";
import { OpenAiProvider } from "../src/lib/ai/providers/openai.js";
import { VertexAiProvider } from "../src/lib/ai/providers/vertex.js";
import { runAiTurn } from "../src/lib/ai/orchestrator.js";
import type { AiProvider } from "../src/lib/ai/providers/types.js";

describe("AI providers and response validation", () => {
  it("maps OpenAI output and usage without exposing the credential", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret-test-key");
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"markdown":"ok","proposal":null}' } }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }), { status: 200 });
    });
    const provider = new OpenAiProvider("gpt-test", "secret-test-key", fetcher as typeof fetch);
    const result = await provider.generate({ system: "system", prompt: "prompt" });
    expect(result).toMatchObject({ provider: "openai", model: "gpt-test", usage: { totalTokens: 7 } });
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
  });

  it("initializes the Vertex provider with an explicit backend model", () => {
    const provider = new VertexAiProvider("gemini-test", "project-test", "us-central1");
    expect(provider.name).toBe("vertex");
    expect(provider.model).toBe("gemini-test");
  });

  it("rejects malformed model envelopes before persistence", async () => {
    const provider: AiProvider = { name: "mock", model: "bad", async generate() { return { text: '{"markdown":""}', provider: "mock", model: "bad", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }; } };
    await expect(runAiTurn({ provider, prompt: "test", history: [], contextJson: "{}" })).rejects.toThrow();
  });
});
