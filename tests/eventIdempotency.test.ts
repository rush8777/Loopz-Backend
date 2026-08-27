import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and, asc } from "drizzle-orm";
import { createTestApp, signup } from "./helpers.js";
import { sessionEvents } from "../src/db/schema.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const owner = await signup(app);
  const site = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Idempotency site" },
    })
  ).json();
  return { owner, site };
}

describe("public event ingestion - eventId idempotency", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("does not create a duplicate row when the exact same event is retried in a second request", async () => {
    const { site } = await setupSite(ctx.app);
    const body = {
      sessionId: "sess_retry",
      events: [{ type: "page_view", timestamp: 1000, eventId: "evt_dup_1", pageViewId: "pv_1", path: "/pricing" }],
    };

    const first = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, payload: body });
    const second = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, payload: body });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const rows = await ctx.db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("evt_dup_1");
  });

  it("does not create duplicates when a whole batch is retried, even mixed with events that already succeeded", async () => {
    const { site } = await setupSite(ctx.app);
    const batch = {
      sessionId: "sess_batch_retry",
      events: [
        { type: "page_view", timestamp: 1000, eventId: "evt_b1", pageViewId: "pv_1", path: "/" },
        { type: "click", timestamp: 1200, eventId: "evt_b2", pageViewId: "pv_1", element: { selector: "#cta" }, x: 10, y: 20 },
      ],
    };

    await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, payload: batch });
    // Simulate an at-least-once retry of the exact same batch (e.g. Transport
    // requeuing after an ambiguous network failure even though the first
    // request actually landed).
    await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, payload: batch });

    const rows = await ctx.db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.eventId).sort()).toEqual(["evt_b1", "evt_b2"]);
  });

  it("dedupes repeated eventIds even within a single batch/request", async () => {
    const { site } = await setupSite(ctx.app);
    const batch = {
      sessionId: "sess_intra_batch",
      events: [
        { type: "page_view", timestamp: 1000, eventId: "evt_same", pageViewId: "pv_1", path: "/" },
        { type: "page_view", timestamp: 1000, eventId: "evt_same", pageViewId: "pv_1", path: "/" },
      ],
    };

    const res = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, payload: batch });
    expect(res.statusCode).toBe(200);

    const rows = await ctx.db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id));
    expect(rows).toHaveLength(1);
  });

  it("scopes eventId uniqueness to the site - the same eventId on two different sites is not deduped across them", async () => {
    const owner = await signup(ctx.app);
    const siteA = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Site A" },
      })
    ).json();
    const siteB = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Site B" },
      })
    ).json();

    const eventPayload = {
      sessionId: "sess_cross_site",
      events: [{ type: "page_view", timestamp: 1000, eventId: "evt_shared", pageViewId: "pv_1", path: "/" }],
    };

    await ctx.app.inject({ method: "POST", url: `/public/sites/${siteA.siteId}/events`, payload: eventPayload });
    await ctx.app.inject({ method: "POST", url: `/public/sites/${siteB.siteId}/events`, payload: eventPayload });

    const rowsA = await ctx.db.select().from(sessionEvents).where(eq(sessionEvents.siteId, siteA.id));
    const rowsB = await ctx.db.select().from(sessionEvents).where(eq(sessionEvents.siteId, siteB.id));
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
  });

  it("still ingests events with no eventId (older SDK builds), independently of one another", async () => {
    const { site } = await setupSite(ctx.app);
    const batch = {
      sessionId: "sess_no_event_id",
      events: [
        { type: "page_view", timestamp: 1000, path: "/" },
        { type: "click", timestamp: 1100, element: { selector: "#cta" }, x: 5, y: 5 },
      ],
    };

    const res = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, payload: batch });
    expect(res.statusCode).toBe(200);

    const rows = await ctx.db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.eventId === null)).toBe(true);
  });
});

describe("public event ingestion - pageViewId persistence", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("persists the SDK-sent pageViewId on every behavioral event type, unmodified", async () => {
    const { site } = await setupSite(ctx.app);
    const batch = {
      sessionId: "sess_pv_types",
      events: [
        { type: "page_view", timestamp: 1000, eventId: "e1", pageViewId: "pv_a", path: "/" },
        { type: "click", timestamp: 1100, eventId: "e2", pageViewId: "pv_a", element: { selector: "#cta" }, x: 1, y: 2 },
        { type: "hover", timestamp: 1200, eventId: "e3", pageViewId: "pv_a", element: { selector: "#hero" }, durationMs: 500 },
        { type: "scroll", timestamp: 1300, eventId: "e4", pageViewId: "pv_a", scrollPercent: 40 },
        { type: "cursor", timestamp: 1400, eventId: "e5", pageViewId: "pv_a", x: 3, y: 4 },
      ],
    };

    await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, payload: batch });

    const rows = await ctx.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.siteId, site.id), eq(sessionEvents.sessionId, "sess_pv_types")))
      .orderBy(asc(sessionEvents.timestamp));

    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.pageViewId === "pv_a")).toBe(true);
    expect(rows.map((r) => r.type)).toEqual(["page_view", "click", "hover", "scroll", "cursor"]);
  });

  it("associates each event with the pageViewId active when it was captured, per event - not the session's latest", async () => {
    const { site } = await setupSite(ctx.app);

    // First "page view" of the session.
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_route_change",
        events: [
          { type: "page_view", timestamp: 1000, eventId: "e1", pageViewId: "pv_1", path: "/" },
          { type: "click", timestamp: 1100, eventId: "e2", pageViewId: "pv_1", element: { selector: "#cta" }, x: 1, y: 2 },
        ],
      },
    });

    // SDK-side route change: a new pageViewId is minted (backend never
    // generates or advances this itself) and carried on subsequent events.
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_route_change",
        events: [
          { type: "page_view", timestamp: 2000, eventId: "e3", pageViewId: "pv_2", path: "/pricing" },
          { type: "click", timestamp: 2100, eventId: "e4", pageViewId: "pv_2", element: { selector: "#buy" }, x: 3, y: 4 },
        ],
      },
    });

    const rows = await ctx.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.siteId, site.id), eq(sessionEvents.sessionId, "sess_route_change")))
      .orderBy(asc(sessionEvents.timestamp));

    expect(rows.map((r) => ({ eventId: r.eventId, pageViewId: r.pageViewId }))).toEqual([
      { eventId: "e1", pageViewId: "pv_1" },
      { eventId: "e2", pageViewId: "pv_1" },
      { eventId: "e3", pageViewId: "pv_2" },
      { eventId: "e4", pageViewId: "pv_2" },
    ]);
  });

  it("never fabricates a pageViewId - a row is left null when the SDK didn't send one", async () => {
    const { site } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_no_pv",
        events: [{ type: "page_view", timestamp: 1000, eventId: "e1", path: "/" }],
      },
    });

    const [row] = await ctx.db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id));
    expect(row.pageViewId).toBeNull();
  });
});
