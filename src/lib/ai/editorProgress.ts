import type { EditorAiProgress } from "./editor.js";

export const EDITOR_AI_STREAM_MEDIA_TYPE = "application/x-ndjson";

export type EditorAiStreamEvent =
  | ({ type: "progress"; requestId: string; sequence: number; elapsedMs: number } & EditorAiProgress)
  | { type: "heartbeat"; requestId: string; sequence: number; elapsedMs: number }
  | { type: "result"; requestId: string; sequence: number; elapsedMs: number; result: { conversationId: string; revision: number; markdown: string; proposal: unknown | null } }
  | { type: "error"; requestId: string; sequence: number; elapsedMs: number; error: string; message: string; conversationId?: string };

export type EditorAiStreamEventInput = EditorAiStreamEvent extends infer Event
  ? Event extends EditorAiStreamEvent ? Omit<Event, "requestId" | "sequence" | "elapsedMs"> : never
  : never;

export function editorAiStreamFrame(event: EditorAiStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}
