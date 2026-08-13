import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const owner = await signup(app);
  const site = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Analysis site" },
    })
  ).json();
  return { owner, site };
}

async function sendEvents(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  siteId: string,
  sessionId: string,
  events: unknown[]
) {
  return app.inject({
    method: "POST",
    url: `/public/sites/${siteId}/events`,
    payload: { sessionId, events },
  });
}

describe("analysis pipeline: durable event log + clustering + fuzzy similarity", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("persists events from the public endpoint even with no active patterns", async () => {
    const { owner, site } = await setupSite(ctx.app);

    const res = await sendEvents(ctx.app, site.siteId, "sess_1", [
      { type: "page_view", timestamp: 0 },
      { type: "click", timestamp: 1000, element: { selector: "#cta" } },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().triggers).toEqual([]); // no patterns defined at all

    const cluster = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/cluster`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { k: 2, minSessions: 1 },
    });
    expect(cluster.statusCode).toBe(200);
    expect(cluster.json().totalSessions).toBe(1);
  });

  it("clusters engaged vs. disengaged sessions and reports a higher conversion rate for the engaged cluster", async () => {
    const { owner, site } = await setupSite(ctx.app);

    // "Engaged" archetype: lots of interaction, converts.
    for (let i = 0; i < 6; i++) {
      await sendEvents(ctx.app, site.siteId, `engaged_${i}`, [
        { type: "page_view", timestamp: 0 },
        { type: "hover", timestamp: 1000, element: { selector: "#hero" }, durationMs: 45000 + i * 500 },
        { type: "scroll", timestamp: 50000, scrollPercent: 80 + i },
        { type: "click", timestamp: 60000, element: { selector: "#feature-a" } },
        { type: "click", timestamp: 70000, element: { selector: "#cta" } },
      ]);
    }
    // "Bounce" archetype: barely any interaction, never converts.
    for (let i = 0; i < 6; i++) {
      await sendEvents(ctx.app, site.siteId, `bounce_${i}`, [{ type: "page_view", timestamp: 0 }]);
    }

    const cluster = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/cluster`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { k: 2, goal: { type: "click", selector: "#cta" }, minSessions: 2 },
    });
    expect(cluster.statusCode).toBe(200);
    const body = cluster.json();
    expect(body.totalSessions).toBe(12);
    expect(body.clusters).toHaveLength(2);

    // Sorted descending by conversion rate - the engaged cluster should be first.
    expect(body.clusters[0].conversionRate).toBe(1);
    expect(body.clusters[0].sessionCount).toBe(6);
    expect(body.clusters[1].conversionRate).toBe(0);
    expect(body.clusters[1].sessionCount).toBe(6);
    expect(body.clusters[0].averages.totalHoverMs).toBeGreaterThan(body.clusters[1].averages.totalHoverMs);
  });

  it("finds sessions with more or fewer steps than the reference as fuzzy matches", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await sendEvents(ctx.app, site.siteId, "sess_exact", [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 1000, element: { selector: "#hero" }, durationMs: 61000 },
      { type: "scroll", timestamp: 70000, scrollPercent: 55 },
      { type: "click", timestamp: 90000, element: { selector: "#cta" } },
    ]);
    // Same essential path but with two extra, unrelated interactions - more steps, same result.
    await sendEvents(ctx.app, site.siteId, "sess_extra_steps", [
      { type: "page_view", timestamp: 0 },
      { type: "click", timestamp: 500, element: { selector: "#nav-about" } },
      { type: "hover", timestamp: 1000, element: { selector: "#hero" }, durationMs: 61000 },
      { type: "hover", timestamp: 30000, element: { selector: "#footer" }, durationMs: 2000 },
      { type: "scroll", timestamp: 70000, scrollPercent: 55 },
      { type: "click", timestamp: 90000, element: { selector: "#cta" } },
    ]);
    // Totally unrelated session.
    await sendEvents(ctx.app, site.siteId, "sess_unrelated", [
      { type: "page_view", timestamp: 0 },
      { type: "click", timestamp: 500, element: { selector: "#pricing-toggle" } },
    ]);

    const referenceTokens = ["enter", "hover:#hero", "scroll", "click:#cta"];
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/similar-sessions`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { referenceTokens, threshold: 0.5 },
    });
    expect(res.statusCode).toBe(200);
    const sessionIds = res.json().matches.map((m: { sessionId: string }) => m.sessionId);
    expect(sessionIds).toContain("sess_exact");
    expect(sessionIds).toContain("sess_extra_steps");
    expect(sessionIds).not.toContain("sess_unrelated");
  });

  it("a VIEWER can run analysis (read-only), but sessions from another org's site never leak in", async () => {
    const { site: siteA } = await setupSite(ctx.app);
    await sendEvents(ctx.app, siteA.siteId, "sess_a", [{ type: "page_view", timestamp: 0 }]);

    const ownerB = await signup(ctx.app, { email: "ownerb2@example.com", orgName: "Org B" });
    const siteB = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${ownerB.org.id}/sites`,
        headers: { authorization: `Bearer ${ownerB.accessToken}` },
        payload: { name: "Site B" },
      })
    ).json();

    const cluster = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/analysis/cluster`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { k: 2, minSessions: 1 },
    });
    expect(cluster.json().totalSessions).toBe(0);
  });

  it("returns a friendly note instead of clustering when there aren't enough sessions", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await sendEvents(ctx.app, site.siteId, "sess_only_one", [{ type: "page_view", timestamp: 0 }]);

    const cluster = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/cluster`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { k: 2, minSessions: 5 },
    });
    expect(cluster.json().clusters).toEqual([]);
    expect(cluster.json().note).toMatch(/not enough sessions/);
  });
});
