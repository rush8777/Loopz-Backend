// Test-only HTTP service. Always creates its own temporary database and binds loopback.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { env } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { createDb, closeDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { surveyResponses, experienceEvents, experienceImpressions, experienceEditorSessions } from '../../src/db/schema.js';
if (env.NODE_ENV !== 'test') throw new Error('The isolated builder fixture requires NODE_ENV=test');
const directory = mkdtempSync(join(tmpdir(), 'movcues-builder-integration-'));
const db = createDb(`file:${join(directory, 'test.db')}`);
await runMigrations(db);
const app = await buildApp(db);
app.get('/__test__/ready', async () => ({ isolated: true }));
app.get('/__test__/analytics/:experienceId', async request => {
  const { experienceId } = request.params as { experienceId: string };
  return { responses: await db.select().from(surveyResponses).where(eq(surveyResponses.experienceId, experienceId)), events: await db.select().from(experienceEvents).where(eq(experienceEvents.experienceId, experienceId)), impressions: await db.select().from(experienceImpressions).where(eq(experienceImpressions.experienceId, experienceId)) };
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
