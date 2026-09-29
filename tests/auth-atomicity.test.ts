import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memberships, organizations, refreshTokens, userAuthIdentities, users } from "../src/db/schema.js";
import { createTestApp, signup } from "./helpers.js";
import { env } from "../src/config.js";

describe("authentication transaction atomicity", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const originalGoogleClientId = env.GOOGLE_CLIENT_ID;
  beforeEach(async () => {
    env.GOOGLE_CLIENT_ID = "test-client-id";
    ctx = await createTestApp({ verifyGoogleCredential: async () => ({ subject: "atomic-sub", email: "google-atomic@example.com", name: "Atomic" }) });
  });
  afterEach(() => { env.GOOGLE_CLIENT_ID = originalGoogleClientId; ctx.cleanup(); });

  it("does not retain a partial password signup when organization creation fails", async () => {
    await ctx.db.run(sql.raw("CREATE TRIGGER fail_signup_org BEFORE INSERT ON organizations BEGIN SELECT RAISE(ABORT, 'forced org failure'); END"));
    const response = await ctx.app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "atomic@example.com", password: "correct-horse-battery-staple", orgName: "Atomic" },
    });
    expect(response.statusCode).toBe(500);
    expect(await ctx.db.select().from(users)).toHaveLength(0);
    expect(await ctx.db.select().from(organizations)).toHaveLength(0);
    expect(await ctx.db.select().from(memberships)).toHaveLength(0);
    expect(await ctx.db.select().from(refreshTokens)).toHaveLength(0);
  });

  it("keeps the previous refresh token active when replacement creation fails", async () => {
    const account = await signup(ctx.app);
    const [oldToken] = await ctx.db.select().from(refreshTokens);
    await ctx.db.run(sql.raw("CREATE TRIGGER fail_refresh_replacement BEFORE INSERT ON refresh_tokens BEGIN SELECT RAISE(ABORT, 'forced refresh failure'); END"));
    const response = await ctx.app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: account.refreshToken } });
    expect(response.statusCode).toBe(500);
    const [after] = await ctx.db.select().from(refreshTokens).where(eq(refreshTokens.id, oldToken.id));
    expect(after.revokedAt).toBeNull();
    expect(await ctx.db.select().from(refreshTokens)).toHaveLength(1);
  });

  it("does not retain any Google signup rows when workspace creation fails", async () => {
    await ctx.db.run(sql.raw("CREATE TRIGGER fail_google_org BEFORE INSERT ON organizations BEGIN SELECT RAISE(ABORT, 'forced org failure'); END"));
    const response = await ctx.app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { credential: "valid", orgName: "Google Atomic" },
    });
    expect(response.statusCode).toBe(500);
    expect(await ctx.db.select().from(users)).toHaveLength(0);
    expect(await ctx.db.select().from(userAuthIdentities)).toHaveLength(0);
    expect(await ctx.db.select().from(organizations)).toHaveLength(0);
    expect(await ctx.db.select().from(memberships)).toHaveLength(0);
    expect(await ctx.db.select().from(refreshTokens)).toHaveLength(0);
  });
});
