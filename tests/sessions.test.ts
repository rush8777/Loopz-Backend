import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const owner = await signup(app);
  const site = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Sessions site" },
    })
  ).json();
  return { owner, site };
}

describe("session list/detail endpoints", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("lists sessions sorted by most recent activity with coordinate data included", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_old",
        events: [{ type: "page_view", timestamp: 1000 }],
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_new",
        events: [
          { type: "page_view", timestamp: 5000 },
          { type: "click", timestamp: 6000, element: { selector: "#cta" }, x: 120, y: 340, viewportWidth: 1440, viewportHeight: 900 },
        ],
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["sess_new", "sess_old"]);
    expect(body.sessions[0].eventCount).toBe(2);
    expect(body.sessions[0].hasReplay).toBe(false);
  });

  it("does not count cursor events toward session totals", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_cursor_total",
        events: [
          { type: "page_view", timestamp: 0 },
          { type: "cursor", timestamp: 100, x: 12, y: 34 },
          { type: "click", timestamp: 200, element: { selector: "#cta" }, x: 50, y: 60, viewportWidth: 1280, viewportHeight: 800 },
          { type: "cursor", timestamp: 300, x: 90, y: 120 },
        ],
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "sess_cursor_total",
          eventCount: 2,
        }),
      ])
    );
  });

  it("returns full ordered event timeline including coordinates for a single session", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_detail",
        events: [
          { type: "page_view", timestamp: 0 },
          { type: "click", timestamp: 1000, element: { selector: "#cta" }, x: 50, y: 60, viewportWidth: 1280, viewportHeight: 800 },
        ],
      },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/sess_detail`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(2);
    expect(body.events[1]).toMatchObject({ type: "click", selector: "#cta", x: 50, y: 60, viewportWidth: 1280 });
  });

  it("404s for a session that doesn't exist", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/does_not_exist`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not leak session data across orgs", async () => {
    const { site: siteA } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${siteA.siteId}/events`,
      payload: { sessionId: "sess_a", events: [{ type: "page_view", timestamp: 0 }] },
    });

    const ownerB = await signup(ctx.app, { email: "sessb@example.com", orgName: "Org B Sessions" });
    const siteB = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${ownerB.org.id}/sites`,
        headers: { authorization: `Bearer ${ownerB.accessToken}` },
        payload: { name: "Site B" },
      })
    ).json();

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/sessions`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(list.json().sessions).toEqual([]);
  });
});

describe("rrweb replay ingestion + retrieval", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("stores rrweb events and serves the FullSnapshot for heatmap rendering", async () => {
    const { owner, site } = await setupSite(ctx.app);

    const ingest = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/replay`,
      payload: {
        sessionId: "sess_replay_1",
        events: [
          { type: 4, timestamp: 0, data: { href: "https://example.com" } }, // Meta
          { type: 2, timestamp: 10, data: { node: { tagName: "html" } } }, // FullSnapshot
          { type: 3, timestamp: 500, data: { source: 0 } }, // IncrementalSnapshot
        ],
      },
    });
    expect(ingest.statusCode).toBe(204);

    const snapshot = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/sess_replay_1/snapshot`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().data).toEqual({ node: { tagName: "html" } });

    const replay = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/sess_replay_1/replay`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(replay.json().events).toHaveLength(3);
    expect(replay.json().events.map((e: { type: number }) => e.type)).toEqual([4, 2, 3]);
  });

  it("session list reflects hasReplay correctly once replay data exists", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "sess_with_replay", events: [{ type: "page_view", timestamp: 0 }] },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/replay`,
      payload: { sessionId: "sess_with_replay", events: [{ type: 2, timestamp: 0, data: {} }] },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.json().sessions[0].hasReplay).toBe(true);
  });

  it("404s for a snapshot request when no replay data was ever sent", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sessions/no_replay_session/snapshot`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "snapshot_not_found" });
  });

  it("rejects replay ingestion for an unknown siteId", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/public/sites/site_fake/replay",
      payload: { sessionId: "s", events: [{ type: 2, timestamp: 0, data: {} }] },
    });
    expect(res.statusCode).toBe(404);
  });
});
