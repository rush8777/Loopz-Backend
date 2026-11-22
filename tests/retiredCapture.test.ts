import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestApp, signup } from "./helpers.js";
import { elementCatalog, elementPageSightings, heatmapCaptureRequests, heatmapReferenceSnapshots, sessionContexts, sessionEvents, sessionReplayEvents } from "../src/db/schema.js";

describe("Retired telemetry compatibility", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  async function setupSite() {
    const owner = await signup(ctx.app);
    const site = (await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "MVP1 site", domain: "customer.example" },
    })).json();
    return { owner, site };
  }

  it("accepts mixed legacy batches but persists only allowed events and identity context", async () => {
    const { site } = await setupSite();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_mixed",
        events: [
          { type: "session_start", timestamp: 900, anonymousId: "anon_1", browserName: "Chrome", deviceType: "desktop" },
          { type: "identify", timestamp: 950, anonymousId: "anon_1", externalUserId: "user_1", traits: { plan: "pro" } },
          { type: "page_view", timestamp: 1000, eventId: "pv", pageViewId: "view_1", anonymousId: "anon_1", path: "/home" },
          { type: "cursor", timestamp: 1010, eventId: "cursor_1", pageViewId: "view_1", anonymousId: "anon_1", path: "/home", x: 10, y: 20 },
          { type: "cursor", timestamp: 1020, eventId: "cursor_2", pageViewId: "view_1", anonymousId: "anon_1", path: "/home", x: 11, y: 21 },
          { type: "hover", timestamp: 1030, eventId: "hover_1", pageViewId: "view_1", anonymousId: "anon_1", path: "/home", element: { selector: "#hero" }, durationMs: 500 },
          { type: "click", timestamp: 1040, eventId: "click_1", pageViewId: "view_1", anonymousId: "anon_1", path: "/home", element: { selector: "#save" }, x: 12, y: 22 },
          { type: "custom", timestamp: 1050, eventId: "custom_1", pageViewId: "view_1", anonymousId: "anon_1", path: "/home", name: "saved", properties: { nested: { ok: true }, values: [1, 2], nullable: null } },
          { type: "scroll", timestamp: 1060, eventId: "scroll_1", pageViewId: "view_1", anonymousId: "anon_1", path: "/home", scrollPercent: 50 },
        ],
      },
    });
    expect(response.statusCode).toBe(200);

    const rows = await ctx.db.select().from(sessionEvents)
      .where(and(eq(sessionEvents.siteId, site.id), eq(sessionEvents.sessionId, "sess_mixed")))
      .orderBy(sessionEvents.timestamp);
    expect(rows.map((row) => row.type)).toEqual(["page_view", "click", "custom", "scroll"]);
    expect(rows.find((row) => row.type === "custom")?.eventProperties).toEqual({ nested: { ok: true }, values: [1, 2], nullable: null });
    expect(rows.every((row) => row.trackedUserId !== null)).toBe(true);
    expect(await ctx.db.select().from(sessionContexts).where(eq(sessionContexts.sessionId, "sess_mixed"))).toHaveLength(1);
  });

  it("acknowledges replay from old SDKs without creating replay rows", async () => {
    const { site } = await setupSite();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/replay`,
      payload: { sessionId: "sess_replay", events: [{ type: 2, timestamp: 1000, data: { node: { type: 0 } } }] },
    });
    expect(response.statusCode).toBe(204);
    expect(await ctx.db.select().from(sessionReplayEvents).where(eq(sessionReplayEvents.siteId, site.id))).toHaveLength(0);
  });

  it("acknowledges legacy element crawls without modifying the element catalog", async () => {
    const { owner, site } = await setupSite();
    const [element] = await ctx.db.insert(elementCatalog).values({
      siteId: site.id, selector: "#save", tagName: "button", label: "Original", source: "manual",
      seenCount: 1, firstSeenAt: new Date(1000), lastSeenAt: new Date(1000),
    }).returning();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { pagePath: "/home", elements: [{ selector: "#save", tagName: "a", label: "New" }, { selector: "#new", tagName: "button" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ created: 0, updated: 0 });
    expect(await ctx.db.select().from(elementCatalog).where(eq(elementCatalog.siteId, site.id))).toEqual([element]);
    expect(await ctx.db.select().from(elementPageSightings).where(eq(elementPageSightings.siteId, site.id))).toHaveLength(0);
    const dashboardResponse = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(dashboardResponse.statusCode).toBe(404);
  });

  it("cannot create heatmap capture requests or reference snapshots", async () => {
    const { owner, site } = await setupSite();
    const page = (await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Home", heatmapEnabled: true, rules: [{ id: "r1", kind: "include", operator: "equals", value: "/home" }] },
    })).json();

    const automatic = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/heatmap-reference?path=%2Fhome&device=desktop` });
    expect(automatic.statusCode).toBe(200);
    expect(automatic.json()).toEqual({ capture: null });

    const manual = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${page.id}/heatmap/capture-request`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { stateId: "default", device: "desktop", targetUrl: "https://customer.example/home" },
    });
    expect(manual.statusCode).toBe(404);

    expect((await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/heatmap-captures/stale-token` })).statusCode).toBe(404);
    const upload = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/heatmap-snapshots/stale-token`,
      payload: { pagePath: "/home", deviceClass: "desktop", viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, documentHeight: 2000, imageDataUrl: "data:image/webp;base64,AAAA" },
    });
    expect(upload.statusCode).toBe(204);
    expect(await ctx.db.select().from(heatmapCaptureRequests).where(eq(heatmapCaptureRequests.siteId, site.id))).toHaveLength(0);
    expect(await ctx.db.select().from(heatmapReferenceSnapshots).where(eq(heatmapReferenceSnapshots.siteId, site.id))).toHaveLength(0);
  });
});
