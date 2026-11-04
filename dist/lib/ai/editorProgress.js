export const EDITOR_AI_STREAM_MEDIA_TYPE = "application/x-ndjson";
export function editorAiStreamFrame(event) {
    return `${JSON.stringify(event)}\n`;
}
//# sourceMappingURL=editorProgress.js.map