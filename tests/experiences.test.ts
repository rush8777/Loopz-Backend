import { publishReviewed } from "./reviewedPublish.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";
import { eq } from "drizzle-orm";
import { experienceEditorSessions, organizationSubscriptions, surveyResponses } from "../src/db/schema.js";
import { applyOnsiteDocument, createBlock, createOnsiteDocument, duplicateDocument, emptyCell, listBlocks, moveCell, onsiteDocumentFromBuilder, resizeSiblings, splitCell } from "../src/lib/experiences/onsiteDocument.js";

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
    ctx.cleanup();
  });

  it("rejects missing or stale reviewed revisions and leaves published content immutable", async () => {
    const { owner, site } = await setup(ctx.app, "review-lock"); const headers = { authorization: `Bearer ${owner.accessToken}` };
    const url = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = (await ctx.app.inject({ method: "POST", url, headers, payload: { kind: "widget", widgetType: "modal", name: "Review", buildUrl: "https://review-lock.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const endpoint = `${url}/${created.id}`; const reviewed = { draftVersionId: created.draftVersion.id, revision: created.draftVersion.revision };
    expect((await ctx.app.inject({ method: "POST", url: endpoint + "/publish", headers })).json().error).toBe("reviewed_revision_required");
    const definition = structuredClone(created.draftVersion.definition); definition.content.heading = "New revision";
    const changed = await ctx.app.inject({ method: "PATCH", url: endpoint, headers, payload: { definition, revision: reviewed.revision } }); expect(changed.statusCode).toBe(200);
    const rejected = await ctx.app.inject({ method: "POST", url: endpoint + "/publish", headers, payload: reviewed });
    expect(rejected.statusCode).toBe(409); expect(rejected.json().error).toBe("reviewed_draft_changed");
    const noOp = await ctx.app.inject({ method: "PATCH", url: endpoint, headers, payload: { definition, revision: changed.json().draftVersion.revision } });
    expect(noOp.statusCode).toBe(200); expect(noOp.json().draftVersion.revision).toBe(changed.json().draftVersion.revision);
    const version = noOp.json().draftVersion;
    const published = await ctx.app.inject({ method: "POST", url: endpoint + "/publish", headers, payload: { draftVersionId: version.id, revision: version.revision } }); expect(published.statusCode).toBe(200);
    const repeated = await ctx.app.inject({ method: "POST", url: endpoint + "/publish", headers, payload: { draftVersionId: version.id, revision: version.revision } }); expect(repeated.statusCode).toBe(409);
    expect(published.json().publishedVersion.definition.content.heading).toBe("New revision");
  });

  it("saves, reloads and publishes the three-step Guide logic journey without stripping settings", async () => {
    const { owner, site } = await setup(ctx.app, "guide-logic"); const headers = { authorization: `Bearer ${owner.accessToken}` }; const url = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = (await ctx.app.inject({ method: "POST", url, headers, payload: { kind: "guide", guidePattern: "modal", builderMode: "onsite", name: "Interactive onboarding", buildUrl: "https://guide-logic.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `${url}/${created.id}/editor-sessions`, headers })).json();
    const access = (await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://guide-logic.example.com" }, payload: { token: new URL(session.launchUrl).searchParams.get("movcues_editor_token") } })).json();
    const editorHeaders = { origin: "https://guide-logic.example.com", authorization: `Bearer ${access.accessToken}` }; const endpoint = `/public/experience-editor/${session.sessionId}/draft`;
    const definition = structuredClone(created.draftVersion.definition);
    definition.steps = ["Welcome", "Feature", "Completion"].map((label, index) => {
      const builder = { version: 1, projectData: {}, html: "", css: "" }; const doc = createOnsiteDocument(true); const heading = listBlocks(doc.root).find(block => block.type === "heading"); if (heading?.type === "heading") heading.html = label;
      return { id: `logic_${index}`, label, pattern: index === 1 ? "anchored_card" : "modal", builder, content: applyOnsiteDocument(builder, doc, index === 1 ? "anchored_card" : "modal").content, behavior: { dismissible: true }, advance: index === 0 ? { type: "button" } : index === 1 ? { type: "element_click", target: { primarySelector: "#use-feature", fallbackSelectors: [], reliability: "reliable" } } : { type: "custom_event", eventName: "project_created" }, ...(index === 1 ? { target: { primarySelector: "#feature-card", fallbackSelectors: [], reliability: "reliable" }, presentation: { delayMs: 200, missingTarget: { action: "skip", timeoutMs: 2500 } } } : { presentation: { delayMs: 0 } }) };
    });
    const saved = await ctx.app.inject({ method: "PATCH", url: endpoint, headers: editorHeaders, payload: { definition, revision: 1 } }); expect(saved.statusCode, saved.body).toBe(200);
    const reloaded = (await ctx.app.inject({ method: "GET", url: endpoint, headers: editorHeaders })).json().version;
    expect(reloaded.definition.steps).toEqual(definition.steps);
    const published = await publishReviewed(ctx.app, { method: "POST", url: `${url}/${created.id}/publish`, headers }); expect(published.statusCode, published.body).toBe(200); expect(published.json().publishedVersion.definition.steps).toEqual(definition.steps);
    const draft = (await ctx.app.inject({ method: "GET", url: `${url}/${created.id}`, headers })).json().draftVersion; const invalid = structuredClone(draft.definition);
    const final = invalid.steps[2]; final.pattern = "anchored_card"; final.target = { primarySelector: "#done", fallbackSelectors: [], reliability: "reliable" }; const finalDoc = onsiteDocumentFromBuilder(final.builder)!; final.content = applyOnsiteDocument(final.builder, finalDoc, "anchored_card").content; final.presentation = { missingTarget: { action: "skip", timeoutMs: 500 } };
    expect((await ctx.app.inject({ method: "PATCH", url: endpoint, headers: editorHeaders, payload: { definition: invalid, revision: draft.revision } })).statusCode).toBe(200);
    const rejected = await publishReviewed(ctx.app, { method: "POST", url: `${url}/${created.id}/publish`, headers });
    expect(rejected.statusCode).toBe(400); expect(rejected.json().error).toBe("invalid_guide_step_configuration"); expect(rejected.json().details.issues).toContainEqual(expect.objectContaining({ message: expect.stringContaining("Step 3") }));
  });

  it("persists nested Guide layouts, images and independent actions through editor save, settings and publish", async () => {
    const { owner, site } = await setup(ctx.app, "ux-guide"); const headers = { authorization: `Bearer ${owner.accessToken}` };
    const url = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = (await ctx.app.inject({ method: "POST", url, headers, payload: { kind: "guide", guidePattern: "modal", builderMode: "onsite", name: "UX guide", buildUrl: "https://ux-guide.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `${url}/${created.id}/editor-sessions`, headers })).json();
    const access = (await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://ux-guide.example.com" }, payload: { token: new URL(session.launchUrl).searchParams.get("movcues_editor_token") } })).json();
    const editorHeaders = { origin: "https://ux-guide.example.com", authorization: `Bearer ${access.accessToken}` }; const endpoint = `/public/experience-editor/${session.sessionId}/draft`;
    const definition = structuredClone(created.draftVersion.definition); const first = definition.steps[0]; const doc = onsiteDocumentFromBuilder(first.builder)!;
    const row = doc.root.children![0]; expect(splitCell(doc, row.id, "row")).toBeTruthy();
    const image = createBlock("image"); if (image.type !== "image") throw new Error("Expected image");
    image.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="; image.alt = "Guide illustration"; row.children![1].block = image;
    expect(resizeSiblings(doc, row.children![0].id, row.children![1].id, .7)).toBe(true);
    const event = createBlock("button", true); if (event.type !== "button") throw new Error("Expected button"); event.label = "Track"; event.action = { id: event.action.id, type: "track_event", eventName: "guide_clicked" };
    doc.root.children!.push(emptyCell(event)); expect(moveCell(doc, doc.root.children!.at(-1)!.id, -1)).toBe(true);
    first.content = applyOnsiteDocument(first.builder, doc, "modal").content;
    const second = structuredClone(first); second.id = "ux_step_two"; const copied = duplicateDocument(doc);
    for (const block of listBlocks(copied.root)) if (block.type === "button" && block.action.type === "next_step") block.action.type = "previous_step";
    second.content = applyOnsiteDocument(second.builder, copied, "modal").content; definition.steps.push(second);
    const saved = await ctx.app.inject({ method: "PATCH", url: endpoint, headers: editorHeaders, payload: { definition, revision: 1 } }); expect(saved.statusCode, saved.body).toBe(200);
    expect((await ctx.app.inject({ method: "PATCH", url: endpoint, headers: editorHeaders, payload: { definition, revision: 1 } })).statusCode).toBe(409);
    const reloaded = (await ctx.app.inject({ method: "GET", url: endpoint, headers: editorHeaders })).json().version;
    expect(reloaded.definition.steps).toEqual(definition.steps);
    const settings = await ctx.app.inject({ method: "PATCH", url: `${url}/${created.id}`, headers, payload: { revision: reloaded.revision, settings: { targeting: { ...definition.targeting, priority: 3 } } } }); expect(settings.statusCode, settings.body).toBe(200);
    expect(settings.json().draftVersion.definition.steps).toEqual(definition.steps);
    const published = await publishReviewed(ctx.app, { method: "POST", url: `${url}/${created.id}/publish`, headers }); expect(published.statusCode, published.body).toBe(200);
    expect(published.json().publishedVersion.definition.steps).toEqual(definition.steps);
  });

  it("applies reference, projection and ownership checks to direct editor requests", async () => {
    const { owner, site } = await setup(ctx.app, "editor-forgery"); const headers = { authorization: `Bearer ${owner.accessToken}` };
    const url = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = (await ctx.app.inject({ method: "POST", url, headers, payload: { kind: "widget", widgetType: "modal", builderMode: "onsite", name: "Direct editor", buildUrl: "https://editor-forgery.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `${url}/${created.id}/editor-sessions`, headers })).json();
    const token = new URL(session.launchUrl).searchParams.get("movcues_editor_token");
    const access = (await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://editor-forgery.example.com" }, payload: { token } })).json();
    const editorHeaders = { origin: "https://editor-forgery.example.com", authorization: `Bearer ${access.accessToken}` }; const endpoint = `/public/experience-editor/${session.sessionId}/draft`;
    const request = (definition: unknown, revision = 1) => ctx.app.inject({ method: "PATCH", url: endpoint, headers: editorHeaders, payload: { definition, revision } });
    const inconsistent = structuredClone(created.draftVersion.definition); inconsistent.content.heading = "Contradictory";
    expect((await request(inconsistent)).json().error).toBe("inconsistent_onsite_content");
    const invalidRef = structuredClone(created.draftVersion.definition); invalidRef.targeting.audience = { type: "segment", segmentId: "nonexistent" };
    expect((await request(invalidRef)).json().error).toBe("invalid_segment");
    expect((await request(created.draftVersion.definition)).json().version.revision).toBe(1);
    const unsafe = structuredClone(created.draftVersion.definition); unsafe.builder.html += '<img src="/x" onerror="alert(1)">';
    expect((await request(unsafe)).statusCode).toBe(400);
    const modified = structuredClone(created.draftVersion.definition); modified.behavior.dismissible = false;
    expect((await request(modified)).json().version.revision).toBe(2);
    expect((await request(modified)).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "PATCH", url: endpoint, headers: { ...editorHeaders, origin: "https://evil.test" }, payload: { definition: modified, revision: 2 } })).statusCode).toBe(401);
    await ctx.db.update(organizationSubscriptions).set({ planId: "starter", status: "active", trialEndsAt: null }).where(eq(organizationSubscriptions.orgId, owner.org.id));
    const advanced = structuredClone(modified); advanced.targeting.schedule = { startsAt: new Date(Date.now() + 86400000).toISOString() };
    const denied = await request(advanced, 2); expect(denied.statusCode).toBe(403); expect(denied.json().error).toBe("feature_unavailable");
    await ctx.db.update(organizationSubscriptions).set({ status: "trialing", trialEndsAt: new Date(Date.now() - 1000) }).where(eq(organizationSubscriptions.orgId, owner.org.id));
    const inactive = await request(modified, 2); expect(inactive.statusCode).toBe(402); expect(inactive.json().error).toBe("subscription_inactive");
    const b = await setup(ctx.app, "editor-other-site");
    await ctx.db.update(experienceEditorSessions).set({ siteId: b.site.id }).where(eq(experienceEditorSessions.id, session.sessionId));
    expect((await request(modified, 2)).statusCode).toBe(401);
  });

  it("creates an isolated draft without silently adding build-page targeting, then publishes a new immutable version", async () => {
    const { owner, site } = await setup(ctx.app, "draft");
    const page = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/pages`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Home", rules: [{ id: "r1", kind: "include", operator: "equals", value: "/home" }] } })).json();
    const created = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Welcome", buildPageId: page.id, template: "blank", useBuildPageAsTarget: false } });
    expect(created.statusCode).toBe(201); expect(created.json().draftVersion.definition.targeting.pageRules).toEqual([]);
    const published = await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.json().id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(published.statusCode).toBe(200); expect(published.json().publishedVersion.versionNumber).toBe(1); expect(published.json().draftVersion.versionNumber).toBe(2);
  });

  it("persists launch setup completion independently from publishing", async () => {
    const { owner, site } = await setup(ctx.app, "launch-setup");
    const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "widget", widgetType: "toast", name: "Launch review", buildUrl: "https://launch-setup.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    expect(created.launchSetupCompletedAt).toBeNull();
    expect(created.status).toBe("draft");

    const completed = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/launch-setup/complete`, headers: authorization });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().launchSetupCompletedAt).toEqual(expect.any(String));
    expect(completed.json().status).toBe("draft");
    expect(completed.json().publishedVersionId).toBeNull();

    const repeated = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/launch-setup/complete`, headers: authorization });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().launchSetupCompletedAt).toBe(completed.json().launchSetupCompletedAt);
  });

  it("keeps builder ownership immutable and rejects stale cross-surface writes", async () => {
    const { owner, site } = await setup(ctx.app, "onsite-mode");
    const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const url = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const createdResponse = await ctx.app.inject({
      method: "POST",
      url,
      headers: authorization,
      payload: {
        kind: "widget",
        widgetType: "modal",
        builderMode: "onsite",
        name: "On-site modal",
        buildUrl: "https://onsite-mode.example.com/home",
        template: "blank",
        useBuildPageAsTarget: false,
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    expect(created).toMatchObject({ builderMode: "onsite", draftVersion: { revision: 1 } });
    expect(created.draftVersion.definition.builder).toMatchObject({
      projectData: { movcues: { authoringSurface: "onsite", schemaVersion: 2 } },
    });
    expect(created.draftVersion.definition.builder.html).toContain('data-movcues-content="heading"');
    expect(created.draftVersion.definition.content.primaryAction).toEqual({ label: "Got it", type: "dismiss" });

    const modalGuideResponse = await ctx.app.inject({
      method: "POST",
      url,
      headers: authorization,
      payload: {
        kind: "guide",
        builderMode: "onsite",
        guidePattern: "modal",
        name: "On-site modal guide",
        buildUrl: "https://onsite-mode.example.com/home",
        template: "blank",
        useBuildPageAsTarget: false,
      },
    });
    expect(modalGuideResponse.statusCode).toBe(201);
    expect(modalGuideResponse.json().draftVersion.definition.steps[0]).toMatchObject({
      pattern: "modal",
      behavior: { dismissible: true },
      builder: { projectData: { movcues: { authoringSurface: "onsite" } } },
    });

    const incompatible = await ctx.app.inject({
      method: "POST",
      url,
      headers: authorization,
      payload: {
        kind: "widget",
        widgetType: "hotspot",
        builderMode: "onsite",
        name: "Unsupported hotspot",
        buildUrl: "https://onsite-mode.example.com/home",
        template: "blank",
        useBuildPageAsTarget: false,
      },
    });
    expect(incompatible.statusCode).toBe(400);
    expect(incompatible.json().error).toBe("onsite_builder_unsupported");

    const locked = await ctx.app.inject({ method: "PATCH", url: `${url}/${created.id}`, headers: authorization, payload: { builderMode: "grapesjs" } });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toBe("builder_mode_locked");
    const dashboardContent = await ctx.app.inject({ method: "PATCH", url: `${url}/${created.id}`, headers: authorization, payload: { definition: created.draftVersion.definition, revision: 1 } });
    expect(dashboardContent.statusCode).toBe(409);
    expect(dashboardContent.json().error).toBe("builder_mode_mismatch");

    const settings = structuredClone(created.draftVersion.definition.targeting);
    settings.priority = 12;
    const settingsSaved = await ctx.app.inject({ method: "PATCH", url: `${url}/${created.id}`, headers: authorization, payload: { settings: { targeting: settings }, revision: 1 } });
    expect(settingsSaved.statusCode, JSON.stringify(settingsSaved.json())).toBe(200);
    expect(settingsSaved.json().draftVersion).toMatchObject({ revision: 2, definition: { targeting: { priority: 12 } } });
    const stale = await ctx.app.inject({ method: "PATCH", url: `${url}/${created.id}`, headers: authorization, payload: { settings: { targeting: settings }, revision: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "draft_conflict", currentRevision: 2 });

    const session = (await ctx.app.inject({ method: "POST", url: `${url}/${created.id}/editor-sessions`, headers: authorization })).json();
    const raw = new URL(session.launchUrl).searchParams.get("movcues_editor_token")!;
    const exchanged = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://onsite-mode.example.com" }, payload: { token: raw } });
    const editorHeaders = { origin: "https://onsite-mode.example.com", authorization: `Bearer ${exchanged.json().accessToken}` };
    const loaded = await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders });
    expect(loaded.json().experience.builderMode).toBe("onsite");
    const edited = loaded.json().version.definition;
    const onsite = onsiteDocumentFromBuilder(edited.builder)!; const heading = listBlocks(onsite.root).find(block => block.type === "heading"); if (heading?.type === "heading") heading.html = "Edited on the product page";
    const localImage = "data:image/png;base64," + btoa("\x89PNG\r\n\x1a\n" + "a".repeat(3000));
    const image = createBlock("image"); if (image.type === "image") { image.src = localImage; image.alt = "Feature preview"; } onsite.root.children!.push(emptyCell(image));
    edited.content = applyOnsiteDocument(edited.builder, onsite, "modal").content;
    const editorSaved = await ctx.app.inject({ method: "PATCH", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders, payload: { definition: edited, revision: loaded.json().version.revision } });
    expect(editorSaved.statusCode).toBe(200);
    expect(editorSaved.json().version).toMatchObject({ revision: 3, definition: { content: { heading: "Edited on the product page" } } });
    const reloaded = await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders });
    expect(reloaded.json().version.definition.builder.html).toContain(localImage);
    const published = await publishReviewed(ctx.app, { method: "POST", url: `${url}/${created.id}/publish`, headers: authorization });
    expect(published.statusCode, JSON.stringify(published.json())).toBe(200);
    expect(published.json().publishedVersion.definition.builder.html).toContain(localImage);
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

  it("deletes an experience and removes it from its site", async () => {
    const { owner, site } = await setup(ctx.app, "delete");
    const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const url = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = (await ctx.app.inject({ method: "POST", url, headers: authorization, payload: { kind: "widget", widgetType: "modal", name: "Disposable", buildUrl: "https://delete.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    expect((await ctx.app.inject({ method: "DELETE", url: `${url}/${created.id}`, headers: authorization })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: `${url}/${created.id}`, headers: authorization })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url, headers: authorization })).json().experiences).toEqual([]);
  });

  it("validates per-step Guide builders and requires a DOM target before publishing", async () => {
    const { owner, site } = await setup(ctx.app, "guide-steps");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "guide", name: "Guide", buildUrl: "https://guide-steps.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const definition = created.draftVersion.definition; definition.steps.push({ id: "step_2", content: { heading: "Second", body: "Second step" }, behavior: { placement: "auto", alignment: "center", offset: 8, dismissible: true } });
    definition.steps[0].behavior = { ...definition.steps[0].behavior, backdrop: true, backdropOpacity: 0.55, closeOnBackdrop: false };
    definition.steps[0].builder = { version: 1, projectData: { pages: [] }, html: '<section class="movcues-widget">First builder</section>', css: ".movcues-widget{color:#111}" };
    definition.steps[0].advance = { type: "element_hover", durationMs: 500 }; definition.targeting.interruptPolicy = "interrupt";
    definition.steps[0].target = { primarySelector: "#first", fallbackSelectors: [], reliability: "reliable", targetContext: { pagePath: "/dashboard" } };
    const saved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition, revision: created.draftVersion.revision } });
    expect(saved.statusCode).toBe(200); expect(saved.json().draftVersion.definition.steps[0]).toMatchObject({ builder: { html: expect.stringContaining("First builder") }, advance: { type: "element_hover", durationMs: 500 }, target: { targetContext: { pagePath: "/dashboard" } }, behavior: { backdrop: true, backdropOpacity: 0.55, closeOnBackdrop: false } });
    definition.steps[0].builder.css = "body{color:red}"; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition, revision: saved.json().draftVersion.revision } })).statusCode).toBe(400); definition.steps[0].builder.css = ".movcues-widget{color:#111}";
    expect((await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } })).json().error).toBe("target_required");
    const invalidPattern = structuredClone(definition); invalidPattern.steps[1].pattern = "slideout";
    expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition: invalidPattern, revision: saved.json().draftVersion.revision } })).statusCode).toBe(400);
    definition.steps[1].pattern = "modal";
    const modalSaved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition, revision: saved.json().draftVersion.revision } });
    expect(modalSaved.statusCode).toBe(200); expect(modalSaved.json().draftVersion.definition.steps[1]).toMatchObject({ pattern: "modal" }); expect(modalSaved.json().draftVersion.definition.steps[1]).not.toHaveProperty("target");
    expect((await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } })).statusCode).toBe(200);
  });

  it("hashes and exchanges an editor token once, removes access after revocation, and enforces origin", async () => {
    const { owner, site } = await setup(ctx.app, "editor");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Editor", buildUrl: "https://editor.example.com/home", template: "blank", useBuildPageAsTarget: false } })).json();
    const sessionRes = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(sessionRes.statusCode).toBe(201); const session = sessionRes.json(); const raw = new URL(session.launchUrl).searchParams.get("movcues_editor_token")!; expect(JSON.stringify(session)).not.toContain("tokenHash");
    const wrongOrigin = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://evil.example.com" }, payload: { token: raw } }); expect(wrongOrigin.statusCode).toBe(401);
    const exchanged = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://editor.example.com" }, payload: { token: raw } }); expect(exchanged.statusCode).toBe(200);
    const reused = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://editor.example.com" }, payload: { token: raw } }); expect(reused.statusCode).toBe(401);
    const editorHeaders = { origin: "https://editor.example.com", authorization: `Bearer ${exchanged.json().accessToken}` }; const loadedDraft = await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders }); expect(loadedDraft.statusCode).toBe(200);
    const editorDefinition = loadedDraft.json().version.definition; editorDefinition.behavior.dismissible = false;
    const editorSaved = await ctx.app.inject({ method: "PATCH", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders, payload: { definition: editorDefinition, revision: loadedDraft.json().version.revision } }); expect(editorSaved.statusCode, JSON.stringify(editorSaved.json())).toBe(200); expect(editorSaved.json().version.definition.behavior.dismissible).toBe(false);
    editorDefinition.content.heading = "Wrong builder";
    const rejectedContent = await ctx.app.inject({ method: "PATCH", url: `/public/experience-editor/${session.sessionId}/draft`, headers: editorHeaders, payload: { definition: editorDefinition, revision: editorSaved.json().version.revision } }); expect(rejectedContent.statusCode).toBe(409); expect(rejectedContent.json().error).toBe("builder_mode_mismatch");
    await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions/${session.sessionId}/revoke`, headers: { authorization: `Bearer ${owner.accessToken}` } });
    const draft = await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${session.sessionId}/draft`, headers: { origin: "https://editor.example.com", authorization: `Bearer ${exchanged.json().accessToken}` } }); expect(draft.statusCode).toBe(401);
  });

  it("rejects an expired editor token", async () => {
    const { owner, site } = await setup(ctx.app, "expired");
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name: "Expired", buildUrl: "https://expired.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const session = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions`, headers: { authorization: `Bearer ${owner.accessToken}` } })).json();
    await ctx.db.update(experienceEditorSessions).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(experienceEditorSessions.id, session.sessionId));
    const raw = new URL(session.launchUrl).searchParams.get("movcues_editor_token")!;
    const exchange = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://expired.example.com" }, payload: { token: raw } });
    expect(exchange.statusCode).toBe(401);
  });

  it("orders eligible experiences by priority with a stable id tie-break", async () => {
    const { owner, site } = await setup(ctx.app, "priority");
    async function create(name: string, priority: number, interruptPolicy?: "queue" | "interrupt") {
      const item = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "toast", name, buildUrl: "https://priority.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
      const definition = item.draftVersion.definition; definition.targeting.priority = priority; if (interruptPolicy) definition.targeting.interruptPolicy = interruptPolicy;
      await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${item.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition, revision: item.draftVersion.revision } });
      await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${item.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } });
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
    await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${a.owner.org.id}/sites/${a.site.id}/experiences/${created.id}/publish`, headers: { authorization: `Bearer ${a.owner.accessToken}` } });
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
    await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: created.draftVersion.revision } }); const published = await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: authorization }); expect(published.statusCode).toBe(200);
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
    const definition = created.draftVersion.definition; definition.builder = { version: 1, projectData: { pages: [{ id: "main", component: { type: "wrapper" } }] }, html: '<section class="movcues-widget"><button data-movcues-action-id="primary">Continue</button></section>', css: ".movcues-widget .button{color:#fff}" };
    const saved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: created.draftVersion.revision } }); expect(saved.statusCode).toBe(200); expect(saved.json().draftVersion.definition.builder.html).toContain("data-movcues-action-id");
    const published = await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: authorization }); expect(published.statusCode).toBe(200);
    const manifest = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?url=https%3A%2F%2Fbuilder-data.example.com%2Fhome&anonymousId=builder_anon&sessionId=builder_session` }); expect(manifest.json().experiences[0].definition.builder.projectData.pages[0].id).toBe("main");
    const nextDraft = published.json().draftVersion.definition; nextDraft.builder.html = '<section class="movcues-widget">Unpublished draft builder</section>'; const nextSaved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition: nextDraft, revision: published.json().draftVersion.revision } }); expect(nextSaved.statusCode).toBe(200);
    const productionAfterDraftEdit = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?url=https%3A%2F%2Fbuilder-data.example.com%2Fhome&anonymousId=builder_anon_2&sessionId=builder_session_2` }); expect(productionAfterDraftEdit.json().experiences[0].definition.builder.html).not.toContain("Unpublished draft builder");
    const editorSession = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/editor-sessions`, headers: authorization })).json(); const editorToken = new URL(editorSession.launchUrl).searchParams.get("movcues_editor_token")!;
    const editorAccess = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin: "https://builder-data.example.com" }, payload: { token: editorToken } }); const editorDraft = await ctx.app.inject({ method: "GET", url: `/public/experience-editor/${editorSession.sessionId}/draft`, headers: { origin: "https://builder-data.example.com", authorization: `Bearer ${editorAccess.json().accessToken}` } }); expect(editorDraft.json().version.definition.builder.html).toContain("Unpublished draft builder");
    definition.builder.html = '<section class="movcues-widget"><script>alert(1)</script></section>'; const invalidMarkup = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: nextSaved.json().draftVersion.revision } }); expect(invalidMarkup.statusCode).toBe(400); expect(invalidMarkup.json().details.issues.length).toBeGreaterThan(0);
    const afterInvalid = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization }); expect(afterInvalid.json().draftVersion.definition.builder.html).toContain("Unpublished draft builder");
    definition.builder.html = '<section class="movcues-widget"><iframe src="https://example.test"></iframe></section>'; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: nextSaved.json().draftVersion.revision } })).statusCode).toBe(400);
    definition.builder.html = '<section class="movcues-widget"><img src="data:image/svg+xml;base64,unsafe"></section>'; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: nextSaved.json().draftVersion.revision } })).statusCode).toBe(400);
    definition.builder.html = '<section class="movcues-widget">Safe</section>'; definition.builder.css = "button{color:red}"; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: nextSaved.json().draftVersion.revision } })).statusCode).toBe(400);
    definition.builder.css = ".movcues-widget{color:red}"; definition.builder.projectData = { pages: [{ component: { script: "alert(1)" } }] }; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: nextSaved.json().draftVersion.revision } })).statusCode).toBe(400);
    definition.builder.projectData = { pages: [{ component: { attributes: { onpointerdown: "alert(1)" } } }] }; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: nextSaved.json().draftVersion.revision } })).statusCode).toBe(400);
  });

  it("creates the new widget defaults and requires a DOM target only for hotspots", async () => {
    const { owner, site } = await setup(ctx.app, "adoption-widgets");
    const expectedSize = { modal: { width: { mode: "fixed", value: 600 }, height: { mode: "auto" } }, slideout: { width: { mode: "fixed", value: 400 }, height: { mode: "auto" } }, banner: { width: { mode: "full" }, height: { mode: "auto" } } } as const;
    for (const widgetType of ["modal", "slideout", "banner"] as const) {
      const create = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType, name: widgetType, buildUrl: "https://adoption-widgets.example.com/home", template: "blank", useBuildPageAsTarget: false } });
      expect(create.statusCode).toBe(201); const item = create.json();
      expect(item.draftVersion.definition.design.size).toEqual(expectedSize[widgetType]);
      expect((await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${item.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } })).statusCode).toBe(200);
    }
    const hotspotCreate = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { kind: "widget", widgetType: "hotspot", name: "hotspot", buildUrl: "https://adoption-widgets.example.com/home", template: "blank", useBuildPageAsTarget: false } });
    expect(hotspotCreate.statusCode).toBe(201); const hotspot = hotspotCreate.json();
    const rejected = await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${hotspot.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } }); expect(rejected.statusCode).toBe(400); expect(rejected.json().error).toBe("target_required");
    hotspot.draftVersion.definition.target = { primarySelector: "#new-feature", fallbackSelectors: ["[data-feature='new']"], reliability: "reliable" };
    expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${hotspot.id}`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { definition: hotspot.draftVersion.definition, revision: hotspot.draftVersion.revision } })).statusCode).toBe(200);
    expect((await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${hotspot.id}/publish`, headers: { authorization: `Bearer ${owner.accessToken}` } })).statusCode).toBe(200);
  });

  it("round-trips valid sizing and rejects widget-specific constraint bypasses", async () => {
    const { owner, site } = await setup(ctx.app, "widget-sizing"); const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "widget", widgetType: "modal", name: "Sized modal", buildUrl: "https://widget-sizing.example.com/home", template: "blank", useBuildPageAsTarget: false } })).json();
    const definition = created.draftVersion.definition; definition.design.size = { width: { mode: "full" }, height: { mode: "viewport" } };
    const saved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: created.draftVersion.revision } }); expect(saved.statusCode).toBe(200); expect(saved.json().draftVersion.definition.design.size.width.mode).toBe("full");
    definition.design.size = { width: { mode: "fixed", value: 961 }, height: { mode: "auto" } };
    const oversized = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: saved.json().draftVersion.revision } }); expect(oversized.statusCode).toBe(400); expect(oversized.json().error).toBe("invalid_widget_size");
    delete definition.design.size; expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: saved.json().draftVersion.revision } })).statusCode).toBe(200);
  });

  it("creates and publishes a validated multi-step survey and persists submitted or abandoned structured responses", async () => {
    const { owner, site } = await setup(ctx.app, "survey"); const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const createdResponse = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "widget", widgetType: "survey", name: "Task feedback", buildUrl: "https://survey.example.com/task", template: "blank", useBuildPageAsTarget: false } });
    expect(createdResponse.statusCode).toBe(201); const created = createdResponse.json(); const definition = created.draftVersion.definition;
    expect(definition.survey.steps).toHaveLength(2); expect(definition.design.size.width.value).toBe(700); expect(definition.behavior).toMatchObject({ modalLayout: "center", backdrop: true, backdropOpacity: 0.45, closeOnBackdrop: false, dismissible: true });
    const duplicate = structuredClone(definition); duplicate.survey.steps[1].questions = [{ ...duplicate.survey.steps[0].questions[0] }];
    expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition: duplicate, revision: created.draftVersion.revision } })).statusCode).toBe(400);
    definition.survey.steps[0].builder.html = definition.survey.steps[0].builder.html.replace('class="movcues-survey-footer"', 'class="movcues-survey-footer" data-movcues-survey-controls="builder"');
    const saved = await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition, revision: created.draftVersion.revision } }); expect(saved.statusCode).toBe(200);
    const published = await publishReviewed(ctx.app, { method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: authorization }); expect(published.statusCode).toBe(200);
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
