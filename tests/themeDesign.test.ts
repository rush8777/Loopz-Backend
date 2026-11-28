import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, signup } from "./helpers.js";
import type { AiGenerateInput, AiGenerateResult } from "../src/lib/ai/providers/types.js";
import { fallbackTheme } from "../src/lib/themes/designSystem.js";
import { componentTheme } from "../src/lib/themes/types.js";
import type { CapturedDesign } from "../src/lib/themes/validation.js";

const evidence: CapturedDesign = {
  version: 2,
  variables: { primary: "#6c4be0" },
  confidence: { typography: .85, primary: .95, surfaces: .85 },
  samples: [
    { role: "page", count: 1, fontFamily: "Arial", fontSize: 16, fontWeight: 400, lineHeight: 1.5,
      letterSpacing: 0, background: "#171b2a", color: "#eef0f8", borderWidth: 0, radius: 0, padding: 8, gap: 0 },
    { role: "display", count: 1, fontFamily: "Georgia", fontSize: 76, fontWeight: 800, lineHeight: 1,
      letterSpacing: 0, borderWidth: 0, radius: 0, padding: 0, gap: 0 },
    { role: "heading", count: 3, fontFamily: "Arial", fontSize: 21, fontWeight: 650, lineHeight: 1.3,
      letterSpacing: 0, borderWidth: 0, radius: 0, padding: 0, gap: 0 },
  ],
};

const output = (text: string): AiGenerateResult => ({
  text, provider: "mock", model: "theme-fixture", usage: { promptTokens: 550, completionTokens: 340, totalTokens: 890 },
});

describe("Geo Theme Studio", () => {
  const generate = vi.fn<(input: AiGenerateInput) => Promise<AiGenerateResult>>();
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let root: string;
  let siteId: string;
  let headers: { authorization: string };

  beforeEach(async () => {
    generate.mockReset();
    ctx = await createTestApp({ aiProvider: { name: "mock", model: "theme-fixture", generate } });
    const account = await signup(ctx.app);
    headers = { authorization: `Bearer ${account.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${account.org.id}/sites`, headers, payload: {
      name: "Studio", domain: "https://studio.example.test",
    } })).json();
    root = `/orgs/${account.org.id}/sites/${site.id}`;
    siteId = site.siteId;
  });
  afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });

  async function captureDesign() {
    const capture = (await ctx.app.inject({ method: "POST", url: `${root}/theme-captures`, headers, payload: { explicit: true } })).json().capture;
    const configUrl = `/public/config/${siteId}`;
    expect((await ctx.app.inject({ method: "GET", url: configUrl })).json().themeCapture).toBeUndefined();
    expect((await ctx.app.inject({ method: "GET", url: `${configUrl}?themeCapture=${capture.id}` })).json().themeCapture.id).toBe(capture.id);
    const received = await ctx.app.inject({ method: "POST", url: `/public/sites/${siteId}/theme-captures/${capture.id}`,
      headers: { origin: "https://studio.example.test" }, payload: { evidence } });
    expect(received.statusCode, received.body).toBe(201);
    return { id: capture.id as string, url: `${root}/theme-captures/${capture.id}/design` };
  }

  it("generates once per capture, clamps display sizes and keeps the proposal out of active experiences", async () => {
    const { id, url } = await captureDesign();
    let finish!: (result: AiGenerateResult) => void;
    generate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const request = ctx.app.inject({ method: "POST", url, headers }).then(response => response);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect((await ctx.app.inject({ method: "POST", url, headers })).json().status).toBe("working");
    const invalidScale = fallbackTheme(evidence);
    invalidScale.components!.guide!.headingFontSize = 60;
    invalidScale.colors.primaryForeground = "#6c4be0";
    invalidScale.typography.headingFontFamily = "Unobserved Fancy Face";
    finish(output(JSON.stringify({ tokens: invalidScale, explanation: "Matched the product’s dark surfaces.", assumptions: ["Used Arial from application headings."] })));
    const generated = (await request).json();
    expect(generated).toMatchObject({ status: "ready", proposal: { tokens: { version: 2, typography: { headingFontFamily: "Arial" },
      colors: { primary: "#6c4be0", primaryForeground: "#ffffff" }, components: { guide: { headingFontSize: 18 } } } } });
    expect(generate.mock.calls[0][0].prompt).not.toContain("Georgia");
    expect((await ctx.app.inject({ method: "POST", url, headers })).json()).toEqual(generated);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await ctx.app.inject({ method: "GET", url: `${root}/theme`, headers })).json().active).toBeNull();

    const saved = await ctx.app.inject({ method: "POST", url: `${root}/style-presets`, headers, payload: {
      name: "Studio dark", sourceCaptureId: id, tokens: generated.proposal.tokens,
    } });
    expect(saved.statusCode, saved.body).toBe(201);
    const style = saved.json().preset;
    expect(style.sourceCaptureId).toBe(id);
    expect(style.sourceDesign).toEqual(generated.proposal);
    const stale = await ctx.app.inject({ method: "PATCH", url: `${root}/style-presets/${style.id}`, headers, payload: { name: "Stale edit", expectedUpdatedAt: "2020-01-01T00:00:00Z" } });
    expect(stale.json()).toEqual({ error: "style_preset_conflict" });
    const reimport = await captureDesign();
    expect(reimport.id).not.toBe(id);
    expect((await ctx.app.inject({ method: "GET", url, headers })).json()).toEqual(generated);
  });

  it("labels malformed or failed responses as fallback and allows an explicit retry", async () => {
    const capture = await captureDesign();
    generate.mockResolvedValueOnce(output('{ "tokens": { "arbitraryCss": "script()" } }'));
    generate.mockRejectedValueOnce(new Error("network unavailable"));
    const malformed = (await ctx.app.inject({ method: "POST", url: capture.url, headers })).json();
    expect(malformed).toMatchObject({ status: "failed", reason: "invalid_design", fallback: {
      version: 2, colors: { background: "#171b2a" }, typography: { headingFontFamily: "Arial" },
    } });
    expect((await ctx.app.inject({ method: "POST", url: capture.url, headers })).json()).toEqual(malformed);
    const savedFallback = (await ctx.app.inject({ method: "POST", url: `${root}/style-presets`, headers, payload: {
      name: "Fallback design", sourceCaptureId: capture.id, sourceFallback: true, tokens: malformed.fallback,
    } })).json().preset;
    expect(savedFallback.sourceDesign.tokens).toEqual(malformed.fallback);
    expect((await ctx.app.inject({ method: "POST", url: capture.url, headers, payload: { retry: true } })).json().reason).toBe("provider_error");
    expect(generate).toHaveBeenCalledTimes(2);
    const stranger = await signup(ctx.app);
    expect((await ctx.app.inject({ method: "GET", url: capture.url, headers: { authorization: `Bearer ${stranger.accessToken}` } })).statusCode).toBe(404);
  });

  it("turns a provider timeout into an explicit fallback", async () => {
    const { url } = await captureDesign();
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => milliseconds === 42_000
      ? AbortSignal.abort(new DOMException("Fixture elapsed", "TimeoutError"))
      : originalTimeout.call(AbortSignal, milliseconds));
    generate.mockImplementation(async input => {
      input.signal?.throwIfAborted();
      return output("{}");
    });
    try {
      const result = (await ctx.app.inject({ method: "POST", url, headers })).json();
      expect(result).toMatchObject({ status: "failed", reason: "timeout", fallback: { version: 2 } });
    } finally { timeout.mockRestore(); }
  });

  it("validates assistant scope and leaves unrelated theme fields untouched", async () => {
    const tokens = fallbackTheme(evidence);
    const url = `${root}/theme-proposals`;
    generate.mockResolvedValueOnce(output(JSON.stringify({ scope: "experience", target: "survey", changes: { headingFontSize: 24 }, explanation: "Raised the survey heading." })));
    const payload = { tokens, request: "Only update the survey heading", scope: "survey", revision: 3 };
    const result = await ctx.app.inject({ method: "POST", url, headers, payload });
    expect(result.statusCode, result.body).toBe(200);
    const { tokens: edited, revision } = result.json();
    expect(revision).toBe(3);
    expect(edited.components.survey.headingFontSize).toBe(24);
    expect(edited.components.modal).toEqual(JSON.parse(JSON.stringify(tokens.components?.modal)));
    expect(edited.colors).toEqual(tokens.colors);
    generate.mockResolvedValueOnce(output(JSON.stringify({ scope: "foundation", changes: { colors: { primary: "#333333" } }, explanation: "Changed all buttons." })));
    expect((await ctx.app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(502);
    expect((await ctx.app.inject({ method: "GET", url: `${root}/style-presets`, headers })).json()).toEqual({ presets: [] });
  });

  it("resolves inherited controls before component overrides and retains legacy input", () => {
    const theme = fallbackTheme(evidence);
    theme.shared = { primaryButton: { radius: 10, minHeight: 38 }, secondaryButton: { radius: 8 } };
    theme.components!.modal!.buttonRadius = 14;
    const modal = componentTheme(theme, "modal");
    expect(modal.shared).toEqual({ primaryButton: { radius: 14, minHeight: 38 }, secondaryButton: { radius: 14 } });
    expect(modal.typography.headingFontSize).toBe(25);
    expect(theme.shared.primaryButton?.radius).toBe(10);
  });
});
