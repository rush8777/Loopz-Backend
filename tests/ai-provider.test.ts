import { describe, expect, it, vi } from "vitest";
import { GeminiApiProvider } from "../src/lib/ai/providers/gemini.js";
import { OpenAiProvider, OpenAiProviderError } from "../src/lib/ai/providers/openai.js";
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

  it("retries a temporary OpenAI rate limit and respects Retry-After", async () => {
    const sleeper = vi.fn(async () => undefined);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }), { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"markdown":"ok","proposal":null}' } }] }), { status: 200 }));
    const provider = new OpenAiProvider("gpt-test", "secret-test-key", fetcher as typeof fetch, sleeper);

    await expect(provider.generate({ system: "system", prompt: "prompt" })).resolves.toMatchObject({ provider: "openai" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleeper).toHaveBeenCalledTimes(1);
    expect(sleeper.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(1000);
  });

  it("does not retry OpenAI credit or quota failures", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "credit_balance_exhausted" } }), { status: 429 }));
    const provider = new OpenAiProvider("gpt-test", "secret-test-key", fetcher as typeof fetch);

    const failure = await provider.generate({ system: "system", prompt: "prompt" }).catch(error => error);
    expect(failure).toBeInstanceOf(OpenAiProviderError);
    expect(failure).toMatchObject({ code: "credit_balance_exhausted", retryable: false });
    expect(failure.message).toContain("credits are exhausted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves the exact OpenAI error message when a retry must be deferred", async () => {
    const exact = "Rate limit reached for gpt-test on tokens per day. Please try again tomorrow.";
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: exact } }), { status: 429, headers: { "retry-after": "3600" } }));
    const provider = new OpenAiProvider("gpt-test", "secret-test-key", fetcher as typeof fetch);

    await expect(provider.generate({ system: "system", prompt: "prompt" })).rejects.toMatchObject({
      code: "rate_limit_exceeded",
      message: exact,
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("initializes the Vertex provider with an explicit backend model", () => {
    const provider = new VertexAiProvider("gemini-test", "project-test", "us-central1");
    expect(provider.name).toBe("vertex");
    expect(provider.model).toBe("gemini-test");
  });

  it("maps Gemini API output and keeps the API key out of the result", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/models/gemini-test:generateContent");
      expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("gemini-secret-key");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        systemInstruction: { parts: [{ text: "system" }] },
        generationConfig: { responseMimeType: "application/json" },
      });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"markdown":"ok","proposal":null}' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
      }), { status: 200 });
    });
    const provider = new GeminiApiProvider("gemini-test", "gemini-secret-key", fetcher as typeof fetch);
    const result = await provider.generate({ system: "system", prompt: "prompt" });
    expect(result).toMatchObject({ provider: "gemini", model: "gemini-test", usage: { totalTokens: 9 } });
    expect(JSON.stringify(result)).not.toContain("gemini-secret-key");
  });

  it("retries transient Gemini availability failures", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 503 } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"markdown":"ok","proposal":null}' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
      }), { status: 200 }));
    const provider = new GeminiApiProvider("gemini-test", "gemini-secret-key", fetcher as typeof fetch);

    await expect(provider.generate({ system: "system", prompt: "prompt" })).resolves.toMatchObject({ provider: "gemini", usage: { totalTokens: 9 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed model envelopes before persistence", async () => {
    const provider: AiProvider = { name: "mock", model: "bad", async generate() { return { text: '{"markdown":""}', provider: "mock", model: "bad", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }; } };
    await expect(runAiTurn({ provider, prompt: "test", history: [], contextJson: "{}" })).rejects.toThrow();
  });
});
