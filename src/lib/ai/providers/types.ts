export interface AiGenerateInput {
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface AiGenerateResult {
  text: string;
  provider: "vertex" | "gemini" | "openai" | "mock";
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface AiProvider {
  readonly name: AiGenerateResult["provider"];
  readonly model: string;
  generate(input: AiGenerateInput): Promise<AiGenerateResult>;
}
