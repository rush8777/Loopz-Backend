import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiProvider } from "../src/lib/ai/providers/types.js";
import { aiToolExecutions, experiences, funnels, sessionEvents } from "../src/db/schema.js";
import { createTestApp, signup } from "./helpers.js";

const mockProvider: AiProvider = {
  name: "mock",
  model: "deterministic-test-model",
  async generate(input) {
    if (input.prompt.includes("force exact failure")) throw new Error("provider_exact_failure_message");
    if (input.prompt.includes("malformed output")) return { text: "{not-json", provider: "mock", model: this.model, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
    if (input.prompt.includes("inline multi")) return { text: JSON.stringify({ blocks: [
      { type: "text", markdown: "## Product activity\n\nHere is the first trusted trend." },
      { type: "chart", chartId: "chart-1" },
      { type: "text", markdown: "The next view gives useful context." },
      { type: "chart", chartId: "chart-2" },
      { type: "text", markdown: "A final trend completes the comparison." },
      { type: "chart", chartId: "chart-3" },
      { type: "text", markdown: "The event breakdown adds one more perspective." },
      { type: "chart", chartId: "chart-4" },
      { type: "text", markdown: "## Conclusion\n\nInvestigate the changes as correlations, not proven causes." },
    ], proposal: null }), provider: "mock", model: this.model, usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 } };
    const proposal = input.prompt.includes("create dashboard") ? {
      type: "dashboard",
      data: {
        name: "Onboarding performance",
        description: "AI-generated preview",
        cards: [{ title: "Unique users", cardType: "metric", width: "small", configuration: { schemaVersion: 1, kind: "metric", metricId: "users.unique", mode: "single", visualization: "previous_period" } }],
      },
    } : null;
    return { text: JSON.stringify({ markdown: "## Evidence-backed answer\n\nThere is no activity in the selected 30-day range.", proposal }), provider: "mock", model: this.model, usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 } };
  },
};

describe("Geo", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp({ aiProvider: mockProvider }); });
  afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });

  async function setup() {
    const owner = await signup(ctx.app);
    const auth = { authorization: "Bearer " + owner.accessToken };
    const site = (await ctx.app.inject({ method: "GET", url: "/orgs/" + owner.org.id + "/sites", headers: auth })).json().sites[0];
    return { owner, auth, site, base: "/orgs/" + owner.org.id + "/sites/" + site.id + "/ai" };
  }

  it("persists an evidence-backed conversation scoped to its owner and site", async () => {
    const { auth, base } = await setup();
    expect((await ctx.app.inject({ method: "GET", url: base + "/status", headers: auth })).json()).toMatchObject({ enabled: true, provider: "mock" });
    const conversation = await ctx.app.inject({ method: "POST", url: base + "/conversations", headers: auth, payload: {} });
    expect(conversation.statusCode).toBe(201);
    const sent = await ctx.app.inject({ method: "POST", url: base + "/conversations/" + conversation.json().id + "/messages", headers: auth, payload: { content: "How are we performing?" } });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().assistantMessage.content).toContain("Evidence-backed");
    expect(sent.json().assistantMessage.contentBlocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: "chart" })]));
    expect(sent.json().assistantMessage.evidence.length).toBeGreaterThan(0);
    const loaded = await ctx.app.inject({ method: "GET", url: base + "/conversations/" + conversation.json().id, headers: auth });
    expect(loaded.json().messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    expect(loaded.json().messages[1].contentBlocks).toEqual(sent.json().assistantMessage.contentBlocks);
  });

  it("requires approval and creates a proposed resource exactly once", async () => {
    const { auth, base } = await setup();
    const conversation = (await ctx.app.inject({ method: "POST", url: base + "/conversations", headers: auth, payload: {} })).json();
    const sent = await ctx.app.inject({ method: "POST", url: base + "/conversations/" + conversation.id + "/messages", headers: auth, payload: { content: "Please create dashboard for onboarding" } });
    expect(sent.statusCode, sent.body).toBe(200);
    const approvalId = sent.json().assistantMessage.approval.id;
    const approved = await ctx.app.inject({ method: "POST", url: base + "/approvals/" + approvalId + "/approve", headers: auth });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().resource.path).toMatch(/^\/dashboard\//);
    const retry = await ctx.app.inject({ method: "POST", url: base + "/approvals/" + approvalId + "/approve", headers: auth });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().resource.id).toBe(approved.json().resource.id);
  });

  it("does not expose another user's conversations", async () => {
    const first = await setup();
    const conversation = (await ctx.app.inject({ method: "POST", url: first.base + "/conversations", headers: first.auth, payload: {} })).json();
    const second = await setup();
    const cross = await ctx.app.inject({ method: "GET", url: second.base + "/conversations/" + conversation.id, headers: second.auth });
    expect(cross.statusCode).toBe(404);
  });

  it("produces trusted analytical blocks for the required controlled scenarios and follow-up", async () => {
    const { owner, auth, site, base } = await setup();
    const now = Date.now();
    await ctx.db.insert(sessionEvents).values([
      { siteId: site.id, sessionId: "scenario-session", anonymousId: "scenario-user", type: "page_view", pagePath: "/onboarding", timestamp: new Date(now - 2 * 86_400_000) },
      { siteId: site.id, sessionId: "scenario-session", anonymousId: "scenario-user", type: "custom", eventName: "onboarding_started", timestamp: new Date(now - 2 * 86_400_000 + 1000) },
      { siteId: site.id, sessionId: "scenario-session", anonymousId: "scenario-user", type: "custom", eventName: "onboarding_completed", timestamp: new Date(now - 2 * 86_400_000 + 2000) },
    ]);
    await ctx.db.insert(funnels).values({ siteId: site.id, name: "Onboarding funnel", steps: [{ type: "event", eventName: "onboarding_started", label: "Started" }, { type: "event", eventName: "onboarding_completed", label: "Completed" }] });
    await ctx.db.insert(experiences).values({ siteId: site.id, kind: "guide", widgetType: null, name: "Welcome guide", createdBy: owner.user.id });
    const conversation = (await ctx.app.inject({ method: "POST", url: base + "/conversations", headers: auth, payload: {} })).json();
    const send = async (content: string) => (await ctx.app.inject({ method: "POST", url: `${base}/conversations/${conversation.id}/messages`, headers: auth, payload: { content } })).json().assistantMessage;

    const changed = await send("Show me what changed last week.");
    expect(changed.contentBlocks.map((block: { type: string }) => block.type)).toEqual(expect.arrayContaining(["metrics", "chart"]));
    const active = await send("Graph our daily active users for the last 30 days.");
    const activeChart = active.contentBlocks.find((block: { type: string }) => block.type === "chart").chart;
    expect(activeChart.title).toContain("Unique users");
    expect(activeChart.data.some((point: { values: Record<string, number> }) => point.values.value === 1)).toBe(true);
    const onboarding = await send("Which onboarding step has the highest drop-off?");
    expect(onboarding.contentBlocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: "chart", chart: expect.objectContaining({ type: "funnel" }) }), expect.objectContaining({ type: "table" })]));
    const guides = await send("How did our guides perform compared with last week?");
    expect(guides.contentBlocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: "chart", chart: expect.objectContaining({ title: "Guide performance" }) })]));
    const followUp = await send("Compare that with the previous period.");
    expect(followUp.contentBlocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: "chart", chart: expect.objectContaining({ title: expect.stringContaining("performance") }) })]));
  });

  it("persists model-selected inline chart order while accepting only trusted chart IDs", async () => {
    const { auth, base } = await setup();
    const conversation = (await ctx.app.inject({ method: "POST", url: base + "/conversations", headers: auth, payload: {} })).json();
    const sent = await ctx.app.inject({ method: "POST", url: `${base}/conversations/${conversation.id}/messages`, headers: auth, payload: { content: "What changed last week? inline multi" } });
    expect(sent.statusCode, sent.body).toBe(200);
    const blocks = sent.json().assistantMessage.contentBlocks;
    expect(blocks.slice(0, 9).map((block: { type: string }) => block.type)).toEqual(["text", "chart", "text", "chart", "text", "chart", "text", "chart", "text"]);
    expect(blocks.filter((block: { type: string }) => block.type === "chart").map((block: { chartId: string }) => block.chartId)).toEqual(["chart-1", "chart-2", "chart-3", "chart-4"]);
    const loaded = await ctx.app.inject({ method: "GET", url: `${base}/conversations/${conversation.id}`, headers: auth });
    expect(loaded.json().messages[1].contentBlocks).toEqual(blocks);
  });

  it("returns and stores the exact provider failure", async () => {
    const { auth, base } = await setup();
    const conversation = (await ctx.app.inject({ method: "POST", url: base + "/conversations", headers: auth, payload: {} })).json();
    const failed = await ctx.app.inject({ method: "POST", url: base + "/conversations/" + conversation.id + "/messages", headers: auth, payload: { content: "force exact failure" } });

    expect(failed.statusCode, failed.body).toBe(502);
    expect(failed.json().message).toBe("AI request failed: provider_exact_failure_message. Your message was preserved; please retry.");
    expect(await ctx.db.select().from(aiToolExecutions)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", errorCode: "provider_exact_failure_message" }),
    ]));
  });

  it("fails safely when a provider returns malformed structured output", async () => {
    const { auth, base } = await setup(); const conversation = (await ctx.app.inject({ method: "POST", url: base + "/conversations", headers: auth, payload: {} })).json();
    const failed = await ctx.app.inject({ method: "POST", url: `${base}/conversations/${conversation.id}/messages`, headers: auth, payload: { content: "malformed output" } });
    expect(failed.statusCode).toBe(502); expect(failed.json()).toMatchObject({ error: "ai_generation_failed" });
    const loaded = await ctx.app.inject({ method: "GET", url: `${base}/conversations/${conversation.id}`, headers: auth });
    expect(loaded.json().messages).toHaveLength(1); expect(loaded.json().messages[0]).toMatchObject({ role: "user", content: "malformed output" });
  });
  it("rejects a site that does not belong to the requested organization", async () => {
    const first = await setup();
    const second = await setup();
    const crossSiteBase = "/orgs/" + first.owner.org.id + "/sites/" + second.site.id + "/ai";
    const response = await ctx.app.inject({ method: "GET", url: crossSiteBase + "/status", headers: first.auth });
    expect(response.statusCode).toBe(404);
  });

});
