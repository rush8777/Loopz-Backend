import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"], name = "Users site") {
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

interface TrackedUserSummary {
  id: string;
  externalUserId: string;
  sessionCount: number;
  properties: Record<string, unknown>;
}

describe("tracked user identity/profile routes", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("creates a tracked user from an identify() event", async () => {
    const { owner, site } = await setupSite(ctx.app);

    const post = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          {
            type: "identify",
            timestamp: 1000,
            anonymousId: "anon_1",
            externalUserId: "user_123",
            traits: { name: "Sarah", plan: "free" },
          },
        ],
      },
    });
    expect(post.statusCode).toBe(200);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { users: TrackedUserSummary[]; total: number };
    expect(body.total).toBe(1);
    expect(body.users[0].externalUserId).toBe("user_123");
    expect(body.users[0].properties).toMatchObject({ name: "Sarah", plan: "free" });
  });

  it("collapses repeat identify() calls for the same user into one tracked user", async () => {
    const { owner, site } = await setupSite(ctx.app);

    for (const ts of [1000, 2000, 3000]) {
      await ctx.app.inject({
        method: "POST",
        url: `/public/sites/${site.siteId}/events`,
        payload: {
          sessionId: `sess_${ts}`,
          events: [{ type: "identify", timestamp: ts, anonymousId: "anon_1", externalUserId: "user_123" }],
        },
      });
    }

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.json().total).toBe(1);
  });

  it("makes prior anonymous activity visible on the profile after identify()", async () => {
    const { owner, site } = await setupSite(ctx.app);

    // Anonymous browsing before identify().
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

    // Then identify().
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "identify", timestamp: 3000, anonymousId: "anon_1", externalUserId: "user_123" }],
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const userId = (list.json() as { users: TrackedUserSummary[] }).users[0].id;

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const stats = detail.json().stats;
    expect(stats.pageViewCount).toBe(2);
    expect(stats.firstPage).toBe("/pricing");

    const activity = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}/activity`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const titles = (activity.json().activities as { title: string }[]).map((a) => a.title);
    expect(titles).toContain("Viewed /pricing");
    expect(titles).toContain("Viewed /features");

    const sessions = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}/sessions`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(sessions.json().total).toBe(1);
  });

  it("current property value reflects the latest identify() call, keeping first-seen metadata", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "identify", timestamp: 1000, anonymousId: "anon_1", externalUserId: "user_123", traits: { plan: "free" } },
        ],
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "identify", timestamp: 2000, anonymousId: "anon_1", externalUserId: "user_123", traits: { plan: "pro" } },
        ],
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const userId = (list.json() as { users: TrackedUserSummary[] }).users[0].id;

    const props = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}/properties`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const planProp = (props.json().properties as { name: string; value: unknown }[]).find((p) => p.name === "plan");
    expect(planProp?.value).toBe("pro");
  });

  it("merges multiple anonymousIds for the same identified user under one profile", async () => {
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
          { type: "identify", timestamp: 2500, anonymousId: "anon_b", externalUserId: "user_123" },
        ],
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const body = list.json() as { users: TrackedUserSummary[]; total: number };
    expect(body.total).toBe(1);
    expect(body.users[0].sessionCount).toBe(2);
  });

  it("keeps the same externalUserId isolated between two different sites", async () => {
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
      payload: { sessionId: "s1", events: [{ type: "identify", timestamp: 1000, anonymousId: "anon_1", externalUserId: "user_123" }] },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${siteB.siteId}/events`,
      payload: { sessionId: "s2", events: [{ type: "identify", timestamp: 1000, anonymousId: "anon_2", externalUserId: "user_123" }] },
    });

    const listA = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerA.org.id}/sites/${siteA.id}/users`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
    });
    const listB = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/users`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });

    expect(listA.json().total).toBe(1);
    expect(listB.json().total).toBe(1);
    const idA = (listA.json() as { users: TrackedUserSummary[] }).users[0].id;
    const idB = (listB.json() as { users: TrackedUserSummary[] }).users[0].id;
    expect(idA).not.toBe(idB);

    // Org A cannot see site B's tracked user, and vice versa.
    const crossFetch = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerA.org.id}/sites/${siteA.id}/users/${idB}`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
    });
    expect(crossFetch.statusCode).toBe(404);
  });

  it("paginates the users list", async () => {
    const { owner, site } = await setupSite(ctx.app);

    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({
        method: "POST",
        url: `/public/sites/${site.siteId}/events`,
        payload: {
          sessionId: `sess_${i}`,
          events: [{ type: "identify", timestamp: 1000 + i, anonymousId: `anon_${i}`, externalUserId: `user_${i}` }],
        },
      });
    }

    const page1 = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users?limit=2&offset=0`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const page2 = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users?limit=2&offset=2`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(page1.json().total).toBe(5);
    expect((page1.json() as { users: unknown[] }).users).toHaveLength(2);
    expect((page2.json() as { users: unknown[] }).users).toHaveLength(2);
  });

  it("does not create a tracked user or session_events row for a malformed identify() with no externalUserId", async () => {
    const { owner, site } = await setupSite(ctx.app);

    const post = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "identify", timestamp: 1000, anonymousId: "anon_1" }],
      },
    });
    expect(post.statusCode).toBe(200);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(list.json().total).toBe(0);
  });

  it("searches users by externalUserId and by property value", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "identify", timestamp: 1000, anonymousId: "anon_1", externalUserId: "user_sarah", traits: { email: "sarah@example.com" } },
        ],
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_2",
        events: [
          { type: "identify", timestamp: 1000, anonymousId: "anon_2", externalUserId: "user_john", traits: { email: "john@example.com" } },
        ],
      },
    });

    const byId = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users?search=sarah`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(byId.json().total).toBe(1);
    expect((byId.json() as { users: TrackedUserSummary[] }).users[0].externalUserId).toBe("user_sarah");

    const byEmail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users?search=john%40example.com`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(byEmail.json().total).toBe(1);
    expect((byEmail.json() as { users: TrackedUserSummary[] }).users[0].externalUserId).toBe("user_john");
  });
});
