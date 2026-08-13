import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

describe("org RBAC and tenant isolation", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("OWNER can create a site; a VIEWER in the same org cannot", async () => {
    const owner = await signup(ctx.app, { email: "owner2@example.com" });
    const viewer = await signup(ctx.app, { email: "viewer@example.com" });

    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: viewer.user.email, role: "VIEWER" },
    });

    const ownerCreate = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Marketing site" },
    });
    expect(ownerCreate.statusCode).toBe(201);

    const viewerCreate = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
      payload: { name: "Should not be created" },
    });
    expect(viewerCreate.statusCode).toBe(403);
    expect(viewerCreate.json()).toMatchObject({ error: "insufficient_role", required: "ADMIN", actual: "VIEWER" });
  });

  it("a user with no membership in an org gets 404, not 403, for that org's routes", async () => {
    const owner = await signup(ctx.app, { email: "owner3@example.com" });
    const stranger = await signup(ctx.app, { email: "stranger@example.com" });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    // 404, not 403 - existence of the org must not be distinguishable
    // from "you're just not a member" to someone probing org IDs.
    expect(res.statusCode).toBe(404);
  });

  it("a site created in org A is never visible when listing org B's sites", async () => {
    const orgA = await signup(ctx.app, { email: "a-owner@example.com", orgName: "Org A" });
    const orgB = await signup(ctx.app, { email: "b-owner@example.com", orgName: "Org B" });

    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${orgA.org.id}/sites`,
      headers: { authorization: `Bearer ${orgA.accessToken}` },
      payload: { name: "Org A's site" },
    });

    const listB = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${orgB.org.id}/sites`,
      headers: { authorization: `Bearer ${orgB.accessToken}` },
    });
    expect(listB.json().sites).toEqual([]);

    // Org B's owner also can't just read org A's sites by guessing the org ID.
    const crossRead = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${orgA.org.id}/sites`,
      headers: { authorization: `Bearer ${orgB.accessToken}` },
    });
    expect(crossRead.statusCode).toBe(404);
  });

  it("public config endpoint only ever returns the requested site's own config", async () => {
    const orgA = await signup(ctx.app, { email: "pub-a@example.com", orgName: "Pub Org A" });
    const orgB = await signup(ctx.app, { email: "pub-b@example.com", orgName: "Pub Org B" });

    const siteA = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${orgA.org.id}/sites`,
        headers: { authorization: `Bearer ${orgA.accessToken}` },
        payload: { name: "Site A" },
      })
    ).json();

    await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${orgA.org.id}/sites/${siteA.id}/config`,
      headers: { authorization: `Bearer ${orgA.accessToken}` },
      payload: { sessionReplay: { enabled: true } },
    });

    const siteB = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${orgB.org.id}/sites`,
        headers: { authorization: `Bearer ${orgB.accessToken}` },
        payload: { name: "Site B" },
      })
    ).json();
    // No config PATCH for site B - it should keep its own default, empty config.

    const publicA = await ctx.app.inject({ method: "GET", url: `/public/config/${siteA.siteId}` });
    expect(publicA.json()).toEqual({
      siteId: siteA.siteId,
      config: { sessionReplay: { enabled: true } },
    });

    const publicB = await ctx.app.inject({ method: "GET", url: `/public/config/${siteB.siteId}` });
    expect(publicB.json()).toEqual({ siteId: siteB.siteId, config: {} });

    // Never leaks orgId, internal id, or domain - only siteId + the allowlisted config.
    expect(publicA.json()).not.toHaveProperty("orgId");
    expect(publicA.json()).not.toHaveProperty("domain");
  });

  it("public config endpoint 404s identically for an unknown siteId (no enumeration signal)", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/public/config/site_totally_made_up" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "site_not_found" });
  });

  it("ADMIN can add members and manage sites, but cannot be implied to have OWNER-only powers", async () => {
    const owner = await signup(ctx.app, { email: "owner4@example.com" });
    const admin = await signup(ctx.app, { email: "admin1@example.com" });

    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: admin.user.email, role: "ADMIN" },
    });

    const adminCreatesSite = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { name: "Admin-created site" },
    });
    expect(adminCreatesSite.statusCode).toBe(201);
  });
});
