import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";
import type { AiProvider } from "../src/lib/ai/providers/types.js";
import { aiConversations, aiMessages } from "../src/db/schema.js";

const provider: AiProvider = {
  name: "mock", model: "editor-test",
  async generate(input) {
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
    const stale = await ctx.app.inject({ method: "POST", url: `/public/experience-editor/${session.sessionId}/ai/chat`, headers: editorHeaders, payload: { ...payload, revision: 999 } });
    expect(stale.statusCode).toBe(409); expect(stale.json().error).toBe("draft_conflict");
  });
});
