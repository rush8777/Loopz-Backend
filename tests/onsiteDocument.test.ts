import { describe, expect, it } from "vitest";
import { applyOnsiteDocument, createBlock, createOnsiteDocument, emptyCell, listBlocks, rawOnsiteDocument, validateCompiledOnsiteBuilder, validateOnsiteDocument, onsiteImageSourceIsSafe } from "../src/lib/experiences/onsiteDocument.js";
import { definitionSchemaFor } from "../src/lib/experiences/validation.js";
import type { WidgetBuilderState } from "../src/lib/experiences/types.js";

const targeting = { pageRules: [], audience: { type: "all" as const }, trigger: { type: "page_load" as const }, frequency: { mode: "once" as const }, priority: 0 };
const design = { width: "md" as const, theme: { background: "#ffffff", foreground: "#111827", primary: "#2563eb", borderRadius: "md" as const } };

describe("structured on-site document validation", () => {
  it("accepts bounded embedded images with consistent compiled output and rejects unsafe data", () => {
    const src = "data:image/png;base64," + btoa("\x89PNG\r\n\x1a\n" + "a".repeat(3000));
    const document = createOnsiteDocument(); const image = createBlock("image"); if (image.type === "image") image.src = src;
    document.root.children!.push(emptyCell(image));
    const builder: WidgetBuilderState = { version: 1, projectData: {}, html: "", css: "" }; const compiled = applyOnsiteDocument(builder, document, "modal");
    expect(validateCompiledOnsiteBuilder(builder, compiled.content, "modal", false)).toEqual([]);
    expect(definitionSchemaFor("widget", "modal").safeParse({ content: compiled.content, builder, design, behavior: { dismissible: true }, targeting }).success).toBe(true);
    expect(onsiteImageSourceIsSafe("data:image/png;base64," + btoa("<svg onload=alert(1)>"))).toBe(false);
    expect(onsiteImageSourceIsSafe("data:image/svg+xml;base64," + btoa("<svg/>"))).toBe(false);
    expect(onsiteImageSourceIsSafe(src + "a".repeat(65000))).toBe(false);
    expect(onsiteImageSourceIsSafe("https://example.com/" + "a".repeat(2000))).toBe(false);
  });
  it("accepts atomically compiled version-2 content with optional heading/body", () => {
    const document = createOnsiteDocument(); const blocks = listBlocks(document.root); document.root.children = document.root.children?.filter(cell => cell.block?.type === "button");
    const builder: WidgetBuilderState = { version: 1, projectData: {}, html: "", css: "" }; const compiled = applyOnsiteDocument(builder, document, "modal");
    expect(compiled.content.heading).toBe(""); expect(compiled.content.body).toBe("");
    const parsed = definitionSchemaFor("widget", "modal").safeParse({ content: compiled.content, builder, design, behavior: { dismissible: true }, targeting }); expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("rejects stale compiled output, duplicate IDs and widget step actions", () => {
    const document = createOnsiteDocument(); const builder: WidgetBuilderState = { version: 1, projectData: {}, html: "", css: "" }; const compiled = applyOnsiteDocument(builder, document, "modal");
    builder.html += " "; expect(validateCompiledOnsiteBuilder(builder, compiled.content, "modal", false)).toContain("Compiled on-site HTML does not match the structured document.");
    builder.html = compiled.html; (builder.projectData.movcues as Record<string, unknown>).actionBindings = {};
    expect(validateCompiledOnsiteBuilder(builder, compiled.content, "modal", false)).toContain("Compiled on-site action binding map does not match the structured document.");
    builder.html = applyOnsiteDocument(builder, document, "modal").html; const button = listBlocks(document.root).find(block => block.type === "button"); if (button?.type === "button") button.action.type = "next_step"; applyOnsiteDocument(builder, document, "modal");
    expect(validateCompiledOnsiteBuilder(builder, applyOnsiteDocument(builder, document, "modal").content, "modal", false).join(" ")).toContain("only supported by Guides");
    document.root.children![1].id = document.root.children![0].id; expect(validateOnsiteDocument(document).valid).toBe(false); expect(rawOnsiteDocument(builder)).toBeTruthy();
  });
});
