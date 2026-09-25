import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sessionEvents, sites } from "../src/db/schema.js";
import { createTestApp, signup } from "./helpers.js";

describe("workspace and site settings", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(() => ctx.cleanup());

  it("lets ADMIN+ rename the workspace and rejects MEMBER", async () => {
    const owner = await signup(ctx.app, { email: "settings-owner@example.com" });
    const member = await signup(ctx.app, { email: "settings-member@example.com" });
    await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/members`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { email: member.user.email, role: "MEMBER" } });

    const denied = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}`, headers: { authorization: `Bearer ${member.accessToken}` }, payload: { name: "Denied" } });
    expect(denied.statusCode).toBe(403);
    const updated = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Acme Labs" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ orgId: owner.org.id, name: "Acme Labs", role: "OWNER" });
  });

  it("updates site name and domain and reports evidence-based installation status", async () => {
    const owner = await signup(ctx.app, { email: "site-settings-owner@example.com" });
    const created = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Old name" } });
    const site = created.json();
    const updated = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Product", domain: "https://app.example.com" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Product", domain: "https://app.example.com" });

    const empty = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/status`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(empty.json()).toMatchObject({ hasReceivedEvents: false, lastEventAt: null, siteId: site.siteId });
    const eventTime = new Date("2026-09-25T10:00:00.000Z");
    await ctx.db.insert(sessionEvents).values({ siteId: site.id, sessionId: "session_1", type: "page_view", timestamp: eventTime });
    const active = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/status`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(active.json()).toMatchObject({ hasReceivedEvents: true, lastEventAt: eventTime.toISOString(), siteId: site.siteId, domain: "https://app.example.com" });
  });

  it("does not expose a site's status across organization boundaries", async () => {
    const owner = await signup(ctx.app, { email: "status-owner@example.com" });
    const stranger = await signup(ctx.app, { email: "status-stranger@example.com" });
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Private" } })).json();
    const response = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/status`, headers: { authorization: `Bearer ${stranger.accessToken}` } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "org_not_found" });
  });

  it("lets ADMIN+ delete a site and cascades its stored data", async () => {
    const owner = await signup(ctx.app, { email: "delete-site-owner@example.com" });
    const created = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Disposable site", domain: "https://delete.example.com" },
    });
    const site = created.json();
    await ctx.db.insert(sessionEvents).values({
      siteId: site.id,
      sessionId: "session_to_delete",
      type: "page_view",
      timestamp: new Date(),
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/orgs/${owner.org.id}/sites/${site.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(response.statusCode).toBe(204);
    expect(await ctx.db.select().from(sites).where(eq(sites.id, site.id))).toHaveLength(0);
    expect(await ctx.db.select().from(sessionEvents).where(eq(sessionEvents.siteId, site.id))).toHaveLength(0);
  });

  it("does not let a MEMBER delete a site", async () => {
    const owner = await signup(ctx.app, { email: "delete-site-owner-two@example.com" });
    const member = await signup(ctx.app, { email: "delete-site-member@example.com" });
    await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: member.user.email, role: "MEMBER" },
    });
    const site = (await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Protected site" },
    })).json();

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/orgs/${owner.org.id}/sites/${site.id}`,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(response.statusCode).toBe(403);
  });
});
