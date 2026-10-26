import type { AiGenerateInput, AiGenerateResult, AiProvider } from "./types.js";

/** Google AI Studio / Gemini Developer API provider authenticated with an API key. */
export class GeminiApiProvider implements AiProvider {
  readonly name = "gemini" as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async generate(input: AiGenerateInput): Promise<AiGenerateResult> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const response = await this.fetcher(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: input.maxOutputTokens ?? 1800,
          temperature: 0.2,
        },
      }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`gemini_http_${response.status}`);

    const body = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const text = body.candidates?.[0]?.content?.parts?.map(part => part.text ?? "").join("");
    if (!text) throw new Error("gemini_empty_response");

    return {
      text,
      provider: this.name,
      model: this.model,
      usage: {
        promptTokens: body.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: body.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  }
}
