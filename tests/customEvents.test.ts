import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"], name = "Custom events site") {
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

describe("custom event validation", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("accepts a well-formed custom event with no properties", async () => {
    const { site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_1", events: [{ type: "custom", timestamp: 1000, name: "video_played" }] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts a well-formed custom event with JSON-serializable properties", async () => {
    const { site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          {
            type: "custom",
            timestamp: 1000,
            name: "checkout_completed",
            properties: { plan: "pro", amount: 49, currency: "USD", tags: ["annual", "upgrade"], gift: null },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a custom event with no name", async () => {
    const { site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_1", events: [{ type: "custom", timestamp: 1000 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a custom event with an empty-string name", async () => {
    const { site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_1", events: [{ type: "custom", timestamp: 1000, name: "" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cleanly rejects a whole batch containing one malformed custom event, without partially ingesting it", async () => {
    const { site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "page_view", timestamp: 1000, path: "/" },
          { type: "custom", timestamp: 2000 }, // missing name
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not weaken validation for existing event types - a click still passes, a bad scrollPercent still rejects", async () => {
    const { site } = await setupSite(ctx.app);
    const stillValid = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_1", events: [{ type: "click", timestamp: 1000, element: { selector: "#cta" } }] },
    });
    expect(stillValid.statusCode).toBe(200);

    const stillInvalid = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_1", events: [{ type: "scroll", timestamp: 1000, scrollPercent: 150 }] },
    });
    expect(stillInvalid.statusCode).toBe(400);
  });
});

describe("custom event persistence and retrieval", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("persists and round-trips name/properties through the session detail API, alongside common metadata", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const properties = { plan: "pro", amount: 49, currency: "USD" };

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_checkout",
        events: [
          {
            type: "custom",
            timestamp: 5000,
            eventId: "evt_checkout_1",
            anonymousId: "anon_1",
            pageViewId: "pv_1",
            name: "checkout_completed",
            properties,
          },
        ],
      },
    });

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/sess_checkout`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const event = detail.json().events[0];
    expect(event).toMatchObject({
      type: "custom",
      eventId: "evt_checkout_1",
      pageViewId: "pv_1",
      name: "checkout_completed",
      properties,
    });
  });

  it("does not appear as a click/hover event and carries no selector/durationMs", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_1", events: [{ type: "custom", timestamp: 1000, name: "signed_up" }] },
    });

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/sess_1`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const event = detail.json().events[0];
    expect(event.type).toBe("custom");
    expect(event.selector).toBeNull();
    expect(event.durationMs).toBeNull();
  });

  it("existing event types (page_view, click, hover, scroll, cursor) continue to persist and serialize exactly as before", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_regression",
        events: [
          { type: "page_view", timestamp: 1000, path: "/pricing" },
          { type: "click", timestamp: 1100, element: { selector: "#cta" } },
          { type: "hover", timestamp: 1200, element: { selector: "#hero" }, durationMs: 500 },
          { type: "scroll", timestamp: 1300, scrollPercent: 40 },
          { type: "cursor", timestamp: 1400, x: 5, y: 5 },
        ],
      },
    });

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/sess_regression`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const events = detail.json().events;
    expect(events).toHaveLength(5);
    expect(events.map((e: { type: string }) => e.type)).toEqual(["page_view", "click", "hover", "scroll", "cursor"]);
    expect(events[0].pagePath).toBe("/pricing");
    expect(events[0].name).toBeNull();
    expect(events[0].properties).toBeNull();
  });
});

describe("custom event deduplication (idempotent ingestion)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("retrying the same custom event does not create a duplicate", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const payload = {
      sessionId: "sess_retry",
      events: [{ type: "custom", timestamp: 1000, eventId: "evt_dup", name: "checkout_completed", properties: { plan: "pro" } }],
    };

    await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, payload });
    await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, payload }); // retry

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/sess_retry`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(detail.json().events).toHaveLength(1);
  });
});

describe("custom event site isolation", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("a custom event ingested for one site never appears in another site's session", async () => {
    const { site: siteA } = await setupSite(ctx.app, "Site A");
    const { owner: ownerB, site: siteB } = await setupSite(ctx.app, "Site B");

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${siteA.siteId}/events`,
      payload: { sessionId: "sess_shared_id", events: [{ type: "custom", timestamp: 1000, name: "checkout_completed" }] },
    });

    const detailFromB = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/sessions/sess_shared_id`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(detailFromB.statusCode).toBe(404);
  });
});

describe("custom event identity resolution", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("a custom event fired after identify() shows up in the tracked user's activity", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "identify", timestamp: 1000, anonymousId: "anon_1", externalUserId: "user_123" },
          { type: "custom", timestamp: 2000, anonymousId: "anon_1", name: "checkout_completed", properties: { plan: "pro" } },
        ],
      },
    });

    const users = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const userId = (users.json().users as { id: string }[])[0].id;

    const activity = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}/activity`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const items = activity.json().activities as { title: string; type: string; metadata: Record<string, unknown> }[];
    const custom = items.find((a) => a.type === "custom");
    expect(custom).toBeDefined();
    expect(custom!.title).toBe("checkout_completed"); // not "Clicked ..." - the raw business event name
    expect(custom!.metadata.eventName).toBe("checkout_completed");
    expect(custom!.metadata.eventProperties).toEqual({ plan: "pro" });
  });

  it("a custom event fired anonymously, before identify(), still resolves into the profile once identified later", async () => {
    const { owner, site } = await setupSite(ctx.app);

    // Anonymous custom event first.
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "custom", timestamp: 1000, anonymousId: "anon_1", name: "cart_updated", properties: { items: 2 } }],
      },
    });

    // identify() happens later, in a later session, same anonymousId -
    // this is the same anonymousId -> tracked_user_aliases mechanism
    // every other event type already relies on, not a second identity
    // mechanism.
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_2",
        events: [{ type: "identify", timestamp: 5000, anonymousId: "anon_1", externalUserId: "user_456" }],
      },
    });

    const users = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const userId = (users.json().users as { id: string }[])[0].id;

    const activity = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}/activity`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const titles = (activity.json().activities as { title: string }[]).map((a) => a.title);
    expect(titles).toContain("cart_updated");
  });

  it("historical custom events are not rewritten by identify() - same event, same id, just now attributable to a user", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "custom", timestamp: 1000, eventId: "evt_hist_1", anonymousId: "anon_1", name: "trial_started" }],
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_2",
        events: [{ type: "identify", timestamp: 5000, anonymousId: "anon_1", externalUserId: "user_789" }],
      },
    });

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/sess_1`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    // The original row is untouched - same eventId, same name - identify() never mutates raw session_events rows.
    expect(detail.json().events[0]).toMatchObject({ eventId: "evt_hist_1", name: "trial_started" });
  });
});
