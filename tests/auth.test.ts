import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, signup } from "./helpers.js";

describe("auth flows", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("signup creates a user, an org, and an OWNER membership", async () => {
    const body = await signup(ctx.app, { email: "owner@example.com" });
    expect(body.user.email).toBe("owner@example.com");
    expect(body.org.name).toBe("Test Org");
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();

    const me = await ctx.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    const meBody = me.json();
    expect(meBody.memberships).toEqual([{ orgId: body.org.id, role: "OWNER" }]);
  });

  it("rejects duplicate signup emails", async () => {
    await signup(ctx.app, { email: "dupe@example.com" });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "dupe@example.com", password: "correct-horse-battery-staple", orgName: "Other" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects a weak password", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "weak@example.com", password: "short", orgName: "Org" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("logs in with correct credentials and rejects wrong ones", async () => {
    await signup(ctx.app, { email: "login@example.com", password: "correct-horse-battery-staple" });

    const good = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "login@example.com", password: "correct-horse-battery-staple" },
    });
    expect(good.statusCode).toBe(200);

    const bad = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "login@example.com", password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);

    const unknown = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@example.com", password: "whatever12345" },
    });
    // Same status/shape as a wrong password - must not leak which emails exist.
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(bad.json());
  });

  it("rejects requests with no token, and with a garbage token", async () => {
    const noAuth = await ctx.app.inject({ method: "GET", url: "/auth/me" });
    expect(noAuth.statusCode).toBe(401);

    const badAuth = await ctx.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(badAuth.statusCode).toBe(401);
  });

  it("refresh rotates the token and invalidates the old refresh token", async () => {
    const body = await signup(ctx.app, { email: "refresh@example.com" });

    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: body.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const newTokens = refreshed.json();
    expect(newTokens.accessToken).toBeTruthy();
    expect(newTokens.refreshToken).not.toBe(body.refreshToken);

    // Reusing the now-rotated-away refresh token must fail.
    const reused = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: body.refreshToken },
    });
    expect(reused.statusCode).toBe(401);
  });

  it("logout revokes the refresh token", async () => {
    const body = await signup(ctx.app, { email: "logout@example.com" });

    const logout = await ctx.app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken: body.refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: body.refreshToken },
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});
