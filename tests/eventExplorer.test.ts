import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"], name = "Events test site") {
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

interface SeedEvent {
  name: string;
  timestamp: number;
  sessionId: string;
  anonymousId?: string;
  eventId?: string;
  pageViewId?: string;
  path?: string; // if set, also injects a matching page_view event with this pageViewId first
  properties?: Record<string, unknown>;
}

async function seedCustomEvents(app: Awaited<ReturnType<typeof createTestApp>>["app"], siteId: string, events: SeedEvent[]) {
  for (const e of events) {
    const batchEvents: Record<string, unknown>[] = [];
    if (e.path && e.pageViewId) {
      batchEvents.push({
        type: "page_view",
        timestamp: e.timestamp - 1,
        pageViewId: e.pageViewId,
        path: e.path,
        eventId: `${e.pageViewId}_pv`,
      });
    }
    batchEvents.push({
      type: "custom",
      timestamp: e.timestamp,
      name: e.name,
      anonymousId: e.anonymousId,
      eventId: e.eventId,
      pageViewId: e.pageViewId,
      properties: e.properties,
    });
    await app.inject({
      method: "POST",
      url: `/public/sites/${siteId}/events`,
      payload: { sessionId: e.sessionId, events: batchEvents },
    });
  }
}

const AUTH = (token: string) => ({ authorization: `Bearer ${token}` });

describe("event catalog", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("discovers distinct custom event names dynamically, with occurrence/user/session counts", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "checkout_completed", timestamp: 1000, sessionId: "s1", anonymousId: "anon_1" },
      { name: "checkout_completed", timestamp: 2000, sessionId: "s2", anonymousId: "anon_2" },
      { name: "checkout_started", timestamp: 1500, sessionId: "s1", anonymousId: "anon_1" },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const { events, total } = res.json();
    expect(total).toBe(2);
    const checkoutCompleted = events.find((e: { name: string }) => e.name === "checkout_completed");
    expect(checkoutCompleted).toMatchObject({ occurrences: 2, uniqueUsers: 2, sessions: 2 });
  });

  it("never hard-codes event names - an event never seeded does not appear", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "custom_thing_xyz", timestamp: 1000, sessionId: "s1" }]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events`,
      headers: AUTH(owner.accessToken),
    });
    const names = res.json().events.map((e: { name: string }) => e.name);
    expect(names).toEqual(["custom_thing_xyz"]);
    expect(names).not.toContain("checkout_completed");
  });

  it("supports server-side event-name search", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "checkout_started", timestamp: 1000, sessionId: "s1" },
      { name: "checkout_completed", timestamp: 1100, sessionId: "s1" },
      { name: "invite_sent", timestamp: 1200, sessionId: "s1" },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events?search=checkout`,
      headers: AUTH(owner.accessToken),
    });
    const names = res.json().events.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual(["checkout_completed", "checkout_started"]);
  });

  it("respects date-range filtering - counts and even presence reflect the selected range, aggregated server-side", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "old_event", timestamp: now - 10 * dayMs, sessionId: "s1" },
      { name: "recent_event", timestamp: now - dayMs, sessionId: "s2" },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events?since=${new Date(now - 3 * dayMs).toISOString()}`,
      headers: AUTH(owner.accessToken),
    });
    const names = res.json().events.map((e: { name: string }) => e.name);
    expect(names).toEqual(["recent_event"]);
    expect(names).not.toContain("old_event");
  });

  it("does not calculate range counts from only the current page - respects the range across the full dataset", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const events: SeedEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push({ name: "paginated_event", timestamp: 1000 + i, sessionId: `s${i}`, anonymousId: `anon_${i}` });
    }
    await seedCustomEvents(ctx.app, site.siteId, events);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events?limit=1`,
      headers: AUTH(owner.accessToken),
    });
    // Even though the page itself only returns 1 row, that row's occurrence count reflects all 5 seeded events, not just what's paginated.
    expect(res.json().events[0].occurrences).toBe(5);
  });

  it("bounds the returned page - never returns an unbounded list", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events?limit=99999`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.statusCode).toBe(400); // limit is capped by the schema (max 200)
  });

  it("site isolation - events from one site never appear in another site's catalog", async () => {
    const { site: siteA } = await setupSite(ctx.app, "Site A");
    const { owner: ownerB, site: siteB } = await setupSite(ctx.app, "Site B");
    await seedCustomEvents(ctx.app, siteA.siteId, [{ name: "site_a_only_event", timestamp: 1000, sessionId: "s1" }]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/events`,
      headers: AUTH(ownerB.accessToken),
    });
    expect(res.json().events).toHaveLength(0);
  });
});

describe("event summary and 404 semantics", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("returns summary stats for a known event", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "checkout_completed", timestamp: 1000, sessionId: "s1", anonymousId: "anon_1" },
      { name: "checkout_completed", timestamp: 2000, sessionId: "s2", anonymousId: "anon_2" },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/checkout_completed`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "checkout_completed", occurrences: 2, uniqueUsers: 2, sessions: 2 });
  });

  it("404s for an event name that never occurred on this site", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/never_happened`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it("does NOT 404 when the event exists but has zero occurrences in the selected date range - returns zeros instead", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const dayMs = 24 * 60 * 60 * 1000;
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "old_event", timestamp: Date.now() - 30 * dayMs, sessionId: "s1" }]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/old_event?since=${new Date().toISOString()}`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().occurrences).toBe(0);
  });
});

describe("unique-user counting reuses the existing identity model", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("counts an anonymousId later claimed by identify() as one user, not two", async () => {
    const { owner, site } = await setupSite(ctx.app);
    // Anonymous occurrence first.
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "signed_up", timestamp: 1000, sessionId: "s1", anonymousId: "anon_shared" }]);
    // identify() claims that anonymousId.
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "s1", events: [{ type: "identify", timestamp: 1100, anonymousId: "anon_shared", externalUserId: "user_1" }] },
    });
    // A second occurrence, now already identified.
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "signed_up", timestamp: 2000, sessionId: "s2", anonymousId: "anon_shared" }]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/signed_up`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.json()).toMatchObject({ occurrences: 2, uniqueUsers: 1, sessions: 2 });
  });

  it("counts two distinct anonymousIds aliased to the same tracked user as one user", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "action_x", timestamp: 1000, sessionId: "s1", anonymousId: "anon_device_1" }]);
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "action_x", timestamp: 2000, sessionId: "s2", anonymousId: "anon_device_2" }]);
    // Same person identifies from both devices.
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "s1",
        events: [{ type: "identify", timestamp: 1500, anonymousId: "anon_device_1", externalUserId: "same_person" }],
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "s2",
        events: [{ type: "identify", timestamp: 2500, anonymousId: "anon_device_2", externalUserId: "same_person" }],
      },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/action_x`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.json().uniqueUsers).toBe(1);
  });

  it("distinct anonymous visitors who never identify count as distinct users", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "action_y", timestamp: 1000, sessionId: "s1", anonymousId: "anon_a" },
      { name: "action_y", timestamp: 2000, sessionId: "s2", anonymousId: "anon_b" },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/action_y`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.json().uniqueUsers).toBe(2);
  });
});

describe("event occurrences", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("lists occurrences with property round-trip, paginated most-recent-first", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "checkout_completed", timestamp: 1000, sessionId: "s1", eventId: "e1", properties: { plan: "pro", amount: 49 } },
      { name: "checkout_completed", timestamp: 2000, sessionId: "s2", eventId: "e2", properties: { plan: "free", amount: 0 } },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/checkout_completed/occurrences`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const { occurrences, total } = res.json();
    expect(total).toBe(2);
    expect(occurrences[0]).toMatchObject({ properties: { plan: "free", amount: 0 } }); // most recent first
    expect(occurrences[1]).toMatchObject({ properties: { plan: "pro", amount: 49 } });
  });

  it("dedicated pagination for occurrences, independent of the catalog's own page size", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const events: SeedEvent[] = [];
    for (let i = 0; i < 5; i++) events.push({ name: "many_occurrences", timestamp: 1000 + i, sessionId: `s${i}` });
    await seedCustomEvents(ctx.app, site.siteId, events);

    const page1 = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/many_occurrences/occurrences?limit=2&offset=0`,
      headers: AUTH(owner.accessToken),
    });
    const page2 = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/many_occurrences/occurrences?limit=2&offset=2`,
      headers: AUTH(owner.accessToken),
    });
    expect(page1.json().occurrences).toHaveLength(2);
    expect(page2.json().occurrences).toHaveLength(2);
    expect(page1.json().total).toBe(5);
  });

  it("resolves each occurrence's page via pageViewId, without duplicating pagePath onto the custom event itself", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "checkout_completed", timestamp: 2000, sessionId: "s1", pageViewId: "pv_1", path: "/checkout" },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/checkout_completed/occurrences`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.json().occurrences[0].pagePath).toBe("/checkout");
  });

  it("attributes an occurrence to its identified user when one exists, otherwise leaves it anonymous", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "signed_up", timestamp: 1000, sessionId: "s1", anonymousId: "anon_x" }]);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "s1", events: [{ type: "identify", timestamp: 1500, anonymousId: "anon_x", externalUserId: "user_x" }] },
    });
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "signed_up", timestamp: 2000, sessionId: "s2", anonymousId: "anon_unclaimed" }]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/signed_up/occurrences`,
      headers: AUTH(owner.accessToken),
    });
    const occurrences = res.json().occurrences;
    const identified = occurrences.find((o: { anonymousId: string }) => o.anonymousId === "anon_x");
    const anonymous = occurrences.find((o: { anonymousId: string }) => o.anonymousId === "anon_unclaimed");
    expect(identified.externalUserId).toBe("user_x");
    expect(anonymous.externalUserId).toBeNull();
  });

  it("provides an occurrence detail drawer view with the full payload", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "checkout_completed", timestamp: 1000, sessionId: "s1", properties: { plan: "pro", amount: 49, currency: "USD" } },
    ]);
    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/checkout_completed/occurrences`,
      headers: AUTH(owner.accessToken),
    });
    const occurrenceId = list.json().occurrences[0].id;

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/checkout_completed/occurrences/${occurrenceId}`,
      headers: AUTH(owner.accessToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ sessionId: "s1", properties: { plan: "pro", amount: 49, currency: "USD" } });
  });
});

describe("event property summarization", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("summarizes categorical (string) properties as a value/percent breakdown", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "checkout_completed", timestamp: 1000, sessionId: "s1", properties: { plan: "pro" } },
      { name: "checkout_completed", timestamp: 2000, sessionId: "s2", properties: { plan: "pro" } },
      { name: "checkout_completed", timestamp: 3000, sessionId: "s3", properties: { plan: "free" } },
      { name: "checkout_completed", timestamp: 4000, sessionId: "s4", properties: { plan: "pro" } },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/checkout_completed/properties`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const plan = res.json().properties.find((p: { name: string }) => p.name === "plan");
    expect(plan.type).toBe("string");
    const pro = plan.values.find((v: { value: string }) => v.value === "pro");
    expect(pro).toMatchObject({ count: 3, percent: 75 });
  });

  it("summarizes numeric properties with min/median/max", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "checkout_completed", timestamp: 1000, sessionId: "s1", properties: { amount: 9 } },
      { name: "checkout_completed", timestamp: 2000, sessionId: "s2", properties: { amount: 49 } },
      { name: "checkout_completed", timestamp: 3000, sessionId: "s3", properties: { amount: 499 } },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/checkout_completed/properties`,
      headers: AUTH(owner.accessToken),
    });
    const amount = res.json().properties.find((p: { name: string }) => p.name === "amount");
    expect(amount).toMatchObject({ type: "number", min: 9, median: 49, max: 499 });
  });

  it("summarizes booleans and does not blow up on null/array/object-valued properties", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      {
        name: "cart_updated",
        timestamp: 1000,
        sessionId: "s1",
        properties: { isGift: true, discountCode: null, items: [{ sku: "A1" }, { sku: "B2" }], meta: { source: "web" } },
      },
      { name: "cart_updated", timestamp: 2000, sessionId: "s2", properties: { isGift: false, discountCode: null } },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/cart_updated/properties`,
      headers: AUTH(owner.accessToken),
    });
    const properties = res.json().properties;
    expect(properties.find((p: { name: string }) => p.name === "isGift").type).toBe("boolean");
    expect(properties.find((p: { name: string }) => p.name === "discountCode").type).toBe("null");
    expect(properties.find((p: { name: string }) => p.name === "items").type).toBe("array");
    expect(properties.find((p: { name: string }) => p.name === "meta").type).toBe("object");
  });

  it("discovers properties dynamically - never assumes fixed property names", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "workspace_created", timestamp: 1000, sessionId: "s1", properties: { teamSize: 5, region: "eu-west" } },
    ]);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/workspace_created/properties`,
      headers: AUTH(owner.accessToken),
    });
    const names = res.json().properties.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(["region", "teamSize"]);
  });

  it("returns an empty properties list for an event that has none", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "video_played", timestamp: 1000, sessionId: "s1" }]);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/video_played/properties`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.json().properties).toEqual([]);
  });
});

describe("event users/sessions/pages breakdowns", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("getEventUsers groups occurrences by resolved identity", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "action_z", timestamp: 1000, sessionId: "s1", anonymousId: "anon_1" },
      { name: "action_z", timestamp: 2000, sessionId: "s1", anonymousId: "anon_1" },
      { name: "action_z", timestamp: 3000, sessionId: "s2", anonymousId: "anon_2" },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/action_z/users`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.json().total).toBe(2);
    const anon1 = res.json().users.find((u: { anonymousId: string }) => u.anonymousId === "anon_1");
    expect(anon1.occurrences).toBe(2);
  });

  it("getEventSessions lists sessions containing the event", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "action_w", timestamp: 1000, sessionId: "s1" },
      { name: "action_w", timestamp: 2000, sessionId: "s2" },
    ]);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/action_w/sessions`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.json().total).toBe(2);
  });

  it("getEventPages breaks down occurrences by page, and buckets unresolvable ones as null", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "checkout_completed", timestamp: 1000, sessionId: "s1", pageViewId: "pv_a", path: "/checkout" },
      { name: "checkout_completed", timestamp: 2000, sessionId: "s2", pageViewId: "pv_b", path: "/checkout" },
      { name: "checkout_completed", timestamp: 3000, sessionId: "s3", pageViewId: "pv_c", path: "/pricing" },
      { name: "checkout_completed", timestamp: 4000, sessionId: "s4" }, // no pageViewId at all
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/checkout_completed/pages`,
      headers: AUTH(owner.accessToken),
    });
    const pages = res.json().pages;
    expect(pages.find((p: { pagePath: string }) => p.pagePath === "/checkout").occurrences).toBe(2);
    expect(pages.find((p: { pagePath: string }) => p.pagePath === "/pricing").occurrences).toBe(1);
    expect(pages.find((p: { pagePath: string | null }) => p.pagePath === null).occurrences).toBe(1);
  });
});

describe("event timeseries", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("buckets occurrences by day and zero-fills empty days across the range", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const day = (n: number) => Date.UTC(2026, 0, n, 12, 0, 0);
    await seedCustomEvents(ctx.app, site.siteId, [
      { name: "checkout_completed", timestamp: day(1), sessionId: "s1" },
      { name: "checkout_completed", timestamp: day(1) + 1000, sessionId: "s2" },
      { name: "checkout_completed", timestamp: day(3), sessionId: "s3" },
    ]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/checkout_completed/timeseries?since=${new Date(day(1)).toISOString()}&until=${new Date(day(3)).toISOString()}`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const points = res.json().points;
    expect(points).toHaveLength(3);
    expect(points[0].count).toBe(2);
    expect(points[1].count).toBe(0); // zero-filled gap day
    expect(points[2].count).toBe(1);
  });
});

describe("used in patterns", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("surfaces a real pattern referencing this event via a custom step, never a fabricated one", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "checkout_completed", timestamp: 1000, sessionId: "s1" }]);

    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/patterns`,
      headers: AUTH(owner.accessToken),
      payload: {
        name: "Checkout completion",
        matchWindowMs: 60000,
        feedback: { message: "Nice!", targetSelector: "#done" },
        steps: [{ id: "s1", verb: "custom", eventName: "checkout_completed", required: true }],
      },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/checkout_completed`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.json().usedIn.patterns).toEqual([expect.objectContaining({ name: "Checkout completion" })]);
  });

  it("shows an empty list, never a fake reference, when no pattern uses the event", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedCustomEvents(ctx.app, site.siteId, [{ name: "lonely_event", timestamp: 1000, sessionId: "s1" }]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/events/lonely_event`,
      headers: AUTH(owner.accessToken),
    });
    expect(res.json().usedIn.patterns).toEqual([]);
  });
});
