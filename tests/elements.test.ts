import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const owner = await signup(app);
  const site = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Elements site" },
    })
  ).json();
  return { owner, site };
}

interface CatalogElement {
  id: string;
  selector: string;
  tagName: string;
  label: string | null;
  role: string | null;
  source: string;
  isIgnored: boolean;
  seenCount: number;
}

describe("element catalog routes", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("ingests a crawl batch and persists new elements", async () => {
    const { owner, site } = await setupSite(ctx.app);

    const post = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: {
        elements: [
          { selector: "#cta", tagName: "button", label: "Save changes", role: "button" },
          { selector: 'a[href="/pricing"]', tagName: "a", label: "Pricing" },
        ],
      },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual({ created: 2, updated: 0 });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    const elements: CatalogElement[] = list.json().elements;
    expect(elements).toHaveLength(2);
    expect(elements.every((e) => e.source === "crawl" && e.seenCount === 1)).toBe(true);
  });

  it("re-crawling the same selector updates seenCount and label rather than duplicating the row", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { elements: [{ selector: "#cta", tagName: "button", label: "Save" }] },
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { elements: [{ selector: "#cta", tagName: "button", label: "Save changes" }] },
    });
    expect(second.json()).toEqual({ created: 0, updated: 1 });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const elements: CatalogElement[] = list.json().elements;
    expect(elements).toHaveLength(1);
    expect(elements[0].seenCount).toBe(2);
    expect(elements[0].label).toBe("Save changes");
  });

  it("a manual rename survives a later crawl with a different heuristic label", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { elements: [{ selector: "#cta", tagName: "button", label: "Save" }] },
    });

    const list1 = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const elementId = (list1.json().elements as CatalogElement[])[0].id;

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements/${elementId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { label: "Checkout button" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().label).toBe("Checkout button");
    expect(patch.json().source).toBe("manual");

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { elements: [{ selector: "#cta", tagName: "button", label: "Save (auto)" }] },
    });

    const list2 = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const after: CatalogElement = (list2.json().elements as CatalogElement[])[0];
    expect(after.label).toBe("Checkout button");
    expect(after.seenCount).toBe(2);
  });

  it("marks an element as ignored without deleting it", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { elements: [{ selector: ".utility-noise", tagName: "div" }] },
    });
    const list1 = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const elementId = (list1.json().elements as CatalogElement[])[0].id;

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements/${elementId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { isIgnored: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().isIgnored).toBe(true);

    const list2 = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list2.json().elements).toHaveLength(1);
  });

  it("returns 404 for an unknown siteId on ingestion", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/site_does_not_exist/elements`,
      payload: { elements: [{ selector: "#cta", tagName: "button" }] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an empty elements array", async () => {
    const { site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { elements: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps catalogs isolated per site - another org's catalog is unaffected", async () => {
    const { site } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { elements: [{ selector: "#cta", tagName: "button" }] },
    });

    const ownerB = await signup(ctx.app, { email: "ownerb-elements@example.com", orgName: "Org B Elements" });
    const siteB = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${ownerB.org.id}/sites`,
        headers: { authorization: `Bearer ${ownerB.accessToken}` },
        payload: { name: "Site B" },
      })
    ).json();

    const crossOrgList = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/elements`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(crossOrgList.statusCode).toBe(200);
    expect(crossOrgList.json().elements).toEqual([]);
  });

  it("rejects unauthenticated access to the list endpoint", async () => {
    const { site } = await setupSite(ctx.app);
    const res = await ctx.app.inject({ method: "GET", url: `/orgs/x/sites/${site.id}/elements` });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a PATCH with neither label nor isIgnored", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { elements: [{ selector: "#cta", tagName: "button" }] },
    });
    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const elementId = (list.json().elements as CatalogElement[])[0].id;

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements/${elementId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {},
    });
    expect(patch.statusCode).toBe(400);
  });

  it("returns 404 when patching an element that belongs to a different site", async () => {
    const { owner, site } = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/elements`,
      payload: { elements: [{ selector: "#cta", tagName: "button" }] },
    });
    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/elements`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const elementId = (list.json().elements as CatalogElement[])[0].id;

    const otherSite = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${owner.org.id}/sites`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Other site" },
      })
    ).json();

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/sites/${otherSite.id}/elements/${elementId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { label: "Hijacked" },
    });
    expect(patch.statusCode).toBe(404);
  });
});
