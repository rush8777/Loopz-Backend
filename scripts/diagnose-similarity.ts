/**
 * diagnose-similarity.ts
 *
 * Answers "why weren't these sessions recognized as the same pattern?"
 * for a specific set of sessions, instead of leaving that as a black
 * box behind a single similarity number. Pulls each session's real
 * events from the DB, runs them through the exact same pipeline the
 * Pattern Observer uses (compileBehavioralEvents -> segmentIntoEpisodes
 * -> behavioralSequenceForEpisode), then:
 *
 *   1. prints each session's actual compiled token sequence
 *   2. diffs every pair of sessions, token by token (sequenceDiff.ts)
 *   3. shows the similarity score against the configured threshold
 *   4. runs observePatterns() on just these sessions and shows which
 *      ones it actually grouped together
 *
 * This is a read-only diagnostic script - it doesn't write anything to
 * the DB and doesn't change how observation runs in production.
 *
 * Usage:
 *   DATABASE_URL=./dev.db npx tsx scripts/diagnose-similarity.ts \
 *     --site <siteId> --sessions sess_1,sess_2,sess_3 \
 *     [--threshold 0.65] [--min-occurrences 3] [--verbose]
 *
 * --verbose additionally prints each derived signal's evidence
 * (durationMs, distanceMoved, direction changes, sample count, etc -
 * the same numbers cursorAggregator.ts computed to decide the signal
 * fired at all) next to every token, so you can see e.g. exactly why
 * one run got a `hover_intent:#save` token and another didn't (its
 * hover fell a few milliseconds short of the threshold) instead of
 * just seeing that the token differs.
 */
import { eq, and, inArray } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { sessionEvents } from "../src/db/schema.js";
import type { IncomingEvent } from "../src/lib/patterns/event.js";
import { compileBehavioralEvents, type CompilableRawEvent } from "../src/lib/behavior/behaviorCompiler.js";
import { segmentIntoEpisodes, type Episode } from "../src/lib/behavior/episodeSegmentation.js";
import { behavioralSequenceForEpisode, tokenForBehavioralEvent } from "../src/lib/behavior/behavioralSequence.js";
import { formatBehavioralEventVerbose } from "../src/lib/behavior/evidenceFormat.js";
import { diffSequences, formatDiff } from "../src/lib/analysis/sequenceDiff.js";
import { observePatterns, DEFAULT_PATTERN_OBSERVER_CONFIG } from "../src/lib/analysis/patternObserver.js";

interface Args {
  siteId: string;
  sessionIds: string[];
  threshold: number;
  minOccurrences: number;
  verbose: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const siteId = get("--site");
  const sessionsRaw = get("--sessions");
  if (!siteId || !sessionsRaw) {
    console.error(
      "Usage: tsx scripts/diagnose-similarity.ts --site <siteId> --sessions <id1,id2,...> [--threshold 0.65] [--min-occurrences 3] [--verbose]"
    );
    process.exit(1);
  }

  return {
    siteId,
    sessionIds: sessionsRaw.split(",").map((s) => s.trim()).filter(Boolean),
    threshold: Number(get("--threshold") ?? DEFAULT_PATTERN_OBSERVER_CONFIG.similarityThreshold),
    minOccurrences: Number(get("--min-occurrences") ?? DEFAULT_PATTERN_OBSERVER_CONFIG.minimumOccurrences),
    verbose: args.includes("--verbose") || args.includes("-v"),
  };
}

function toCompilableEvents(rows: (typeof sessionEvents.$inferSelect)[]): CompilableRawEvent[] {
  return rows.map((row) => ({
    id: row.id,
    type: row.type as IncomingEvent["type"],
    timestamp: row.timestamp.getTime(),
    element: row.selector ? { selector: row.selector } : undefined,
    durationMs: row.durationMs ?? undefined,
    scrollPercent: row.scrollPercent ?? undefined,
    x: row.x ?? undefined,
    y: row.y ?? undefined,
    viewportWidth: row.viewportWidth ?? undefined,
    viewportHeight: row.viewportHeight ?? undefined,
  }));
}

function printTokens(label: string, tokens: string[]) {
  console.log(`  ${label}: ${tokens.length === 0 ? "(no behavioral events)" : tokens.join(" -> ")}`);
}

function printEpisodeVerbose(label: string, episode: Episode) {
  console.log(`  ${label}:`);
  if (episode.events.length === 0) {
    console.log("    (no behavioral events)");
    return;
  }
  for (const event of episode.events) {
    const token = tokenForBehavioralEvent(event);
    console.log(
      "    "
        + formatBehavioralEventVerbose(event, token, "        ")
          .split("\n")
          .join("\n    ")
    );
  }
}

async function main() {
  const { siteId, sessionIds, threshold, minOccurrences, verbose } = parseArgs();
  const db = createDb(process.env.DATABASE_URL ?? "./dev.db");

  console.log(`\nLoading ${sessionIds.length} session(s) from site ${siteId}...\n`);

  const rows = await db
    .select()
    .from(sessionEvents)
    .where(and(eq(sessionEvents.siteId, siteId), inArray(sessionEvents.sessionId, sessionIds)));

  if (rows.length === 0) {
    console.error("No raw events found for those session ids on that site. Check --site and --sessions.");
    process.exit(1);
  }

  const bySession = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }

  for (const sessionId of sessionIds) {
    if (!bySession.has(sessionId)) console.warn(`no events found for session "${sessionId}" - it will be skipped.`);
  }

  const episodesBySession = new Map<string, Episode[]>();
  console.log("=".repeat(70));
  console.log("SESSION SEQUENCES");
  console.log("=".repeat(70));

  for (const [sessionId, sessionRows] of bySession) {
    const compiled = compileBehavioralEvents(toCompilableEvents(sessionRows));
    const episodes = segmentIntoEpisodes(sessionId, compiled);
    episodesBySession.set(sessionId, episodes);

    console.log(`\n${sessionId}  (${sessionRows.length} raw events -> ${compiled.length} behavioral events -> ${episodes.length} episode(s))`);
    if (episodes.length > 1) {
      console.log(`  NOTE: this session split into ${episodes.length} episodes (page change or idle gap) - only episode 0 is used in the pairwise comparison below.`);
    }
    episodes.forEach((ep, i) => {
      if (verbose) {
        printEpisodeVerbose(`episode ${i}`, ep);
      } else {
        printTokens(`episode ${i}`, behavioralSequenceForEpisode(ep));
      }
    });
    if (episodes.length === 0) {
      console.log("  (no episodes - every event was noise/telemetry with nothing behaviorally meaningful)");
    }
  }

  const sessionsWithPrimaryEpisode = [...episodesBySession.entries()]
    .filter(([, eps]) => eps.length > 0)
    .map(([sessionId, eps]) => ({ sessionId, episode: eps[0], tokens: behavioralSequenceForEpisode(eps[0]) }));

  console.log(`\n${"=".repeat(70)}`);
  console.log(`PAIRWISE COMPARISON  (threshold: ${threshold})`);
  console.log("=".repeat(70));

  for (let i = 0; i < sessionsWithPrimaryEpisode.length; i++) {
    for (let j = i + 1; j < sessionsWithPrimaryEpisode.length; j++) {
      const A = sessionsWithPrimaryEpisode[i];
      const B = sessionsWithPrimaryEpisode[j];
      const diff = diffSequences(A.tokens, B.tokens);
      const verdict = diff.similarity >= threshold ? "WOULD MATCH" : "WOULD NOT MATCH";

      console.log(`\n${A.sessionId}  vs  ${B.sessionId}`);
      console.log(`  similarity: ${diff.similarity.toFixed(3)}   ${verdict}`);
      if (diff.onlyInA.length > 0) console.log(`  only in ${A.sessionId}: ${diff.onlyInA.join(", ")}`);
      if (diff.onlyInB.length > 0) console.log(`  only in ${B.sessionId}: ${diff.onlyInB.join(", ")}`);
      if (diff.substitutions.length > 0) {
        console.log(`  differing steps: ${diff.substitutions.map((s) => `${s.a} != ${s.b}`).join("; ")}`);
      }
      if (diff.onlyInA.length === 0 && diff.onlyInB.length === 0 && diff.substitutions.length === 0) {
        console.log("  (identical token sequences)");
      }

      if (verbose && (diff.onlyInA.length > 0 || diff.onlyInB.length > 0 || diff.substitutions.length > 0)) {
        console.log("\n  WHY (evidence behind each differing token):");
        let ai = 0;
        let bi = 0;
        for (const op of diff.ops) {
          if (op.type === "equal") {
            ai++;
            bi++;
            continue;
          }
          if (op.type === "delete") {
            const ev = A.episode.events[ai];
            const annotation = ev ? formatBehavioralEventVerbose(ev, `${A.sessionId}: ${op.a}`) : `${A.sessionId}: ${op.a}`;
            console.log(`    ${annotation.split("\n").join("\n    ")}`);
            ai++;
          } else if (op.type === "insert") {
            const ev = B.episode.events[bi];
            const annotation = ev ? formatBehavioralEventVerbose(ev, `${B.sessionId}: ${op.b}`) : `${B.sessionId}: ${op.b}`;
            console.log(`    ${annotation.split("\n").join("\n    ")}`);
            bi++;
          } else {
            const evA = A.episode.events[ai];
            const evB = B.episode.events[bi];
            const annA = evA ? formatBehavioralEventVerbose(evA, `${A.sessionId}: ${op.a}`) : `${A.sessionId}: ${op.a}`;
            const annB = evB ? formatBehavioralEventVerbose(evB, `${B.sessionId}: ${op.b}`) : `${B.sessionId}: ${op.b}`;
            console.log(`    ${annA.split("\n").join("\n    ")}`);
            console.log(`    ${annB.split("\n").join("\n    ")}`);
            ai++;
            bi++;
          }
        }
      }

      console.log("");
      console.log(
        formatDiff(diff)
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")
      );
    }
  }

  const allEpisodes = [...episodesBySession.values()].flat();
  console.log(`\n${"=".repeat(70)}`);
  console.log(`OBSERVER RESULT  (minimumOccurrences: ${minOccurrences}, similarityThreshold: ${threshold})`);
  console.log("=".repeat(70));

  const candidates = observePatterns(allEpisodes, { similarityThreshold: threshold, minimumOccurrences: minOccurrences });

  if (candidates.length === 0) {
    console.log(`\nNo candidate formed - no group of episodes reached minimumOccurrences (${minOccurrences}) at this threshold.`);
    console.log("This is why the dashboard shows nothing for these sessions even though real events were recorded.");
  } else {
    candidates.forEach((c, i) => {
      console.log(`\nGroup ${i + 1}: ${c.occurrenceCount} occurrence(s) across ${c.uniqueSessionCount} session(s)`);
      console.log(`  sessions: ${c.sessionIds.join(", ")}`);
      if (verbose) {
        const exemplarEpisode = allEpisodes.find(
          (ep) => JSON.stringify(behavioralSequenceForEpisode(ep)) === JSON.stringify(c.representativeSequence)
        );
        if (exemplarEpisode) {
          printEpisodeVerbose("representative sequence", exemplarEpisode);
        } else {
          printTokens("representative sequence", c.representativeSequence);
        }
      } else {
        printTokens("representative sequence", c.representativeSequence);
      }
      console.log(
        `  similarity avg/min/max: ${c.similarity.average.toFixed(2)} / ${c.similarity.minimum.toFixed(2)} / ${c.similarity.maximum.toFixed(2)}`
      );
    });

    const groupedSessionIds = new Set(candidates.flatMap((c) => c.sessionIds));
    const ungrouped = sessionsWithPrimaryEpisode.map((s) => s.sessionId).filter((id) => !groupedSessionIds.has(id));
    if (ungrouped.length > 0) {
      console.log(`\nThese sessions did NOT end up in any group: ${ungrouped.join(", ")}`);
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
