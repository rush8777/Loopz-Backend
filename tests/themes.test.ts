import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";

const tokens = {
  version: 1 as const,
  colors: { background: "#ffffff", surface: "#f8fafc", text: "#111827", mutedText: "#64748b", primary: "#7c3aed", primaryForeground: "#ffffff", border: "#e2e8f0" },
  typography: { bodyFontFamily: "Inter, sans-serif", headingFontFamily: "Inter, sans-serif", bodyFontSize: 16, headingFontSize: 28, bodyFontWeight: 400, headingFontWeight: 700, bodyLineHeight: 1.5, headingLineHeight: 1.2 },
  radii: { sm: 4, md: 10, lg: 20 },
  shadows: { sm: { x: 0, y: 2, blur: 8, spread: 0, color: "rgba(0, 0, 0, 0.1)" }, md: { x: 0, y: 12, blur: 32, spread: 0, color: "rgba(0, 0, 0, 0.18)" } },
};
const capturePayload = { tokens, evidence: { confidence: { "colors.primary": .9 }, cssVariables: { "--brand-color": "#7c3aed" }, sdkVersion: "0.1.0" } };

describe("site themes", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });

  it("captures from the configured origin, activates an edited candidate, and seeds new experiences", async () => {
    const owner = await signup(ctx.app, { email: "theme-owner@example.com" });
    const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: authorization, payload: { name: "Product", domain: "https://app.example.com" } })).json();
    const capture = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/theme-captures`, headers: authorization })).json().capture;
    const config = await ctx.app.inject({ method: "GET", url: `/public/config/${site.siteId}` });
    expect(config.json().themeCapture.id).toBe(capture.id);
    expect((await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/theme-captures/${capture.id}`, headers: { origin: "https://evil.example.com" }, payload: capturePayload })).statusCode).toBe(403);
    const received = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/theme-captures/${capture.id}`, headers: { origin: "https://app.example.com" }, payload: capturePayload });
    expect(received.statusCode).toBe(201);
    const candidate = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/theme`, headers: authorization });
    expect(candidate.json().candidate).toMatchObject({ captureId: capture.id, origin: "https://app.example.com", tokens: { colors: { primary: "#7c3aed" } } });
    const edited = { ...tokens, colors: { ...tokens.colors, primary: "#db2777" } };
    expect((await ctx.app.inject({ method: "PUT", url: `/orgs/${owner.org.id}/sites/${site.id}/theme`, headers: authorization, payload: { captureId: capture.id, tokens: edited } })).statusCode).toBe(200);
    const experience = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "widget", widgetType: "toast", name: "Themed", buildUrl: "https://app.example.com/home", template: "blank", useBuildPageAsTarget: false } });
    expect(experience.statusCode).toBe(201);
    expect(experience.json().draftVersion.definition.design.theme).toMatchObject({ primary: "#db2777", siteTheme: { version: 1 } });
    expect((await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/theme-captures/${capture.id}`, headers: { origin: "https://app.example.com" }, payload: capturePayload })).statusCode).toBe(409);
  });

  it("requires a domain and prevents cross-tenant reads", async () => {
    const owner = await signup(ctx.app, { email: "theme-owner-two@example.com" });
    const stranger = await signup(ctx.app, { email: "theme-stranger@example.com" });
    const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: authorization, payload: { name: "No domain" } })).json();
    expect((await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/theme-captures`, headers: authorization })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/theme`, headers: { authorization: `Bearer ${stranger.accessToken}` } })).statusCode).toBe(404);
  });
});
