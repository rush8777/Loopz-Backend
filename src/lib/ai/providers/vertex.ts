import { GoogleAuth } from "google-auth-library";
import type { AiGenerateInput, AiGenerateResult, AiProvider } from "./types.js";

export class VertexAiProvider implements AiProvider {
  readonly name = "vertex" as const;
  private readonly auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

  constructor(
    readonly model: string,
    private readonly project: string,
    private readonly location: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async generate(input: AiGenerateInput): Promise<AiGenerateResult> {
    const client = await this.auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) throw new Error("vertex_missing_access_token");
    const endpoint = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.project)}/locations/${encodeURIComponent(this.location)}/publishers/google/models/${encodeURIComponent(this.model)}:generateContent`;
    const response = await this.fetcher(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: input.maxOutputTokens ?? 1800, temperature: 0.2 },
      }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`vertex_http_${response.status}`);
    const body = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const text = body.candidates?.[0]?.content?.parts?.map(part => part.text ?? "").join("");
    if (!text) throw new Error("vertex_empty_response");
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
