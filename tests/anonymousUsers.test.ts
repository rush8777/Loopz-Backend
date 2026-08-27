import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"], name = "Anon site") {
  const owner = await signup(app);
  const site = (
    await app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name },
    })
  ).json();
  return { owner, site };
}

interface AnonymousVisitorSummary {
  anonymousId: string;
  sessionCount: number;
  isAnonymous: boolean;
}

describe("anonymous visitor routes", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("an unidentified visitor exists as an anonymous identity as soon as it has activity", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "page_view", timestamp: 1000, anonymousId: "anon_1", path: "/pricing" }],
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const body = list.json() as { visitors: AnonymousVisitorSummary[]; total: number };
    expect(body.total).toBe(1);
    expect(body.visitors[0].anonymousId).toBe("anon_1");
    expect(body.visitors[0].isAnonymous).toBe(true);

    // Never appears in the identified users list.
    const identified = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(identified.json().total).toBe(0);
  });

  it("exposes activity and sessions for an anonymous visitor", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "page_view", timestamp: 1000, anonymousId: "anon_1", path: "/pricing" },
          { type: "page_view", timestamp: 2000, anonymousId: "anon_1", path: "/features" },
        ],
      },
    });

    const profile = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users/anon_1`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(profile.statusCode).toBe(200);
    const body = profile.json();
    expect(body.identityType).toBe("anonymous");
    expect(body.stats.pageViewCount).toBe(2);
    expect(body.stats.firstPage).toBe("/pricing");

    const activity = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users/anon_1/activity`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const titles = (activity.json().activities as { title: string }[]).map((a) => a.title);
    expect(titles).toContain("Viewed /pricing");
    expect(titles).toContain("Viewed /features");

    const sessions = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users/anon_1/sessions`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(sessions.json().total).toBe(1);
  });

  it("404s for an anonymousId that has never been seen on the site", async () => {
    const { owner, site } = await setupSite(ctx.app);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users/never_seen`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("resolves an anonymous visitor to the identified user on identify(), carrying historical activity over", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "page_view", timestamp: 1000, anonymousId: "anon_1", path: "/pricing" },
          { type: "page_view", timestamp: 2000, anonymousId: "anon_1", path: "/features" },
        ],
      },
    });

    // Still anonymous before identify().
    const beforeList = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(beforeList.json().total).toBe(1);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "identify", timestamp: 3000, anonymousId: "anon_1", externalUserId: "user_123" }],
      },
    });

    // No longer listed as an independent anonymous identity.
    const afterList = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(afterList.json().total).toBe(0);

    // Its detail endpoint now points at the identified user instead of rendering a standalone profile.
    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users/anon_1`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(detail.json().identityType).toBe("identified");
    expect(detail.json().resolvedTo.externalUserId).toBe("user_123");

    // Historical anonymous activity is visible from the identified profile.
    const identifiedList = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const userId = identifiedList.json().users[0].id;

    const userDetail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(userDetail.json().stats.pageViewCount).toBe(2);
    expect(userDetail.json().anonymousIds).toEqual(["anon_1"]);

    const activity = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}/activity`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const titles = (activity.json().activities as { title: string }[]).map((a) => a.title);
    expect(titles).toContain("Viewed /pricing");
  });

  it("associates multiple anonymousIds with one identified user, without double counting sessions", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_a",
        events: [
          { type: "page_view", timestamp: 1000, anonymousId: "anon_a", path: "/a" },
          { type: "identify", timestamp: 1500, anonymousId: "anon_a", externalUserId: "user_123" },
        ],
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_b",
        events: [
          { type: "page_view", timestamp: 2000, anonymousId: "anon_b", path: "/b" },
          { type: "page_view", timestamp: 2100, anonymousId: "anon_b", path: "/b/2" },
          { type: "identify", timestamp: 2500, anonymousId: "anon_b", externalUserId: "user_123" },
        ],
      },
    });

    const identifiedList = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const body = identifiedList.json();
    expect(body.total).toBe(1);
    expect(body.users[0].anonymousIds.sort()).toEqual(["anon_a", "anon_b"]);
    // Two distinct sessions, one per anonymousId - no duplication.
    expect(body.users[0].sessionCount).toBe(2);

    const userDetail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${body.users[0].id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(userDetail.json().stats.sessionCount).toBe(2);
    expect(userDetail.json().stats.pageViewCount).toBe(3);
  });

  it("does not merge two anonymous visitors that were never identify()'d", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_a",
        events: [{ type: "page_view", timestamp: 1000, anonymousId: "anon_a", path: "/a" }],
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_b",
        events: [{ type: "page_view", timestamp: 2000, anonymousId: "anon_b", path: "/b" }],
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const body = list.json() as { visitors: AnonymousVisitorSummary[]; total: number };
    expect(body.total).toBe(2);
    expect(body.visitors.map((v) => v.anonymousId).sort()).toEqual(["anon_a", "anon_b"]);
  });

  it("resolving a session's session count does not change after identify() (no double counting)", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "page_view", timestamp: 1000, anonymousId: "anon_1", path: "/a" },
          { type: "page_view", timestamp: 2000, anonymousId: "anon_1", path: "/b" },
        ],
      },
    });

    const before = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users/anon_1`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(before.json().stats.sessionCount).toBe(1);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "identify", timestamp: 3000, anonymousId: "anon_1", externalUserId: "user_123" }],
      },
    });

    const identifiedList = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(identifiedList.json().users[0].sessionCount).toBe(1);
  });

  it("keeps the same anonymousId isolated between two different sites", async () => {
    const { owner: ownerA, site: siteA } = await setupSite(ctx.app, "Site A");
    const ownerB = await signup(ctx.app);
    const siteB = (
      await ctx.app.inject({
        method: "POST",
        url: `/orgs/${ownerB.org.id}/sites`,
        headers: { authorization: `Bearer ${ownerB.accessToken}` },
        payload: { name: "Site B" },
      })
    ).json();

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${siteA.siteId}/events`,
      payload: { sessionId: "s1", events: [{ type: "page_view", timestamp: 1000, anonymousId: "anon_shared", path: "/a" }] },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${siteB.siteId}/events`,
      payload: { sessionId: "s2", events: [{ type: "page_view", timestamp: 1000, anonymousId: "anon_shared", path: "/b" }] },
    });

    const listA = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerA.org.id}/sites/${siteA.id}/anonymous-users`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
    });
    expect(listA.json().total).toBe(1);

    // Site B's owner cannot see site A's anonymous visitor via cross-site access.
    const crossFetch = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/anonymous-users/anon_shared`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(crossFetch.statusCode).toBe(200); // exists on site B too, independently
    expect(crossFetch.json().stats.firstPage).toBe("/b");
  });

  it("searches anonymous visitors by anonymousId", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "s1", events: [{ type: "page_view", timestamp: 1000, anonymousId: "anon_alpha", path: "/a" }] },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "s2", events: [{ type: "page_view", timestamp: 1000, anonymousId: "anon_beta", path: "/b" }] },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users?search=alpha`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.json().total).toBe(1);
    expect(res.json().visitors[0].anonymousId).toBe("anon_alpha");
  });
});
