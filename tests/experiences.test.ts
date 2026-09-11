import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";
import { eq } from "drizzle-orm";
import { experienceEditorSessions, surveyResponses } from "../src/db/schema.js";

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

  it("filters unified widget experiences by a supported widget type", async () => {
    const { owner, site } = await setup(ctx.app, "collection-filter");
    for (const widgetType of ["modal", "banner"] as const) {
      const response = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType, name: widgetType, buildUrl: "https://collection-filter.example.com", template: "blank", useBuildPageAsTarget: false } });
      expect(response.statusCode).toBe(201);
    }
    const filtered = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences?kind=widget&widgetType=modal`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(filtered.statusCode).toBe(200); expect(filtered.json().experiences).toHaveLength(1); expect(filtered.json().experiences[0].widgetType).toBe("modal");
    const invalid = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences?kind=widget&widgetType=checklist`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(invalid.statusCode).toBe(400); expect(invalid.json().error).toBe("invalid_widget_type");
  });

  it("rejects duplicate experience names within the same site", async () => {
    const { owner, site } = await setup(ctx.app, "unique-names");
    const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const url = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const payload = { kind: "widget", widgetType: "modal", name: "Untitled widget", buildUrl: "https://unique-names.example.com", template: "blank", useBuildPageAsTarget: false };
    const first = await ctx.app.inject({ method: "POST", url, headers: authorization, payload });
    expect(first.statusCode).toBe(201);

    const duplicate = await ctx.app.inject({ method: "POST", url, headers: authorization, payload: { ...payload, name: "untitled widget" } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("experience_name_exists");

    const second = await ctx.app.inject({ method: "POST", url, headers: authorization, payload: { ...payload, name: "Another experience" } });
    expect(second.statusCode).toBe(201);
    const rename = await ctx.app.inject({ method: "PATCH", url: `${url}/${second.json().id}`, headers: authorization, payload: { name: "UNTITLED WIDGET" } });
    expect(rename.statusCode).toBe(409);
    expect(rename.json().error).toBe("experience_name_exists");
  });

  it("validates per-step Guide builders and requires a DOM target before publishing", async () => {
    const { owner, site } = await setup(ctx.app, "guide-steps");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "guide", name: "Guide", buildUrl: "https://guide-steps.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const definition = created.draftVersion.definition; definition.steps.push({ id: "step_2", content: { heading: "Second", body: "Second step" }, behavior: { placement: "auto", alignment: "center", offset: 8, dismissible: true } });
    definition.steps[0].builder = { version: 1, projectData: { pages: [] }, html: '<section class="movecues-widget">First builder</section>', css: ".movecues-widget{color:#111}" };
    definition.steps[0].advance = { type: "element_hover", durationMs: 500 }; definition.targeting.interruptPolicy = "interrupt";
    definition.steps[0].target = { primarySelector: "#first", fallbackSelectors: [], reliability: "reliable", targetContext: { pagePath: "/dashboard" } };
    const saved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition } });
    expect(saved.statusCode).toBe(200); expect(saved.json().draftVersion.definition.steps[0]).toMatchObject({ builder: { html: expect.stringContaining("First builder") }, advance: { type: "element_hover", durationMs: 500 }, target: { targetContext: { pagePath: "/dashboard" } } });
    definition.steps[0].builder.css = "body{color:red}"; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition } })).statusCode).toBe(400); definition.steps[0].builder.css = ".movecues-widget{color:#111}";
    expect((await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } })).json().error).toBe("target_required");
    definition.steps[1].target = { primarySelector: "#second", fallbackSelectors: ["[data-step=second]"], reliability: "reliable" };
    await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition } });
    expect((await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } })).statusCode).toBe(200);
  });

  it("hashes and exchanges an editor token once, removes access after revocation, and enforces origin", async () => {
    const { owner, site } = await setup(ctx.app, "editor");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Editor", buildUrl: "https://editor.example.com/home", template: "blank", useBuildPageAsTarget: false } })).json();
    const sessionRes = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(sessionRes.statusCode).toBe(201); const session = sessionRes.json(); const raw = new URL(session.launchUrl).searchParams.get("movecues_editor_token")!; expect(JSON.stringify(session)).not.toContain("tokenHash");
    const wrongOrigin = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://evil.example.com" }, payload: { token: raw } }); expect(wrongOrigin.statusCode).toBe(401);
    const exchanged = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://editor.example.com" }, payload: { token: raw } }); expect(exchanged.statusCode).toBe(200);
    const reused = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://editor.example.com" }, payload: { token: raw } }); expect(reused.statusCode).toBe(401);
    const editorHeaders = { origin: "https://editor.example.com", authorization: `Bearer ${exchanged.json().accessToken}` }; const loadedDraft = await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders }); expect(loadedDraft.statusCode).toBe(200);
    const editorDefinition = loadedDraft.json().version.definition; editorDefinition.builder = { version: 1, projectData: { pages: [{ id: "main" }] }, html: '<section class="movecues-widget">Editor content</section>', css: ".movecues-widget{color:#111}" };
    const editorSaved = await ctx.app.inject({ method: "PATCH", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders, payload: { definition: editorDefinition } }); expect(editorSaved.statusCode).toBe(200); expect(editorSaved.json().version.definition.builder.projectData.pages[0].id).toBe("main");
    await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions/${session.sessionId}/revoke`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    const draft = await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: { origin: "https://editor.example.com", authorization: `Bearer ${exchanged.json().accessToken}` } }); expect(draft.statusCode).toBe(401);
  });

  it("rejects an expired editor token", async () => {
    const { owner, site } = await setup(ctx.app, "expired");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Expired", buildUrl: "https://expired.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions`, headers: { authorization: `Bearer ${owner.accessToken}` } })).json();
    await ctx.db.update(experienceEditorSessions).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(experienceEditorSessions.id, session.sessionId));
    const raw = new URL(session.launchUrl).searchParams.get("movecues_editor_token")!;
    const exchange = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://expired.example.com" }, payload: { token: raw } });
    expect(exchange.statusCode).toBe(401);
  });

  it("orders eligible experiences by priority with a stable id tie-break", async () => {
    const { owner, site } = await setup(ctx.app, "priority");
    async function create(name: string, priority: number, interruptPolicy?: "queue" | "interrupt") {
      const item = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name, buildUrl: "https://priority.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
      const definition = item.draftVersion.definition; definition.targeting.priority = priority; if (interruptPolicy) definition.targeting.interruptPolicy = interruptPolicy;
      await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${item.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition } });
      await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${item.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } });
      return item;
    }
    const low = await create("Low", 1); const high = await create("High", 20, "interrupt");
    const manifest = (await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?url=https%3A%2F%2Fpriority.example.com%2F&anonymousId=anon_priority&sessionId=sess_priority` })).json();
    expect(manifest.experiences.map((item: { id: string }) => item.id)).toEqual([high.id, low.id]);
    expect(manifest.experiences.map((item: { interruptPolicy: string }) => item.interruptPolicy)).toEqual(["interrupt", "queue"]);
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

  it("continues an active Guide across full-page navigation without creating another impression", async () => {
    const { owner, site } = await setup(ctx.app, "guide-resume"); const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "guide", name: "Multi-page Guide", buildUrl: "https://guide-resume.example.com/home", template: "blank", useBuildPageAsTarget: false } })).json();
    const definition = created.draftVersion.definition; definition.targeting.pageRules = [{ id: "home", kind: "include", operator: "equals", value: "/home" }]; definition.targeting.frequency = { mode: "once" };
    definition.steps[0].target = { primarySelector: "#first", fallbackSelectors: [], reliability: "reliable", targetContext: { pagePath: "/home" } };
    definition.steps.push(
      { id: "step_2", content: { heading: "Second", body: "Second page" }, target: { primarySelector: "#second", fallbackSelectors: [], reliability: "reliable", targetContext: { pagePath: "/pricing" } }, behavior: { placement: "auto", alignment: "center", offset: 8, dismissible: true } },
      { id: "step_3", content: { heading: "Third", body: "Third page" }, target: { primarySelector: "#third", fallbackSelectors: [], reliability: "reliable", targetContext: { pagePath: "/integrations" } }, behavior: { placement: "auto", alignment: "center", offset: 8, dismissible: true } },
    );
    await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } }); const published = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: authorization }); expect(published.statusCode).toBe(200);
    const first = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?url=https%3A%2F%2Fguide-resume.example.com%2Fhome&anonymousId=guide_anon&sessionId=guide_session` }); const versionId = first.json().experiences[0].versionId;
    const shown = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { experienceId: created.id, versionId, anonymousId: "guide_anon", sessionId: "guide_session", event: "shown" } }); expect(shown.statusCode).toBe(201);
    const withoutProgress = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?url=https%3A%2F%2Fguide-resume.example.com%2Fpricing&anonymousId=guide_anon&sessionId=guide_session` }); expect(withoutProgress.json().experiences).toEqual([]);
    const resume = new URLSearchParams({ url: "https://guide-resume.example.com/pricing", anonymousId: "guide_anon", sessionId: "guide_session", activeGuideId: created.id, activeGuideVersionId: versionId }); const continued = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?${resume}` }); expect(continued.statusCode).toBe(200); expect(continued.json().experiences).toHaveLength(1); expect(continued.json().experiences[0]).toMatchObject({ id: created.id, versionId, impressionId: shown.json().impressionId }); expect(continued.json().experiences[0].definition.steps).toHaveLength(3);
  });

  it("does not allow another organization to read an experience", async () => {
    const a = await setup(ctx.app, "tenant-a"); const b = await setup(ctx.app, "tenant-b");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${a.owner.org.id}/sites/${a.site.id}/experiences`, headers: { authorization: `Bearer ${a.owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Private", buildUrl: "https://tenant-a.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const cross = await ctx.app.inject({ method: "GET", url: `/orgs/${b.owner.org.id}/sites/${a.site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${b.owner.accessToken}` } }); expect(cross.statusCode).toBe(404);
  });

  it("persists and publishes safe builder data while rejecting unsafe markup and CSS", async () => {
    const { owner, site } = await setup(ctx.app, "builder-data"); const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "widget", widgetType: "modal", name: "Builder", buildUrl: "https://builder-data.example.com/home", template: "blank", useBuildPageAsTarget: false } })).json();
    const definition = created.draftVersion.definition; definition.builder = { version: 1, projectData: { pages: [{ id: "main", component: { type: "wrapper" } }] }, html: '<section class="movecues-widget"><button data-movecues-action-id="primary">Continue</button></section>', css: ".movecues-widget .button{color:#fff}" };
    const saved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } }); expect(saved.statusCode).toBe(200); expect(saved.json().draftVersion.definition.builder.html).toContain("data-movecues-action-id");
    const published = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: authorization }); expect(published.statusCode).toBe(200);
    const manifest = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?url=https%3A%2F%2Fbuilder-data.example.com%2Fhome&anonymousId=builder_anon&sessionId=builder_session` }); expect(manifest.json().experiences[0].definition.builder.projectData.pages[0].id).toBe("main");
    const nextDraft = published.json().draftVersion.definition; nextDraft.builder.html = '<section class="movecues-widget">Unpublished draft builder</section>'; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition: nextDraft } })).statusCode).toBe(200);
    const productionAfterDraftEdit = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?url=https%3A%2F%2Fbuilder-data.example.com%2Fhome&anonymousId=builder_anon_2&sessionId=builder_session_2` }); expect(productionAfterDraftEdit.json().experiences[0].definition.builder.html).not.toContain("Unpublished draft builder");
    const editorSession = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions`, headers: authorization })).json(); const editorToken = new URL(editorSession.launchUrl).searchParams.get("movecues_editor_token")!;
    const editorAccess = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://builder-data.example.com" }, payload: { token: editorToken } }); const editorDraft = await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${editorSession.sessionId}/draft`, headers: { origin: "https://builder-data.example.com", authorization: `Bearer ${editorAccess.json().accessToken}` } }); expect(editorDraft.json().version.definition.builder.html).toContain("Unpublished draft builder");
    definition.builder.html = '<section class="movecues-widget"><script>alert(1)</script></section>'; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } })).statusCode).toBe(400);
    definition.builder.html = '<section class="movecues-widget">Safe</section>'; definition.builder.css = "button{color:red}"; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } })).statusCode).toBe(400);
    definition.builder.css = ".movecues-widget{color:red}"; definition.builder.projectData = { pages: [{ component: { script: "alert(1)" } }] }; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } })).statusCode).toBe(400);
    definition.builder.projectData = { pages: [{ component: { attributes: { onpointerdown: "alert(1)" } } }] }; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } })).statusCode).toBe(400);
  });

  it("creates the new widget defaults and requires a DOM target only for hotspots", async () => {
    const { owner, site } = await setup(ctx.app, "adoption-widgets");
    const expectedSize = { modal: { width: { mode: "fixed", value: 600 }, height: { mode: "auto" } }, slideout: { width: { mode: "fixed", value: 400 }, height: { mode: "auto" } }, banner: { width: { mode: "full" }, height: { mode: "auto" } } } as const;
    for (const widgetType of ["modal", "slideout", "banner"] as const) {
      const create = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType, name: widgetType, buildUrl: "https://adoption-widgets.example.com/home", template: "blank", useBuildPageAsTarget: false } });
      expect(create.statusCode).toBe(201); const item = create.json();
      expect(item.draftVersion.definition.design.size).toEqual(expectedSize[widgetType]);
      expect((await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${item.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } })).statusCode).toBe(200);
    }
    const hotspotCreate = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "hotspot", name: "hotspot", buildUrl: "https://adoption-widgets.example.com/home", template: "blank", useBuildPageAsTarget: false } });
    expect(hotspotCreate.statusCode).toBe(201); const hotspot = hotspotCreate.json();
    const rejected = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${hotspot.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } }); expect(rejected.statusCode).toBe(400); expect(rejected.json().error).toBe("target_required");
    hotspot.draftVersion.definition.target = { primarySelector: "#new-feature", fallbackSelectors: ["[data-feature='new']"], reliability: "reliable" };
    expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${hotspot.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition: hotspot.draftVersion.definition } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${hotspot.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } })).statusCode).toBe(200);
  });

  it("round-trips valid sizing and rejects widget-specific constraint bypasses", async () => {
    const { owner, site } = await setup(ctx.app, "widget-sizing"); const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "widget", widgetType: "modal", name: "Sized modal", buildUrl: "https://widget-sizing.example.com/home", template: "blank", useBuildPageAsTarget: false } })).json();
    const definition = created.draftVersion.definition; definition.design.size = { width: { mode: "full" }, height: { mode: "viewport" } };
    const saved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } }); expect(saved.statusCode).toBe(200); expect(saved.json().draftVersion.definition.design.size.width.mode).toBe("full");
    definition.design.size = { width: { mode: "fixed", value: 961 }, height: { mode: "auto" } };
    const oversized = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } }); expect(oversized.statusCode).toBe(400); expect(oversized.json().error).toBe("invalid_widget_size");
    delete definition.design.size; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } })).statusCode).toBe(200);
  });

  it("creates and publishes a validated multi-step survey and persists submitted or abandoned structured responses", async () => {
    const { owner, site } = await setup(ctx.app, "survey"); const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const createdResponse = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "widget", widgetType: "survey", name: "Task feedback", buildUrl: "https://survey.example.com/task", template: "blank", useBuildPageAsTarget: false } });
    expect(createdResponse.statusCode).toBe(201); const created = createdResponse.json(); const definition = created.draftVersion.definition;
    expect(definition.survey.steps).toHaveLength(2); expect(definition.design.size.width.value).toBe(700); expect(definition.behavior).toMatchObject({ modalLayout: "center", backdrop: true, backdropOpacity: 0.45, closeOnBackdrop: false, dismissible: true });
    const duplicate = structuredClone(definition); duplicate.survey.steps[1].questions = [{ ...duplicate.survey.steps[0].questions[0] }];
    expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition: duplicate } })).statusCode).toBe(400);
    const saved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } }); expect(saved.statusCode).toBe(200);
    const published = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: authorization }); expect(published.statusCode).toBe(200);
    const manifest = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?url=https%3A%2F%2Fsurvey.example.com%2Ftask&anonymousId=survey_anon&sessionId=survey_session` }); expect(manifest.statusCode).toBe(200); const delivered = manifest.json().experiences[0]; expect(delivered.widgetType).toBe("survey");
    const shown = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { experienceId: created.id, versionId: delivered.versionId, anonymousId: "survey_anon", sessionId: "survey_session", event: "shown" } }); expect(shown.statusCode).toBe(201);
    const identity = { experienceId: created.id, versionId: delivered.versionId, impressionId: shown.json().impressionId, anonymousId: "survey_anon", sessionId: "survey_session" };
    const response = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/survey-responses`, payload: identity }); expect(response.statusCode).toBe(201);
    const idempotent = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/survey-responses`, payload: identity }); expect(idempotent.statusCode).toBe(200); expect(idempotent.json().responseId).toBe(response.json().responseId);
    const rating = definition.survey.steps[0].questions[0]; const text = definition.survey.steps[0].questions[1];
    const missingRequired = await ctx.app.inject({ method: "PATCH", url: `/public/sites/${site.siteId}/survey-responses/${response.json().responseId}`, payload: { ...identity, currentStepId: definition.survey.steps[1].id, answers: { [text.id]: "Hard to find" }, submitted: true } }); expect(missingRequired.statusCode).toBe(400);
    const submit = await ctx.app.inject({ method: "PATCH", url: `/public/sites/${site.siteId}/survey-responses/${response.json().responseId}`, payload: { ...identity, currentStepId: definition.survey.steps[1].id, answers: { [rating.id]: 4, [text.id]: "Hard to find" }, submitted: true } }); expect(submit.statusCode).toBe(204);
    const [stored] = await ctx.db.select().from(surveyResponses); expect(stored.answers).toEqual({ [rating.id]: 4, [text.id]: "Hard to find" }); expect(stored.submittedAt).toBeInstanceOf(Date);
    const shownTwo = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { experienceId: created.id, versionId: delivered.versionId, anonymousId: "survey_anon_2", sessionId: "survey_session_2", event: "shown" } });
    const identityTwo = { experienceId: created.id, versionId: delivered.versionId, impressionId: shownTwo.json().impressionId, anonymousId: "survey_anon_2", sessionId: "survey_session_2" };
    const responseTwo = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/survey-responses`, payload: identityTwo });
    expect((await ctx.app.inject({ method: "PATCH", url: `/public/sites/${site.siteId}/survey-responses/${responseTwo.json().responseId}`, payload: { ...identityTwo, currentStepId: definition.survey.steps[0].id, answers: { [rating.id]: 2 }, abandoned: true } })).statusCode).toBe(204);
    const rows = await ctx.db.select().from(surveyResponses); expect(rows.find(row => row.id === responseTwo.json().responseId)?.abandonedAt).toBeInstanceOf(Date);
  });
});
