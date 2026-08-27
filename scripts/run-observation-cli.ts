/**
 * run-observation-cli.ts
 *
 * The CLI equivalent of `POST .../analysis/patterns/observe` - calls
 * the exact same `runSiteObservation()` service the HTTP route uses
 * (see `src/lib/analysis/runObservation.ts`), so it persists real
 * `episodes`/`behavioral_events`/`pattern_candidates`/`pattern_episodes`
 * rows for the site, not a dry-run simulation. On top of that, it
 * prints a full verbose report: every session's compiled episodes with
 * every behavioral event's evidence (the direct output of cursor
 * aggregation - durationMs, distanceMoved, direction changes, etc),
 * then every resulting pattern candidate with its quality/similarity
 * breakdown and which sessions/episodes contributed to it.
 *
 * Usage:
 *   DATABASE_URL=./dev.db npx tsx scripts/run-observation-cli.ts \
 *     --site <siteId> \
 *     [--threshold 0.65] [--min-occurrences 3] [--quiet]
 *
 * --quiet skips the per-episode evidence dump and only prints the
 * resulting candidates - useful once you've already inspected the
 * evidence and just want the summary.
 */
import { eq, asc } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { episodes, behavioralEvents } from "../src/db/schema.js";
import { runSiteObservation } from "../src/lib/analysis/runObservation.js";
import { DEFAULT_PATTERN_OBSERVER_CONFIG } from "../src/lib/analysis/patternObserver.js";
import { formatVerboseAnnotation } from "../src/lib/behavior/evidenceFormat.js";
import { describeElementIdentity, hasStableIdentity, type ElementIdentity } from "../src/lib/behavior/elementIdentity.js";
import type { BehavioralEventEvidence } from "../src/lib/behavior/behavioralEvent.js";

function getFlag(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function main() {
  const siteId = getFlag("--site");
  if (!siteId) {
    console.error("Usage: tsx scripts/run-observation-cli.ts --site <siteId> [--threshold 0.65] [--min-occurrences 3] [--quiet]");
    process.exit(1);
  }

  const quiet = process.argv.includes("--quiet");
  const config = {
    similarityThreshold: Number(getFlag("--threshold") ?? DEFAULT_PATTERN_OBSERVER_CONFIG.similarityThreshold),
    minimumOccurrences: Number(getFlag("--min-occurrences") ?? DEFAULT_PATTERN_OBSERVER_CONFIG.minimumOccurrences),
  };

  const db = createDb(process.env.DATABASE_URL ?? "./dev.db");

  console.log(`\nRunning observation for site ${siteId}  (threshold=${config.similarityThreshold}, minOccurrences=${config.minimumOccurrences})`);
  console.log("This persists episodes/behavioral_events/pattern_candidates - same as POST .../analysis/patterns/observe.\n");

  const result = await runSiteObservation(db, siteId, config);

  console.log(`sessions: ${result.sessionCount}   episodes: ${result.episodeCount}   candidates: ${result.candidates.length}`);

  if (!quiet) {
    console.log(`\n${"=".repeat(70)}`);
    console.log("PERSISTED EPISODES (with cursor-aggregation evidence)");
    console.log("=".repeat(70));

    const episodeRows = await db.select().from(episodes).where(eq(episodes.siteId, siteId));
    episodeRows.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

    for (const episode of episodeRows) {
      console.log(`\n${episode.id}  (session ${episode.sessionId}, ${episode.startReason} -> ${episode.endReason})`);
      const behavioralRows = await db
        .select()
        .from(behavioralEvents)
        .where(eq(behavioralEvents.episodeId, episode.id))
        .orderBy(asc(behavioralEvents.timestamp));

      for (const row of behavioralRows) {
        const element = (row.element as ElementIdentity | null) ?? undefined;
        const token = element && hasStableIdentity(element) ? `${row.kind}:${describeElementIdentity(element)}` : row.kind;
        const annotation = formatVerboseAnnotation({
          durationMs: row.durationMs,
          count: row.count,
          evidence: row.evidence as BehavioralEventEvidence | null,
        });
        console.log(`    ${token}${annotation ? `  (${annotation})` : ""}`);
      }
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("DISCOVERED PATTERN CANDIDATES");
  console.log("=".repeat(70));

  if (result.candidates.length === 0) {
    console.log("\nNo recurring pattern cleared minimumOccurrences at this threshold.");
  } else {
    for (const c of result.candidates) {
      console.log(`\n${c.id}`);
      console.log(`  occurrences: ${c.occurrenceCount}   uniqueSessions: ${c.uniqueSessionCount}`);
      console.log(`  sessions: ${c.sessionIds.join(", ")}`);
      console.log(`  representative sequence: ${c.representativeSequence.join(" -> ")}`);
      console.log(
        `  similarity avg/min/max: ${c.similarity.average.toFixed(2)} / ${c.similarity.minimum.toFixed(2)} / ${c.similarity.maximum.toFixed(2)}`
      );
      console.log(
        `  quality: frequency=${c.quality.frequencyScore.toFixed(2)} coverage=${c.quality.coverageScore.toFixed(2)} ` +
          `consistency=${c.quality.consistencyScore.toFixed(2)} recency=${c.quality.recencyScore.toFixed(2)} ` +
          `overall=${c.quality.overallScore.toFixed(2)}`
      );
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
