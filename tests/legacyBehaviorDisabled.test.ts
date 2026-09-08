import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";

describe("retired Behavioral Intelligence HTTP surface", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => {
    await ctx.app.close();
    (ctx.db as unknown as { $client: { close(): void } }).$client.close();
    ctx.cleanup();
  });

  it("does not register pattern, analysis, or observer routes", async () => {
    const owner = await signup(ctx.app);
    const site = (await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Retired behavior site" },
    })).json();
    const headers = { authorization: `Bearer ${owner.accessToken}` };

    const responses = await Promise.all([
      ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/patterns`, headers }),
      ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/cluster`, headers, payload: {} }),
      ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/analysis/patterns/candidates`, headers }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404]);
  });

  it("keeps ingestion active but always returns an empty legacy trigger list", async () => {
    const owner = await signup(ctx.app);
    const site = (await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/sites`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Ingestion site" },
    })).json();

    const response = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "session_1", events: [{ eventId: "event_1", type: "click", timestamp: 1_000, element: { selector: "#cta" } }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ triggers: [] });
  });
});
