import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  sessionEvents,
  episodes as episodesTable,
  behavioralEvents as behavioralEventsTable,
  patternCandidates,
  patternEpisodes,
} from "../../db/schema.js";
import type { IncomingEvent } from "../patterns/event.js";
import { compileBehavioralEvents, type CompilableRawEvent } from "../behavior/behaviorCompiler.js";
import { segmentIntoEpisodes, type Episode } from "../behavior/episodeSegmentation.js";
import type { BehavioralEvent } from "../behavior/behavioralEvent.js";
import { observePatterns, type PatternCandidate, type PatternObserverConfig } from "./patternObserver.js";

/**
 * Wires together the pipeline built across prior tasks into something
 * an HTTP route can actually call:
 *
 *   session_events (raw, per site)
 *     -> group by session, with row ids preserved for provenance
 *     -> compileBehavioralEvents()  (behaviorCompiler.ts)
 *     -> segmentIntoEpisodes()      (episodeSegmentation.ts)
 *     -> observePatterns()          (patternObserver.ts)
 *     -> persist episodes + behavioral_events + pattern_candidates + pattern_episodes
 *
 * None of the individual stages are reimplemented here - this module
 * only adds the DB read/write glue those pure functions don't have.
 *
 * RECOMPUTE STRATEGY: `episodes`, `behavioral_events`, `pattern_candidates`,
 * and `pattern_episodes` are all documented as derived/rebuildable (see
 * their comments in db/schema.ts). This function's persistence strategy
 * is a full resync: delete this site's existing rows in those four
 * tables, then insert freshly computed ones. Simple, deterministic, and
 * correct for MVP scale - not an incremental/streaming design. A
 * production version would diff instead of replace; that's future work,
 * not introduced here.
 */

export interface ObservationResult {
  sessionCount: number;
  episodeCount: number;
  candidates: PatternCandidate[];
}

/**
 * Mirrors routes/analysis.ts's groupBySession, but also keeps each
 * row's id (for provenance) and its x/y/viewport fields (dropped there
 * but needed here for the cursor aggregator). Deliberately a separate
 * function rather than a shared export, so this task doesn't risk
 * changing analysis.ts's existing, already-tested behavior.
 */
function groupBySessionWithIds(rows: (typeof sessionEvents.$inferSelect)[]): Map<string, CompilableRawEvent[]> {
  const bySession = new Map<string, CompilableRawEvent[]>();
  for (const row of rows) {
    const list = bySession.get(row.sessionId) ?? [];
    const event: CompilableRawEvent = {
      id: row.id,
      type: row.type as IncomingEvent["type"],
      timestamp: row.timestamp.getTime(),
      element: row.selector
        ? { selector: row.selector, ...(row.elementLabel && { label: row.elementLabel }), ...(row.elementRole && { role: row.elementRole }) }
        : undefined,
      durationMs: row.durationMs ?? undefined,
      scrollPercent: row.scrollPercent ?? undefined,
      x: row.x ?? undefined,
      y: row.y ?? undefined,
      viewportWidth: row.viewportWidth ?? undefined,
      viewportHeight: row.viewportHeight ?? undefined,
      // custom events only - see session_events.eventName/eventProperties.
      name: row.eventName ?? undefined,
      properties: (row.eventProperties as CompilableRawEvent["properties"]) ?? undefined,
    };
    list.push(event);
    bySession.set(row.sessionId, list);
  }
  return bySession;
}

function behavioralEventEvidenceOf(event: BehavioralEvent) {
  return "evidence" in event ? (event.evidence ?? null) : null;
}
function behavioralEventDurationMsOf(event: BehavioralEvent): number | null {
  return "durationMs" in event && typeof event.durationMs === "number" ? event.durationMs : null;
}
function behavioralEventCountOf(event: BehavioralEvent): number | null {
  return "count" in event && typeof event.count === "number" ? event.count : null;
}
function behavioralEventElementOf(event: BehavioralEvent) {
  return "element" in event ? (event.element ?? null) : null;
}

/**
 * Runs the full pipeline for one site and persists the result. Safe to
 * call repeatedly (each call fully replaces this site's derived data
 * with a fresh computation over its current `session_events`).
 */
export async function runSiteObservation(
  db: Db,
  siteId: string,
  configOverrides: Partial<PatternObserverConfig> = {}
): Promise<ObservationResult> {
  const rows = await db.select().from(sessionEvents).where(eq(sessionEvents.siteId, siteId));
  const bySession = groupBySessionWithIds(rows);

  const allEpisodes: Episode[] = [];
  for (const [sessionId, events] of bySession) {
    const compiled = compileBehavioralEvents(events);
    const sessionEpisodes = segmentIntoEpisodes(sessionId, compiled);
    allEpisodes.push(...sessionEpisodes);
  }

  // --- Clear this site's previously-derived rows (see module doc). ---
  await db.delete(patternCandidates).where(eq(patternCandidates.siteId, siteId)); // cascades pattern_episodes
  await db.delete(episodesTable).where(eq(episodesTable.siteId, siteId));
  await db.delete(behavioralEventsTable).where(eq(behavioralEventsTable.siteId, siteId));

  // --- Persist episodes (one insert per episode, to get each one's real DB id back for the behavioral_events FK and the candidate linkage below). ---
  const logicalEpisodeIdToDbId = new Map<string, string>();
  for (const episode of allEpisodes) {
    const [row] = await db
      .insert(episodesTable)
      .values({
        siteId,
        sessionId: episode.sessionId,
        startedAt: new Date(episode.startedAt),
        endedAt: new Date(episode.endedAt),
        startReason: episode.startReason,
        endReason: episode.endReason,
      })
      .returning();
    logicalEpisodeIdToDbId.set(episode.id, row.id);

    if (episode.events.length > 0) {
      await db.insert(behavioralEventsTable).values(
        episode.events.map((event) => ({
          siteId,
          sessionId: episode.sessionId,
          episodeId: row.id,
          kind: event.kind,
          category: event.category,
          timestamp: new Date(event.timestamp),
          element: behavioralEventElementOf(event),
          durationMs: behavioralEventDurationMsOf(event),
          count: behavioralEventCountOf(event),
          evidence: behavioralEventEvidenceOf(event),
          sourceEventIds: event.sourceEventIds ?? null,
        }))
      );
    }
  }

  // --- Observe recurring patterns across every episode from this site. ---
  const candidates = observePatterns(allEpisodes, configOverrides);

  // The ids observePatterns() assigns are deterministic but purely
  // in-memory (see patternObserver.ts) - not the same as the DB's own
  // cuid primary keys. Callers (the route layer) need the persisted id
  // to look a candidate back up later, so the returned array swaps in
  // each candidate's real DB id here rather than the in-memory one.
  const persistedCandidates: PatternCandidate[] = [];

  for (const candidate of candidates) {
    const [row] = await db
      .insert(patternCandidates)
      .values({
        siteId,
        representativeSequence: candidate.representativeSequence,
        occurrenceCount: candidate.occurrenceCount,
        uniqueSessionCount: candidate.uniqueSessionCount,
        firstSeenAt: new Date(candidate.firstSeenAt),
        lastSeenAt: new Date(candidate.lastSeenAt),
        similarity: candidate.similarity,
        quality: candidate.quality,
      })
      .returning();

    const episodeDbIds = candidate.episodeIds
      .map((logicalId) => logicalEpisodeIdToDbId.get(logicalId))
      .filter((id): id is string => Boolean(id));

    if (episodeDbIds.length > 0) {
      await db.insert(patternEpisodes).values(episodeDbIds.map((episodeId) => ({ patternCandidateId: row.id, episodeId })));
    }

    persistedCandidates.push({ ...candidate, id: row.id });
  }

  return { sessionCount: bySession.size, episodeCount: allEpisodes.length, candidates: persistedCandidates };
}
