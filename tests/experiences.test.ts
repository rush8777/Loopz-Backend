import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";
import { eq } from "drizzle-orm";
import { experienceEditorSessions } from "../src/db/schema.js";

async function setup(app: Awaited<ReturnType<typeof createTestApp>>["app"], suffix = "a") {
  const owner = await signup(app, { email: `experience-${suffix}@example.com` });
  const site = (await app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Experience site", domain: `${suffix}.example.com` } })).json();
  return { owner, site };
}

describe("visual experiences", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => {
    await ctx.app.close();
    (ctx.db as unknown as { $client: { close(): void } }).$client.close();
    ctx.cleanup();
  });

  it("creates an isolated draft without silently adding build-page targeting, then publishes a new immutable version", async () => {
    const { owner, site } = await setup(ctx.app, "draft");
    const page = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/pages`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Home", rules: [{ id: "r1", kind: "include", operator: "equals", value: "/home" }] } })).json();
    const created = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Welcome", buildPageId: page.id, template: "blank", useBuildPageAsTarget: false } });
    expect(created.statusCode).toBe(201); expect(created.json().draftVersion.definition.targeting.pageRules).toEqual([]);
    const published = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.json().id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(published.statusCode).toBe(200); expect(published.json().publishedVersion.versionNumber).toBe(1); expect(published.json().draftVersion.versionNumber).toBe(2);
  });

  it("requires a valid DOM target for every guide step before publishing", async () => {
    const { owner, site } = await setup(ctx.app, "guide-steps");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "guide", name: "Guide", buildUrl: "https://guide-steps.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const definition = created.draftVersion.definition; definition.steps.push({ id: "step_2", content: { heading: "Second", body: "Second step" }, behavior: { placement: "auto", alignment: "center", offset: 8, dismissible: true } });
    definition.steps[0].target = { primarySelector: "#first", fallbackSelectors: [], reliability: "reliable" };
    await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition } });
    expect((await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } })).json().error).toBe("target_required");
    definition.steps[1].target = { primarySelector: "#second", fallbackSelectors: ["[data-step=second]"], reliability: "reliable" };
    await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition } });
    expect((await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } })).statusCode).toBe(200);
  });

  it("hashes and exchanges an editor token once, removes access after revocation, and enforces origin", async () => {
    const { owner, site } = await setup(ctx.app, "editor");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Editor", buildUrl: "https://editor.example.com/home", template: "blank", useBuildPageAsTarget: false } })).json();
    const sessionRes = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(sessionRes.statusCode).toBe(201); const session = sessionRes.json(); const raw = new URL(session.launchUrl).searchParams.get("loopz_editor_token")!; expect(JSON.stringify(session)).not.toContain("tokenHash");
    const wrongOrigin = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://evil.example.com" }, payload: { token: raw } }); expect(wrongOrigin.statusCode).toBe(401);
    const exchanged = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://editor.example.com" }, payload: { token: raw } }); expect(exchanged.statusCode).toBe(200);
    const reused = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://editor.example.com" }, payload: { token: raw } }); expect(reused.statusCode).toBe(401);
    await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions/${session.sessionId}/revoke`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    const draft = await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: { origin: "https://editor.example.com", authorization: `Bearer ${exchanged.json().accessToken}` } }); expect(draft.statusCode).toBe(401);
  });

  it("rejects an expired editor token", async () => {
    const { owner, site } = await setup(ctx.app, "expired");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Expired", buildUrl: "https://expired.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions`, headers: { authorization: `Bearer ${owner.accessToken}` } })).json();
    await ctx.db.update(experienceEditorSessions).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(experienceEditorSessions.id, session.sessionId));
    const raw = new URL(session.launchUrl).searchParams.get("loopz_editor_token")!;
    const exchange = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://expired.example.com" }, payload: { token: raw } });
    expect(exchange.statusCode).toBe(401);
  });

  it("orders eligible experiences by priority with a stable id tie-break", async () => {
    const { owner, site } = await setup(ctx.app, "priority");
    async function create(name: string, priority: number) {
      const item = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name, buildUrl: "https://priority.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
      const definition = item.draftVersion.definition; definition.targeting.priority = priority;
      await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${item.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition } });
      await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${item.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } });
      return item;
    }
    const low = await create("Low", 1); const high = await create("High", 20);
    const manifest = (await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?url=https%3A%2F%2Fpriority.example.com%2F&anonymousId=anon_priority&sessionId=sess_priority` })).json();
    expect(manifest.experiences.map((item: { id: string }) => item.id)).toEqual([high.id, low.id]);
  });

  it("returns only published site-scoped presentation data, persists impressions, and applies once frequency", async () => {
    const a = await setup(ctx.app, "site-a"); const b = await setup(ctx.app, "site-b");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${a.owner.org.id}/sites/${a.site.id}/experiences`, headers: { authorization: `Bearer ${a.owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Toast", buildUrl: "https://site-a.example.com/home", template: "blank", useBuildPageAsTarget: false } })).json();
    expect((await ctx.app.inject({ method: "GET", url: `/public/sites/${a.site.siteId}/experiences?url=https%3A%2F%2Fsite-a.example.com%2Fhome&anonymousId=anon_1&sessionId=sess_1` })).json().experiences).toEqual([]);
    await ctx.app.inject({ method: "POST", url: `/orgs/${a.owner.org.id}/sites/${a.site.id}/experiences/${created.id}/publish`, headers: { authorization: `Bearer ${a.owner.accessToken}` } });
    const manifest = await ctx.app.inject({ method: "GET", url: `/public/sites/${a.site.siteId}/experiences?url=https%3A%2F%2Fsite-a.example.com%2Fhome&anonymousId=anon_1&sessionId=sess_1` });
    expect(manifest.statusCode).toBe(200); expect(manifest.json().experiences).toHaveLength(1); expect(manifest.json().experiences[0].definition).not.toHaveProperty("targeting");
    expect((await ctx.app.inject({ method: "GET", url: `/public/sites/${b.site.siteId}/experiences?url=https%3A%2F%2Fsite-b.example.com%2Fhome&anonymousId=anon_1&sessionId=sess_1` })).json().experiences).toEqual([]);
    const shown = await ctx.app.inject({ method: "POST", url: `/public/sites/${a.site.siteId}/experience-events`, payload: { experienceId: created.id, versionId: manifest.json().experiences[0].versionId, anonymousId: "anon_1", sessionId: "sess_1", event: "shown" } }); expect(shown.statusCode).toBe(201);
    const dismissed = await ctx.app.inject({ method: "POST", url: `/public/sites/${a.site.siteId}/experience-events`, payload: { experienceId: created.id, versionId: manifest.json().experiences[0].versionId, impressionId: shown.json().impressionId, event: "dismissed" } }); expect(dismissed.statusCode).toBe(204);
    const second = await ctx.app.inject({ method: "GET", url: `/public/sites/${a.site.siteId}/experiences?url=https%3A%2F%2Fsite-a.example.com%2Fhome&anonymousId=anon_1&sessionId=sess_2` }); expect(second.json().experiences).toEqual([]);
  });

  it("does not allow another organization to read an experience", async () => {
    const a = await setup(ctx.app, "tenant-a"); const b = await setup(ctx.app, "tenant-b");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${a.owner.org.id}/sites/${a.site.id}/experiences`, headers: { authorization: `Bearer ${a.owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Private", buildUrl: "https://tenant-a.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const cross = await ctx.app.inject({ method: "GET", url: `/orgs/${b.owner.org.id}/sites/${a.site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${b.owner.accessToken}` } }); expect(cross.statusCode).toBe(404);
  });
});
