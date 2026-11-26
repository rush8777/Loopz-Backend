import { generateKeyPairSync, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InjectOptions } from "fastify";
import { agentSkills, geoAgentConversations, geoAgentTurns, trackedUserProperties, trackedUsers } from "../src/db/schema.js";
import type { AiProvider } from "../src/lib/ai/providers/types.js";
import type { KnowledgeEmbedder } from "../src/lib/knowledge/embeddings.js";
import { processSkillIndex } from "../src/lib/skills/registry.js";
import { retrieveSkills } from "../src/lib/skills/retrieval.js";
import { createTestApp, signup } from "./helpers.js";

const origin = "https://example.test";
const signal = new AbortController().signal;
const metadata = {
  name: "Create an invoice", description: "Create and save an invoice in Billing.",
  intentExamples: ["How do I create an invoice?", "I need to bill a customer"], keywords: ["invoice", "billing"], preconditions: [],
};
const embedding: KnowledgeEmbedder = { key: "mock:2", dimensions: 2, embed: async () => ({ vectors: [[1, 0]], tokens: 12 }) };

describe("Agent skills", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let siteId: string;
  let publicId: string;
  let headers: { authorization: string };
  const generate = vi.fn<AiProvider["generate"]>();

  beforeEach(async () => {
    generate.mockReset();
    ctx = await createTestApp({ aiProvider: { name: "mock", model: "suggest", generate }, knowledgeEmbedder: null });
    const owner = await signup(ctx.app);
    orgId = owner.org.id;
    headers = { authorization: `Bearer ${owner.accessToken}` };
    const site = await ctx.app.inject({ method: "POST", url: `/orgs/${orgId}/sites`, headers, payload: { name: "Billing", domain: origin } });
    expect(site.statusCode, site.body).toBe(201);
    ({ id: siteId, siteId: publicId } = site.json());
  });
  afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });

  const base = () => `/orgs/${orgId}/sites/${siteId}`;
  const send = (method: InjectOptions["method"], path: string, payload?: object) =>
    ctx.app.inject({ method, url: base() + path, headers, payload });
  async function guide() {
    const result = await send("POST", "/experiences", {
      kind: "guide", guidePattern: "modal", builderMode: "onsite", name: metadata.name, buildUrl: origin + "/billing", template: "blank", useBuildPageAsTarget: false,
    });
    expect(result.statusCode, result.body).toBe(201);
    return result.json();
  }
  async function publish(id: string, skill?: { enabled: boolean; metadata?: object }) {
    const current = (await send("GET", `/experiences/${id}`)).json().draftVersion;
    return send("POST", `/experiences/${id}/publish`, { draftVersionId: current.id, revision: current.revision, ...(skill ? { skill } : {}) });
  }
  async function list() {
    const response = await send("GET", "/agent-skills");
    expect(response.statusCode, response.body).toBe(200);
    return response.json().skills;
  }

  it("requires publication and explicit opt-in, validates inputs, isolates orgs, and enforces revision checks", async () => {
    const draft = await guide();
    const path = `/agent-skills/${draft.id}`;
    const approved = { enabled: true, metadata };
    expect((await send("PUT", path, { guideVersionId: draft.draftVersion.id, expectedRevision: null, skill: approved })).statusCode).toBe(404);
    expect((await publish(draft.id, { enabled: true })).statusCode).toBe(400);
    const published = await publish(draft.id);
    expect(published.statusCode, published.body).toBe(200);
    expect(await list()).toEqual([]);
    const guideVersionId = published.json().publishedVersionId;
    const request = { guideVersionId, expectedRevision: null, skill: approved };
    const activated = await send("PUT", path, request);
    expect(activated.statusCode, activated.body).toBe(200);
    const skill = activated.json().skill;
    expect(skill).toMatchObject({ status: "pending", entryPath: "/billing", guideVersionId });
    expect((await send("PUT", path, request)).statusCode).toBe(409);
    const repeated = await send("PUT", path, { ...request, expectedRevision: skill.revision });
    expect(repeated.json().skill.revision).toBe(skill.revision);
    expect(await list()).toHaveLength(1);
    const other = await signup(ctx.app);
    const hostile = await ctx.app.inject({ method: "PUT", url: `/orgs/${other.org.id}/sites/${siteId}${path}`, headers: { authorization: `Bearer ${other.accessToken}` }, payload: request });
    expect(hostile.statusCode).toBe(404);

    const edited = await send("PUT", path, { ...request, expectedRevision: skill.revision,
      skill: { enabled: true, metadata: { ...metadata, description: "Save a new invoice in Billing." } } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().skill.revision).not.toBe(skill.revision);
    expect(await processSkillIndex(ctx.db, embedding, signal)).toBe(true);
    expect((await list())[0].status).toBe("ready");
    const match = (await list())[0];
    const scope = { orgId, siteId };
    const hybrid = await retrieveSkills(ctx.db, scope, [match.id], "I need to bill a customer", { origin }, embedding, signal);
    expect(hybrid.selected?.id).toBe(match.id);
    expect(hybrid.embeddingTokens).toBe(12);
    const unauthorized = await retrieveSkills(ctx.db, { ...scope, orgId: other.org.id }, [match.id], metadata.name, { origin }, embedding, signal);
    expect(unauthorized.selected).toBeUndefined();
    const disallowed = await retrieveSkills(ctx.db, scope, [match.id], metadata.name, { permitted: false, inspect: true }, null, signal);
    expect(disallowed.candidates[0]).toMatchObject({ eligible: false, reason: "widget_targeting" });
    const failedEmbedding = { ...embedding, embed: async () => { throw new Error("offline"); } };
    const keyword = await retrieveSkills(ctx.db, scope, [match.id], metadata.name, {}, failedEmbedding, signal);
    expect(keyword.selected?.id).toBe(match.id);
    expect(keyword.degraded).toBe(true);
  });

  it("isolates obsolete jobs, supports recovery, and excludes republished, paused, and deleted guides", async () => {
    const draft = await guide();
    const approved = { enabled: true, metadata };
    const published = await publish(draft.id, approved);
    expect(published.statusCode, published.body).toBe(200);
    const [old] = await list();
    const broken = { ...embedding, embed: async () => { throw new Error("offline"); } };
    await processSkillIndex(ctx.db, broken, signal);
    expect((await list())[0].status).toBe("failed");
    const path = `/agent-skills/${draft.id}`;
    expect((await send("PUT", path, { guideVersionId: old.guideVersionId, expectedRevision: old.revision, skill: approved })).statusCode).toBe(200);
    let finish!: () => void;
    let claimed!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { claimed = resolve; });
    const delayed = { ...embedding, async embed() { claimed(); await waiting; return { vectors: [[1, 0]], tokens: 12 }; } };
    const worker = processSkillIndex(ctx.db, delayed, signal);
    await entered;
    const newer = await publish(draft.id, { enabled: true, metadata: { ...metadata, description: "Create a customer invoice." } });
    expect(newer.statusCode, newer.body).toBe(200);
    finish();
    await worker;
    expect((await list())[0]).toMatchObject({ status: "pending", id: old.id, guideVersionId: newer.json().publishedVersionId });
    await processSkillIndex(ctx.db, null, signal);
    const query = () => retrieveSkills(ctx.db, { orgId, siteId }, [old.id], metadata.name, { origin }, null, signal);
    expect((await query()).selected?.id).toBe(old.id);
    expect((await publish(draft.id)).statusCode).toBe(200);
    expect((await list())[0].status).toBe("unavailable");
    expect((await query()).selected).toBeUndefined();
    expect((await publish(draft.id, approved)).statusCode).toBe(200);
    await processSkillIndex(ctx.db, null, signal);
    expect((await send("POST", `/experiences/${draft.id}/pause`)).statusCode).toBe(200);
    expect((await query()).selected).toBeUndefined();
    const [paused] = await list();
    expect((await send("PUT", path, { guideVersionId: paused.guideVersionId, expectedRevision: paused.revision, skill: { enabled: false } })).statusCode).toBe(200);
    expect((await list())[0].status).toBe("disabled");
    expect((await send("DELETE", `/experiences/${draft.id}`)).statusCode).toBe(204);
    expect(await ctx.db.select().from(agentSkills)).toEqual([]);
  });

  it("validates metadata suggestions and does not expose recommendations in public streams or history", async () => {
    const draft = await guide();
    const suggested = { versionId: draft.draftVersion.id, revision: draft.draftVersion.revision };
    const path = `/agent-skills/${draft.id}/suggest`;
    const output = { provider: "mock", model: "suggest", usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 } };
    generate.mockResolvedValueOnce({ ...output, text: "invalid JSON" });
    expect((await send("POST", path, suggested)).json().method).toBe("manual");
    const { preconditions, ...modelMetadata } = metadata;
    generate.mockResolvedValueOnce({ ...output, text: JSON.stringify(modelMetadata) });
    expect((await send("POST", path, suggested)).json()).toMatchObject({ method: "ai", metadata });
    expect(await list()).toEqual([]);

    const published = await publish(draft.id, { enabled: true, metadata });
    expect(published.statusCode, published.body).toBe(200);
    await processSkillIndex(ctx.db, null, signal);
    const [skill] = await list();
    const geo = (await send("POST", "/experiences", { kind: "widget", widgetType: "geo_agent", builderMode: "geo_agent", name: "Geo" })).json();
    const definition = geo.draftVersion.definition;
    definition.geoAgent.skillIds = [skill.id];
    const configured = await send("PATCH", `/experiences/${geo.id}`, { definition, revision: geo.draftVersion.revision });
    expect(configured.statusCode, configured.body).toBe(200);
    const previewPath = `/experiences/${geo.id}/geo-agent/preview`;
    const preview = await send("POST", previewPath, { config: definition.geoAgent, question: "I need to bill a customer.", evaluation: { mode: "visitor", url: origin + "/settings", targeting: definition.targeting } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ permitted: true, decision: { decision: "recommend_skill", skillId: skill.id },
      candidates: [{ id: skill.id, eligible: true }], message: metadata.description });
    expect(await ctx.db.select().from(geoAgentConversations)).toEqual([]);

    expect((await publish(geo.id)).statusCode).toBe(200);
    const route = `/public/sites/${publicId}/geo-agent/${geo.id}`;
    const url = origin + "/settings";
    const session = await ctx.app.inject({ method: "POST", url: route + "/session", headers: { origin }, payload: { url } });
    expect(session.statusCode, session.body).toBe(200);
    const visitor = { origin, authorization: `Bearer ${session.json().token}` };
    const qs = "?url=" + encodeURIComponent(url);
    const conversation = await ctx.app.inject({ method: "POST", url: route + "/conversations" + qs, headers: visitor });
    expect(conversation.statusCode, conversation.body).toBe(201);
    const endpoint = route + "/conversations/" + conversation.json().conversationId;
    const turn = await ctx.app.inject({ method: "POST", url: endpoint + "/messages" + qs, headers: visitor, payload: { requestId: crypto.randomUUID(), question: metadata.name } });
    expect(turn.statusCode, turn.body).toBe(200);
    const result = JSON.parse(turn.body.trim().split("\n").at(-1)!).result;
    expect(result).toEqual({ schemaVersion: 1, conversationId: conversation.json().conversationId, messageId: expect.any(String),
      actions: [], citations: [], message: metadata.description });
    expect(turn.body).not.toContain(skill.id);
    const [row] = await ctx.db.select().from(geoAgentTurns).where(eq(geoAgentTurns.id, result.messageId));
    expect(row.skillDiagnostics?.recommendation).toMatchObject({ decision: "recommend_skill", skillId: skill.id });
    const history = await ctx.app.inject({ method: "GET", url: endpoint + qs, headers: visitor });
    expect(history.statusCode).toBe(200);
    expect(history.body).not.toContain(skill.id);
    expect(history.body).toContain('"actions":[]');
  });
  it("requires a signed identity that satisfies the guide audience in visitor simulation", async () => {
    const draft = await guide();
    const now = new Date();
    const [tracked] = await ctx.db.insert(trackedUsers).values({ siteId, externalUserId: "manager", firstSeenAt: now, lastSeenAt: now,
      firstIdentifiedAt: now, lastIdentifiedAt: now }).returning();
    await ctx.db.insert(trackedUserProperties).values({ trackedUserId: tracked.id, siteId, name: "plan", value: "pro", valueType: "string",
      source: "identify", firstSeenAt: now, lastSeenAt: now });
    const segment = await send("POST", "/segments", { name: "Billing managers", definition: { logic: "and",
      conditions: [{ type: "user_property", propertyName: "plan", operator: "equals", value: "pro" }] } });
    expect(segment.statusCode, segment.body).toBe(201);
    const { definition, revision } = draft.draftVersion;
    definition.targeting.audience = { type: "segment", segmentId: segment.json().id };
    const changed = await send("PATCH", `/experiences/${draft.id}`, { settings: { targeting: definition.targeting }, revision });
    expect(changed.statusCode, changed.body).toBe(200);
    const published = await publish(draft.id, { enabled: true, metadata });
    expect(published.statusCode, published.body).toBe(200);
    await processSkillIndex(ctx.db, null, signal);
    const [skill] = await list();
    const geo = (await send("POST", "/experiences", { kind: "widget", widgetType: "geo_agent", builderMode: "geo_agent", name: "Geo" })).json();
    const config = geo.draftVersion.definition.geoAgent;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    config.identityPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
    config.skillIds = [skill.id];
    const token = (iss: string, sub: string) => {
      const encoded = [JSON.stringify({ alg: "EdDSA" }), JSON.stringify({ iss, sub, aud: "movcues-geo-agent", exp: Math.floor(Date.now() / 1000) + 120 })]
        .map(value => Buffer.from(value).toString("base64url")).join(".");
      return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`;
    };
    const preview = (mode: "admin" | "visitor", identityToken?: string) => send("POST", `/experiences/${geo.id}/geo-agent/preview`, {
      config, question: metadata.name, evaluation: { mode, url: origin + "/settings", targeting: geo.draftVersion.definition.targeting, identityToken },
    });
    for (const mode of ["admin", "visitor"] as const) {
      const anonymous = await preview(mode);
      expect(anonymous.statusCode, anonymous.body).toBe(200);
      expect(anonymous.json().decision.decision).not.toBe("recommend_skill");
      expect(anonymous.json().candidates[0].reason).toBe("verified_identity_required");
    }
    expect((await preview("visitor", token("foreign-site", "manager"))).statusCode).toBe(401);
    expect((await preview("visitor", token(publicId, "unknown-manager"))).json().candidates[0].reason).toBe("audience_restricted");
    expect((await preview("visitor", token(publicId, "manager"))).json().decision.decision).toBe("recommend_skill");
  });

});
