import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";
import { checklistItemId, checklistItemMarkup } from "../src/lib/experiences/checklistPresets.js";

async function setup(ctx: Awaited<ReturnType<typeof createTestApp>>, suffix: string) {
  const owner = await signup(ctx.app, { email: `checklist-${suffix}@example.com` });
  const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Checklist site", domain: `${suffix}.example.com` } })).json();
  return { owner, site, headers: { authorization: `Bearer ${owner.accessToken}` } };
}

describe("onboarding checklists", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); (ctx.db as unknown as { $client: { close(): void } }).$client.close(); ctx.cleanup(); });

  it("creates without a build URL, persists sticky item completion, acknowledges completion, and reopens for a new item", async () => {
    const { owner, site, headers } = await setup(ctx, "lifecycle"); const base = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const createdResponse = await ctx.app.inject({ method: "POST", url: base, headers, payload: { kind: "checklist", name: "Getting started", template: "default", useBuildPageAsTarget: false } });
    expect(createdResponse.statusCode).toBe(201); const created = createdResponse.json(); expect(created.widgetType).toBeNull(); expect(created.buildUrl).toBeNull(); expect(created.draftVersion.definition.items).toHaveLength(1);
    const published = await ctx.app.inject({ method: "POST", url: `${base}/${created.id}/publish`, headers }); expect(published.statusCode, JSON.stringify(published.json())).toBe(200); const versionId = published.json().publishedVersion.id;
    const query = `url=${encodeURIComponent("https://lifecycle.example.com/home")}&anonymousId=anon_checklist&sessionId=session_checklist`;
    const manifest = await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?${query}` }); expect(manifest.statusCode).toBe(200); expect(manifest.json().checklists).toHaveLength(1);
    const itemId = manifest.json().checklists[0].definition.items[0].id; const identity = { url: "https://lifecycle.example.com/home", anonymousId: "anon_checklist", sessionId: "session_checklist", versionId };
    const click = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/checklists/${created.id}/actions`, payload: { ...identity, action: "item_click", itemId } }); expect(click.statusCode).toBe(200); expect(click.json().progress.complete).toBe(true); expect(click.json().progress.newlyCompletedIds).toEqual([itemId]);
    const acknowledged = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/checklists/${created.id}/actions`, payload: { ...identity, action: "completion_acknowledged" } }); expect(acknowledged.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?${query}` })).json().checklists).toEqual([]);

    const latest = (await ctx.app.inject({ method: "GET", url: `${base}/${created.id}`, headers })).json(); const definition = latest.draftVersion.definition; const second = { id: checklistItemId(), title: "Second task", action: { type: "none" }, completion: { type: "item_clicked" } }; definition.items.push(second); definition.builder.html = definition.builder.html.replace('</div></div><button type="button" class="movecues-checklist__launcher"', `${checklistItemMarkup(second)}</div></div><button type="button" class="movecues-checklist__launcher"`);
    expect((await ctx.app.inject({ method: "PATCH", url: `${base}/${created.id}`, headers, payload: { definition } })).statusCode).toBe(200); expect((await ctx.app.inject({ method: "POST", url: `${base}/${created.id}/publish`, headers })).statusCode).toBe(200);
    const reopened = (await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?${query}` })).json().checklists[0]; expect(reopened.progress.completedItemIds).toEqual([itemId]); expect(reopened.progress.complete).toBe(false); expect(reopened.progress.completionAcknowledged).toBe(false);
  });

  it("explicitly launches a manual Guide while bypassing automatic page and frequency targeting", async () => {
    const { owner, site, headers } = await setup(ctx, "manual"); const base = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = (await ctx.app.inject({ method: "POST", url: base, headers, payload: { kind: "guide", name: "Manual guide", buildUrl: "https://manual.example.com/home", template: "blank", useBuildPageAsTarget: false } })).json(); const definition = created.draftVersion.definition; definition.steps[0].pattern = "modal"; definition.steps[0].behavior = { dismissible: true }; definition.targeting.trigger = { type: "manual" }; definition.targeting.pageRules = [{ id: "elsewhere", kind: "include", operator: "equals", value: "/elsewhere" }];
    expect((await ctx.app.inject({ method: "PATCH", url: `${base}/${created.id}`, headers, payload: { definition } })).statusCode).toBe(200); expect((await ctx.app.inject({ method: "POST", url: `${base}/${created.id}/publish`, headers })).statusCode).toBe(200);
    const query = `url=${encodeURIComponent("https://manual.example.com/home")}&anonymousId=anon_manual&sessionId=session_manual`; expect((await ctx.app.inject({ method: "GET", url: `/public/sites/${site.siteId}/experiences?${query}` })).json().experiences).toEqual([]);
    const launch = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experiences/${created.id}/launch`, payload: { url: "https://manual.example.com/home", anonymousId: "anon_manual", sessionId: "session_manual", source: "api" } }); expect(launch.statusCode).toBe(200); expect(launch.json()).toMatchObject({ id: created.id, kind: "guide", launchContext: { source: "api" } });
  });
});
