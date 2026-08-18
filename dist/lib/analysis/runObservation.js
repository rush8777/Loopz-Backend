import { eq } from "drizzle-orm";
import { sessionEvents, episodes as episodesTable, behavioralEvents as behavioralEventsTable, patternCandidates, patternEpisodes, } from "../../db/schema.js";
import { compileBehavioralEvents } from "../behavior/behaviorCompiler.js";
import { segmentIntoEpisodes } from "../behavior/episodeSegmentation.js";
import { observePatterns } from "./patternObserver.js";
/**
 * Mirrors routes/analysis.ts's groupBySession, but also keeps each
 * row's id (for provenance) and its x/y/viewport fields (dropped there
 * but needed here for the cursor aggregator). Deliberately a separate
 * function rather than a shared export, so this task doesn't risk
 * changing analysis.ts's existing, already-tested behavior.
 */
function groupBySessionWithIds(rows) {
    const bySession = new Map();
    for (const row of rows) {
        const list = bySession.get(row.sessionId) ?? [];
        const event = {
            id: row.id,
            type: row.type,
            timestamp: row.timestamp.getTime(),
            element: row.selector ? { selector: row.selector } : undefined,
            durationMs: row.durationMs ?? undefined,
            scrollPercent: row.scrollPercent ?? undefined,
            x: row.x ?? undefined,
            y: row.y ?? undefined,
            viewportWidth: row.viewportWidth ?? undefined,
            viewportHeight: row.viewportHeight ?? undefined,
        };
        list.push(event);
        bySession.set(row.sessionId, list);
    }
    return bySession;
}
function behavioralEventEvidenceOf(event) {
    return "evidence" in event ? (event.evidence ?? null) : null;
}
function behavioralEventDurationMsOf(event) {
    return "durationMs" in event && typeof event.durationMs === "number" ? event.durationMs : null;
}
function behavioralEventCountOf(event) {
    return "count" in event && typeof event.count === "number" ? event.count : null;
}
function behavioralEventElementOf(event) {
    return "element" in event ? (event.element ?? null) : null;
}
/**
 * Runs the full pipeline for one site and persists the result. Safe to
 * call repeatedly (each call fully replaces this site's derived data
 * with a fresh computation over its current `session_events`).
 */
export async function runSiteObservation(db, siteId, configOverrides = {}) {
    const rows = await db.select().from(sessionEvents).where(eq(sessionEvents.siteId, siteId));
    const bySession = groupBySessionWithIds(rows);
    const allEpisodes = [];
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
    const logicalEpisodeIdToDbId = new Map();
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
            await db.insert(behavioralEventsTable).values(episode.events.map((event) => ({
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
            })));
        }
    }
    // --- Observe recurring patterns across every episode from this site. ---
    const candidates = observePatterns(allEpisodes, configOverrides);
    // The ids observePatterns() assigns are deterministic but purely
    // in-memory (see patternObserver.ts) - not the same as the DB's own
    // cuid primary keys. Callers (the route layer) need the persisted id
    // to look a candidate back up later, so the returned array swaps in
    // each candidate's real DB id here rather than the in-memory one.
    const persistedCandidates = [];
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
            .filter((id) => Boolean(id));
        if (episodeDbIds.length > 0) {
            await db.insert(patternEpisodes).values(episodeDbIds.map((episodeId) => ({ patternCandidateId: row.id, episodeId })));
        }
        persistedCandidates.push({ ...candidate, id: row.id });
    }
    return { sessionCount: bySession.size, episodeCount: allEpisodes.length, candidates: persistedCandidates };
}
//# sourceMappingURL=runObservation.js.map