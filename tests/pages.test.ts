import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const owner = await signup(app);
  const site = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Pages test site" },
    })
  ).json();
  return { owner, site };
}

/** Seeds page_view traffic for a set of pagePaths, `count` views each, via the public ingestion endpoint. */
async function seedPageViews(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  siteId: string,
  paths: { path: string; views: number; anonymousId?: string }[]
) {
  let t = 1000;
  for (const { path, views, anonymousId } of paths) {
    for (let i = 0; i < views; i++) {
      await app.inject({
        method: "POST",
        url: `/public/sites/${siteId}/events`,
        payload: {
          sessionId: `sess_${path}_${i}`,
          events: [
            {
              type: "page_view",
              timestamp: t++,
              eventId: `evt_${path}_${i}`,
              anonymousId: anonymousId ?? `anon_${path}_${i}`,
              path,
            },
          ],
        },
      });
    }
  }
}

describe("Pages CRUD", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("creates a Page with include rules and computes metrics from real traffic", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedPageViews(ctx.app, site.siteId, [
      { path: "/products/1", views: 3 },
      { path: "/products/2", views: 2 },
      { path: "/pricing", views: 5 },
    ]);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: "Product Detail",
        area: "Commerce",
        rules: [{ id: "r1", kind: "include", operator: "starts_with", value: "/products" }],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("Product Detail");
    expect(body.views).toBe(5); // 3 + 2
    expect(body.uniqueSessions).toBe(5);
  });

  it("rejects a rule set with no include rules", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Bad page", rules: [{ id: "r1", kind: "exclude", operator: "contains", value: "admin" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects duplicate rule ids", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: "Dup rule ids",
        rules: [
          { id: "r1", kind: "include", operator: "equals", value: "/a" },
          { id: "r1", kind: "include", operator: "equals", value: "/b" },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists Pages for a site with metrics per Page", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedPageViews(ctx.app, site.siteId, [
      { path: "/settings", views: 2 },
      { path: "/settings/billing", views: 4 },
    ]);
    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Settings", rules: [{ id: "r1", kind: "include", operator: "starts_with", value: "/settings" }] },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { pages } = res.json();
    expect(pages).toHaveLength(1);
    expect(pages[0].views).toBe(6);
  });

  it("updates a Page's rules, which reclassifies existing traffic without any backfill", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedPageViews(ctx.app, site.siteId, [
      { path: "/shop/products/1", views: 3 },
      { path: "/products/1", views: 7 },
    ]);

    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/pages`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Products", rules: [{ id: "r1", kind: "include", operator: "starts_with", value: "/products" }] },
      })
    ).json();
    expect(created.views).toBe(7); // only /products/1 matches the old rule

    const updated = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { rules: [{ id: "r1", kind: "include", operator: "contains", value: "/products" }] },
    });
    expect(updated.statusCode).toBe(200);
    // Same historical session_events rows, reclassified by the new rule - both paths now count.
    expect(updated.json().views).toBe(10);
  });

  it("deletes a Page", async () => {
    const { owner, site } = await setupSite(ctx.app);
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites/${site.id}/pages`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Temp", rules: [{ id: "r1", kind: "include", operator: "equals", value: "/temp" }] },
      })
    ).json();

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    const get = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(get.statusCode).toBe(404);
  });

  it("keeps Pages isolated per site/org - a page from one org 404s for another org", async () => {
    const { owner: ownerA, site: siteA } = await setupSite(ctx.app);
    const { owner: ownerB } = await setupSite(ctx.app);

    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${ownerA.org.id}/sites/${siteA.id}/pages`,
        headers: { authorization: `Bearer ${ownerA.accessToken}` },
        payload: { name: "Private", rules: [{ id: "r1", kind: "include", operator: "equals", value: "/x" }] },
      })
    ).json();

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteA.id}/pages/${created.id}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Untagged URLs", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("lists pagePaths not matched by any existing Page, sorted by views descending", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedPageViews(ctx.app, site.siteId, [
      { path: "/dashboard", views: 5 },
      { path: "/settings", views: 2 },
      { path: "/rare-page", views: 9 },
    ]);
    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Dashboard", rules: [{ id: "r1", kind: "include", operator: "equals", value: "/dashboard" }] },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/untagged`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { untagged } = res.json();
    expect(untagged.map((u: { pagePath: string }) => u.pagePath)).toEqual(["/rare-page", "/settings"]);
  });
});

describe("Page rule preview", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("tests candidate rules against real traffic without persisting a Page", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await seedPageViews(ctx.app, site.siteId, [
      { path: "/products/1", views: 2 },
      { path: "/products/2", views: 3 },
      { path: "/pricing", views: 1 },
    ]);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/preview`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { rules: [{ id: "r1", kind: "include", operator: "matches_pattern", value: "/products/*" }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matched.map((m: { pagePath: string }) => m.pagePath).sort()).toEqual(["/products/1", "/products/2"]);
    expect(body.metrics.views).toBe(5);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.json().pages).toHaveLength(0); // preview never persists anything
  });
});
