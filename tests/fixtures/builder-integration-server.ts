// Test-only HTTP service. Always creates its own temporary database and binds loopback.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { env } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import type { AiProvider } from '../../src/lib/ai/providers/types.js';
import { createDb, closeDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { checklistStates, checklistItemCompletions, surveyResponses, experienceEvents, experienceImpressions, experienceEditorSessions } from '../../src/db/schema.js';
if (env.NODE_ENV !== 'test') throw new Error('The isolated builder fixture requires NODE_ENV=test');
const directory = mkdtempSync(join(tmpdir(), 'movcues-builder-integration-'));
const db = createDb(`file:${join(directory, 'test.db')}`);
await runMigrations(db);
const guideCaptureProvider: AiProvider = {
  name: "mock", model: "guide-capture-integration",
  async generate({ prompt }) {
    const { captured } = JSON.parse(prompt) as { captured: Array<{ id: string }> };
    if (captured.length !== 4) throw new Error("The integration journey expects four targets");
    const [navigation, heading, create, finish] = captured;
    const modal = { pattern: "modal", targetId: null, purpose: "Explain the journey", body: "Follow these steps to create a project.", delayMs: 0, missingTarget: null, advance: { type: "button" } };
    const tooltip = { ...modal, pattern: "anchored_card", purpose: "Show the captured control", missingTarget: { action: "wait", timeoutMs: 5000 } };
    return {
      text: JSON.stringify({ steps: [
        { ...modal, heading: "Welcome to your project tour" },
        { ...tooltip, heading: "Open Features", targetId: navigation.id, advance: { type: "route", targetId: heading.id } },
        { ...tooltip, heading: "Project details", targetId: heading.id },
        { ...tooltip, heading: "Create a project", targetId: create.id, advance: { type: "route", targetId: finish.id } },
        { ...tooltip, heading: "Finish the website task", targetId: finish.id, advance: { type: "unconfigured", reason: "Confirm an application event for project creation." } },
        { ...modal, heading: "Your project is ready" },
      ] }),
      provider: "mock", model: this.model, usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
    };
  },
};
const geoProvider: AiProvider = {
  name: "mock", model: "geo-agent-integration",
  async generate() { throw new Error("Expected the visitor streaming provider"); },
  async streamText(input, delta) {
    const prompt = JSON.parse(input.prompt);
    if (!prompt.excerpts?.length) throw new Error("Expected retrieved knowledge");
    if (prompt.question.includes("slow")) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(input.signal?.reason); };
      const timer = setTimeout(() => { input.signal?.removeEventListener("abort", abort); resolve(); }, 3000);
      input.signal?.addEventListener("abort", abort, { once: true });
    });
    delta("Open Billing and choose New invoice. [[K1]]\n");
    return { text: "", provider: "mock", model: this.model, usage: { promptTokens: 46, completionTokens: 14, totalTokens: 60 } };
  },
};
const app = await buildApp(db, env.GUIDE_CAPTURE_ENABLED ? { aiProvider: guideCaptureProvider }
  : process.env.GEO_AGENT_INTEGRATION === "true" ? { aiProvider: geoProvider, knowledgeEmbedder: null } : {});
app.get('/__test__/ready', async () => ({ isolated: true }));
app.get('/__test__/analytics/:experienceId', async request => {
  const { experienceId } = request.params as { experienceId: string };
  return { responses: await db.select().from(surveyResponses).where(eq(surveyResponses.experienceId, experienceId)), events: await db.select().from(experienceEvents).where(eq(experienceEvents.experienceId, experienceId)), impressions: await db.select().from(experienceImpressions).where(eq(experienceImpressions.experienceId, experienceId)) };
});
app.get('/__test__/checklist/:experienceId',async request=>{
 const {experienceId}=request.params as {experienceId:string};const states=await db.select().from(checklistStates).where(eq(checklistStates.experienceId,experienceId));
 const completions=await db.select().from(checklistItemCompletions);return{states,completions:completions.filter(row=>states.some(state=>state.id===row.checklistStateId))};
});
app.post('/__test__/expire/:experienceId', async request => {
  const { experienceId } = request.params as { experienceId: string };
  await db.update(experienceEditorSessions).set({ expiresAt: new Date(0) }).where(eq(experienceEditorSessions.experienceId, experienceId));
  return { expired: true };
});
await app.listen({ host: '127.0.0.1', port: 4310 });
let closing = false;
async function close() { if (closing) return; closing = true; await app.close(); await closeDb(db); rmSync(directory, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
