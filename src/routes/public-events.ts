import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sites, patterns, patternMatchStates, patternMatches, sessionEvents } from "../db/schema.js";
import { trackEventsBodySchema } from "../lib/patterns/validation.js";
import { advanceMatch, createInitialMatchState, type MatchState } from "../lib/patterns/matcher.js";
import type { PatternDefinition } from "../lib/patterns/types.js";
import type { IncomingEvent } from "../lib/patterns/event.js";
import { resolveIdentity } from "../lib/identity/resolveIdentity.js";
import { recordSessionStart } from "../lib/identity/environmentContext.js";

/**
 * Public, unauthenticated (same trust model as /public/config - see the
 * comment there) endpoint the SDK calls as event batches are ready to
 * send. For each ACTIVE pattern on the site, advances that pattern's
 * match state for this session by the newly-arrived events, persists
 * the updated state, and returns feedback for any pattern that just
 * completed in this call.
 *
 * Deliberately NOT a general-purpose analytics ingestion endpoint -
 * events are held only long enough to advance match state, not stored
 * as a queryable event log. That's a distinct, larger piece of
 * infrastructure (heatmaps/funnels/replay) covered elsewhere; this
 * endpoint exists solely to serve the live-feedback trigger loop.
 *
 * `custom` events (analytics.event(name, properties?) on the SDK) are a
 * first-class event type here, alongside page_view/click/hover/scroll/
 * cursor - not a parallel pipeline. They flow through the exact same
 * validation -> session_events persistence -> pattern-matching path as
 * every other behavioral event; the only difference is which columns
 * get populated (eventName/eventProperties instead of
 * selector/durationMs/etc.) - see the insert below.
 *
 * Idempotent per event: each incoming event's SDK-generated `eventId`
 * (when present - see validation.ts) is persisted alongside it in
 * `session_events` under a (siteId, eventId) unique index, so a retried
 * event or a retried whole batch (Transport's at-least-once delivery)
 * inserts zero duplicate rows on replay - see the onConflictDoNothing
 * below.
 */
export function registerPublicEventsRoutes(app: FastifyInstance, db: Db) {
  app.post("/public/sites/:siteId/events", async (request, reply) => {
    const { siteId } = request.params as { siteId: string };

    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
    if (!site) {
      // Same 404 shape as /public/config for an unknown siteId - no enumeration signal.
      return reply.code(404).send({ error: "site_not_found" });
    }

    const parsed = trackEventsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { sessionId, events } = parsed.data;

    // identify() calls are identity/property data, and session_start is
    // one-per-session environment context - neither is interaction
    // telemetry, so neither is written to session_events (which stays a
    // pure behavioral/interaction log). identify() resolves into the
    // tracked-user layer (see resolveIdentity.ts); session_start
    // upserts a session_contexts row (see environmentContext.ts).
    // Everything else keeps flowing through the existing pipeline
    // unchanged, now just carrying anonymousId + page path along with
    // it so the identity layer and profile activity feed have
    // something to resolve/display.
    const identifyEvents = events.filter((e) => e.type === "identify");
    const sessionStartEvents = events.filter((e) => e.type === "session_start");
    const behavioralEvents = events.filter(
      (
        e
      ): e is IncomingEvent & { anonymousId?: string; path?: string; eventId?: string; pageViewId?: string } =>
        e.type !== "identify" && e.type !== "session_start"
    );

    // Durable log first - this is what feeds clustering/feature-extraction
    // later. Independent of whether any pattern is active on the site;
    // analysis shouldn't depend on the site owner having authored a
    // pattern first.
    //
    // onConflictDoNothing targets session_events_site_event_unique
    // (siteId, eventId) - this is what makes ingestion idempotent: the
    // Transport's at-least-once delivery (or any client-side retry) can
    // resend a batch whose events were already durably inserted, and the
    // repeat insert is a silent no-op per row instead of a duplicate
    // behavioral event. Events without an eventId (older SDK builds) are
    // never deduped against anything, per SQLite's default unique-index
    // NULL handling - same tradeoff already accepted for anonymousId.
    if (behavioralEvents.length > 0) {
      await db
        .insert(sessionEvents)
        .values(
          behavioralEvents.map((e) => ({
            siteId: site.id,
            sessionId,
            anonymousId: e.anonymousId ?? null,
            eventId: e.eventId ?? null,
            pageViewId: e.pageViewId ?? null,
            type: e.type,
            timestamp: new Date(e.timestamp),
            pagePath: e.path ?? null,
            selector: e.element?.selector ?? null,
            elementLabel: e.element?.label ?? null,
            elementRole: e.element?.role ?? null,
            durationMs: e.durationMs ?? null,
            scrollPercent: e.scrollPercent ?? null,
            x: e.x ?? null,
            y: e.y ?? null,
            viewportWidth: e.viewportWidth ?? null,
            viewportHeight: e.viewportHeight ?? null,
            documentX: e.documentX ?? null,
            documentY: e.documentY ?? null,
            documentWidth: e.documentWidth ?? null,
            documentHeight: e.documentHeight ?? null,
            deviceClass: e.deviceClass ?? null,
            heatmapStateId: e.heatmapStateId ?? null,
            rageClickCount: e.rageClickCount ?? null,
            // custom events only (validation.ts guarantees `name` is
            // present whenever type === "custom"). `properties` stays
            // whatever JSON-serializable shape the caller sent -
            // `mode: "json"` on the column round-trips it verbatim.
            eventName: e.type === "custom" ? (e.name ?? null) : null,
            eventProperties: e.type === "custom" ? (e.properties ?? null) : null,
          }))
        )
        .onConflictDoNothing({ target: [sessionEvents.siteId, sessionEvents.eventId] });
    }

    for (const identifyEvent of identifyEvents) {
      if (!identifyEvent.externalUserId) continue; // malformed - identify() with no userId, nothing to resolve
      await resolveIdentity(db, {
        siteId: site.id,
        anonymousId: identifyEvent.anonymousId,
        externalUserId: identifyEvent.externalUserId,
        traits: identifyEvent.traits,
        timestamp: identifyEvent.timestamp,
      });
    }

    for (const sessionStartEvent of sessionStartEvents) {
      if (!sessionStartEvent.anonymousId) continue; // malformed - can't attribute this session's environment to anyone
      await recordSessionStart(db, {
        siteId: site.id,
        sessionId,
        anonymousId: sessionStartEvent.anonymousId,
        timestamp: sessionStartEvent.timestamp,
        browserName: sessionStartEvent.browserName,
        browserVersion: sessionStartEvent.browserVersion,
        osName: sessionStartEvent.osName,
        osVersion: sessionStartEvent.osVersion,
        deviceType: sessionStartEvent.deviceType,
        language: sessionStartEvent.language,
        timezone: sessionStartEvent.timezone,
        screenWidth: sessionStartEvent.screenWidth,
        screenHeight: sessionStartEvent.screenHeight,
        referrer: sessionStartEvent.referrer,
      });
    }

    const activePatterns = await db
      .select()
      .from(patterns)
      .where(and(eq(patterns.siteId, site.id), eq(patterns.status, "ACTIVE")));

    const triggers: { patternId: string; patternName: string; feedback: PatternDefinition["feedback"] }[] = [];

    for (const patternRow of activePatterns) {
      const definition: PatternDefinition = {
        id: patternRow.id,
        siteId: site.id,
        name: patternRow.name,
        matchWindowMs: patternRow.matchWindowMs,
        origin: patternRow.origin as PatternDefinition["origin"],
        status: patternRow.status as PatternDefinition["status"],
        steps: patternRow.steps as PatternDefinition["steps"],
        feedback: patternRow.feedback as PatternDefinition["feedback"],
      };

      const [existingStateRow] = await db
        .select()
        .from(patternMatchStates)
        .where(
          and(eq(patternMatchStates.patternId, patternRow.id), eq(patternMatchStates.sessionId, sessionId))
        )
        .limit(1);

      // A terminal (matched/expired) state means this pattern has
      // already run its course for this session - don't re-evaluate.
      // Re-arming (letting a pattern fire again per session, or with a
      // cooldown) is a deliberate product decision left for later, not
      // an oversight.
      if (existingStateRow && (existingStateRow.status === "matched" || existingStateRow.status === "expired")) {
        continue;
      }

      const priorState: MatchState = existingStateRow
        ? {
            patternId: patternRow.id,
            sessionId,
            cursor: existingStateRow.cursor,
            matchedSteps: existingStateRow.matchedSteps as MatchState["matchedSteps"],
            startedAt: existingStateRow.startedAt?.getTime() ?? null,
            lastMatchedAt: existingStateRow.lastMatchedAt?.getTime() ?? null,
            status: existingStateRow.status as MatchState["status"],
          }
        : createInitialMatchState(patternRow.id, sessionId);

      const nextState = advanceMatch(definition, priorState, behavioralEvents);

      const nextStateValues = {
        cursor: nextState.cursor,
        matchedSteps: nextState.matchedSteps,
        startedAt: nextState.startedAt != null ? new Date(nextState.startedAt) : null,
        lastMatchedAt: nextState.lastMatchedAt != null ? new Date(nextState.lastMatchedAt) : null,
        status: nextState.status,
        updatedAt: new Date(),
      };

      if (existingStateRow) {
        await db.update(patternMatchStates).set(nextStateValues).where(eq(patternMatchStates.id, existingStateRow.id));
      } else {
        await db.insert(patternMatchStates).values({
          patternId: patternRow.id,
          sessionId,
          ...nextStateValues,
        });
      }

      if (nextState.status === "matched" && priorState.status !== "matched") {
        await db.insert(patternMatches).values({ patternId: patternRow.id, siteId: site.id, sessionId });
        triggers.push({ patternId: patternRow.id, patternName: patternRow.name, feedback: definition.feedback });
      }
    }

    return reply.send({ triggers });
  });
}
