import checklistFixture from "./fixtures/checklist-v4.json";
import { applyOnsiteDocument, createOnsiteSurveyDocument } from "../src/lib/experiences/onsiteDocument.js";
import type { SurveyQuestion } from "../src/lib/experiences/types.js";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/source-editability.json";
import { SOURCE_EDITABILITY } from "../src/lib/experiences/sourceEditability.js";
import { validateSourceMarkup } from "../src/lib/experiences/sourceMarkup.js";
import { editorAiRequestSchema, runEditorAiTurn, validateEditorProposalAgainstDraft } from "../src/lib/ai/editor.js";
import type { AiProvider } from "../src/lib/ai/providers/types.js";
import type { ExperienceDefinition } from "../src/lib/experiences/types.js";

const source = { ...fixture, actionBindings: { start_now: { type: "dismiss" as const } } };
const options = { widgetType: "modal" as const, guide: false, editable: true };

describe("source visual editability contract", () => {
  it("accepts the shared SDK fixture with full styling and responsive rules", () => {
    expect(validateSourceMarkup(source, options)).toEqual([]); expect(SOURCE_EDITABILITY.version).toBe(1);
  });
  it.each([
    fixture.html.replace('data-movcues-node-id="hero_node"', ""),
    fixture.html.replace('data-movcues-block-id="body_block"', 'data-movcues-block-id="title_block"'),
    fixture.html.replace('data-movcues-block-id="title_block"', ""),
    fixture.html.replace('<strong>something</strong>', '<section data-movcues-node-id="nested_layout">Bad</section>'),
  ])("rejects unsafe or ambiguous editable metadata", html => {
    expect(validateSourceMarkup({ ...source, html }, options).length).toBeGreaterThan(0);
  });
  it("preserves surviving IDs and refuses CSS outside the declared editing capabilities", () => {
    const value = { version: 1 as const, html: "", css: "", projectData: {} }, f = structuredClone(checklistFixture);
    applyOnsiteDocument(value, f.document as Parameters<typeof applyOnsiteDocument>[1], "checklist", undefined, f.definition as Parameters<typeof applyOnsiteDocument>[4]);
    const extra = '<button data-movcues-checklist-role="item" data-movcues-checklist-item-id="foreign_task">Unexpected</button>';
    expect(validateSourceMarkup({ html: value.html.replace("</section>", `${extra}</section>`), css: value.css, actionBindings: {} }, { widgetType: "checklist", guide: false, checklist: f.definition }).join(" ")).toContain("Checklist source task identities must match the canonical items exactly.");
    expect(validateSourceMarkup({ ...source, html: fixture.html.replace("title_block", "replaced_title") }, { ...options, previousHtml: fixture.html }).join(" ")).toContain("must preserve");
    for (const css of [".movcues-widget .hero{position:fixed}", ".movcues-widget .hero{flex-direction:row-reverse}", ".movcues-widget::before{content:'Hi'}", ".movcues-widget #title{color:red}"]) expect(validateSourceMarkup({ ...source, css }, options).length).toBeGreaterThan(0);
  });
  const questions: SurveyQuestion[] = [
    { id: "question_one", type: "single_choice", label: "Choose", options: [{ id: "option_one", label: "First" }] },
    { id: "question_one", type: "multiple_choice", label: "Choose", options: [{ id: "option_one", label: "First" }] },
    { id: "question_one", type: "short_text", label: "Feedback" }, { id: "question_one", type: "long_text", label: "Feedback" },
    { id: "question_one", type: "rating", label: "Rate", min: 1, max: 5 }, { id: "question_one", type: "nps", label: "Recommend" },
  ];
  it.each(questions)("validates canonical $type inputs without treating answer options as ordinary actions", question => {
    const builder = { version: 1 as const, html: "", css: "", projectData: {} };
    const document = createOnsiteSurveyDocument([question]); applyOnsiteDocument(builder, document, "survey", { questions: [question], submitLabel: "Send" });
    const proposal = { html: builder.html.replace("<section ", '<section data-movcues-node-id="source_root" '), css: builder.css, actionBindings: {} };
    const config = { widgetType: "survey" as const, guide: false, editable: true, survey: { questions: [question] } };
    expect(validateSourceMarkup(proposal, config)).toEqual([]);
    const html = proposal.html.replace('data-movcues-question-input', 'title').replace(/data-movcues-option-id="[^"]+"/, 'data-movcues-option-id="invented_option"');
    expect(validateSourceMarkup({ ...proposal, html }, config).length).toBeGreaterThan(0);
  });
  it("repairs missing metadata using the existing server feedback retry", async () => {
    const prompts: string[] = [], systems: string[] = [];
    const provider: AiProvider = { name: "mock", model: "mock", async generate(input) {
      prompts.push(input.prompt); systems.push(input.system);
      const html = prompts.length === 1 ? fixture.html.replace('data-movcues-block-id="title_block"', "") : fixture.html;
      return { text: JSON.stringify({ markdown: "Ready", proposal: { summary: "Redesign", operations: [{ type: "replace_markup", ...source, html }] } }), provider: "mock", model: "mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    } };
    const builder = { version: 1 as const, projectData: { movcues: { authoringSurface: "source", actionBindings: source.actionBindings } }, html: fixture.html, css: fixture.css };
    const definition = { builder, content: { heading: "Welcome aboard", body: "Build something memorable." }, design: {}, behavior: {}, targeting: {} } as ExperienceDefinition;
    const request = editorAiRequestSchema.parse({ prompt: "Redesign it", revision: 1, context: { experience: { id: "exp_1", name: "Welcome", widgetType: "modal", builderMode: "onsite" }, selection: { kind: "step", label: "Step" }, document: {}, source: { ...source, authoringSurface: "source", supportedActions: ["dismiss", "open_url", "track_event"] } } });
    const result = await runEditorAiTurn(provider, request, [], undefined, proposal => validateEditorProposalAgainstDraft(definition, request, proposal));
    expect(prompts).toHaveLength(2); expect(prompts[1]).toContain("data-movcues-block-id"); expect(prompts[1]).toContain("SERVER_VALIDATION_FEEDBACK");
    expect(systems[0]).toContain(JSON.stringify(SOURCE_EDITABILITY)); expect(result.proposal?.operations[0]).toMatchObject({ html: fixture.html });
  });
});
