import { describe, expect, it } from "vitest";
import { guideDefinitionSchema, widgetDefinitionSchema } from "../src/lib/experiences/validation.js";

const target = { primarySelector: "#checkout-modal", fallbackSelectors: ["[data-testid=checkout]"], label: "Checkout modal", reliability: "reliable" as const };
const targeting = { pageRules: [], audience: { type: "all" as const }, trigger: { type: "page_load" as const }, frequency: { mode: "once" as const }, priority: 0 };
const design = { width: "md" as const, theme: { background: "#fff", foreground: "#111", primary: "#2563eb", borderRadius: "md" as const } };

describe("experience layer validation", () => {
  it.each([
    { mode: "auto" },
    { mode: "relative", relation: "below", target },
    { mode: "always_on_top" },
    { mode: "custom", zIndex: 1200 },
  ])("accepts the $mode widget policy", layer => {
    expect(widgetDefinitionSchema.safeParse({ content: { heading: "Hello", body: "World" }, design, behavior: { dismissible: true, layer }, targeting }).success).toBe(true);
  });

  it("accepts legacy guide-level policies and validated per-step overrides", () => {
    const definition = { design, targeting, behavior: { layer: { mode: "relative", relation: "above", target } }, steps: [{ id: "one", content: { heading: "One", body: "Body" }, behavior: { dismissible: true } }] };
    expect(guideDefinitionSchema.safeParse(definition).success).toBe(true);
    const parsed = guideDefinitionSchema.parse({ ...definition, steps: [{ ...definition.steps[0], behavior: { dismissible: true, layer: { mode: "auto" } } }] });
    expect(parsed.steps[0].behavior.layer).toEqual({ mode: "auto" });
    expect(guideDefinitionSchema.safeParse({ ...definition, steps: [{ ...definition.steps[0], behavior: { dismissible: true, layer: { mode: "custom", zIndex: 0 } } }] }).success).toBe(false);
  });

  it("accepts validated per-step Survey overrides", () => {
    const definition = { content: { heading: "Survey", body: "Body" }, design, behavior: { dismissible: true, layer: { mode: "auto" } }, targeting, survey: { showProgress: true, allowBack: true, submitLabel: "Submit", steps: [{ id: "one", content: { heading: "One", body: "Body" }, questions: [], behavior: { layer: { mode: "custom", zIndex: 1500 } } }] } };
    const parsed = widgetDefinitionSchema.parse(definition);
    expect(parsed.survey?.steps[0].behavior?.layer).toEqual({ mode: "custom", zIndex: 1500 });
    expect(widgetDefinitionSchema.safeParse({ ...definition, survey: { ...definition.survey, steps: [{ ...definition.survey.steps[0], behavior: { layer: { mode: "custom", zIndex: 0 } } }] } }).success).toBe(false);
  });

  it("rejects invalid custom values and incomplete relative policies", () => {
    const base = { content: { heading: "Hello", body: "World" }, design, targeting };
    expect(widgetDefinitionSchema.safeParse({ ...base, behavior: { dismissible: true, layer: { mode: "custom", zIndex: 0 } } }).success).toBe(false);
    expect(widgetDefinitionSchema.safeParse({ ...base, behavior: { dismissible: true, layer: { mode: "relative", relation: "above" } } }).success).toBe(false);
  });
});
