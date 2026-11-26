import { and, eq, sql } from "drizzle-orm";
import { agentSkills, experiences, experienceVersions, sites } from "../src/db/schema.js";
import { geoAgentConfig } from "../src/lib/geoAgent/config.js";
import { answerFromKnowledge } from "../src/lib/geoAgent/answer.js";
import { processKnowledgeJob } from "../src/lib/knowledge/jobs.js";
import { type KnowledgeEmbedder } from "../src/lib/knowledge/embeddings.js";
import { processSkillIndex, registerSkill } from "../src/lib/skills/registry.js";
import { retrieveSkills } from "../src/lib/skills/retrieval.js";
import { createTestApp, signup } from "../tests/helpers.js";

const signal = new AbortController().signal;
const origin = "https://example.test";
const question = "How do I create an invoice?";
const mock: KnowledgeEmbedder = {
  key: "mock:512:1", dimensions: 512,
  async embed(texts) {
    return {
      vectors: texts.map(text => Array.from({ length: 512 }, (_, i) => (i + (text.includes("invoice") ? 1 : 7)) % 13 / 13)),
      tokens: texts.reduce((sum, text) => sum + text.split(/\s+/).length, 0),
    };
  },
};
const statistics = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)), p95: Number(sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2)) };
};
const measure = async (fn: () => Promise<void>, trials = 30) => {
  const recorded = [];
  for (let i = -3; i < trials; i++) {
    const began = performance.now();
    await fn();
    if (i >= 0) recorded.push(performance.now() - began);
  }
  return statistics(recorded);
};
const ctx = await createTestApp({ knowledgeEmbedder: null, aiProvider: null });
try {
  const owner = await signup(ctx.app);
  const [site] = await ctx.db.select().from(sites).where(eq(sites.orgId, owner.org.id)).limit(1);
  const scope = { orgId: owner.org.id, siteId: site.id };
  const headers = { authorization: `Bearer ${owner.accessToken}` };
  const base = `/orgs/${scope.orgId}/sites/${scope.siteId}`;
  const guide = await ctx.app.inject({ method: "POST", url: base + "/experiences", headers, payload: {
    kind: "guide", guidePattern: "modal", builderMode: "onsite", name: "Create an invoice",
    buildUrl: origin, template: "blank", useBuildPageAsTarget: false,
  } });
  if (guide.statusCode !== 201) throw new Error(guide.body);
  const definition = guide.json().draftVersion.definition;
  const sourceResponse = await ctx.app.inject({ method: "POST", url: base + "/knowledge/sources", headers, payload: {
    name: "Billing docs", type: "manual", visibility: "public", config: {
      title: "Create an invoice", content: "Open Billing and choose Create invoice to invoice your customer.",
    },
  } });
  if (sourceResponse.statusCode !== 201) throw new Error(sourceResponse.body);
  await processKnowledgeJob(ctx.db, mock, signal);
  const sourceId = sourceResponse.json().source.id;
  const config = geoAgentConfig.parse({ schemaVersion: 1, appearance: {}, sourceIds: [sourceId] });
  const provider = {
    name: "mock", model: "mock",
    async generate(input: { prompt: string }) {
      const promptTokens = input.prompt.split(/\s+/).length;
      return { provider: "mock", model: "mock", text: JSON.stringify({ lines: ["Open Billing and choose Create invoice. [[K1]]"] }),
        usage: { promptTokens, completionTokens: 8, totalTokens: promptTokens + 8 } };
    },
  };
  const answer = async (selected: string[]) => {
    const first: number[] = [];
    let tokens = 0;
    let retrieval = 0;
    const totalMs = await measure(async () => {
      const now = performance.now();
      const result = await answerFromKnowledge({
        db: ctx.db, scope, config: { ...config, skillIds: selected }, provider, embedder: mock,
        question, history: [], publicOnly: true, skillAccess: { origin }, signal,
        onDelta() { first.push(performance.now() - now); },
      });
      retrieval += result.retrievalMs;
      tokens += result.tokens;
    });
    return { totalMs, firstDeltaMs: statistics(first.slice(3)), meanRetrievalMs: Number((retrieval / 33).toFixed(2)), tokensPerTurn: tokens / 33 };
  };
  console.log(JSON.stringify({ documentsOnly: await answer([]) }));
  const ids: string[] = [];
  for (const count of [10, 100, 500]) {
    const indexed = [];
    while (ids.length < count) {
      const label = ids.length === 0 ? "Create an invoice" : `Configure workspace ${ids.length}`;
      const [guideRow] = await ctx.db.insert(experiences).values({ siteId: site.id, name: label, kind: "guide", status: "published", createdBy: owner.user.id }).returning();
      const [version] = await ctx.db.insert(experienceVersions).values({ experienceId: guideRow.id, versionNumber: 1, state: "published", definition, createdBy: owner.user.id }).returning();
      await ctx.db.update(experiences).set({ publishedVersionId: version.id }).where(eq(experiences.id, guideRow.id));
      await registerSkill(ctx.db, scope, guideRow.id, version.id, { enabled: true, metadata: {
        name: label, description: `This guide covers how to ${label.toLowerCase()}.`,
        intentExamples: [label], keywords: [], preconditions: [],
      } }, "/app");
      const began = performance.now();
      await processSkillIndex(ctx.db, mock, signal);
      indexed.push(performance.now() - began);
      const [skill] = await ctx.db.select({ id: agentSkills.id }).from(agentSkills).where(eq(agentSkills.guideId, guideRow.id));
      ids.push(skill.id);
    }
    const keywordMs = await measure(async () => { await retrieveSkills(ctx.db, scope, ids, question, { origin }, null, signal); });
    const hybridMs = await measure(async () => { await retrieveSkills(ctx.db, scope, ids, question, { origin }, mock, signal); });
    const nativeCosineMs = await measure(async () => {
      await ctx.db.select({ score: sql<number>`vector_distance_cos(vector32(${agentSkills.embedding}), vector32(${JSON.stringify((await mock.embed([question], signal)).vectors[0])}))` })
        .from(agentSkills).where(and(eq(agentSkills.siteId, site.id), eq(agentSkills.embeddingKey, mock.key))).limit(count);
    });
    console.log(JSON.stringify({ count, indexingMs: statistics(indexed), keywordMs, hybridMs, nativeCosineMs, combined: await answer(ids) }));
  }
} finally {
  await ctx.app.close();
  ctx.cleanup();
}
