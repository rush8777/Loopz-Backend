import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setup(app: Awaited<ReturnType<typeof createTestApp>>["app"]) { const owner = await signup(app); const site = (await app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Dashboard site" } })).json(); return { owner, site }; }
const metric = { schemaVersion: 1, kind: "metric", metricId: "users.unique", mode: "trend", visualization: "line" };
function auth(token: string) { return { authorization: `Bearer ${token}` }; }

describe("dashboard persistence", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>; beforeEach(async () => { ctx = await createTestApp(); }); afterEach(() => { try { ctx.cleanup(); } catch { /* better-sqlite keeps the Windows handle until process exit */ } });
  it("creates, reads, reorders, and deletes a site-owned dashboard", async () => {
    const { owner, site } = await setup(ctx.app);
    const created = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/dashboards`, headers: auth(owner.accessToken), payload: { name: "Product", cards: [{ title: "Users", cardType: "metric", width: "small", configuration: metric }] } });
    expect(created.statusCode).toBe(201); const dashboard = created.json(); expect(dashboard.cards).toHaveLength(1); expect(dashboard.cards[0].position).toBe(0);
    const updated = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/dashboards/${dashboard.id}`, headers: auth(owner.accessToken), payload: { name: "Product health", cards: [{ ...dashboard.cards[0], width: "full" }, { title: "Copy", cardType: "metric", width: "medium", configuration: metric }] } });
    expect(updated.statusCode).toBe(200); expect(updated.json().cards.map((c: { position: number }) => c.position)).toEqual([0, 1]);
    expect((await ctx.app.inject({ method: "DELETE", url: `/orgs/${owner.org.id}/sites/${site.id}/dashboards/${dashboard.id}`, headers: auth(owner.accessToken) })).statusCode).toBe(204);
  });
  it("allows VIEWER reads but rejects mutations", async () => {
    const { owner, site } = await setup(ctx.app); const viewer = await signup(ctx.app);
    await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/members`, headers: auth(owner.accessToken), payload: { email: viewer.user.email, role: "VIEWER" } });
    expect((await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/dashboards`, headers: auth(viewer.accessToken) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/dashboards`, headers: auth(viewer.accessToken), payload: { name: "No" } })).statusCode).toBe(403);
  });
  it("does not expose another site's dashboard", async () => {
    const a = await setup(ctx.app), b = await setup(ctx.app); const dashboard = (await ctx.app.inject({ method: "POST", url: `/orgs/${a.owner.org.id}/sites/${a.site.id}/dashboards`, headers: auth(a.owner.accessToken), payload: { name: "Private" } })).json();
    expect((await ctx.app.inject({ method: "GET", url: `/orgs/${b.owner.org.id}/sites/${a.site.id}/dashboards/${dashboard.id}`, headers: auth(b.owner.accessToken) })).statusCode).toBe(404);
  });
});
