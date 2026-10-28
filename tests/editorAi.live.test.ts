import { describe, expect, it } from "vitest";
import { env } from "../src/config.js";
import { editorAiRequestSchema, runEditorAiTurn } from "../src/lib/ai/editor.js";
import { createConfiguredAiProvider } from "../src/lib/ai/providers/index.js";

// This suite makes paid network calls only when explicitly enabled:
//   $env:RUN_LIVE_AI_TESTS = "true"; npm.cmd test -- --run tests/editorAi.live.test.ts
const runLive = process.env.RUN_LIVE_AI_TESTS === "true";
const live = runLive ? describe : describe.skip;

const widgetContext = {
  experience: { id: "exp_live_widget", name: "Welcome", kind: "widget" as const, widgetType: "modal", builderMode: "onsite" as const },
  selection: { kind: "step" as const, label: "Welcome" },
  document: { schemaVersion: 2, id: "doc_live_widget", root: { id: "cell_root", children: [{ id: "cell_heading", block: { id: "block_heading", type: "heading" } }] } },
};

const guideContext = {
  experience: { id: "exp_live_guide", name: "Product tour", kind: "guide" as const, widgetType: null, builderMode: "onsite" as const },
  selection: { kind: "step" as const, label: "Welcome", scope: "guide" as const, stepId: "step_welcome" },
  guide: { id: "exp_live_guide", name: "Product tour", revision: 1, currentStepId: "step_welcome", totalSteps: 1, targeting: {}, steps: [{ id: "step_welcome", index: 0, label: "Welcome", pattern: "modal" as const, heading: "Welcome", description: "Start your tour", buttons: [], advance: { type: "button" }, dismissible: true, positionTarget: { configured: false } }] },
  currentDocument: { schemaVersion: 2, id: "doc_live_guide", root: { id: "cell_root", children: [{ id: "cell_heading", block: { id: "block_heading", type: "heading" } }] } },
};

const surveyContext = {
  experience: { id: "exp_live_survey", name: "Feedback", kind: "widget" as const, widgetType: "survey", builderMode: "onsite" as const },
  revision: 1, scope: "survey" as const, currentStepId: "step_survey", selection: { kind: "step" as const, label: "Feedback" },
  configuration: { showProgress: true, allowBack: true, submitLabel: "Send" },
  steps: [{ id: "step_survey", heading: "Feedback", body: "Tell us what you think", questions: [{ id: "question_rating", type: "rating" as const, label: "How was your experience?", min: 1, max: 5 }] }],
  currentDocument: { schemaVersion: 3, id: "doc_live_survey", root: { id: "cell_root", children: [{ id: "cell_heading", block: { id: "block_heading", type: "heading" } }, { id: "cell_questions", block: { id: "block_questions", type: "survey_questions" } }, { id: "cell_controls", block: { id: "block_controls", type: "survey_controls" } }] } },
  targeting: {},
};

const checklistContext = {
  experience: { id: "exp_live_checklist", name: "Setup", kind: "checklist" as const, widgetType: null, builderMode: "onsite" as const },
  revision: 1, currentView: "expanded" as const, selection: { kind: "step" as const, label: "Setup" }, selectedItemId: "task_profile",
  checklist: { title: "Get started", description: "Finish your setup", totalTasks: 1, behavior: {}, completionMessage: {}, items: [{ id: "task_profile", position: 0, title: "Complete your profile", description: "Add your name and photo", action: { type: "none" as const }, completion: { type: "item_clicked" as const } }] },
  resources: { guides: [], segments: [] },
  currentDocument: { schemaVersion: 4, id: "doc_live_checklist", root: { id: "cell_root", children: [{ id: "cell_title", block: { id: "block_title", type: "heading" } }] } },
  targeting: {},
};

const cases = [
  ["widget", "Polish the welcome heading and visual hierarchy with one small safe change.", widgetContext],
  ["guide", "Add one concise modal follow-up step after the current welcome step.", guideContext],
  ["survey", "Improve the current rating question label and make it more inviting.", surveyContext],
  ["checklist", "Improve the title of the selected setup task without adding tasks.", checklistContext],
] as const;

live.sequential("live configured-provider editor response contract", () => {
  it.each(cases)("returns a valid %s proposal", async (_kind, prompt, context) => {
    const provider = createConfiguredAiProvider();
    if (!provider) throw new Error("AI_ENABLED=true is required when RUN_LIVE_AI_TESTS=true");
    const input = editorAiRequestSchema.parse({ prompt, revision: 1, context });
    const result = await runEditorAiTurn(provider, input, []);

    expect(result.generation.provider).toBe(env.AI_PROVIDER);
    expect(result.generation.model).toBe(provider.model);
    expect(result.markdown).toEqual(expect.any(String));
    expect(result.proposal).not.toBeNull();
    expect(result.proposal?.operations.length).toBeGreaterThan(0);
  }, 120_000);
});
