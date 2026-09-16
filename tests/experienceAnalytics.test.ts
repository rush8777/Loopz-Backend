import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";

describe("experience analytics", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); (ctx.db as unknown as { $client: { close(): void } }).$client.close(); ctx.cleanup(); });

  it("deduplicates Guide step reach and returns backend-computed funnel aggregates", async () => {
    const owner = await signup(ctx.app, { email: "experience-analytics@example.com" }); const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: authorization, payload: { name: "Analytics", domain: "analytics.example.com" } })).json();
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "guide", name: "Onboarding", buildUrl: "https://analytics.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const definition = created.draftVersion.definition; definition.steps[0].pattern = "modal"; definition.steps[0].advance = { type: "button" };
    await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } });
    const published = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: authorization })).json(); const versionId = published.publishedVersion.id;
    const base = { experienceId: created.id, versionId, anonymousId: "anon_1", sessionId: "session_1", pageViewId: "page_1", timestamp: Date.now() };
    const shown = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { ...base, event: "shown", eventType: "experience_shown" } }); expect(shown.statusCode).toBe(201); const impressionId = shown.json().impressionId;
    for (let index = 0; index < 2; index++) { const response = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { ...base, impressionId, event: "interaction", eventType: "guide_step_shown", stepId: definition.steps[0].id, stepIndex: 0 } }); expect(response.statusCode, response.body).toBe(204); }
    expect((await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { ...base, impressionId, event: "interaction", eventType: "guide_step_completed", stepId: definition.steps[0].id, stepIndex: 0, durationMs: 1250 } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { ...base, impressionId, event: "completed", eventType: "guide_completed", stepId: definition.steps[0].id, stepIndex: 0 } })).statusCode).toBe(204);
    const analytics = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/analytics`, headers: authorization });
    expect(analytics.statusCode).toBe(200); expect(analytics.json().summary).toMatchObject({ usersSeen: 1, usersStarted: 1, completed: 1, completionRate: 100 }); expect(analytics.json().guide.steps[0]).toMatchObject({ usersReached: 1, usersAdvanced: 1, dropOff: 0, averageDurationMs: 1250 });
  });
});
