import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiProvider } from "../src/lib/ai/providers/types.js";
import { aiToolExecutions } from "../src/db/schema.js";
import { createTestApp, signup } from "./helpers.js";

const mockProvider: AiProvider = {
  name: "mock",
  model: "deterministic-test-model",
  async generate(input) {
    if (input.prompt.includes("force exact failure")) throw new Error("provider_exact_failure_message");
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

describe("Movcues AI", () => {
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
    expect(sent.json().assistantMessage.evidence.length).toBeGreaterThan(0);
    const loaded = await ctx.app.inject({ method: "GET", url: base + "/conversations/" + conversation.json().id, headers: auth });
    expect(loaded.json().messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
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
  it("rejects a site that does not belong to the requested organization", async () => {
    const first = await setup();
    const second = await setup();
    const crossSiteBase = "/orgs/" + first.owner.org.id + "/sites/" + second.site.id + "/ai";
    const response = await ctx.app.inject({ method: "GET", url: crossSiteBase + "/status", headers: first.auth });
    expect(response.statusCode).toBe(404);
  });

});
