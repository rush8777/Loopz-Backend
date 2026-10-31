import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";
import type { AiProvider } from "../src/lib/ai/providers/types.js";
import { aiConversations, aiMessages, aiToolExecutions } from "../src/db/schema.js";

const provider: AiProvider = {
  name: "mock", model: "editor-test",
  async generate(input) {
    if (input.prompt.includes("force failure")) throw new Error("editor_ai_invalid_response");
    if (input.prompt.includes('"kind":"checklist"') && input.prompt.includes('"authoringSurface":"source"')) {
      const serialized = input.prompt.split("\n\nEDITOR_CONTEXT:\n")[1]?.split("\n\nCURRENT_DRAFT_REVISION:")[0];
      const context = JSON.parse(serialized ?? "null") as { source?: { html: string; css: string; actionBindings: Record<string, unknown> } } | null;
      if (!context?.source) throw new Error("source_context_missing");
      return { text: JSON.stringify({ markdown: "A safe source redesign is ready.", proposal: { summary: "Preserve and revalidate the source design", operations: [{ type: "replace_markup", html: context.source.html.replace("<section ", '<section data-movcues-node-id="source_root" '), css: context.source.css, actionBindings: context.source.actionBindings }] } }), provider: "mock", model: "editor-test", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    }
    if (input.prompt.includes('"kind":"checklist"')) {
      const itemId = input.prompt.match(/"selectedItemId":"([^"]+)"/)?.[1] ?? "item_missing";
      return { text: JSON.stringify({ markdown: "A safe Checklist preview is ready.", proposal: { summary: "Connect the first task", operations: [{ type: "update_checklist_task", itemId, patch: { title: "Take the product tour" } }] } }), provider: "mock", model: "editor-test", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    }
    if (input.prompt.includes('"widgetType":"survey"')) {
      const stepId = input.prompt.match(/"currentStepId":"([^"]+)"/)?.[1] ?? "step_missing";
      return { text: JSON.stringify({ markdown: "A safe Survey preview is ready.", proposal: { summary: "Clarify the first Survey step", operations: [{ type: "update_survey_step", stepId, patch: { heading: "Tell us what you think" } }] } }), provider: "mock", model: "editor-test", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    }
    if (input.prompt.includes('"kind":"guide"')) {
      const stepId = input.prompt.match(/"currentStepId":"([^"]+)"/)?.[1] ?? "step_missing";
      return { text: JSON.stringify({ markdown: "A safe Guide preview is ready.", proposal: { summary: "Rename the first step", operations: [{ type: "update_guide_step", stepId, patch: { label: "Clear introduction" } }] } }), provider: "mock", model: "editor-test", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    }
    const match = input.prompt.match(/"blockId":"([^"]+)"/);
    return { text: JSON.stringify({ markdown: "A safe preview is ready.", proposal: { summary: "Rewrite the heading", operations: [{ type: "update_text", blockId: match?.[1] ?? "block_missing", text: "A clearer welcome" }] } }), provider: "mock", model: "editor-test", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  },
};

describe("editor-session AI route", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp({ aiProvider: provider }); });
  afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });

  it("authenticates the editor origin, pins the draft revision and persists the conversation", async () => {
    const owner = await signup(ctx.app); const headers = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers, payload: { name: "AI editor", domain: "ai-editor.example.test" } })).json();
    const base = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = (await ctx.app.inject({ method: "POST", url: base, headers, payload: { kind: "widget", widgetType: "modal", builderMode: "onsite", name: "Welcome", buildUrl: "https://ai-editor.example.test", template: "blank", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `${base}/${created.id}/editor-sessions`, headers })).json();
    const exchange = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://ai-editor.example.test" }, payload: { token: new URL(session.launchUrl).searchParams.get("movcues_editor_token") } });
    const editorHeaders = { origin: "https://ai-editor.example.test", authorization: `Bearer ${exchange.json().accessToken}` };
    const draft = (await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders })).json();
    const document = draft.version.definition.builder.projectData.movcues.onsiteDocument; const firstCell = document.root.children[0];
    const payload = { prompt: "Make the selected heading clearer", revision: draft.version.revision, context: { experience: { id: created.id, name: "Welcome", widgetType: "modal", builderMode: "onsite" }, selection: { kind: "block", label: "Heading", cellId: firstCell.id, blockId: firstCell.block.id, blockType: "heading" }, document } };
    const denied = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: { ...editorHeaders, origin: "https://evil.test" }, payload });
    expect(denied.statusCode).toBe(401);
    const response = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: editorHeaders, payload });
    expect(response.statusCode, response.body).toBe(200); expect(response.json()).toMatchObject({ revision: draft.version.revision, proposal: { operations: [{ type: "update_text", blockId: firstCell.block.id }] } });
    expect(await ctx.db.select().from(aiConversations)).toHaveLength(1); expect(await ctx.db.select().from(aiMessages)).toHaveLength(2);
    const failed = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: editorHeaders, payload: { ...payload, conversationId: response.json().conversationId, prompt: "force failure" } });
    expect(failed.statusCode, failed.body).toBe(502); expect(failed.json()).toMatchObject({ error: "ai_generation_failed", message: "AI request failed: editor_ai_invalid_response. Your message was preserved; please retry." });
    expect(await ctx.db.select().from(aiToolExecutions)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "completed" }), expect.objectContaining({ status: "failed", errorCode: "editor_ai_invalid_response" })]));
    const stale = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: editorHeaders, payload: { ...payload, revision: 999 } });
    expect(stale.statusCode).toBe(409); expect(stale.json().error).toBe("draft_conflict");
  });

  it("accepts a sanitized Guide context and validates proposal step IDs against the draft", async () => {
    const owner = await signup(ctx.app); const headers = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers, payload: { name: "Guide AI", domain: "guide-ai.example.test" } })).json();
    const base = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = (await ctx.app.inject({ method: "POST", url: base, headers, payload: { kind: "guide", guidePattern: "modal", builderMode: "onsite", name: "Onboarding", buildUrl: "https://guide-ai.example.test", template: "blank", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `${base}/${created.id}/editor-sessions`, headers })).json();
    const exchange = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://guide-ai.example.test" }, payload: { token: new URL(session.launchUrl).searchParams.get("movcues_editor_token") } });
    const editorHeaders = { origin: "https://guide-ai.example.test", authorization: `Bearer ${exchange.json().accessToken}` };
    const draft = (await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders })).json();
    const step = draft.version.definition.steps[0]; const currentDocument = step.builder.projectData.movcues.onsiteDocument;
    const context = { experience: { id: created.id, name: "Onboarding", kind: "guide", widgetType: null, builderMode: "onsite" }, selection: { kind: "step", label: step.label ?? "Step", scope: "guide", stepId: step.id }, guide: { id: created.id, name: "Onboarding", revision: draft.version.revision, currentStepId: step.id, totalSteps: 1, steps: [{ id: step.id, index: 0, label: step.label, pattern: step.pattern ?? "anchored_card", heading: step.content.heading, description: step.content.body, buttons: [], advance: step.advance ?? { type: "button" }, presentation: step.presentation, dismissible: step.behavior.dismissible ?? true, positionTarget: { configured: false } }], targeting: draft.version.definition.targeting }, currentDocument };
    const response = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: editorHeaders, payload: { prompt: "Make the introduction clearer", revision: draft.version.revision, context } });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().proposal.operations[0]).toMatchObject({ type: "update_guide_step", stepId: step.id });
    const unsafe = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: editorHeaders, payload: { prompt: "Pick target", revision: draft.version.revision, context: { ...context, guide: { ...context.guide, steps: [{ ...context.guide.steps[0], positionTarget: { configured: true, primarySelector: "#billing" } }] } } } });
    expect(unsafe.statusCode).toBe(400);
  });

  it("accepts a sanitized Survey context and returns a server-validated Survey proposal", async () => {
    const owner = await signup(ctx.app); const headers = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers, payload: { name: "Survey AI", domain: "survey-ai.example.test" } })).json();
    const base = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = (await ctx.app.inject({ method: "POST", url: base, headers, payload: { kind: "widget", widgetType: "survey", builderMode: "onsite", name: "Research", buildUrl: "https://survey-ai.example.test", template: "blank", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `${base}/${created.id}/editor-sessions`, headers })).json();
    const exchange = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://survey-ai.example.test" }, payload: { token: new URL(session.launchUrl).searchParams.get("movcues_editor_token") } });
    const editorHeaders = { origin: "https://survey-ai.example.test", authorization: `Bearer ${exchange.json().accessToken}` };
    const draft = (await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders })).json(), survey = draft.version.definition.survey, step = survey.steps[0];
    const context = { experience: { id: created.id, name: "Research", kind: "widget", widgetType: "survey", builderMode: "onsite" }, revision: draft.version.revision, scope: "survey", currentStepId: step.id, selection: { kind: "step", label: step.content.heading || "Survey" }, configuration: { showProgress: survey.showProgress, allowBack: survey.allowBack, submitLabel: survey.submitLabel }, steps: survey.steps.map((value: { id: string; content: { heading: string; body: string }; questions: unknown[]; branching?: unknown }) => ({ id: value.id, heading: value.content.heading, body: value.content.body, questions: value.questions, branching: value.branching })), currentDocument: step.builder.projectData.movcues.onsiteDocument, targeting: draft.version.definition.targeting };
    const response = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: editorHeaders, payload: { prompt: "Make the first step clearer", revision: draft.version.revision, context } });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().proposal.operations[0]).toMatchObject({ type: "update_survey_step", stepId: step.id });
  });

  it("accepts Checklist context only with the server-owned site resources", async () => {
    const owner = await signup(ctx.app); const headers = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers, payload: { name: "Checklist AI", domain: "checklist-ai.example.test" } })).json();
    const base = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    await ctx.app.inject({ method: "POST", url: base, headers, payload: { kind: "guide", name: "Product tour", builderMode: "onsite", buildUrl: "https://checklist-ai.example.test", template: "blank", useBuildPageAsTarget: false } });
    await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/segments`, headers, payload: { name: "Activated", definition: { logic: "and", conditions: [{ type: "event", eventName: "activated", operator: "performed" }] } } });
    const created = (await ctx.app.inject({ method: "POST", url: base, headers, payload: { kind: "checklist", name: "Setup", builderMode: "onsite", buildUrl: "https://checklist-ai.example.test", template: "default", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `${base}/${created.id}/editor-sessions`, headers })).json();
    const exchange = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://checklist-ai.example.test" }, payload: { token: new URL(session.launchUrl).searchParams.get("movcues_editor_token") } });
    const editorHeaders = { origin: "https://checklist-ai.example.test", authorization: `Bearer ${exchange.json().accessToken}` };
    const draft = (await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders })).json(), definition = draft.version.definition, item = definition.items[0];
    const context = { experience: { id: created.id, name: "Setup", kind: "checklist", widgetType: null, builderMode: "onsite" }, revision: draft.version.revision, currentView: "expanded", selection: { kind: "step", label: "Checklist" }, selectedItemId: item.id, checklist: { title: definition.title, description: definition.description, totalTasks: definition.items.length, behavior: definition.behavior, completionMessage: definition.completionMessage, items: definition.items.map((value: any, position: number) => ({ ...value, position })) }, resources: { guides: draft.references.guides, segments: draft.references.segments }, currentDocument: definition.builder.projectData.movcues.onsiteDocument, targeting: definition.targeting };
    const response = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: editorHeaders, payload: { prompt: "Improve the first task", revision: draft.version.revision, context } });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().proposal.operations[0]).toMatchObject({ type: "update_checklist_task", itemId: item.id });
    const sourceDefinition = structuredClone(definition); sourceDefinition.builder.projectData.movcues = { ...sourceDefinition.builder.projectData.movcues, authoringSurface: "source", sourceVersion: 1, actionBindings: {} };
    const saved = await ctx.app.inject({ method: "PATCH", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders, payload: { revision: draft.version.revision, definition: sourceDefinition } });
    expect(saved.statusCode, saved.body).toBe(200);
    const sourceRevision = saved.json().version.revision;
    const sourceContext = { ...context, revision: sourceRevision, source: { html: sourceDefinition.builder.html, css: sourceDefinition.builder.css, authoringSurface: "source", actionBindings: {}, supportedActions: ["dismiss", "open_url", "track_event"] } };
    const followUp = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: editorHeaders, payload: { prompt: "Improve the source design again", revision: sourceRevision, context: sourceContext } });
    expect(followUp.statusCode, followUp.body).toBe(200); expect(followUp.json().proposal.operations[0]).toMatchObject({ type: "replace_markup" });
    const tampered = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: editorHeaders, payload: { prompt: "Use another guide", revision: sourceRevision, context: { ...sourceContext, resources: { ...sourceContext.resources, guides: [...sourceContext.resources.guides, { id: "guide_foreign", name: "Foreign", status: "published" }] } } } });
    expect(tampered.statusCode).toBe(409); expect(tampered.json().error).toBe("stale_editor_context");
  });
});
