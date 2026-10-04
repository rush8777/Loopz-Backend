import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestApp, signup } from "./helpers.js";
import {
  dashboards,
  experienceVersions,
  funnels,
  memberships,
  organizationInvitations,
  segments,
  users,
} from "../src/db/schema.js";
import {
  getDashboardUsage,
  getFunnelUsage,
  getMemberUsage,
  getMonthlyActiveUsers,
  getPublishedExperienceUsage,
  getSegmentUsage,
  getSiteUsage,
} from "../src/lib/usage/usage.js";

const month = { year: 2026, month: 3 };
const march = Date.UTC(2026, 2, 10);

async function setup(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const owner = await signup(app);
  const site = (await app.inject({
    method: "POST",
    url: `/orgs/${owner.org.id}/sites`,
    headers: { authorization: `Bearer ${owner.accessToken}` },
    payload: { name: "Usage site", domain: "https://production.example.test" },
  })).json();
  return { owner, site };
}

async function identifyAfterActivity(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  siteId: string,
  anonymousId: string,
  externalUserId: string,
  timestamp = march,
  origin = "https://production.example.test",
  sessionId = `session-${anonymousId}`,
) {
  const response = await app.inject({
    method: "POST",
    url: `/public/sites/${siteId}/events`,
    headers: { origin },
    payload: {
      sessionId,
      events: [
        { type: "page_view", timestamp, anonymousId, path: "/pricing" },
        { type: "identify", timestamp: timestamp + 1, anonymousId, externalUserId },
      ],
    },
  });
  expect(response.statusCode).toBe(200);
}

describe("pricing usage foundations", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });

  it("counts an identified production user once across events, sessions, and anonymous-to-identified resolution", async () => {
    const { site } = await setup(ctx.app);
    await identifyAfterActivity(ctx.app, site.siteId, "anon-a", "customer-a");
    await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, headers: { origin: "https://production.example.test" }, payload: {
      sessionId: "session-second", events: [
        { type: "page_view", timestamp: march + 2, anonymousId: "anon-a", path: "/account" },
        { type: "custom", timestamp: march + 3, anonymousId: "anon-a", name: "saved" },
      ],
    } });
    expect(await getMonthlyActiveUsers(ctx.db, site.id, month)).toBe(1);
  });

  it("counts distinct identified users only in the requested month and only from the production origin", async () => {
    const { site } = await setup(ctx.app);
    await identifyAfterActivity(ctx.app, site.siteId, "anon-a", "customer-a", march);
    await identifyAfterActivity(ctx.app, site.siteId, "anon-b", "customer-b", march + 1_000);
    await identifyAfterActivity(ctx.app, site.siteId, "anon-old", "customer-old", Date.UTC(2026, 1, 28));
    await identifyAfterActivity(ctx.app, site.siteId, "anon-local", "customer-local", march + 2_000, "http://localhost:5173");
    // Editor mode does not initialize the normal SDK event pipeline; even if
    // analytics are sent from a non-production preview origin, it is retained
    // but not billable by the same origin rule.
    await identifyAfterActivity(ctx.app, site.siteId, "anon-preview", "customer-preview", march + 3_000, "https://preview.example.test");
    expect(await getMonthlyActiveUsers(ctx.db, site.id, month)).toBe(2);
  });

  it("counts memberships and only valid pending invitations", async () => {
    const { owner } = await setup(ctx.app);
    const now = new Date(march);
    const [member] = await ctx.db.insert(users).values({ email: "member@example.test" }).returning();
    await ctx.db.insert(memberships).values({ userId: member.id, orgId: owner.org.id, role: "MEMBER" });
    await ctx.db.insert(organizationInvitations).values([
      { orgId: owner.org.id, email: "pending@example.test", role: "MEMBER", tokenHash: "pending", invitedByUserId: owner.user.id, expiresAt: new Date(march + 10_000) },
      { orgId: owner.org.id, email: "expired@example.test", role: "MEMBER", tokenHash: "expired", invitedByUserId: owner.user.id, expiresAt: new Date(march - 10_000) },
      { orgId: owner.org.id, email: "revoked@example.test", role: "MEMBER", tokenHash: "revoked", invitedByUserId: owner.user.id, expiresAt: new Date(march + 10_000), revokedAt: now },
      { orgId: owner.org.id, email: "member@example.test", role: "MEMBER", tokenHash: "duplicate-member", invitedByUserId: owner.user.id, expiresAt: new Date(march + 10_000) },
      { orgId: owner.org.id, email: "accepted@example.test", role: "MEMBER", tokenHash: "accepted", invitedByUserId: owner.user.id, expiresAt: new Date(march + 10_000), acceptedAt: now },
    ]);
    // owner + active membership + one valid pending invitation
    expect(await getMemberUsage(ctx.db, owner.org.id, now)).toBe(3);
  });

  it("keeps all saved-resource counters scoped to their tenant site", async () => {
    const { owner, site } = await setup(ctx.app);
    await ctx.db.insert(dashboards).values({ siteId: site.id, name: "One", createdBy: owner.user.id });
    await ctx.db.insert(segments).values({ siteId: site.id, name: "One", definition: { logic: "all", conditions: [] } });
    await ctx.db.insert(funnels).values({ siteId: site.id, name: "One", steps: [] });
    expect(await getSiteUsage(ctx.db, owner.org.id)).toBe(1);
    expect(await getDashboardUsage(ctx.db, site.id)).toBe(1);
    expect(await getSegmentUsage(ctx.db, site.id)).toBe(1);
    expect(await getFunnelUsage(ctx.db, site.id)).toBe(1);
  });

  it("counts published and future-scheduled experiences but excludes paused, draft, expired, and invalid published pointers", async () => {
    const { owner, site } = await setup(ctx.app);
    const auth = { authorization: `Bearer ${owner.accessToken}` };
    const create = async (name: string) => (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: auth, payload: { kind: "widget", widgetType: "toast", name, buildUrl: "https://production.example.test", template: "blank", useBuildPageAsTarget: false } })).json();
    const current = await create("Current");
    const future = await create("Future");
    const expired = await create("Expired");
    const paused = await create("Paused");
    await Promise.all([current, future, expired, paused].map((experience) => ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${experience.id}/publish`, headers: auth })));
    await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${paused.id}/pause`, headers: auth });
    const setSchedule = async (experience: any, schedule: { startsAt?: string; endsAt?: string }) => {
      const published = (await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${experience.id}`, headers: auth })).json().publishedVersion;
      const definition = { ...published.definition, targeting: { ...published.definition.targeting, schedule } };
      await ctx.db.update(experienceVersions).set({ definition }).where(eq(experienceVersions.id, published.id));
    };
    await setSchedule(future, { startsAt: new Date(march + 100_000).toISOString() });
    await setSchedule(expired, { endsAt: new Date(march - 100_000).toISOString() });
    expect(await getPublishedExperienceUsage(ctx.db, site.id, new Date(march))).toBe(2);
  });
});
