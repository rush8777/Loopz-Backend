import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";
import { publishReviewed } from "./reviewedPublish.js";
import { applySourceMarkup, sourceContentProjection } from "../src/lib/experiences/sourceMarkup.js";

describe("source-authored draft lifecycle", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });

  it("saves, reloads, and publishes the exact validated HTML/CSS without dropping the recovery document", async () => {
    const owner = await signup(ctx.app, { email: "source-lifecycle@example.com" }), headers = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers, payload: { name: "Source lifecycle", domain: "source-lifecycle.example.com" } })).json();
    const base = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = (await ctx.app.inject({ method: "POST", url: base, headers, payload: { kind: "widget", widgetType: "modal", builderMode: "onsite", name: "Onboarding", buildUrl: "https://source-lifecycle.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `${base}/${created.id}/editor-sessions`, headers })).json();
    const exchange = (await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://source-lifecycle.example.com" }, payload: { token: new URL(session.launchUrl).searchParams.get("movcues_editor_token") } })).json();
    const editorHeaders = { origin: "https://source-lifecycle.example.com", authorization: `Bearer ${exchange.accessToken}` }, endpoint = `/public/experience-editor/${session.sessionId}/draft`;
    const loaded = (await ctx.app.inject({ method: "GET", url: endpoint, headers: editorHeaders })).json(), definition = structuredClone(loaded.version.definition);
    const recoveryId = definition.builder.projectData.movcues.onsiteDocument.id;
    const html = `<section class="movcues-widget movcues-widget--modal" data-movcues-widget-type="modal" data-movcues-document-version="2"><div class="onboarding"><h2 data-movcues-content="heading">Welcome to your workspace</h2><p data-movcues-content="body">Invite your team and ship your first project.</p><button type="button" data-movcues-action-id="start_setup">Start setup</button></div></section>`;
    const css = `.movcues-widget{padding:36px;background:linear-gradient(135deg,#eff6ff,#fff)}.movcues-widget .onboarding{display:grid;gap:18px}@media(max-width:520px){.movcues-widget{padding:22px}.movcues-widget .onboarding{gap:12px}}`;
    applySourceMarkup(definition.builder, { html, css, actionBindings: { start_setup: { type: "dismiss" } } }); definition.content = sourceContentProjection(html, definition.content);
    const saved = await ctx.app.inject({ method: "PATCH", url: endpoint, headers: editorHeaders, payload: { definition, revision: loaded.version.revision } });
    expect(saved.statusCode, saved.body).toBe(200);
    const reloaded = (await ctx.app.inject({ method: "GET", url: endpoint, headers: editorHeaders })).json();
    expect(reloaded.version.definition.builder).toMatchObject({ html, css, projectData: { movcues: { authoringSurface: "source", onsiteDocument: { id: recoveryId }, actionBindings: { start_setup: { type: "dismiss" } } } } });
    const published = await publishReviewed(ctx.app, { method: "POST", url: `${base}/${created.id}/publish`, headers });
    expect(published.statusCode, published.body).toBe(200); expect(published.json().publishedVersion.definition.builder).toMatchObject({ html, css, projectData: { movcues: { authoringSurface: "source" } } });
  });
});
