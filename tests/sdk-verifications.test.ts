import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sdkVerificationChallenges, sessionEvents } from "../src/db/schema.js";
import { createTestApp, signup } from "./helpers.js";

describe("live SDK verification", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(() => ctx.cleanup());

  async function setupSite(email: string, domain = "https://app.example.com") {
    const owner = await signup(ctx.app, { email });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Product", domain },
    });
    return { owner, site: response.json() as { id: string; siteId: string; domain: string } };
  }

  async function createChallenge(owner: Awaited<ReturnType<typeof signup>>, siteId: string) {
    return ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites/${siteId}/sdk-verifications`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
  }

  it("creates a challenge, exposes it to the active SDK, acknowledges it, and polls connected", async () => {
    const { owner, site } = await setupSite("sdk-connected@example.com");
    const created = await createChallenge(owner, site.id);
    expect(created.statusCode).toBe(201);
    expect(created.json().verification).toMatchObject({ status: "pending", detectedAt: null });
    const verificationId = created.json().verification.id as string;

    const config = await ctx.app.inject({ method: "GET", url: `/public/config/${site.siteId}` });
    expect(config.statusCode).toBe(200);
    expect(config.headers["cache-control"]).toBe("no-store");
    expect(config.json().sdkVerification).toMatchObject({ id: verificationId });

    const acknowledged = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/sdk-verifications/${verificationId}/ack`,
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().verification).toMatchObject({ id: verificationId, status: "connected" });

    const polled = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sdk-verifications/${verificationId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().verification).toMatchObject({ id: verificationId, status: "connected" });
    expect(polled.json().verification.detectedAt).toBeTruthy();
  });

  it("does not let a different site acknowledge a challenge", async () => {
    const first = await setupSite("sdk-site-one@example.com");
    const secondSiteResponse = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${first.owner.org.id}/sites`,
      headers: { authorization: `Bearer ${first.owner.accessToken}` },
      payload: { name: "Other product", domain: "https://other.example.com" },
    });
    const secondSite = secondSiteResponse.json() as { siteId: string };
    const created = await createChallenge(first.owner, first.site.id);
    const verificationId = created.json().verification.id as string;

    const response = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${secondSite.siteId}/sdk-verifications/${verificationId}/ack`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "verification_not_found" });
  });

  it("rejects an expired challenge and reports it as expired when polled", async () => {
    const { owner, site } = await setupSite("sdk-expired@example.com");
    const created = await createChallenge(owner, site.id);
    const verificationId = created.json().verification.id as string;
    await ctx.db
      .update(sdkVerificationChallenges)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(sdkVerificationChallenges.id, verificationId));

    const acknowledged = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/sdk-verifications/${verificationId}/ack`,
    });
    expect(acknowledged.statusCode).toBe(410);
    expect(acknowledged.json()).toEqual({ error: "verification_expired" });

    const polled = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/sdk-verifications/${verificationId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(polled.json().verification).toMatchObject({ status: "expired", detectedAt: null });
  });

  it("keeps historical last-event status independent from live verification", async () => {
    const { owner, site } = await setupSite("sdk-history@example.com");
    const eventTime = new Date("2026-09-25T10:00:00.000Z");
    await ctx.db.insert(sessionEvents).values({
      siteId: site.id,
      sessionId: "historical-session",
      type: "page_view",
      timestamp: eventTime,
    });
    await createChallenge(owner, site.id);

    const status = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/sites/${site.id}/status`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(status.json()).toMatchObject({
      hasReceivedEvents: true,
      lastEventAt: eventTime.toISOString(),
      siteId: site.siteId,
      domain: "https://app.example.com",
    });
  });
});
