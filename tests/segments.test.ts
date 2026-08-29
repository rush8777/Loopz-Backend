import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"], name = "Segments test site") {
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
  const res = await app.inject({
    method: "POST",
    url: `/public/sites/${siteId}/events`,
    payload: { sessionId, events },
  });
  expect(res.statusCode).toBe(200);
}

async function identify(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  siteId: string,
  anonymousId: string,
  externalUserId: string,
  traits: Record<string, unknown> = {},
  ts = 1000
) {
  await track(app, siteId, `sess_${anonymousId}`, [
    { type: "identify", timestamp: ts, anonymousId, externalUserId, traits },
  ]);
}

async function customEvent(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  siteId: string,
  anonymousId: string,
  name: string,
  ts = 1000
) {
  await track(app, siteId, `sess_${anonymousId}`, [{ type: "custom", timestamp: ts, name, anonymousId }]);
}

async function pageView(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  siteId: string,
  anonymousId: string,
  path: string,
  ts = 1000
) {
  await track(app, siteId, `sess_${anonymousId}`, [{ type: "page_view", timestamp: ts, anonymousId, path }]);
}

async function createPage(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  orgId: string,
  siteId: string,
  token: string,
  name: string,
  value: string
) {
  const res = await app.inject({
    method: "POST",
    url: `/orgs/${orgId}/sites/${siteId}/pages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name, rules: [{ id: "r1", kind: "include", operator: "equals", value }] },
  });
  return res.json();
}

describe("Segments CRUD", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("creates a segment and returns its audience count", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1", { plan: "free" });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: "Free users",
        description: "Users on the free plan",
        definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "plan", operator: "equals", value: "free" }] },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("Free users");
    expect(body.audienceCount).toBe(1);
  });

  it("rejects an invalid definition", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Bad segment", definition: { logic: "xor", conditions: [] } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a definition with an unknown condition type", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Bad segment", definition: { logic: "and", conditions: [{ type: "geo", country: "US" }] } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists segments with per-segment audience counts", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1", { plan: "free" });
    await identify(ctx.app, site.siteId, "anon_2", "u2", { plan: "pro" });

    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: "All users",
        definition: { logic: "or", conditions: [{ type: "user_property", propertyName: "plan", operator: "exists" }] },
      },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { segments, total } = res.json();
    expect(total).toBe(1);
    expect(segments[0].audienceCount).toBe(2);
  });

  it("searches segments by name", async () => {
    const { owner, site } = await setupSite(ctx.app);
    for (const name of ["High-intent trial users", "Free users with friction", "Recently activated"]) {
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name, definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "plan", operator: "exists" }] } },
      });
    }

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments?search=free`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const { segments, total } = res.json();
    expect(total).toBe(1);
    expect(segments[0].name).toBe("Free users with friction");
  });

  it("updates a segment's definition, which changes its audience count", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1", { plan: "free" });
    await identify(ctx.app, site.siteId, "anon_2", "u2", { plan: "pro" });

    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: {
          name: "Plan segment",
          definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "plan", operator: "equals", value: "free" }] },
        },
      })
    ).json();
    expect(created.audienceCount).toBe(1);

    const updated = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "plan", operator: "equals", value: "pro" }] },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().audienceCount).toBe(1);

    const members = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/${created.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(members.json().members[0].externalUserId).toBe("u2");
  });

  it("deletes a segment", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Temp", definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "plan", operator: "exists" }] } },
      })
    ).json();

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    const get = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(get.statusCode).toBe(404);
  });

  it("keeps segments isolated per site - a segment from Site A 404s for another org querying by id", async () => {
    const { owner: ownerA, site: siteA } = await setupSite(ctx.app, "Site A");
    const { owner: ownerB } = await setupSite(ctx.app, "Site B");

    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${ownerA.org.id}/sites/${siteA.id}/segments`,
        headers: { authorization: `Bearer ${ownerA.accessToken}` },
        payload: { name: "Private", definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "plan", operator: "exists" }] } },
      })
    ).json();

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteA.id}/segments/${created.id}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Segment preview", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("evaluates a candidate definition without persisting anything", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1");
    await customEvent(ctx.app, site.siteId, "anon_1", "checkout_started");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "event", eventName: "checkout_started", operator: "performed" }] } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().audienceCount).toBe(1);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.json().total).toBe(0); // preview never persists
  });

  it("rejects an invalid definition on preview too", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [] } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Segment evaluation - event conditions", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("matches users who performed an event", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1");
    await identify(ctx.app, site.siteId, "anon_2", "u2");
    await customEvent(ctx.app, site.siteId, "anon_1", "checkout_started");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "event", eventName: "checkout_started", operator: "performed" }] } },
    });
    expect(res.json().audienceCount).toBe(1);
  });

  it("matches users who did NOT perform an event, against the known-identity universe", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1");
    await identify(ctx.app, site.siteId, "anon_2", "u2");
    await customEvent(ctx.app, site.siteId, "anon_1", "checkout_completed");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "event", eventName: "checkout_completed", operator: "not_performed" }] } },
    });
    // Only u2 is known (from identify()) and did not complete checkout.
    expect(res.json().audienceCount).toBe(1);
  });

  it("respects a time window on event conditions", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1", {}, 1000);
    // Event far in the past - outside any reasonable "last N days" window.
    await customEvent(ctx.app, site.siteId, "anon_1", "checkout_started", 1000);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        definition: {
          logic: "and",
          conditions: [{ type: "event", eventName: "checkout_started", operator: "performed", timeWindow: { value: 7, unit: "days" } }],
        },
      },
    });
    expect(res.json().audienceCount).toBe(0);
  });

  it("classic funnel-drop segment: started checkout AND did not complete it", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "started_only");
    await identify(ctx.app, site.siteId, "anon_2", "completed");
    await identify(ctx.app, site.siteId, "anon_3", "never_started");
    await customEvent(ctx.app, site.siteId, "anon_1", "checkout_started");
    await customEvent(ctx.app, site.siteId, "anon_2", "checkout_started");
    await customEvent(ctx.app, site.siteId, "anon_2", "checkout_completed");

    const definition = {
      logic: "and",
      conditions: [
        { type: "event", eventName: "checkout_started", operator: "performed" },
        { type: "event", eventName: "checkout_completed", operator: "not_performed" },
      ],
    };
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition },
    });
    expect(res.json().audienceCount).toBe(1); // only started_only

    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "High-intent trial users", definition },
      })
    ).json();
    const members = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/${created.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(members.json().members.map((m: { externalUserId: string }) => m.externalUserId)).toEqual(["started_only"]);

    // Membership reflects current data - once started_only also completes checkout, they drop out.
    await customEvent(ctx.app, site.siteId, "anon_1", "checkout_completed");
    const after = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(after.json().audienceCount).toBe(0);
  });
});

describe("Segment evaluation - user property conditions", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("equals", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1", { plan: "free" });
    await identify(ctx.app, site.siteId, "anon_2", "u2", { plan: "pro" });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "plan", operator: "equals", value: "free" }] } },
    });
    expect(res.json().audienceCount).toBe(1);
  });

  it("greater_than on a numeric property", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1", { seats: 12 });
    await identify(ctx.app, site.siteId, "anon_2", "u2", { seats: 2 });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "seats", operator: "greater_than", value: 5 }] } },
    });
    expect(res.json().audienceCount).toBe(1);
  });

  it("not_exists matches identified users without the property", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1", { plan: "free" });
    await identify(ctx.app, site.siteId, "anon_2", "u2", {});
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "plan", operator: "not_exists" }] } },
    });
    expect(res.json().audienceCount).toBe(1);
  });
});

describe("Segment evaluation - page conditions", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("matches users who visited a defined Page", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const page = await createPage(ctx.app, owner.org.id, site.id, owner.accessToken, "Pricing", "/pricing");
    await identify(ctx.app, site.siteId, "anon_1", "u1");
    await identify(ctx.app, site.siteId, "anon_2", "u2");
    await pageView(ctx.app, site.siteId, "anon_1", "/pricing");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "page", pageId: page.id, operator: "visited" }] } },
    });
    expect(res.json().audienceCount).toBe(1);
  });

  it("matches users who did NOT visit a defined Page", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const page = await createPage(ctx.app, owner.org.id, site.id, owner.accessToken, "Pricing", "/pricing");
    await identify(ctx.app, site.siteId, "anon_1", "u1");
    await identify(ctx.app, site.siteId, "anon_2", "u2");
    await pageView(ctx.app, site.siteId, "anon_1", "/pricing");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "page", pageId: page.id, operator: "not_visited" }] } },
    });
    expect(res.json().audienceCount).toBe(1); // u2
  });
});

describe("Segment evaluation - nested AND/OR groups", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("evaluates a nested OR group inside a top-level AND group", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "sawPricing");
    await identify(ctx.app, site.siteId, "anon_2", "requestedDemo");
    await identify(ctx.app, site.siteId, "anon_3", "neither");
    await customEvent(ctx.app, site.siteId, "anon_1", "checkout_started");
    await customEvent(ctx.app, site.siteId, "anon_1", "pricing_viewed");
    await customEvent(ctx.app, site.siteId, "anon_2", "checkout_started");
    await customEvent(ctx.app, site.siteId, "anon_2", "demo_requested");
    await customEvent(ctx.app, site.siteId, "anon_3", "checkout_started");

    const definition = {
      logic: "and",
      conditions: [
        { type: "event", eventName: "checkout_started", operator: "performed" },
        {
          logic: "or",
          conditions: [
            { type: "event", eventName: "pricing_viewed", operator: "performed" },
            { type: "event", eventName: "demo_requested", operator: "performed" },
          ],
        },
      ],
    };
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition },
    });
    expect(res.json().audienceCount).toBe(2); // sawPricing, requestedDemo - not "neither"
  });

  it("returns zero for a definition that matches nobody", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await identify(ctx.app, site.siteId, "anon_1", "u1", { plan: "free" });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "user_property", propertyName: "plan", operator: "equals", value: "enterprise" }] } },
    });
    expect(res.json().audienceCount).toBe(0);
  });
});

describe("Segment evaluation - identity resolution", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("counts an anonymous visitor exactly once, even before identification", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await customEvent(ctx.app, site.siteId, "anon_only", "checkout_started");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "event", eventName: "checkout_started", operator: "performed" }] } },
    });
    expect(res.json().audienceCount).toBe(1);

    const members = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: "Anon checkout",
        definition: { logic: "and", conditions: [{ type: "event", eventName: "checkout_started", operator: "performed" }] },
      },
    });
    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/${members.json().id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.json().members[0]).toMatchObject({ identityType: "anonymous", anonymousId: "anon_only" });
  });

  it("does not double-count a visitor before and after identify() resolves them - anonymous activity merges into the identified profile", async () => {
    const { owner, site } = await setupSite(ctx.app);
    // Anonymous activity first...
    await customEvent(ctx.app, site.siteId, "anon_merge", "checkout_started", 1000);
    // ...then identified later in the same browser session.
    await identify(ctx.app, site.siteId, "anon_merge", "merged_user", {}, 2000);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { definition: { logic: "and", conditions: [{ type: "event", eventName: "checkout_started", operator: "performed" }] } },
    });
    // One person, not two - the pre-identify anonymous event and the
    // post-identify identity resolve to the same tracked user.
    expect(res.json().audienceCount).toBe(1);

    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/segments`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: {
          name: "Merged identity",
          definition: { logic: "and", conditions: [{ type: "event", eventName: "checkout_started", operator: "performed" }] },
        },
      })
    ).json();
    const members = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/segments/${created.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(members.json().members[0]).toMatchObject({ identityType: "identified", externalUserId: "merged_user" });
  });
});
