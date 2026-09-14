import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";

async function setup(app: Awaited<ReturnType<typeof createTestApp>>["app"]) { const owner = await signup(app); const site = (await app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Analytics site" } })).json(); return { owner, site }; }
async function track(app: Awaited<ReturnType<typeof createTestApp>>["app"], publicId: string, anonymousId: string, events: unknown[]) { await app.inject({ method: "POST", url: `/public/sites/${publicId}/events`, payload: { sessionId: `s_${anonymousId}`, events } }); }
function filters(days = 3) { return { since: new Date(Date.now() - days * 86_400_000).toISOString(), until: new Date().toISOString(), granularity: "day", excludedEventNames: [] }; }

describe("dashboard analytics", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>; beforeEach(async () => { ctx = await createTestApp(); }); afterEach(() => { try { ctx.cleanup(); } catch { /* better-sqlite keeps the Windows handle until process exit */ } });
  it("zero-fills buckets and merges anonymous activity into its identified user", async () => {
    const { owner, site } = await setup(ctx.app), at = Date.now() - 86_400_000;
    await track(ctx.app, site.siteId, "merge", [{ type: "custom", timestamp: at, name: "used", anonymousId: "merge" }]);
    await track(ctx.app, site.siteId, "merge", [{ type: "identify", timestamp: at + 1, anonymousId: "merge", externalUserId: "person", traits: {} }, { type: "custom", timestamp: at + 2, name: "used", anonymousId: "merge" }]);
    const response = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/analytics/query`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { filters: filters(), query: { schemaVersion: 1, kind: "metric", metricId: "users.unique", events: { eventNames: ["used"], match: "any" }, mode: "trend", visualization: "line" } } });
    expect(response.statusCode).toBe(200); const body = response.json(); expect(body.result.buckets).toHaveLength(4); expect(Math.max(...body.result.buckets.map((b: { values: { value: number } }) => b.values.value))).toBe(1);
  });
  it("implements Each, Any, and All event-set semantics", async () => {
    const { owner, site } = await setup(ctx.app), at = Date.now() - 1000;
    await track(ctx.app, site.siteId, "one", [{ type: "custom", timestamp: at, name: "a", anonymousId: "one" }, { type: "custom", timestamp: at + 1, name: "b", anonymousId: "one" }]);
    await track(ctx.app, site.siteId, "two", [{ type: "custom", timestamp: at, name: "a", anonymousId: "two" }]);
    const query = async (match: string) => (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/analytics/query`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { filters: filters(), query: { schemaVersion: 1, kind: "metric", metricId: "users.unique", events: { eventNames: ["a", "b"], match }, mode: "single", visualization: "total" } } })).json();
    expect((await query("any")).result.values[0].value).toBe(2); expect((await query("all")).result.values[0].value).toBe(1); const each = await query("each"); expect(each.result.values.map((v: { value: number }) => v.value)).toEqual([2, 1]);
  });
  it("computes non-running retention and rejects invalid combinations and oversized batches", async () => {
    const { owner, site } = await setup(ctx.app), d2 = Date.now() - 2 * 86_400_000, d1 = Date.now() - 86_400_000;
    await track(ctx.app, site.siteId, "retained", [{ type: "custom", timestamp: d2, name: "start", anonymousId: "retained" }, { type: "custom", timestamp: d1, name: "return", anonymousId: "retained" }]);
    const retention = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/analytics/query`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { filters: filters(), query: { schemaVersion: 1, kind: "retention", startEvent: { type: "event", eventName: "start" }, returnEvent: { type: "event", eventName: "return" }, cohort: { type: "start_date" }, visualization: "grid" } } });
    expect(retention.statusCode).toBe(200); expect(retention.json().result.rows[0].cells[1].percentage).toBe(100);
    const invalid = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/analytics/query`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { filters: filters(), query: { schemaVersion: 1, kind: "metric", metricId: "events.occurrences", events: { eventNames: ["a", "b"], match: "all" }, mode: "single", visualization: "total" } } }); expect(invalid.statusCode).toBe(400);
    const oversized = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/analytics/query/batch`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { filters: filters(), queries: Array.from({ length: 25 }, (_, i) => ({ requestId: String(i), query: { schemaVersion: 1, kind: "metric", metricId: "users.unique", mode: "single", visualization: "total" } })) } }); expect(oversized.statusCode).toBe(400);
  });
});
