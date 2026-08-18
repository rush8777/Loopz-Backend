import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const owner = await signup(app);
  const site = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Observer site" },
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

function workflowEvents(startedAt: number) {
  return [
    { type: "page_view", timestamp: startedAt },
    { type: "click", timestamp: startedAt + 1000, element: { selector: "#dashboard" } },
    { type: "click", timestamp: startedAt + 2000, element: { selector: "#projects" } },
    { type: "click", timestamp: startedAt + 3000, element: { selector: "#create" } },
    { type: "click", timestamp: startedAt + 4000, element: { selector: "#save" } },
  ];
}

describe("pattern observer routes", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("observes a recurring workflow across many sessions and persists candidates", async () => {
    const { owner, site } = await setupSite(ctx.app);

    for (let i = 0; i < 6; i++) {
      await sendEvents(ctx.app, site.siteId, `sess_${i}`, workflowEvents(i * 100_000));
    }

    const observe = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/patterns/observe`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {},
    });
    expect(observe.statusCode).toBe(200);
    const body = observe.json();
    expect(body.sessionCount).toBe(6);
    expect(body.episodeCount).toBe(6);
    expect(body.candidateCount).toBe(1);
    expect(body.candidates[0].occurrenceCount).toBe(6);
    expect(body.candidates[0].uniqueSessionCount).toBe(6);
    expect(body.candidates[0].representativeSequence).toContain("click:#create");
    expect(body.candidates[0].representativeSequence.some((t: string) => t.startsWith("cursor"))).toBe(false);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/patterns/candidates`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().candidates).toHaveLength(1);
    expect(list.json().candidates[0].occurrenceCount).toBe(6);
    expect(list.json().candidates[0].quality).toHaveProperty("overallScore");
    expect(list.json().candidates[0].similarity).toHaveProperty("average");
  });

  it("exposes per-episode evidence with cursor-free tokens via the detail endpoint", async () => {
    const { owner, site } = await setupSite(ctx.app);

    for (let i = 0; i < 4; i++) {
      const base = i * 100_000;
      const events: unknown[] = [{ type: "page_view", timestamp: base }];
      let t = base + 10;
      for (let c = 0; c < 60; c++) {
        events.push({ type: "cursor", timestamp: t, x: 40 + (c % 2 === 0 ? 2 : -2), y: 40 });
        t += 5;
      }
      events.push({ type: "click", timestamp: t, element: { selector: "#cta" }, x: 40, y: 40 });
      await sendEvents(ctx.app, site.siteId, `sess_evidence_${i}`, events);
    }

    const observe = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/patterns/observe`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { minimumOccurrences: 3 },
    });
    expect(observe.statusCode).toBe(200);
    const candidateId = observe.json().candidates[0].id;

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/patterns/candidates/${candidateId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.candidate.id).toBe(candidateId);
    expect(body.evidence.length).toBeGreaterThanOrEqual(3);
    for (const ev of body.evidence) {
      expect(ev.sessionId).toBeTruthy();
      expect(ev.tokens.every((t: string) => !t.startsWith("cursor"))).toBe(true);
      expect(ev.tokens).toContain("click:#cta");
    }
  });

  it("returns 404 for a candidate belonging to a different site", async () => {
    const { owner, site } = await setupSite(ctx.app);
    for (let i = 0; i < 3; i++) await sendEvents(ctx.app, site.siteId, `sess_${i}`, workflowEvents(i * 100_000));
    const observe = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/patterns/observe`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {},
    });
    const candidateId = observe.json().candidates[0].id;

    const ownerB = await signup(ctx.app, { email: "ownerb-observer@example.com", orgName: "Org B" });
    const siteB = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${ownerB.org.id}/sites`,
        headers: { authorization: `Bearer ${ownerB.accessToken}` },
        payload: { name: "Site B" },
      })
    ).json();

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/analysis/patterns/candidates/${candidateId}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("re-running observation replaces prior candidates rather than accumulating duplicates", async () => {
    const { owner, site } = await setupSite(ctx.app);
    for (let i = 0; i < 5; i++) await sendEvents(ctx.app, site.siteId, `sess_${i}`, workflowEvents(i * 100_000));

    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/patterns/observe`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {},
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/patterns/observe`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {},
    });
    expect(second.json().candidateCount).toBe(1);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/patterns/candidates`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.json().candidates).toHaveLength(1);
  });

  it("a session occurring once does not become a candidate at the default minimumOccurrences", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await sendEvents(ctx.app, site.siteId, "sess_only_one", workflowEvents(0));

    const observe = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/patterns/observe`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {},
    });
    expect(observe.json().candidateCount).toBe(0);
  });

  it("keeps sites isolated - another org's events never influence this site's observation", async () => {
    const { owner, site } = await setupSite(ctx.app);
    for (let i = 0; i < 3; i++) await sendEvents(ctx.app, site.siteId, `sess_${i}`, workflowEvents(i * 100_000));

    const ownerB = await signup(ctx.app, { email: "ownerb-observer2@example.com", orgName: "Org B2" });
    const siteB = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${ownerB.org.id}/sites`,
        headers: { authorization: `Bearer ${ownerB.accessToken}` },
        payload: { name: "Site B2" },
      })
    ).json();

    const observeB = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/analysis/patterns/observe`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {},
    });
    expect(observeB.json().sessionCount).toBe(0);
    expect(observeB.json().candidateCount).toBe(0);
  });
});
