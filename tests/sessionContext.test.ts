import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"], name = "Env site") {
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

const CHROME_WINDOWS_ENV = {
  browserName: "Chrome",
  browserVersion: "128.0.0.0",
  osName: "Windows",
  osVersion: "10.0",
  deviceType: "desktop" as const,
  language: "en-US",
  timezone: "America/New_York",
  screenWidth: 1920,
  screenHeight: 1080,
  referrer: "https://google.com/",
};

describe("session_start ingestion / environment context", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("does not write a session_events row for session_start", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "session_start", timestamp: 1000, anonymousId: "anon_1", ...CHROME_WINDOWS_ENV },
          { type: "page_view", timestamp: 1001, anonymousId: "anon_1", path: "/pricing" },
        ],
      },
    });

    const profile = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users/anon_1`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    // eventCount should reflect only the real interaction event (page_view), not session_start.
    expect(profile.json().stats.eventCount).toBe(1);
  });

  it("surfaces environment context on an anonymous visitor's profile", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "session_start", timestamp: 1000, anonymousId: "anon_1", ...CHROME_WINDOWS_ENV },
          { type: "page_view", timestamp: 1001, anonymousId: "anon_1", path: "/pricing" },
        ],
      },
    });

    const profile = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users/anon_1`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const body = profile.json();
    expect(body.environment).toMatchObject({
      browserName: "Chrome",
      osName: "Windows",
      deviceType: "desktop",
      language: "en-US",
      timezone: "America/New_York",
      screenWidth: 1920,
      screenHeight: 1080,
      referrer: "https://google.com/",
    });
  });

  it("carries environment context over to the identified profile after identify()", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "session_start", timestamp: 1000, anonymousId: "anon_1", ...CHROME_WINDOWS_ENV },
          { type: "identify", timestamp: 1500, anonymousId: "anon_1", externalUserId: "user_123" },
        ],
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const userId = list.json().users[0].id;

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(detail.json().environment).toMatchObject({ browserName: "Chrome", osName: "Windows" });
  });

  it("reflects the most recent session's environment when a user has multiple sessions on different devices", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_desktop",
        events: [
          { type: "session_start", timestamp: 1000, anonymousId: "anon_1", ...CHROME_WINDOWS_ENV },
          { type: "identify", timestamp: 1500, anonymousId: "anon_1", externalUserId: "user_123" },
        ],
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_mobile",
        events: [
          {
            type: "session_start",
            timestamp: 5000,
            anonymousId: "anon_2",
            browserName: "Safari",
            osName: "iOS",
            deviceType: "mobile",
          },
          { type: "identify", timestamp: 5500, anonymousId: "anon_2", externalUserId: "user_123" },
        ],
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const userId = list.json().users[0].id;

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    // The later (mobile) session_start should win.
    expect(detail.json().environment).toMatchObject({ browserName: "Safari", osName: "iOS", deviceType: "mobile" });
  });

  it("upserts rather than duplicating on a repeated session_start for the same session", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "session_start", timestamp: 1000, anonymousId: "anon_1", ...CHROME_WINDOWS_ENV }],
      },
    });
    // Retry of the same batch (e.g. a network retry) - same sessionId.
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "session_start", timestamp: 1000, anonymousId: "anon_1", ...CHROME_WINDOWS_ENV }],
      },
    });

    const profile = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users/anon_1`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(profile.json().environment.browserName).toBe("Chrome");
  });

  it("returns null environment for a visitor who has never sent a session_start (e.g. an older SDK build)", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "page_view", timestamp: 1000, anonymousId: "anon_1", path: "/pricing" }],
      },
    });

    const profile = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/anonymous-users/anon_1`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(profile.json().environment).toBeNull();
  });

  it("includes device/browser on each session row for a tracked user", async () => {
    const { owner, site } = await setupSite(ctx.app);

    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [
          { type: "session_start", timestamp: 1000, anonymousId: "anon_1", ...CHROME_WINDOWS_ENV },
          { type: "identify", timestamp: 1500, anonymousId: "anon_1", externalUserId: "user_123" },
        ],
      },
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const userId = list.json().users[0].id;

    const sessions = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/users/${userId}/sessions`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(sessions.json().sessions[0]).toMatchObject({
      sessionId: "sess_1",
      browserName: "Chrome",
      osName: "Windows",
      deviceType: "desktop",
    });
  });

  it("keeps site isolation for session context, same as everything else", async () => {
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
      payload: {
        sessionId: "s1",
        events: [{ type: "session_start", timestamp: 1000, anonymousId: "anon_shared", ...CHROME_WINDOWS_ENV }],
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${siteB.siteId}/events`,
      payload: {
        sessionId: "s2",
        events: [{ type: "session_start", timestamp: 1000, anonymousId: "anon_shared", browserName: "Firefox", osName: "Linux" }],
      },
    });

    const profileA = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerA.org.id}/sites/${siteA.id}/anonymous-users/anon_shared`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
    });
    const profileB = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${ownerB.org.id}/sites/${siteB.id}/anonymous-users/anon_shared`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });

    expect(profileA.json().environment.browserName).toBe("Chrome");
    expect(profileB.json().environment.browserName).toBe("Firefox");
  });

  it("ignores a session_start with no anonymousId rather than throwing", async () => {
    const { site } = await setupSite(ctx.app);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_1",
        events: [{ type: "session_start", timestamp: 1000, ...CHROME_WINDOWS_ENV }],
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
