import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { sessionEvents, trackedUsers } from "../src/db/schema.js";
import { createTestApp, signup } from "./helpers.js";
import type { Client, InStatement } from "@libsql/client";

async function setupSite(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const owner = await signup(app);
  return (await app.inject({
    method: "POST",
    url: `/orgs/${owner.org.id}/sites`,
    headers: { authorization: `Bearer ${owner.accessToken}` },
    payload: { name: "Batch ingestion site" },
  })).json();
}

describe("public event ingestion - batching and identity boundaries", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(() => ctx.cleanup());

  it("persists a normal behavioral batch with one session_events INSERT", async () => {
    const site = await setupSite(ctx.app);
    const client: Client = ctx.db.$client;
    const originalExecute = client.execute.bind(client);
    const statements: string[] = [];
    client.execute = (statement: InStatement) => {
      statements.push(typeof statement === "string" ? statement : statement.sql);
      return originalExecute(statement);
    };

    const response = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_bulk",
        events: [
          { type: "click", timestamp: 1000, eventId: "bulk_1", anonymousId: "anon_1", element: { selector: "#one" } },
          { type: "click", timestamp: 1100, eventId: "bulk_2", anonymousId: "anon_2", element: { selector: "#two" } },
          { type: "click", timestamp: 1200, eventId: "bulk_3", anonymousId: "anon_3", element: { selector: "#three" } },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(statements.filter((sql) => /^insert into "session_events"/i.test(sql))).toHaveLength(1);
    expect(statements.filter((sql) => /from "tracked_user_aliases"/i.test(sql))).toHaveLength(1);
  });

  it("keeps the owner active on each side of an identify boundary", async () => {
    const site = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: { sessionId: "seed", events: [{ type: "identify", timestamp: 500, anonymousId: "anon_shared", externalUserId: "previous_user" }] },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_boundary",
        events: [
          { type: "click", timestamp: 1000, eventId: "before", anonymousId: "anon_shared", element: { selector: "#before" } },
          { type: "identify", timestamp: 1100, anonymousId: "anon_shared", externalUserId: "next_user" },
          { type: "click", timestamp: 1200, eventId: "after", anonymousId: "anon_shared", element: { selector: "#after" } },
        ],
      },
    });
    expect(response.statusCode).toBe(200);

    const users = await ctx.db.select().from(trackedUsers).where(eq(trackedUsers.siteId, site.id));
    const userById = new Map(users.map((user) => [user.id, user.externalUserId]));
    const events = await ctx.db.select().from(sessionEvents)
      .where(and(eq(sessionEvents.siteId, site.id), eq(sessionEvents.sessionId, "sess_boundary")))
      .orderBy(asc(sessionEvents.timestamp));
    expect(events.map((event) => userById.get(event.trackedUserId!))).toEqual(["previous_user", "next_user"]);
  });

  it("assigns all events after identify to that user", async () => {
    const site = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_identify_first",
        events: [
          { type: "identify", timestamp: 1000, anonymousId: "anon_1", externalUserId: "user_a" },
          { type: "click", timestamp: 1100, eventId: "a1", anonymousId: "anon_1", element: { selector: "#one" } },
          { type: "click", timestamp: 1200, eventId: "a2", anonymousId: "anon_1", element: { selector: "#two" } },
        ],
      },
    });

    const rows = await ctx.db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, "sess_identify_first"));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.trackedUserId)).size).toBe(1);
    expect(rows[0].trackedUserId).not.toBeNull();
  });

  it("preserves ownership across multiple identify boundaries", async () => {
    const site = await setupSite(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/public/sites/${site.siteId}/events`,
      payload: {
        sessionId: "sess_multi_identify",
        events: [
          { type: "click", timestamp: 1000, eventId: "m1", anonymousId: "anon_1", element: { selector: "#one" } },
          { type: "identify", timestamp: 1100, anonymousId: "anon_1", externalUserId: "user_a" },
          { type: "click", timestamp: 1200, eventId: "m2", anonymousId: "anon_1", element: { selector: "#two" } },
          { type: "identify", timestamp: 1300, anonymousId: "anon_1", externalUserId: "user_b" },
          { type: "click", timestamp: 1400, eventId: "m3", anonymousId: "anon_1", element: { selector: "#three" } },
        ],
      },
    });

    const users = await ctx.db.select().from(trackedUsers).where(eq(trackedUsers.siteId, site.id));
    const userById = new Map(users.map((user) => [user.id, user.externalUserId]));
    const events = await ctx.db.select().from(sessionEvents)
      .where(eq(sessionEvents.sessionId, "sess_multi_identify"))
      .orderBy(asc(sessionEvents.timestamp));
    // The first unresolved row is claimed by the first identify(), matching
    // established behavior. The second identify() cannot rewrite A-owned rows.
    expect(events.map((event) => userById.get(event.trackedUserId!))).toEqual(["user_a", "user_a", "user_b"]);
  });
});
