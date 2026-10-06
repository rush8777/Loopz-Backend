import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestApp, signup } from "./helpers.js";
import { organizationSubscriptions } from "../src/db/schema.js";
import { syncPaddleSubscription } from "../src/routes/billing.js";

describe("plans and entitlements", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });

  async function setup(suffix: string) {
    const owner = await signup(ctx.app, { email: `plans-${suffix}@example.test` });
    const auth = { authorization: `Bearer ${owner.accessToken}` };
    const siteResponse = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: auth, payload: { name: "Product", domain: `https://${suffix}.example.test` } });
    expect(siteResponse.statusCode).toBe(201);
    return { owner, auth, site: siteResponse.json() };
  }

  async function setSubscription(orgId: string, values: { planId?: string; status?: string; trialEndsAt?: Date | null }) {
    await ctx.db.update(organizationSubscriptions).set({ ...values, updatedAt: new Date() }).where(eq(organizationSubscriptions.orgId, orgId));
  }

  it("starts every new organization on a fourteen-day full Growth trial", async () => {
    const { owner, auth } = await setup("trial");
    const response = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/plan-usage`, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      subscription: { planId: "growth", planName: "Growth", status: "trialing", active: true },
      limits: { monthlyActiveUsers: 15_000, site: 3, member: 10, published_experience: 25 },
    });
    const remaining = new Date(response.json().subscription.trialEndsAt).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(13 * 86_400_000);
    expect(remaining).toBeLessThanOrEqual(14 * 86_400_000);
  });

  it("enforces Starter site capacity without affecting reads", async () => {
    const { owner, auth } = await setup("site-limit");
    await setSubscription(owner.org.id, { planId: "starter", status: "active", trialEndsAt: null });
    const blocked = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: auth, payload: { name: "Second", domain: "https://second.example.test" } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: "resource_limit", entitlement: { resource: "site", current: 1, limit: 1 } });
    expect((await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites`, headers: auth })).statusCode).toBe(200);
  });

  it("enforces resource capacity across the organization rather than per site", async () => {
    const { owner, auth, site } = await setup("org-capacity");
    const second = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: auth, payload: { name: "Second", domain: "https://org-capacity-two.example.test" } });
    expect(second.statusCode).toBe(201);
    const siteIds = [site.id, site.id, second.json().id];
    for (const [index, siteId] of siteIds.entries()) {
      const created = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${siteId}/dashboards`, headers: auth, payload: { name: `Dashboard ${index + 1}` } });
      expect(created.statusCode).toBe(201);
    }
    await setSubscription(owner.org.id, { planId: "starter", status: "active", trialEndsAt: null });
    const blocked = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${second.json().id}/dashboards`, headers: auth, payload: { name: "One too many" } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: "resource_limit", entitlement: { resource: "dashboard", current: 3, limit: 3 } });
  });

  it("rejects newly introduced Growth controls on Starter but grandfathers an existing definition", async () => {
    const { owner, auth, site } = await setup("features");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: auth, payload: { kind: "widget", widgetType: "toast", name: "Triggered", buildUrl: "https://features.example.test", template: "blank", useBuildPageAsTarget: false } })).json();
    const advanced = structuredClone(created.draftVersion.definition);
    advanced.targeting.trigger = { type: "custom_event", eventName: "activated" };
    expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: auth, payload: { definition: advanced } })).statusCode).toBe(200);
    await setSubscription(owner.org.id, { planId: "starter", status: "active", trialEndsAt: null });
    const preserved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: auth, payload: { definition: advanced } });
    expect(preserved.statusCode).toBe(200);
    const newlyAdded = structuredClone(advanced); newlyAdded.targeting.schedule = { startsAt: new Date(Date.now() + 86_400_000).toISOString() };
    const blocked = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: auth, payload: { definition: newlyAdded } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: "feature_unavailable", entitlement: { feature: "experience_scheduling", planId: "starter" } });
  });

  it("makes an expired trial read-only and stops public experience delivery", async () => {
    const { owner, auth, site } = await setup("expired");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: auth, payload: { kind: "widget", widgetType: "toast", name: "Live", buildUrl: "https://expired.example.test", template: "blank", useBuildPageAsTarget: false } })).json();
    expect((await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: auth })).statusCode).toBe(200);
    await setSubscription(owner.org.id, { status: "trialing", trialEndsAt: new Date(Date.now() - 1_000) });
    const mutation = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}`, headers: auth, payload: { name: "Blocked" } });
    expect(mutation.statusCode).toBe(402);
    const delivery = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?url=${encodeURIComponent("https://expired.example.test/")}&anonymousId=anon&sessionId=session` });
    expect(delivery.statusCode).toBe(200);
    expect(delivery.json()).toMatchObject({ experiences: [], checklists: [] });
  });

  it("applies Paddle events idempotently and ignores older lifecycle events", async () => {
    const { owner } = await setup("paddle-sync");
    const payload = {
      id: "sub_01test", status: "active", customerId: "ctm_01test", updatedAt: "2026-10-04T00:00:00.000Z",
      customData: { movcuesOrgId: owner.org.id }, currentBillingPeriod: { startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-11-01T00:00:00.000Z" },
      scheduledChange: null, items: [{ price: { id: "price_growth" } }],
    };
    const resolve = (priceId: string | null | undefined) => priceId === "price_growth" ? "growth" as const : null;
    await syncPaddleSubscription(ctx.db, { eventId: "evt_new", eventType: "subscription.updated", occurredAt: new Date("2026-10-04T00:00:00.000Z"), subscription: payload }, resolve);
    await syncPaddleSubscription(ctx.db, { eventId: "evt_new", eventType: "subscription.updated", occurredAt: new Date("2026-10-04T00:00:00.000Z"), subscription: payload }, resolve);
    await syncPaddleSubscription(ctx.db, { eventId: "evt_old", eventType: "subscription.canceled", occurredAt: new Date("2026-10-03T00:00:00.000Z"), subscription: { ...payload, status: "canceled" } }, resolve);
    const [subscription] = await ctx.db.select().from(organizationSubscriptions).where(eq(organizationSubscriptions.orgId, owner.org.id));
    expect(subscription).toMatchObject({ planId: "growth", status: "active", paddleCustomerId: "ctm_01test", paddleSubscriptionId: "sub_01test", paddlePriceId: "price_growth" });
  });
});
