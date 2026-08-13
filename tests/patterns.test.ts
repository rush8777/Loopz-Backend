import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

const heroToCtaSteps = [
  { id: "s1", verb: "enter", required: true },
  { id: "s2", verb: "hover", target: { selector: "#hero" }, minDurationMs: 60_000, required: true, maxGapMs: 120_000 },
  { id: "s3", verb: "scroll_past", minScrollPercent: 50, required: true, maxGapMs: 60_000 },
  { id: "s4", verb: "click", target: { selector: "#cta" }, required: true, maxGapMs: 120_000 },
];

async function setupSiteWithPattern(app: Awaited<ReturnType<typeof createTestApp>>["app"], status = "ACTIVE") {
  const owner = await signup(app);
  const site = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Test site" },
    })
  ).json();

  const pattern = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/patterns`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: "Hero to CTA",
        matchWindowMs: 5 * 60 * 1000,
        steps: heroToCtaSteps,
        feedback: { message: "Need help deciding?", targetSelector: "#cta" },
      },
    })
  ).json();

  if (status !== "DRAFT") {
    await app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/sites/${site.id}/patterns/${pattern.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { status },
    });
  }

  return { owner, site, pattern };
}

describe("pattern registry CRUD + RBAC", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("patterns start in DRAFT status by default - never live until explicitly activated", async () => {
    const { pattern } = await setupSiteWithPattern(ctx.app, "DRAFT");
    expect(pattern.status).toBe("DRAFT");
  });

  it("rejects a pattern with duplicate step ids", async () => {
    const owner = await signup(ctx.app);
    const site = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Site" },
      })
    ).json();

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/patterns`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: "Bad pattern",
        matchWindowMs: 60_000,
        steps: [
          { id: "dup", verb: "enter", required: true },
          { id: "dup", verb: "click", target: { selector: "#x" }, required: true },
        ],
        feedback: { message: "hi", targetSelector: "#x" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("duplicate_step_id");
  });

  it("VIEWER can list patterns but cannot create one", async () => {
    const { owner, site } = await setupSiteWithPattern(ctx.app);
    const viewer = await signup(ctx.app, { email: "viewer2@example.com" });
    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: viewer.user.email, role: "VIEWER" },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/patterns`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().patterns).toHaveLength(1);

    const create = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/patterns`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
      payload: { name: "x", matchWindowMs: 1000, steps: [{ id: "a", verb: "enter" }], feedback: { message: "m", targetSelector: "#x" } },
    });
    expect(create.statusCode).toBe(403);
  });

  it("a pattern belonging to site A's org is not reachable through site B's org", async () => {
    const { site: siteA, pattern } = await setupSiteWithPattern(ctx.app);
    const ownerB = await signup(ctx.app, { email: "ownerb@example.com", orgName: "Org B" });
    const siteB = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${ownerB.org.id}/sites`,
        headers: { authorization: `Bearer ${ownerB.accessToken}` },
        payload: { name: "Site B" },
      })
    ).json();

    // Org B trying to read/patch org A's pattern through org B's own orgId - must 404, not leak or succeed.
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/patterns/${pattern.id}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { status: "PAUSED" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("live pattern trigger via the public events endpoint", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("fires a trigger with the right feedback once the full sequence completes", async () => {
    const { site } = await setupSiteWithPattern(ctx.app, "ACTIVE");

    const batch1 = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_live_1",
        events: [
          { type: "page_view", timestamp: 0 },
          { type: "hover", timestamp: 5_000, element: { selector: "#hero" }, durationMs: 61_000 },
        ],
      },
    });
    expect(batch1.json().triggers).toEqual([]);

    const batch2 = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_live_1",
        events: [
          { type: "scroll", timestamp: 70_000, scrollPercent: 55 },
          { type: "click", timestamp: 90_000, element: { selector: "#cta" } },
        ],
      },
    });

    expect(batch2.json().triggers).toHaveLength(1);
    expect(batch2.json().triggers[0]).toMatchObject({
      patternName: "Hero to CTA",
      feedback: { message: "Need help deciding?", targetSelector: "#cta" },
    });
  });

  it("a DRAFT (inactive) pattern never triggers even with a matching sequence", async () => {
    const { site } = await setupSiteWithPattern(ctx.app, "DRAFT");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_draft",
        events: [
          { type: "page_view", timestamp: 0 },
          { type: "hover", timestamp: 5_000, element: { selector: "#hero" }, durationMs: 61_000 },
          { type: "scroll", timestamp: 70_000, scrollPercent: 55 },
          { type: "click", timestamp: 90_000, element: { selector: "#cta" } },
        ],
      },
    });
    expect(res.json().triggers).toEqual([]);
  });

  it("does not re-fire the same pattern twice for the same session", async () => {
    const { site } = await setupSiteWithPattern(ctx.app, "ACTIVE");
    const events = [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 5_000, element: { selector: "#hero" }, durationMs: 61_000 },
      { type: "scroll", timestamp: 70_000, scrollPercent: 55 },
      { type: "click", timestamp: 90_000, element: { selector: "#cta" } },
    ];

    const first = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_once", events },
    });
    expect(first.json().triggers).toHaveLength(1);

    const second = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_once", events: [{ type: "click", timestamp: 200_000, element: { selector: "#cta" } }] },
    });
    expect(second.json().triggers).toEqual([]);
  });

  it("different sessions on the same site are matched completely independently", async () => {
    const { site } = await setupSiteWithPattern(ctx.app, "ACTIVE");
    const fullSequence = [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 5_000, element: { selector: "#hero" }, durationMs: 61_000 },
      { type: "scroll", timestamp: 70_000, scrollPercent: 55 },
      { type: "click", timestamp: 90_000, element: { selector: "#cta" } },
    ];

    const sessionA = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_A", events: fullSequence },
    });
    const sessionB = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_B", events: [{ type: "page_view", timestamp: 0 }] }, // incomplete
    });

    expect(sessionA.json().triggers).toHaveLength(1);
    expect(sessionB.json().triggers).toEqual([]);
  });

  it("404s for an unknown siteId, identically to the public config endpoint", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/public/sites/site_does_not_exist/events",
      payload: { sessionId: "s", events: [{ type: "page_view", timestamp: 0 }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "site_not_found" });
  });

  it("rejects a malformed event batch", async () => {
    const { site } = await setupSiteWithPattern(ctx.app, "ACTIVE");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "s", events: [{ type: "not_a_real_type", timestamp: 0 }] },
    });
    expect(res.statusCode).toBe(400);
  });
});
