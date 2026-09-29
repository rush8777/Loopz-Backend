import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "../src/config.js";
import { memberships, organizations, refreshTokens, userAuthIdentities, users } from "../src/db/schema.js";
import type { VerifyGoogleCredential } from "../src/lib/google-auth.js";
import { createTestApp, signup } from "./helpers.js";

const identities: Record<string, { subject: string; email: string; name?: string }> = {
  alice: { subject: "google-alice", email: " Alice@Example.com ", name: "Alice" },
  new: { subject: "google-new", email: "new@example.com", name: "New Person" },
  race: { subject: "google-race", email: "race@example.com", name: "Race Person" },
};

const verifyGoogleCredential: VerifyGoogleCredential = vi.fn(async (credential, audience) => {
  if (audience !== "test-google-client-id" || credential.startsWith("invalid") || !identities[credential]) {
    throw new Error("verification rejected");
  }
  return identities[credential];
});

describe("Google authentication", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    env.GOOGLE_CLIENT_ID = "test-google-client-id";
    ctx = await createTestApp({ verifyGoogleCredential });
  });
  afterEach(() => ctx.cleanup());

  it("links an existing password user by verified normalized email without duplicating the user or org", async () => {
    const passwordSignup = await signup(ctx.app, { email: "alice@example.com", password: "correct-horse-battery-staple" });
    const google = await ctx.app.inject({ method: "POST", url: "/auth/google", payload: { credential: "alice" } });
    expect(google.statusCode).toBe(200);
    expect(google.json().user.id).toBe(passwordSignup.user.id);
    expect((await ctx.db.select().from(users))).toHaveLength(1);
    expect((await ctx.db.select().from(organizations))).toHaveLength(1);
    expect((await ctx.db.select().from(userAuthIdentities))).toHaveLength(1);

    const passwordLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "alice@example.com", password: "correct-horse-battery-staple" },
    });
    expect(passwordLogin.statusCode).toBe(200);
  });

  it("uses the normal me, refresh rotation, and logout flows for a linked Google user", async () => {
    await signup(ctx.app, { email: "alice@example.com" });
    const auth = await ctx.app.inject({ method: "POST", url: "/auth/google", payload: { credential: "alice" } });
    const session = auth.json();
    const me = await ctx.app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${session.accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("alice@example.com");

    const refreshed = await ctx.app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: session.refreshToken } });
    expect(refreshed.statusCode).toBe(200);
    const rotated = refreshed.json();
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
    expect((await ctx.db.select().from(refreshTokens)).length).toBeGreaterThanOrEqual(3);

    expect((await ctx.app.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken: rotated.refreshToken } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: rotated.refreshToken } })).statusCode).toBe(401);
  });

  it("requires explicit signup before writing any records for a new identity", async () => {
    const response = await ctx.app.inject({ method: "POST", url: "/auth/google", payload: { credential: "new" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "google_signup_required" });
    expect(await ctx.db.select().from(users)).toHaveLength(0);
    expect(await ctx.db.select().from(userAuthIdentities)).toHaveLength(0);
    expect(await ctx.db.select().from(organizations)).toHaveLength(0);
    expect(await ctx.db.select().from(memberships)).toHaveLength(0);
  });

  it("atomically creates a Google-only user, identity, organization, OWNER membership, and session", async () => {
    const response = await ctx.app.inject({ method: "POST", url: "/auth/google", payload: { credential: "new", orgName: "Google Org" } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ user: { email: "new@example.com", name: "New Person" }, org: { name: "Google Org" } });
    expect(response.json().accessToken).toBeTruthy();
    expect(response.json().refreshToken).toBeTruthy();

    const [user] = await ctx.db.select().from(users).where(eq(users.email, "new@example.com"));
    expect(user.passwordHash).toBeNull();
    expect(await ctx.db.select().from(userAuthIdentities)).toHaveLength(1);
    expect((await ctx.db.select().from(memberships))[0].role).toBe("OWNER");

    const passwordAttempt = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { email: "new@example.com", password: "some-password" } });
    expect(passwordAttempt.statusCode).toBe(401);
    expect(passwordAttempt.json()).toEqual({ error: "invalid_credentials" });
  });

  it("reuses the provider subject and cannot create duplicate users under concurrent requests", async () => {
    const [first, second] = await Promise.all([
      ctx.app.inject({ method: "POST", url: "/auth/google", payload: { credential: "race", orgName: "First Org" } }),
      ctx.app.inject({ method: "POST", url: "/auth/google", payload: { credential: "race", orgName: "Second Org" } }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    expect(first.json().user.id).toBe(second.json().user.id);
    expect(await ctx.db.select().from(users)).toHaveLength(1);
    expect(await ctx.db.select().from(userAuthIdentities)).toHaveLength(1);
    expect(await ctx.db.select().from(organizations)).toHaveLength(1);
  });

  it.each(["invalid-signature", "invalid-audience", "invalid-unverified-email", "invalid-missing-claims"])(
    "returns a generic authentication error when verification rejects %s",
    async (credential) => {
      const response = await ctx.app.inject({ method: "POST", url: "/auth/google", payload: { credential } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid_google_credential" });
    },
  );

  it("handles missing server configuration without breaking app startup", async () => {
    env.GOOGLE_CLIENT_ID = undefined;
    const response = await ctx.app.inject({ method: "POST", url: "/auth/google", payload: { credential: "alice" } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "google_auth_not_configured" });
  });
});
