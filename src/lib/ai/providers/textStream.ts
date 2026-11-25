import type { AiGenerateInput, AiGenerateResult } from "./types.js";

type Usage = AiGenerateResult["usage"];
type Chunk = { delta: string; usage?: Usage };
export type TextDelta = (text: string) => void;

export function googleTextChunk(value: unknown): Chunk {
  const frame = value as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
  const usage = frame.usageMetadata;
  return {
    delta: frame.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? "").join("") ?? "",
    ...(usage && { usage: { promptTokens: usage.promptTokenCount ?? 0, completionTokens: usage.candidatesTokenCount ?? 0, totalTokens: usage.totalTokenCount ?? 0 } }),
  };
}

export function googleTextBody(input: AiGenerateInput) {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: input.system }] },
    contents: [{ role: "user", parts: [{ text: input.prompt }] }],
    generationConfig: { responseMimeType: "text/plain", maxOutputTokens: input.maxOutputTokens ?? 640, temperature: 0.2 },
  });
}

export async function readTextStream(
  response: Response, provider: AiGenerateResult["provider"], model: string,
  decode: (data: unknown) => Chunk, onDelta: TextDelta,
): Promise<AiGenerateResult> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("provider_stream_failed");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let buffer = "";
  const readLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const chunk = decode(JSON.parse(data));
    if (chunk.usage) usage = chunk.usage;
    if (chunk.delta) {
      text += chunk.delta;
      if (text.length > 20_000) throw new Error("provider_output_limit");
      onDelta(chunk.delta);
    }
  };
  try {
    while (true) {
      const frame = await reader.read();
      if (frame.done) break;
      buffer += frame.value;
      if (buffer.length > 256_000) throw new Error("provider_frame_limit");
      for (const line of buffer.split("\n").slice(0, -1)) readLine(line);
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    }
    if (buffer) readLine(buffer);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { text, usage, provider, model, httpAttempts: 1 };
}
