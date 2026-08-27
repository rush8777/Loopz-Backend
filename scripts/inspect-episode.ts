/**
 * inspect-episode.ts
 *
 * Renders one *persisted* episode - i.e. a row already written to the
 * `episodes`/`behavioral_events` tables by a previous
 * `POST .../analysis/patterns/observe` call (or `runSiteObservation()`
 * directly) - by its real database id. This is different from
 * `diagnose-similarity.ts`, which recompiles fresh from raw
 * `session_events` on the fly; this script shows you exactly what's
 * actually sitting in the DB right now, including full evidence for
 * every derived signal (the direct output of cursor aggregation).
 *
 * Since episode ids aren't something you'd normally have memorized,
 * `--list` finds them for you first.
 *
 * Usage:
 *   # find episode ids for a session
 *   DATABASE_URL=./dev.db npx tsx scripts/inspect-episode.ts \
 *     --site <siteId> --session <sessionId> --list
 *
 *   # render one episode's full persisted behavioral events + evidence
 *   DATABASE_URL=./dev.db npx tsx scripts/inspect-episode.ts \
 *     --episode <episodeId>
 */
import { eq, asc } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { episodes, behavioralEvents } from "../src/db/schema.js";
import { formatVerboseAnnotation } from "../src/lib/behavior/evidenceFormat.js";
import { describeElementIdentity, hasStableIdentity, type ElementIdentity } from "../src/lib/behavior/elementIdentity.js";
import type { BehavioralEventEvidence } from "../src/lib/behavior/behavioralEvent.js";

function getFlag(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

async function listEpisodesForSession(db: ReturnType<typeof createDb>, siteId: string, sessionId: string) {
  const rows = await db.select().from(episodes).where(eq(episodes.siteId, siteId));
  const forSession = rows.filter((r) => r.sessionId === sessionId).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  if (forSession.length === 0) {
    console.log(`\nNo persisted episodes found for session "${sessionId}" on site "${siteId}".`);
    console.log("Has an observation run been triggered for this site yet? (POST .../analysis/patterns/observe, or run-observation-cli.ts)");
    return;
  }

  console.log(`\nEpisodes for session "${sessionId}":\n`);
  for (const ep of forSession) {
    console.log(`  ${ep.id}`);
    console.log(`    ${ep.startedAt.toISOString()} -> ${ep.endedAt.toISOString()}  (${ep.startReason} -> ${ep.endReason})`);
  }
  console.log(`\nRun with --episode <id> to see one of these in full.\n`);
}

async function renderEpisode(db: ReturnType<typeof createDb>, episodeId: string) {
  const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  if (!episode) {
    console.error(`No persisted episode found with id "${episodeId}". Use --site/--session --list to find real ids.`);
    process.exit(1);
  }

  console.log(`\nEpisode ${episode.id}`);
  console.log(`  site:    ${episode.siteId}`);
  console.log(`  session: ${episode.sessionId}`);
  console.log(`  span:    ${episode.startedAt.toISOString()} -> ${episode.endedAt.toISOString()}`);
  console.log(`  boundary: ${episode.startReason} -> ${episode.endReason}`);

  const rows = await db
    .select()
    .from(behavioralEvents)
    .where(eq(behavioralEvents.episodeId, episode.id))
    .orderBy(asc(behavioralEvents.timestamp));

  console.log(`\n  ${rows.length} behavioral event(s):\n`);
  for (const row of rows) {
    const element = (row.element as ElementIdentity | null) ?? undefined;
    const token = element && hasStableIdentity(element) ? `${row.kind}:${describeElementIdentity(element)}` : row.kind;
    const annotation = formatVerboseAnnotation({
      durationMs: row.durationMs,
      count: row.count,
      evidence: row.evidence as BehavioralEventEvidence | null,
    });

    console.log(`    [${row.timestamp.toISOString()}] ${row.category.padEnd(16)} ${token}`);
    if (annotation) console.log(`        (${annotation})`);
    if (row.sourceEventIds) {
      const ids = row.sourceEventIds as string[];
      console.log(`        source raw events: ${ids.length} (${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", ..." : ""})`);
    }
  }
  console.log("");
}

async function main() {
  const db = createDb(process.env.DATABASE_URL ?? "./dev.db");
  const episodeId = getFlag("--episode");
  const siteId = getFlag("--site");
  const sessionId = getFlag("--session");
  const list = hasFlag("--list");

  if (episodeId) {
    await renderEpisode(db, episodeId);
    return;
  }
  if (siteId && sessionId && list) {
    await listEpisodesForSession(db, siteId, sessionId);
    return;
  }

  console.error(
    "Usage:\n" +
      "  tsx scripts/inspect-episode.ts --site <siteId> --session <sessionId> --list\n" +
      "  tsx scripts/inspect-episode.ts --episode <episodeId>"
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
