import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";

describe("session activity endpoint", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => {
    await ctx.app.close();
    (ctx.db as unknown as { $client: { close(): void } }).$client.close();
    ctx.cleanup();
  });

  it("returns compact page groups and keeps raw detail compatible", async () => {
    const owner = await signup(ctx.app);
    const site = (await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Activity site" },
    })).json();
    const cursorEvents = Array.from({ length: 100 }, (_, index) => ({
      type: "cursor", timestamp: 2_000 + index, pageViewId: "pv_1", x: index, y: index, viewportWidth: 1000, viewportHeight: 800,
    }));
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_activity",
        events: [
          { type: "page_view", timestamp: 1_000, pageViewId: "pv_1", path: "/pricing" },
          ...cursorEvents,
          { type: "hover", timestamp: 30_000, pageViewId: "pv_1", element: { selector: "#cta", label: "Start trial" }, durationMs: 20_000, x: 100, y: 100, viewportWidth: 1000, viewportHeight: 800 },
          { type: "click", timestamp: 31_000, pageViewId: "pv_1", element: { selector: "#cta", label: "Start trial" }, x: 100, y: 100, viewportWidth: 1000, viewportHeight: 800 },
          { type: "custom", timestamp: 32_000, pageViewId: "pv_1", name: "checkout_started", properties: { plan: "pro" } },
          { type: "scroll", timestamp: 33_000, pageViewId: "pv_1", scrollPercent: 78 },
        ],
      },
    });

    const headers = { authorization: `Bearer ${owner.accessToken}` };
    const activity = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/sess_activity/activity`, headers });
    expect(activity.statusCode).toBe(200);
    const body = activity.json();
    expect(body.counts).toEqual({ pageVisits: 1, clicks: 1, customEvents: 1 });
    expect(body.coverage).toMatchObject({ complete: true, cursorSampleCount: 100 });
    expect(body.pages[0]).toMatchObject({ pageViewId: "pv_1", path: "/pricing", deepestScrollPercent: 78 });
    expect(body.pages[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "click", element: expect.objectContaining({ label: "Start trial" }) }),
      expect.objectContaining({ kind: "custom", name: "checkout_started", properties: { plan: "pro" } }),
      expect.objectContaining({ kind: "long_hover", durationMs: 20_000 }),
    ]));
    expect(body.pages[0].items.some((item: { kind: string }) => item.kind === "cursor")).toBe(false);

    const raw = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/sess_activity`, headers });
    expect(raw.statusCode).toBe(200);
    expect(raw.json().events).toHaveLength(105);
    expect(raw.json().events.some((event: { type: string; x: number }) => event.type === "cursor" && event.x === 25)).toBe(true);

    const list = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/sessions`, headers });
    expect(list.json().sessions[0]).toMatchObject({ pageVisitCount: 1, clickCount: 1, customEventCount: 1 });
    expect(list.json().sessions[0].eventCount).toBe(105);
  });

  it("does not expose another organization's session", async () => {
    const ownerA = await signup(ctx.app);
    const siteA = (await ctx.app.inject({ method: "POST", url: `/orgs/${ownerA.org.id}/sites`, headers: { authorization: `Bearer ${ownerA.accessToken}` }, payload: { name: "A" } })).json();
    await ctx.app.inject({ method: "POST", url: `/public/sites/${siteA.siteId}/events`, payload: { sessionId: "shared_id", events: [{ type: "page_view", timestamp: 1_000, pageViewId: "pv_a", path: "/secret" }] } });
    const ownerB = await signup(ctx.app, { email: "session-activity-b@example.com", orgName: "B" });

    const response = await ctx.app.inject({ method: "GET", url: `/orgs/${ownerB.org.id}/sites/${siteA.id}/sessions/shared_id/activity`, headers: { authorization: `Bearer ${ownerB.accessToken}` } });
    expect(response.statusCode).toBe(404);
  });
});
