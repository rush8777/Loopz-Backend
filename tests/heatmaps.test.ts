import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";

type App = Awaited<ReturnType<typeof createTestApp>>["app"];
type Owner = Awaited<ReturnType<typeof signup>>;

async function setupSite(app: App, email?: string) {
  const owner = await signup(app, email ? { email } : {});
  const site = (await app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Heatmap site" } })).json();
  return { owner, site };
}

async function createPage(app: App, owner: Owner, siteId: string, value: string, heatmapEnabled = true) {
  return (await app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${siteId}/pages`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Products", heatmapEnabled, rules: [{ id: "r1", kind: "include", operator: "matches_pattern", value }] } })).json();
}

async function ingest(app: App, publicId: string, sessionId: string, events: Record<string, unknown>[]) {
  const response = await app.inject({ method: "POST", url: `/public/sites/${publicId}/events`, payload: { sessionId, events } });
  expect(response.statusCode).toBe(200);
}

function heatmap(app: App, owner: Owner, siteId: string, pageId: string, query = "stateId=default&device=desktop&layer=click") {
  return app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${siteId}/pages/${pageId}/heatmap?${query}`, headers: { authorization: `Bearer ${owner.accessToken}` } });
}

describe("Page heatmaps", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => {
    await ctx.app.close();
    (ctx.db as unknown as { $client: { close(): void } }).$client.close();
    ctx.cleanup();
  });

  it("aggregates multiple matching raw paths and reclassifies history when Page rules change", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const page = await createPage(ctx.app, owner, site.id, "/products/*");
    await ingest(ctx.app, site.siteId, "s-products", [
      { type: "click", timestamp: 1000, eventId: "c1", path: "/products/123", x: 10, y: 20, documentX: 10, documentY: 520, viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, documentHeight: 3000, deviceClass: "desktop" },
      { type: "click", timestamp: 1001, eventId: "c2", path: "/products/456", x: 30, y: 40, documentX: 30, documentY: 1040, viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, documentHeight: 3000, deviceClass: "desktop" },
    ]);

    const before = await heatmap(ctx.app, owner, site.id, page.id);
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ interactionCount: 2, points: [{ x: 10, y: 520, count: 1 }, { x: 30, y: 1040, count: 1 }] });

    await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${page.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { rules: [{ id: "r1", kind: "include", operator: "matches_pattern", value: "/account/*" }] } });
    expect((await heatmap(ctx.app, owner, site.id, page.id)).json().interactionCount).toBe(0);
    const replacement = await createPage(ctx.app, owner, site.id, "/products/*");
    expect((await heatmap(ctx.app, owner, site.id, replacement.id)).json().interactionCount).toBe(2);
  });

  it("keeps desktop, mobile, Default, and configured modal state data separate", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const page = await createPage(ctx.app, owner, site.id, "/dashboard");
    const state = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${page.id}/heatmap/states`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Create Project Modal", selector: '[role="dialog"][data-dialog="create-project"]' } })).json();
    await ingest(ctx.app, site.siteId, "s-dashboard", [
      { type: "click", timestamp: 2000, eventId: "default-desktop", path: "/dashboard", documentX: 100, documentY: 200, viewportWidth: 1440, viewportHeight: 900, deviceClass: "desktop" },
      { type: "click", timestamp: 2001, eventId: "modal-desktop", path: "/dashboard", documentX: 300, documentY: 400, viewportWidth: 1440, viewportHeight: 900, deviceClass: "desktop", heatmapStateId: state.id },
      { type: "click", timestamp: 2002, eventId: "default-mobile", path: "/dashboard", documentX: 20, documentY: 80, viewportWidth: 390, viewportHeight: 844, deviceClass: "mobile" },
    ]);
    expect((await heatmap(ctx.app, owner, site.id, page.id)).json().points).toEqual([{ x: 100, y: 200, count: 1 }]);
    expect((await heatmap(ctx.app, owner, site.id, page.id, `stateId=${state.id}&device=desktop&layer=click`)).json().points).toEqual([{ x: 300, y: 400, count: 1 }]);
    expect((await heatmap(ctx.app, owner, site.id, page.id, "stateId=default&device=mobile&layer=click")).json().points).toEqual([{ x: 20, y: 80, count: 1 }]);
  });

  it("captures a manually opened modal reference without any rrweb data", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const page = await createPage(ctx.app, owner, site.id, "/dashboard");
    const state = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${page.id}/heatmap/states`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Notifications Drawer", selector: "[data-drawer=notifications]" } })).json();
    const request = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${page.id}/heatmap/capture-request`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { stateId: state.id, device: "desktop", targetUrl: "https://customer.example/dashboard" } });
    expect(request.statusCode).toBe(201);
    const token = new URL(request.json().captureUrl).searchParams.get("__loopz_heatmap_capture");
    expect(request.json()).not.toHaveProperty("command");
    const upload = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/heatmap-snapshots/${token}`, payload: { pagePath: "/dashboard", deviceClass: "desktop", viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, documentHeight: 2400, imageDataUrl: "data:image/webp;base64,AAAA" } });
    expect(upload.statusCode).toBe(201);
    const result = await heatmap(ctx.app, owner, site.id, page.id, `stateId=${state.id}&device=desktop&layer=click`);
    expect(result.json().snapshot).toMatchObject({ pagePath: "/dashboard", documentHeight: 2400, imageDataUrl: "data:image/webp;base64,AAAA" });
  });

  it("filters every metric by date and computes top clicks, unique-session scroll reach, and rage clicks", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const page = await createPage(ctx.app, owner, site.id, "/metrics");
    await ingest(ctx.app, site.siteId, "s1", [
      { type: "page_view", timestamp: 2000, eventId: "pv1", pageViewId: "v1", path: "/metrics", viewportWidth: 1440, deviceClass: "desktop" },
      { type: "click", timestamp: 2500, eventId: "a1", pageViewId: "v1", path: "/metrics", element: { selector: "#create", label: "Create project" }, documentX: 10, documentY: 20, viewportWidth: 1440, deviceClass: "desktop" },
      { type: "click", timestamp: 2600, eventId: "a2", pageViewId: "v1", path: "/metrics", element: { selector: "#create", label: "Create project" }, documentX: 10, documentY: 20, viewportWidth: 1440, deviceClass: "desktop" },
      { type: "scroll", timestamp: 2700, eventId: "sc1", pageViewId: "v1", path: "/metrics", scrollPercent: 80, viewportWidth: 1440, deviceClass: "desktop" },
      { type: "rage_click", timestamp: 2800, eventId: "rc1", pageViewId: "v1", path: "/metrics", element: { selector: "#create" }, documentX: 10, documentY: 20, rageClickCount: 5, viewportWidth: 1440, deviceClass: "desktop" },
    ]);
    await ingest(ctx.app, site.siteId, "s2", [{ type: "page_view", timestamp: 2100, eventId: "pv2", pageViewId: "v2", path: "/metrics", viewportWidth: 1440, deviceClass: "desktop" }, { type: "click", timestamp: 2300, eventId: "b1", pageViewId: "v2", path: "/metrics", element: { selector: "#reports", label: "View reports" }, documentX: 30, documentY: 40, viewportWidth: 1440, deviceClass: "desktop" }, { type: "scroll", timestamp: 2400, eventId: "sc2", pageViewId: "v2", path: "/metrics", scrollPercent: 50, viewportWidth: 1440, deviceClass: "desktop" }]);
    await ingest(ctx.app, site.siteId, "s3", [{ type: "page_view", timestamp: 2200, eventId: "pv3", pageViewId: "v3", path: "/metrics", viewportWidth: 1440, deviceClass: "desktop" }]);
    const range = `stateId=default&device=desktop&layer=click&from=${encodeURIComponent(new Date(1500).toISOString())}&to=${encodeURIComponent(new Date(3000).toISOString())}`;
    const body = (await heatmap(ctx.app, owner, site.id, page.id, range)).json();
    expect(body.metrics).toMatchObject({ visits: 3, totalClicks: 3, dropOffRate: 1 });
    expect(body.topClickedElements[0]).toMatchObject({ selector: "#create", count: 2, percentage: 2 / 3 });
    expect(body.scrollReach).toEqual([{ depth: 25, reached: 2 / 3 }, { depth: 50, reached: 2 / 3 }, { depth: 75, reached: 1 / 3 }, { depth: 100, reached: 0 }]);
    const rage = (await heatmap(ctx.app, owner, site.id, page.id, range.replace("layer=click", "layer=rage_click"))).json();
    expect(rage).toMatchObject({ interactionCount: 1, points: [{ x: 10, y: 20, count: 5 }] });
    const excludedRange = `stateId=default&device=desktop&layer=click&from=${encodeURIComponent(new Date(5000).toISOString())}&to=${encodeURIComponent(new Date(6000).toISOString())}`;
    const excluded = (await heatmap(ctx.app, owner, site.id, page.id, excludedRange)).json();
    expect(excluded.metrics.visits).toBe(0);
  });

  it("issues one automatic reference instruction and stops after capture", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await createPage(ctx.app, owner, site.id, "/auto");
    const instruction = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/heatmap-reference?path=%2Fauto&device=desktop` });
    expect(instruction.statusCode).toBe(200);
    const token = instruction.json().capture.token;
    const upload = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/heatmap-snapshots/${token}`, payload: { pagePath: "/auto", deviceClass: "desktop", viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, documentHeight: 2000, imageDataUrl: "data:image/webp;base64,AAAA" } });
    expect(upload.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/heatmap-reference?path=%2Fauto&device=desktop` })).json()).toEqual({ capture: null });
  });

  it("keeps disabled Pages inactive and enforces site/org isolation", async () => {
    const first = await setupSite(ctx.app, "heatmap-first@example.com");
    const second = await setupSite(ctx.app, "heatmap-second@example.com");
    const disabled = await createPage(ctx.app, first.owner, first.site.id, "/private", false);
    expect((await heatmap(ctx.app, first.owner, first.site.id, disabled.id)).statusCode).toBe(409);
    const index = await ctx.app.inject({ method: "GET", url: `/orgs/${first.owner.org.id}/sites/${first.site.id}/heatmaps`, headers: { authorization: `Bearer ${first.owner.accessToken}` } });
    expect(index.json().heatmaps[0]).toMatchObject({ heatmapEnabled: false });
    const crossTenant = await ctx.app.inject({ method: "GET", url: `/orgs/${second.owner.org.id}/sites/${first.site.id}/heatmaps`, headers: { authorization: `Bearer ${second.owner.accessToken}` } });
    expect(crossTenant.statusCode).toBe(404);
  });
});
