import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function createSite(app: Awaited<ReturnType<typeof createTestApp>>["app"], email?: string) {
  const owner = await signup(app, email ? { email } : {});
  const site = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Page elements site" },
    })
  ).json();
  return { owner, site };
}

async function ingest(app: Awaited<ReturnType<typeof createTestApp>>["app"], publicSiteId: string, pagePath: string, label = "Buy") {
  return app.inject({
    method: "POST",
    url: `/public/sites/${publicSiteId}/elements`,
    payload: { pagePath, elements: [{ selector: "button.buy", tagName: "button", label, role: "button" }] },
  });
}

async function createPage(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  owner: Awaited<ReturnType<typeof signup>>,
  siteId: string,
  name: string,
  value: string
) {
  return (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${siteId}/pages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name, rules: [{ id: "r1", kind: "include", operator: "matches_pattern", value }] },
    })
  ).json();
}

describe("Page element sightings", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(async () => {
    await ctx.app.close();
    (ctx.db as unknown as { $client: { close(): void } }).$client.close();
    ctx.cleanup();
  });

  it("keeps global identity while aggregating one element across matched raw paths", async () => {
    const { owner, site } = await createSite(ctx.app);
    expect((await ingest(ctx.app, site.siteId, "/products/123")).statusCode).toBe(200);
    expect((await ingest(ctx.app, site.siteId, "/products/456")).statusCode).toBe(200);

    const globalList = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(globalList.json().elements).toHaveLength(1);
    expect(globalList.json().elements[0].seenCount).toBe(2);

    const page = await createPage(ctx.app, owner, site.id, "Product detail", "/products/*");
    const result = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${page.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json().elements).toHaveLength(1);
    expect(result.json().elements[0]).toMatchObject({
      selector: "button.buy",
      seenCount: 2,
      matchedPaths: ["/products/123", "/products/456"],
    });
  });

  it("reclassifies historical sightings after Page rules change without rewriting them", async () => {
    const { owner, site } = await createSite(ctx.app);
    await ingest(ctx.app, site.siteId, "/account/profile");
    const account = await createPage(ctx.app, owner, site.id, "Account", "/account/*");

    const before = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${account.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(before.json().elements).toHaveLength(1);

    await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${account.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { rules: [{ id: "r1", kind: "include", operator: "matches_pattern", value: "/profile/*" }] },
    });
    const after = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${account.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(after.json().elements).toEqual([]);

    const replacement = await createPage(ctx.app, owner, site.id, "Profile", "/account/*");
    const reassigned = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${replacement.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(reassigned.json().elements[0].selector).toBe("button.buy");
  });

  it("preserves human label and ignored state through later sightings", async () => {
    const { owner, site } = await createSite(ctx.app);
    await ingest(ctx.app, site.siteId, "/settings", "Generated label");
    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const elementId = list.json().elements[0].id;
    await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements/${elementId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { label: "Save changes", isIgnored: true },
    });
    await ingest(ctx.app, site.siteId, "/settings", "Crawler replacement");

    const page = await createPage(ctx.app, owner, site.id, "Settings", "/settings");
    const result = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/pages/${page.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(result.json().elements[0]).toMatchObject({ label: "Save changes", source: "manual", isIgnored: true, seenCount: 2 });
  });

  it("keeps another site's Page elements isolated", async () => {
    const siteA = await createSite(ctx.app, "page-elements-a@example.com");
    const siteB = await createSite(ctx.app, "page-elements-b@example.com");
    await ingest(ctx.app, siteA.site.siteId, "/settings");
    const pageB = await createPage(ctx.app, siteB.owner, siteB.site.id, "Settings", "/settings");

    const result = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${siteB.owner.org.id}/sites/${siteB.site.id}/pages/${pageB.id}/elements`,
      headers: { authorization: `Bearer ${siteB.owner.accessToken}` },
    });
    expect(result.json().elements).toEqual([]);
  });

  it("rejects malformed pagePath but accepts legacy payloads without one", async () => {
    const { site } = await createSite(ctx.app);
    const malformed = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { pagePath: "https://example.com/settings", elements: [{ selector: "#save", tagName: "button" }] },
    });
    expect(malformed.statusCode).toBe(400);

    const legacy = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { elements: [{ selector: "#save", tagName: "button" }] },
    });
    expect(legacy.statusCode).toBe(200);
  });
});
