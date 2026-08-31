import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"], name = "Funnels test site") {
  const owner = await signup(app);
  const site = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name },
    })
  ).json();
  return { owner, site };
}

async function track(app: Awaited<ReturnType<typeof createTestApp>>["app"], siteId: string, sessionId: string, events: unknown[]) {
  const res = await app.inject({ method: "POST", url: `/public/sites/${siteId}/events`, payload: { sessionId, events } });
  expect(res.statusCode).toBe(200);
}

async function identify(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  siteId: string,
  anonymousId: string,
  externalUserId: string,
  ts = 1000
) {
  await track(app, siteId, `sess_${anonymousId}`, [{ type: "identify", timestamp: ts, anonymousId, externalUserId, traits: {} }]);
}

async function customEvent(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  siteId: string,
  anonymousId: string,
  name: string,
  ts: number
) {
  await track(app, siteId, `sess_${anonymousId}`, [{ type: "custom", timestamp: ts, name, anonymousId }]);
}

async function pageView(app: Awaited<ReturnType<typeof createTestApp>>["app"], siteId: string, anonymousId: string, path: string, ts: number) {
  await track(app, siteId, `sess_${anonymousId}`, [{ type: "page_view", timestamp: ts, anonymousId, path }]);
}

async function createPage(app: Awaited<ReturnType<typeof createTestApp>>["app"], orgId: string, siteId: string, token: string, name: string, value: string) {
  const res = await app.inject({
    method: "POST",
    url: `/orgs/${orgId}/sites/${siteId}/pages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name, rules: [{ id: "r1", kind: "include", operator: "equals", value }] },
  });
  return res.json();
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function daysAgo(n: number, offsetMs = 0): number {
  return NOW - n * DAY + offsetMs;
}

async function analyze(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  orgId: string,
  siteId: string,
  token: string,
  funnelId: string,
  query: Record<string, string> = {}
) {
  const qs = new URLSearchParams({ since: new Date(daysAgo(60)).toISOString(), until: new Date().toISOString(), ...query }).toString();
  const res = await app.inject({
    method: "GET",
    url: `/orgs/${orgId}/sites/${siteId}/funnels/${funnelId}/analyze?${qs}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return res;
}

describe("Funnels CRUD", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("creates a funnel with valid event steps", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_completed", daysAgo(5, 60_000));

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: "Signup Activation",
        description: "Main signup flow",
        steps: [
          { type: "event", eventName: "signup_started", label: "Signup Started" },
          { type: "event", eventName: "signup_completed", label: "Signup Completed" },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("Signup Activation");
    expect(body.steps).toHaveLength(2);
    expect(body.conversionWindowMinutes).toBe(1440); // default
  });

  it("rejects a funnel step referencing an event that has never occurred", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Bad funnel", steps: [{ type: "event", eventName: "totally_made_up_event" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_step_reference");
  });

  it("rejects a funnel step referencing a page from another site", async () => {
    const { owner, site } = await setupSite(ctx.app, "Site A");
    const { owner: ownerB, site: siteB } = await setupSite(ctx.app, "Site B");
    const pageOnSiteB = await createPage(ctx.app, ownerB.org.id, siteB.id, ownerB.accessToken, "Pricing", "/pricing");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Cross-site funnel", steps: [{ type: "page", pageId: pageOnSiteB.id }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty steps array", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "No steps", steps: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a custom conversion window", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Windowed", steps: [{ type: "event", eventName: "signup_started" }], conversionWindow: { value: 1, unit: "hours" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().conversionWindowMinutes).toBe(60);
  });

  it("lists funnels with step counts and default-range conversion", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_completed", daysAgo(5, 60_000));

    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Signup Activation", steps: [{ type: "event", eventName: "signup_started" }, { type: "event", eventName: "signup_completed" }] },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { funnels, total } = res.json();
    expect(total).toBe(1);
    expect(funnels[0].stepCount).toBe(2);
    expect(funnels[0].overallConversion).toBe(100);
  });

  it("searches funnels by name", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    for (const name of ["Signup activation", "Checkout funnel"]) {
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name, steps: [{ type: "event", eventName: "signup_started" }] },
      });
    }
    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels?search=checkout`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const { funnels, total } = res.json();
    expect(total).toBe(1);
    expect(funnels[0].name).toBe("Checkout funnel");
  });

  it("updates a funnel's steps", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    await customEvent(ctx.app, site.siteId, "anon_1", "workspace_created", daysAgo(5, 60_000));

    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Funnel", steps: [{ type: "event", eventName: "signup_started" }] },
      })
    ).json();

    const updated = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { steps: [{ type: "event", eventName: "signup_started" }, { type: "event", eventName: "workspace_created" }] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().steps).toHaveLength(2);
  });

  it("deletes a funnel", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Temp", steps: [{ type: "event", eventName: "signup_started" }] },
      })
    ).json();

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    const get = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(get.statusCode).toBe(404);
  });

  it("keeps funnels isolated per site", async () => {
    const { owner: ownerA, site: siteA } = await setupSite(ctx.app, "Site A");
    const { owner: ownerB } = await setupSite(ctx.app, "Site B");
    await customEvent(ctx.app, siteA.siteId, "anon_1", "signup_started", daysAgo(5));

    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${ownerA.org.id}/sites/${siteA.id}/funnels`,
        headers: { authorization: `Bearer ${ownerA.accessToken}` },
        payload: { name: "Private", steps: [{ type: "event", eventName: "signup_started" }] },
      })
    ).json();

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteA.id}/funnels/${created.id}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Funnel evaluation", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  async function createFunnel(
    orgId: string,
    siteId: string,
    token: string,
    steps: unknown[],
    conversionWindow?: { value: number; unit: "hours" | "days" }
  ) {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/sites/${siteId}/funnels`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Test funnel", steps, ...(conversionWindow ? { conversionWindow } : {}) },
    });
    return res.json();
  }

  it("evaluates a one-step funnel - trivially 100% conversion", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    await customEvent(ctx.app, site.siteId, "anon_2", "signup_started", daysAgo(5));

    const funnel = await createFunnel(owner.org.id, site.id, owner.accessToken, [{ type: "event", eventName: "signup_started" }]);
    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id);
    const body = res.json();
    expect(body.totalUsers).toBe(2);
    expect(body.convertedUsers).toBe(2);
    expect(body.overallConversion).toBe(100);
  });

  it("evaluates a two-step funnel with drop-off", async () => {
    const { owner, site } = await setupSite(ctx.app);
    for (const id of ["anon_1", "anon_2", "anon_3", "anon_4"]) {
      await customEvent(ctx.app, site.siteId, id, "signup_started", daysAgo(5));
    }
    // Only 2 of 4 complete step 2.
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_completed", daysAgo(5, 60_000));
    await customEvent(ctx.app, site.siteId, "anon_2", "signup_completed", daysAgo(5, 60_000));

    const funnel = await createFunnel(owner.org.id, site.id, owner.accessToken, [
      { type: "event", eventName: "signup_started" },
      { type: "event", eventName: "signup_completed" },
    ]);
    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id);
    const body = res.json();
    expect(body.steps[0].users).toBe(4);
    expect(body.steps[1].users).toBe(2);
    expect(body.steps[1].conversionFromStart).toBe(50);
    expect(body.overallConversion).toBe(50);
    expect(body.steps[0].droppedBeforeNext).toBe(2);
  });

  it("evaluates a multi-step funnel with progressive drop-off", async () => {
    const { owner, site } = await setupSite(ctx.app);
    // 10 start, 7 reach step 2, 4 reach step 3.
    for (let i = 0; i < 10; i++) await customEvent(ctx.app, site.siteId, `anon_${i}`, "a", daysAgo(5));
    for (let i = 0; i < 7; i++) await customEvent(ctx.app, site.siteId, `anon_${i}`, "b", daysAgo(5, 60_000));
    for (let i = 0; i < 4; i++) await customEvent(ctx.app, site.siteId, `anon_${i}`, "c", daysAgo(5, 120_000));

    const funnel = await createFunnel(owner.org.id, site.id, owner.accessToken, [
      { type: "event", eventName: "a" },
      { type: "event", eventName: "b" },
      { type: "event", eventName: "c" },
    ]);
    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id);
    const body = res.json();
    expect(body.steps.map((s: { users: number }) => s.users)).toEqual([10, 7, 4]);
    expect(body.steps[1].conversionFromPrevious).toBe(70);
    expect(body.steps[2].conversionFromPrevious).toBeCloseTo(57.1, 1);
  });

  it("does not count a user who performed steps out of order", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    // anon_2 performs completed BEFORE started - should not count as reaching step 2.
    await customEvent(ctx.app, site.siteId, "anon_2", "signup_completed", daysAgo(6));
    await customEvent(ctx.app, site.siteId, "anon_2", "signup_started", daysAgo(5));

    const funnel = await createFunnel(owner.org.id, site.id, owner.accessToken, [
      { type: "event", eventName: "signup_started" },
      { type: "event", eventName: "signup_completed" },
    ]);
    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id);
    const body = res.json();
    expect(body.steps[0].users).toBe(2); // both started
    expect(body.steps[1].users).toBe(0); // neither completed AFTER starting
  });

  it("counts each user once even with duplicate event fires", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5, 5_000));
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5, 10_000));

    const funnel = await createFunnel(owner.org.id, site.id, owner.accessToken, [{ type: "event", eventName: "signup_started" }]);
    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id);
    expect(res.json().totalUsers).toBe(1);
  });

  it("returns a zero-result funnel cleanly when nobody performed step 1", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "unrelated_event", daysAgo(5));

    const funnel = await createFunnel(owner.org.id, site.id, owner.accessToken, [{ type: "event", eventName: "unrelated_event" }]);
    const emptyRes = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id, {
      since: new Date(daysAgo(2)).toISOString(),
      until: new Date(daysAgo(1)).toISOString(),
    });
    const body = emptyRes.json();
    expect(body.totalUsers).toBe(0);
    expect(body.overallConversion).toBe(0);
  });

  it("respects the date range - a step-1 event outside the range doesn't start the funnel", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(50));

    const funnel = await createFunnel(owner.org.id, site.id, owner.accessToken, [{ type: "event", eventName: "signup_started" }]);
    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id, {
      since: new Date(daysAgo(10)).toISOString(),
      until: new Date().toISOString(),
    });
    expect(res.json().totalUsers).toBe(0);
  });

  it("respects the conversion window - a step completed after the window doesn't count", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    // Completes 2 hours later - outside a 1-hour window.
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_completed", daysAgo(5, 2 * 60 * 60 * 1000));

    const funnel = await createFunnel(
      owner.org.id,
      site.id,
      owner.accessToken,
      [{ type: "event", eventName: "signup_started" }, { type: "event", eventName: "signup_completed" }],
      { value: 1, unit: "hours" }
    );
    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id);
    const body = res.json();
    expect(body.steps[0].users).toBe(1);
    expect(body.steps[1].users).toBe(0);
  });

  it("counts a step completed within the conversion window", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_completed", daysAgo(5, 30 * 60 * 1000)); // 30 min later

    const funnel = await createFunnel(
      owner.org.id,
      site.id,
      owner.accessToken,
      [{ type: "event", eventName: "signup_started" }, { type: "event", eventName: "signup_completed" }],
      { value: 1, unit: "hours" }
    );
    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id);
    expect(res.json().steps[1].users).toBe(1);
  });

  it("evaluates a page-view step using an existing Page definition", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const page = await createPage(ctx.app, owner.org.id, site.id, owner.accessToken, "Pricing", "/pricing");
    await pageView(ctx.app, site.siteId, "anon_1", "/pricing", daysAgo(5));
    await customEvent(ctx.app, site.siteId, "anon_1", "checkout_started", daysAgo(5, 60_000));

    const funnel = await createFunnel(owner.org.id, site.id, owner.accessToken, [
      { type: "page", pageId: page.id, label: "Viewed Pricing" },
      { type: "event", eventName: "checkout_started" },
    ]);
    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id);
    const body = res.json();
    expect(body.steps[0].users).toBe(1);
    expect(body.steps[1].users).toBe(1);
    expect(body.steps[0].label).toBe("Viewed Pricing");
  });

  it("filters funnel evaluation to a saved segment", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "free_user", daysAgo(6));
    await identify(ctx.app, site.siteId, "anon_2", "pro_user", daysAgo(6));
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_prop", events: [{ type: "identify", timestamp: daysAgo(6), anonymousId: "anon_1", externalUserId: "free_user", traits: { plan: "free" } }] },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_prop2", events: [{ type: "identify", timestamp: daysAgo(6), anonymousId: "anon_2", externalUserId: "pro_user", traits: { plan: "pro" } }] },
    });
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    await customEvent(ctx.app, site.siteId, "anon_2", "signup_started", daysAgo(5));

    const segment = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Free users", definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "plan", operator: "equals", value: "free" }] } },
      })
    ).json();

    const funnel = await createFunnel(owner.org.id, site.id, owner.accessToken, [{ type: "event", eventName: "signup_started" }]);
    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id, { segmentId: segment.id });
    expect(res.json().totalUsers).toBe(1); // only free_user
  });

  it("exposes hydrated users who reached a given step, linking to the existing user identity", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1", daysAgo(6));
    await customEvent(ctx.app, site.siteId, "anon_1", "signup_started", daysAgo(5));
    await customEvent(ctx.app, site.siteId, "anon_only", "signup_started", daysAgo(5));

    const funnel = await createFunnel(owner.org.id, site.id, owner.accessToken, [{ type: "event", eventName: "signup_started" }]);
    const qs = new URLSearchParams({ since: new Date(daysAgo(10)).toISOString(), until: new Date().toISOString() }).toString();
    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/funnels/${funnel.id}/steps/0/users?${qs}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { users, total } = res.json();
    expect(total).toBe(2);
    expect(users.some((u: { externalUserId: string }) => u.externalUserId === "u1")).toBe(true);
    expect(users.some((u: { anonymousId: string }) => u.anonymousId === "anon_only")).toBe(true);
  });
});

describe("Funnel identity resolution", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("does not double-count anonymous activity that later resolves to an identified user", async () => {
    const { owner, site } = await setupSite(ctx.app);
    // Anonymous step 1...
    await customEvent(ctx.app, site.siteId, "anon_merge", "signup_started", daysAgo(5));
    // ...identified shortly after, then completes step 2 as the identified user (same anonymousId/session).
    await identify(ctx.app, site.siteId, "anon_merge", "merged_user", daysAgo(5, 30_000));
    await customEvent(ctx.app, site.siteId, "anon_merge", "signup_completed", daysAgo(5, 60_000));

    const funnel = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/funnels`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Merge test", steps: [{ type: "event", eventName: "signup_started" }, { type: "event", eventName: "signup_completed" }] },
      })
    ).json();

    const res = await analyze(ctx.app, owner.org.id, site.id, owner.accessToken, funnel.id);
    const body = res.json();
    expect(body.steps[0].users).toBe(1);
    expect(body.steps[1].users).toBe(1); // same person, not two
  });
});
