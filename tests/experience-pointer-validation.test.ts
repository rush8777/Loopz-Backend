import { describe, expect, it } from "vitest";
import { definitionSchemaFor } from "../src/lib/experiences/validation.js";

const widgetDefinition = {
  content: { heading: "Guide", body: "Anchored content" },
  design: { width: "md", theme: { background: "#ffffff", foreground: "#111827", primary: "#2563eb", borderRadius: "md" } },
  behavior: { dismissible: true, placement: "bottom", alignment: "center", offset: 8 },
  targeting: { pageRules: [], audience: { type: "all" }, trigger: { type: "page_load" }, frequency: { mode: "once" }, priority: 0 },
};

describe("anchored pointer validation", () => {
  it("keeps legacy definitions without pointer settings valid", () => {
    expect(definitionSchemaFor("widget", "anchored_card").safeParse(widgetDefinition).success).toBe(true);
  });

  it("accepts strict pointer settings within the supported size range", () => {
    const definition = structuredClone(widgetDefinition);
    Object.assign(definition.behavior, { pointer: { enabled: false, size: 24 } });

    expect(definitionSchemaFor("widget", "anchored_card").safeParse(definition).success).toBe(true);
  });

  it.each([3, 31, 10.5])("rejects invalid pointer size %s", size => {
    const definition = structuredClone(widgetDefinition);
    Object.assign(definition.behavior, { pointer: { enabled: true, size } });

    expect(definitionSchemaFor("widget", "anchored_card").safeParse(definition).success).toBe(false);
  });

  it("rejects unknown nested pointer properties", () => {
    const definition = structuredClone(widgetDefinition);
    Object.assign(definition.behavior, { pointer: { enabled: true, size: 10, color: "#ffffff" } });

    expect(definitionSchemaFor("widget", "anchored_card").safeParse(definition).success).toBe(false);
  });

  it("accepts pointer settings on anchored Guide steps", () => {
    const guideDefinition = {
      steps: [{ id: "step_1", pattern: "anchored_card", content: widgetDefinition.content, behavior: { ...widgetDefinition.behavior, pointer: { enabled: true, size: 10 } } }],
      design: widgetDefinition.design,
      targeting: widgetDefinition.targeting,
    };

    expect(definitionSchemaFor("guide").safeParse(guideDefinition).success).toBe(true);
  });
});
