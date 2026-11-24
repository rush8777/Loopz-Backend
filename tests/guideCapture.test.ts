import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "../src/config.js";
import { experienceEditorSessions, guideCaptureCheckpoints } from "../src/db/schema.js";
import { capturePlanSchema, parseCapturePlan } from "../src/lib/experiences/guideCapture.js";
import { onsiteDocumentFromBuilder } from "../src/lib/experiences/onsiteDocument.js";
import { createTestApp, signup } from "./helpers.js";

const origin = "https://guide-capture.example.test";
const fixture = {
  name: "First invoice", kind: "guide", builderMode: "onsite", guideCreation: "guided_capture", buildUrl: origin + "/invoices",
  theme: { source: "preset", preset: "dark" }, useBuildPageAsTarget: true,
};
const targets = [
  { id: "create", target: { primarySelector: "button#create", fallbackSelectors: ['button[data-testid="new-invoice"]'], reliability: "reliable", tagName: "button", label: "New invoice", targetContext: { pagePath: "/invoices" } } },
  { id: "details", target: { primarySelector: "input#details", fallbackSelectors: [], reliability: "reliable", tagName: "input", label: "Invoice details", targetContext: { pagePath: "/invoices/new" } } },
  { id: "save", target: { primarySelector: "button#save", fallbackSelectors: [], reliability: "reliable", tagName: "button", label: "Save invoice", targetContext: { pagePath: "/invoices/new" } } },
] as const;
const step = { purpose: "Guide the author", pattern: "modal", targetId: null, heading: "Create an invoice", body: "Add the details, then review.", advance: { type: "button" }, delayMs: 0, missingTarget: null };
const plan = { steps: [
  step,
  { ...step, pattern: "anchored_card", targetId: "create", advance: { type: "route", targetId: "details" }, missingTarget: { action: "wait", timeoutMs: 5000 } },
  { ...step, pattern: "anchored_card", targetId: "save", advance: { type: "unconfigured", reason: "Verify submission." } },
  { ...step, heading: "Invoice created" },
] };

const generate = vi.fn(async ({ prompt }: { prompt: string }) => {
  if (prompt.includes("offline")) throw new Error("Provider unavailable");
  const text = prompt.includes("untrusted") ? '{"steps":[{"targetId":"unknown"}]}' : JSON.stringify(plan);
  return { text, provider: "mock" as const, model: "capture", usage: { promptTokens: 34, completionTokens: 21, totalTokens: 55 } };
});

describe("guide capture editor API", () => {
  let all: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    const ctx = await createTestApp({ aiProvider: { name: "mock", model: "capture", generate } });
    const account = await signup(ctx.app);
    const headers = { authorization: `Bearer ${account.accessToken}` };
    const response = await ctx.app.inject({ method: "POST", url: `/orgs/${account.org.id}/sites`, headers, payload: { name: "Guide Capture", domain: "guide-capture.example.test" } });
    const site = response.json();
    const root = `/orgs/${account.org.id}/sites/${site.id}`;
    const dashboard = `${root}/experiences`;

    async function open(id: string) {
      const session = await ctx.app.inject({ method: "POST", url: `${dashboard}/${id}/editor-sessions`, headers });
      expect(session.statusCode, session.body).toBe(201);
      const { launchUrl, sessionId } = session.json();
      const exchange = await ctx.app.inject({ method: "POST", url: "/public/experience-editor/exchange", headers: { origin }, payload: { token: new URL(launchUrl).searchParams.get("movcues_editor_token"), includeDraft: true } });
      expect(exchange.statusCode, exchange.body).toBe(200);
      return { sessionId, editor: `/public/experience-editor/${sessionId}`, editorHeaders: { origin, authorization: `Bearer ${exchange.json().accessToken}` }, exchange: exchange.json() };
    }
    const create = (payload: Record<string, unknown> = fixture) => ctx.app.inject({ method: "POST", url: dashboard, headers, payload });
    return { ...ctx, root, dashboard, headers, open, create };
  }

  beforeEach(async () => { env.GUIDE_CAPTURE_ENABLED = true; generate.mockClear(); all = await setup(); });
  afterEach(async () => { env.GUIDE_CAPTURE_ENABLED = false; await all.app.close(); all.cleanup(); });

  it("keeps the capability off by default and preserves manual creation", async () => {
    env.GUIDE_CAPTURE_ENABLED = false;
    const catalog = await all.app.inject({ method: "GET", url: `${all.root}/experience-templates?kind=guide`, headers: all.headers });
    expect(catalog.json().guidedCaptureEnabled).toBeUndefined();
    expect((await all.create()).statusCode).toBe(409);
    const result = await all.create({ ...fixture, guideCreation: undefined });
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json().guidedCapturePending).toBeUndefined();
    const session = await all.open(result.json().id);
    expect(session.exchange.draft.guidedCapture).toBeUndefined();
  });

  it("scopes checkpoints, persists them across editor sessions and replaces the draft only after preview and apply", async () => {
    const created = await all.create();
    expect(created.statusCode, created.body).toBe(201);
    const { id, draftVersion } = created.json();
    expect(created.json().guidedCapturePending).toBe(true);
    const publish = () => all.app.inject({ method: "POST", url: `${all.dashboard}/${id}/publish`, headers: all.headers, payload: { draftVersionId: draftVersion.id, revision: 1 } });
    expect((await publish()).json().message).toContain("Finish Guided Capture");
    const first = await all.open(id);
    expect(first.exchange.draft.guidedCapture).toBe(true);
    const observations = [
      { type: "click", sequence: 1, path: "/invoices", targetId: targets[0].id, control: "link" },
      { type: "route", sequence: 2, from: "/invoices", to: "/invoices/new", afterClick: 1 },
    ];
    const workflow = { stage: "preview", prompt: "Create a first invoice", plan, draftRevision: 1, previewStepId: "capture_step_2" };
    const initial = await all.app.inject({ method: "PUT", url: `${first.editor}/guide-capture`, headers: first.editorHeaders, payload: { checkpointRevision: 0, mode: "navigate", targets, observations, workflow } });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json().checkpointRevision).toBe(1);
    await all.db.update(experienceEditorSessions).set({ expiresAt: new Date(0) }).where(eq(experienceEditorSessions.id, first.sessionId));
    const denied = await all.app.inject({ method: "GET", url: `${first.editor}/guide-capture`, headers: first.editorHeaders });
    expect(denied.statusCode).toBe(401);

    env.GUIDE_CAPTURE_ENABLED = false;
    expect((await all.create({ ...fixture, name: "New capture while disabled" })).statusCode).toBe(409);
    const { editor, editorHeaders, sessionId } = await all.open(id);
    const base = `${editor}/guide-capture`;
    const call = (suffix: string, payload?: unknown) => all.app.inject({
      method: payload === undefined ? "GET" : "POST", url: base + suffix, headers: editorHeaders, ...(payload === undefined ? {} : { payload: payload as object }),
    });
    expect((await call("")).json()).toMatchObject({ checkpointRevision: 1, revision: 1, mode: "navigate", targets, observations, workflow });
    expect((await all.app.inject({ method: "GET", url: base, headers: { ...editorHeaders, origin: "https://other.example.test" } })).statusCode).toBe(401);
    expect((await all.app.inject({ method: "PUT", url: base, headers: editorHeaders, payload: { checkpointRevision: 0, mode: "select", targets: [] } })).statusCode).toBe(409);
    const unsafe = [{ ...targets[0], target: { ...targets[0].target, primarySelector: 'a[href="/reset?token=secret"]' } }];
    expect((await all.app.inject({ method: "PUT", url: base, headers: editorHeaders, payload: { checkpointRevision: 1, mode: "select", targets: unsafe } })).statusCode).toBe(400);

    const revisions = { revision: 1, checkpointRevision: 1 };
    for (const prompt of ["untrusted", "offline"]) expect((await call("/plan", { ...revisions, prompt })).statusCode).toBe(502);
    expect((await call("/plan", { ...revisions, prompt: "Create a first invoice" })).json()).toMatchObject({ plan });
    const providerPayload = generate.mock.lastCall?.[0].prompt ?? "";
    expect(providerPayload).toContain("Invoice details");
    expect(JSON.parse(providerPayload).observations).toEqual(observations);
    expect(providerPayload).not.toContain('button#create');
    expect((await call("/preview", { ...revisions, plan })).statusCode).toBe(400);
    expect((await call("/preview", { ...revisions, plan: { steps: Array(21).fill(step) } })).statusCode).toBe(400);

    const configured = structuredClone(plan);
    configured.steps[2].advance = { type: "custom_event", eventName: "invoice_created" };
    const payload = { ...revisions, plan: configured };
    const preview = await call("/preview", payload);
    expect(preview.statusCode, preview.body).toBe(200);
    const { definition, previewTicket } = preview.json();
    expect(definition.design.theme).toMatchObject(draftVersion.definition.design.theme);
    expect(definition.steps[0].builder.html).toContain('aria-label="sparkles"');
    expect(definition.steps[1].builder.html).not.toContain("data-movcues-action-id");
    expect(definition.steps[3].builder.html).toContain('aria-label="check"');
    expect(definition.steps[1].advance.pageRules).toEqual(expect.arrayContaining([expect.objectContaining({ operator: "equals", value: "/invoices/new" })]));
    expect(definition.steps[2].advance).toEqual({ type: "custom_event", eventName: "invoice_created" });
    expect(definition.steps[1].target.targetContext).toEqual({ pagePath: "/invoices", match: "path" });
    expect(definition.steps.every((item: { builder: Parameters<typeof onsiteDocumentFromBuilder>[0] }) => onsiteDocumentFromBuilder(item.builder)?.schemaVersion === 2)).toBe(true);
    expect((await all.app.inject({ method: "GET", url: `${editor}/draft`, headers: editorHeaders })).json().version.revision).toBe(1);
    expect((await call("/apply", { ...payload, previewTicket: "0".repeat(64) })).statusCode).toBe(409);
    expect((await call("/apply", { ...payload, revision: 2, previewTicket })).statusCode).toBe(409);
    const applied = await call("/apply", { ...payload, previewTicket });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().version).toMatchObject({ revision: 2, definition });
    expect(await all.db.select().from(guideCaptureCheckpoints).where(eq(guideCaptureCheckpoints.editorSessionId, sessionId))).toHaveLength(0);
    expect((await all.app.inject({ method: "GET", url: `${editor}/draft`, headers: editorHeaders })).json().guidedCapture).toBeUndefined();
  });

  it("rejects invented targets, unsupported actions, and submission clicks in provider output", () => {
    const captured = structuredClone(targets);
    const attempt = (advance: unknown, targetId = "save") => JSON.stringify({ steps: [{ ...step, pattern: "anchored_card", targetId, advance }, step] });
    const valid = captured.map(item => ({ ...item, target: { ...item.target, fallbackSelectors: [...item.target.fallbackSelectors] } }));
    expect(() => parseCapturePlan(attempt({ type: "element_click" }), valid)).toThrow("does not verify success");
    expect(() => parseCapturePlan(attempt({ type: "route", targetId: "invented" }), valid)).toThrow("different page");
    expect(() => parseCapturePlan(attempt({ type: "button" }, "invented"), valid)).toThrow("from this capture");
    expect(() => parseCapturePlan(attempt({ type: "custom_event", eventName: "invented" }), valid)).toThrow("author must confirm");
    expect(parseCapturePlan(attempt({ type: "button" }), valid).steps[0].advance.type).toBe("unconfigured");
    const unobserved = parseCapturePlan(JSON.stringify(plan), valid, [
      { type: "route", sequence: 1, from: "/invoices", to: "/settings" },
    ]);
    expect(unobserved.steps[1].advance).toMatchObject({ type: "unconfigured", reason: expect.stringContaining("not observed") });
    expect(capturePlanSchema.safeParse({ steps: [{ ...step, heading: "<img src=x>" }] }).success).toBe(false);
  });
});
