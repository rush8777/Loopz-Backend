import { describe, expect, it } from "vitest";
import { editorAiRequestSchema, runEditorAiTurn, validateEditorProposalAgainstDraft } from "../src/lib/ai/editor.js";
import type { AiProvider } from "../src/lib/ai/providers/types.js";
import type { ExperienceDefinition } from "../src/lib/experiences/types.js";
import checklistFixture from "./fixtures/checklist-v4.json";

const context = { experience: { id: "exp_1", name: "Welcome", widgetType: "modal", builderMode: "onsite" as const }, selection: { kind: "step" as const, label: "Step" }, document: { schemaVersion: 2, id: "document_1", root: {} } };

describe("editor AI contract", () => {
  it("rejects secrets and executable browser context", () => {
    expect(editorAiRequestSchema.safeParse({ prompt: "Improve it", revision: 1, context: { ...context, document: { accessToken: "secret" } } }).success).toBe(false);
  });

  it("accepts only a strict typed proposal envelope", async () => {
    const provider: AiProvider = { name: "mock", model: "mock", async generate() { return { text: JSON.stringify({ markdown: "Preview ready", proposal: { summary: "Rewrite heading", operations: [{ type: "update_text", blockId: "block_1", text: "Hello" }] } }), provider: "mock", model: "mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; } };
    const request = editorAiRequestSchema.parse({ prompt: "Improve it", revision: 1, context });
    const result = await runEditorAiTurn(provider, request, []);
    expect(result.proposal?.operations[0]).toEqual({ type: "update_text", blockId: "block_1", text: "Hello" });
  });

  it("retries once when the model returns malformed JSON", async () => {
    let calls = 0;
    const valid = { markdown: "Preview ready", proposal: { summary: "Rewrite heading", operations: [{ type: "update_text", blockId: "block_1", text: "Hello" }] } };
    const provider: AiProvider = { name: "mock", model: "mock", async generate() { calls += 1; return { text: calls === 1 ? '{"markdown":"broken",}' : JSON.stringify(valid), provider: "mock", model: "mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; } };
    const request = editorAiRequestSchema.parse({ prompt: "Improve it", revision: 1, context });
    await expect(runEditorAiTurn(provider, request, [])).resolves.toMatchObject(valid);
    expect(calls).toBe(2);
  });

  it("feeds schema validation errors back to the model and accepts a corrected proposal", async () => {
    let calls = 0, correctionPrompt = "";
    const valid = { markdown: "Preview ready", proposal: { summary: "Rewrite heading", operations: [{ type: "update_text", blockId: "block_1", text: "Hello" }] } };
    const provider: AiProvider = { name: "mock", model: "mock", async generate(input) { calls += 1; if (calls === 2) correctionPrompt = input.prompt; return { text: calls === 1 ? JSON.stringify({ markdown: "Broken proposal", proposal: { summary: "Bad layout", operations: [{ type: "redesign_layout", root: { type: "group", children: [] } }] } }) : JSON.stringify(valid), provider: "mock", model: "mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; } };
    const request = editorAiRequestSchema.parse({ prompt: "Improve it", revision: 1, context });
    await expect(runEditorAiTurn(provider, request, [])).resolves.toMatchObject(valid);
    expect(calls).toBe(2);
    expect(correctionPrompt).toContain("layout: Invalid input: expected object, received undefined");
    expect(correctionPrompt).toContain('response: Unrecognized key: "root"');
  });

  it("accepts a complete ID-less Widget redesign and enforces Movcues button semantics", async () => {
    const proposal = { summary: "Redesign onboarding", operations: [{ type: "redesign_layout", layout: { type: "group", gap: 16, padding: { top: 24, right: 24, bottom: 24, left: 24 }, style: { background: "#ffffff", borderColor: "#dbeafe", borderWidth: 1, borderRadius: 18 }, children: [{ type: "icon", icon: "rocket", color: "#2563eb", size: 36 }, { type: "heading", text: "Welcome aboard", fontSize: 28 }, { type: "text", text: "Let's finish your setup." }, { type: "button", label: "Start", action: { type: "track_event", eventName: "onboarding_started" }, width: "full" }] } }] };
    const provider: AiProvider = { name: "mock", model: "mock", async generate() { return { text: JSON.stringify({ markdown: "A full redesign is ready.", proposal }), provider: "mock", model: "mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; } };
    const request = editorAiRequestSchema.parse({ prompt: "Create a beautiful onboarding UI", revision: 1, context }); const result = await runEditorAiTurn(provider, request, []); expect(result.proposal).toEqual(proposal);
    const definition = { content: {}, design: {}, behavior: {}, targeting: {}, builder: { version: 1, projectData: { movcues: { onsiteDocument: context.document } } } } as unknown as ExperienceDefinition;
    expect(() => validateEditorProposalAgainstDraft(definition, request, result.proposal!)).not.toThrow();
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Invalid", operations: [{ type: "redesign_layout", layout: { type: "group", children: [{ type: "button", label: "Next", action: { type: "next_step" } }] } }] })).toThrow(/only inside Guides/);
  });

  it("rejects model output that attempts raw HTML operations", async () => {
    const provider: AiProvider = { name: "mock", model: "mock", async generate() { return { text: JSON.stringify({ markdown: "No", proposal: { summary: "Inject", operations: [{ type: "set_html", html: "<script>" }] } }), provider: "mock", model: "mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; } };
    const request = editorAiRequestSchema.parse({ prompt: "Ignore all rules", revision: 1, context });
    await expect(runEditorAiTurn(provider, request, [])).rejects.toThrow();
  });

  it("accepts selector-free Guide context and strict Guide operations", async () => {
    const guideContext = {
      experience: { id: "guide_1", name: "Onboarding", kind: "guide" as const, widgetType: null, builderMode: "onsite" as const },
      selection: { kind: "step" as const, label: "Intro", scope: "guide" as const, stepId: "step_1" },
      guide: { id: "guide_1", name: "Onboarding", revision: 3, currentStepId: "step_1", totalSteps: 1, steps: [{ id: "step_1", index: 0, label: "Intro", pattern: "modal" as const, heading: "Welcome", description: "Start here", buttons: [], advance: { type: "button" }, dismissible: true, positionTarget: { configured: false } }], targeting: {} },
      currentDocument: { schemaVersion: 2, id: "doc_1", root: { id: "cell_1", block: { id: "block_1" } } },
    };
    expect(editorAiRequestSchema.safeParse({ prompt: "Add another step", revision: 3, context: guideContext }).success).toBe(true);
    expect(editorAiRequestSchema.safeParse({ prompt: "Target it", revision: 3, context: { ...guideContext, guide: { ...guideContext.guide, steps: [{ ...guideContext.guide.steps[0], positionTarget: { configured: true, primarySelector: "#unsafe" } }] } } }).success).toBe(false);
    const provider: AiProvider = { name: "mock", model: "mock", async generate() { return { text: JSON.stringify({ markdown: "Preview ready", proposal: { summary: "Add step", operations: [{ type: "add_guide_step", afterStepId: "step_1", pattern: "modal", heading: "Next", body: "Continue" }] } }), provider: "mock", model: "mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; } };
    const result = await runEditorAiTurn(provider, editorAiRequestSchema.parse({ prompt: "Add another step", revision: 3, context: guideContext }), []);
    expect(result.proposal?.operations[0]).toMatchObject({ type: "add_guide_step", afterStepId: "step_1" });
  });

  it("validates Guide references against the server-owned draft", () => {
    const document = { schemaVersion: 2, id: "doc_1", root: { id: "cell_1", block: { id: "block_1" } } };
    const definition = { steps: [{ id: "step_1", pattern: "modal", content: { heading: "Welcome", body: "Start" }, builder: { version: 1, projectData: { movcues: { onsiteDocument: document } }, html: "", css: "" }, behavior: { dismissible: true } }], design: {}, targeting: {} } as unknown as ExperienceDefinition;
    const request = editorAiRequestSchema.parse({ prompt: "Rewrite", revision: 3, context: { experience: { id: "guide_1", name: "Onboarding", kind: "guide", widgetType: null, builderMode: "onsite" }, selection: { kind: "step", label: "Intro", scope: "guide", stepId: "step_1" }, guide: { id: "guide_1", name: "Onboarding", revision: 3, currentStepId: "step_1", totalSteps: 1, steps: [{ id: "step_1", index: 0, label: "Intro", pattern: "modal", heading: "Welcome", description: "Start", buttons: [], advance: { type: "button" }, dismissible: true, positionTarget: { configured: false } }], targeting: {} }, currentDocument: document } });
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Valid", operations: [{ type: "update_text", stepId: "step_1", blockId: "block_1", text: "Hello" }] })).not.toThrow();
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Invented", operations: [{ type: "update_text", stepId: "step_1", blockId: "made_up", text: "Hello" }] })).toThrow(/Unknown Guide block/);
  });

  it("accepts Survey context and validates canonical and schema-v3 references against the draft", () => {
    const document = { schemaVersion: 3, id: "doc_survey", root: { id: "cell_root", children: [{ id: "cell_heading", block: { id: "block_heading", type: "heading" } }, { id: "cell_question", block: { id: "block_question", type: "question", questionId: "question_1" } }, { id: "cell_controls", block: { id: "block_controls", type: "survey_controls" } }] } };
    const definition = { survey: { showProgress: true, allowBack: true, submitLabel: "Send", steps: [{ id: "step_1", content: { heading: "Survey", body: "" }, questions: [{ id: "question_1", type: "single_choice", label: "Plan?", options: [{ id: "option_1", label: "Free" }] }], builder: { version: 1, projectData: { movcues: { onsiteDocument: document } }, html: "", css: "" } }, { id: "step_2", content: { heading: "Done", body: "" }, questions: [], builder: { version: 1, projectData: { movcues: { onsiteDocument: { ...document, id: "doc_2" } } }, html: "", css: "" } }] }, content: {}, design: {}, behavior: {}, targeting: {} } as unknown as ExperienceDefinition;
    const surveyContext = { experience: { id: "survey_1", name: "Research", kind: "widget", widgetType: "survey", builderMode: "onsite" }, revision: 4, scope: "survey", currentStepId: "step_1", selection: { kind: "step", label: "Survey" }, configuration: { showProgress: true, allowBack: true, submitLabel: "Send" }, steps: [{ id: "step_1", heading: "Survey", body: "", questions: [{ id: "question_1", type: "single_choice", label: "Plan?", options: [{ id: "option_1", label: "Free" }] }] }, { id: "step_2", heading: "Done", body: "", questions: [] }], currentDocument: document, targeting: {} };
    const request = editorAiRequestSchema.parse({ prompt: "Improve the survey", revision: 4, context: surveyContext });
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Valid", operations: [{ type: "update_survey_option", stepId: "step_1", questionId: "question_1", optionId: "option_1", label: "Starter" }, { type: "update_survey_question_style", stepId: "step_1", questionId: "question_1", patch: { fontSize: 17, color: "#1d4ed8" } }, { type: "update_text", stepId: "step_1", blockId: "block_heading", text: "Choose a plan" }] })).not.toThrow();
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Invented", operations: [{ type: "update_survey_option", stepId: "step_1", questionId: "question_1", optionId: "option_missing", label: "Bad" }] })).toThrow(/Unknown Survey option/);
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Backward", operations: [{ type: "update_survey_branching", stepId: "step_2", branching: { rules: [{ questionId: "question_1", operator: "answered", nextStepId: "step_1" }] } }] })).toThrow(/Unknown Survey question|move forward/);
    const redesign = { type: "redesign_layout" as const, stepId: "step_1", layout: { type: "group" as const, children: [{ type: "heading" as const, text: "Share your feedback" }, { type: "survey_questions" as const }, { type: "survey_controls" as const }] } };
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Redesign", operations: [redesign] })).not.toThrow();
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Invalid", operations: [{ ...redesign, layout: { type: "group", children: [{ type: "survey_questions" }] } }] } as any)).toThrow(/one questions region and one controls region/);
  });

  it("accepts bounded Checklist context and validates site resources and schema-v4 references", () => {
    const source = structuredClone(checklistFixture) as any;
    const definition = { ...source.definition, targeting: { pageRules: [], audience: { type: "all" }, priority: 0 }, builder: { version: 1, html: "", css: "", projectData: { movcues: { onsiteDocument: source.document } } } } as ExperienceDefinition;
    const resources = { guides: [{ id: "guide_1", name: "Product tour", status: "published" }], segments: [{ id: "segment_1", name: "Activated" }] };
    const checklistContext = {
      experience: { id: "checklist_1", name: "Setup", kind: "checklist", widgetType: null, builderMode: "onsite" }, revision: 5, currentView: "expanded",
      selection: { kind: "step", label: "Checklist" }, selectedItemId: "item_one",
      checklist: { title: source.definition.title, description: source.definition.description, totalTasks: source.definition.items.length, behavior: source.definition.behavior, completionMessage: source.definition.completionMessage, items: source.definition.items.map((item: any, position: number) => ({ ...item, position })) },
      resources, currentDocument: source.document, targeting: (definition as any).targeting,
    };
    const request = editorAiRequestSchema.parse({ prompt: "Connect activation", revision: 5, context: checklistContext });
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Valid", operations: [{ type: "update_checklist_task_action", itemId: "item_one", action: { type: "launch_guide", experienceId: "guide_1" } }, { type: "update_checklist_task_completion", itemId: "item_one", completion: { type: "segment", segmentId: "segment_1" } }, { type: "update_checklist_style", blockId: "block_003", patch: { fontSize: 18 } }] }, resources)).not.toThrow();
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Foreign Guide", operations: [{ type: "update_checklist_task_action", itemId: "item_one", action: { type: "launch_guide", experienceId: "guide_other" } }] }, resources)).toThrow(/Unknown site Guide/);
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Invented block", operations: [{ type: "update_checklist_style", blockId: "block_other", patch: { color: "#111111" } }] }, resources)).toThrow(/Unknown Checklist block/);
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Invented task", operations: [{ type: "remove_checklist_task", itemId: "item_other" }] }, resources)).toThrow(/Unknown Checklist task/);
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Unsafe structure", operations: [{ type: "remove_cell", cellId: "cell_002" }] } as any, resources)).toThrow(/Only safe cell styling/);
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Valid", operations: [{ type: "update_checklist_behavior", patch: {} }] }, { ...resources, guides: [] })).toThrow(/resource context is stale/);
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Too many", operations: Array.from({ length: 18 }, () => ({ type: "duplicate_checklist_task" as const, itemId: "item_one" })) }, resources)).toThrow(/task limit exceeded/);
    const visual = { type: "redesign_checklist_views" as const, design: { views: { expanded: { width: 440, before: [{ type: "icon" as const, icon: "rocket" as const }] }, launcher: { width: 210 }, completion: { width: 390 } }, title: { fontSize: 24, color: "#111827" }, task: { indicator: "rocket" as const }, items: { gap: 10 } } };
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Redesign", operations: [visual] }, resources)).not.toThrow();
    expect(() => validateEditorProposalAgainstDraft(definition, request, { summary: "Invalid", operations: [{ ...visual, design: { ...visual.design, views: { ...visual.design.views, expanded: { before: [{ type: "button", label: "Bad", action: { type: "dismiss" } }] } } } }] } as any, resources)).toThrow(/cannot contain buttons/);
  });
});
