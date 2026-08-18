import { eq, and } from "drizzle-orm";
import { sites, patterns, patternMatchStates, patternMatches, sessionEvents } from "../db/schema.js";
import { trackEventsBodySchema } from "../lib/patterns/validation.js";
import { advanceMatch, createInitialMatchState } from "../lib/patterns/matcher.js";
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
 */
export function registerPublicEventsRoutes(app, db) {
    app.post("/public/sites/:siteId/events", async (request, reply) => {
        const { siteId } = request.params;
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
        // Durable log first - this is what feeds clustering/feature-extraction
        // later. Independent of whether any pattern is active on the site;
        // analysis shouldn't depend on the site owner having authored a
        // pattern first.
        if (events.length > 0) {
            await db.insert(sessionEvents).values(events.map((e) => ({
                siteId: site.id,
                sessionId,
                type: e.type,
                timestamp: new Date(e.timestamp),
                selector: e.element?.selector ?? null,
                durationMs: e.durationMs ?? null,
                scrollPercent: e.scrollPercent ?? null,
                x: e.x ?? null,
                y: e.y ?? null,
                viewportWidth: e.viewportWidth ?? null,
                viewportHeight: e.viewportHeight ?? null,
            })));
        }
        const activePatterns = await db
            .select()
            .from(patterns)
            .where(and(eq(patterns.siteId, site.id), eq(patterns.status, "ACTIVE")));
        const triggers = [];
        for (const patternRow of activePatterns) {
            const definition = {
                id: patternRow.id,
                siteId: site.id,
                name: patternRow.name,
                matchWindowMs: patternRow.matchWindowMs,
                origin: patternRow.origin,
                status: patternRow.status,
                steps: patternRow.steps,
                feedback: patternRow.feedback,
            };
            const [existingStateRow] = await db
                .select()
                .from(patternMatchStates)
                .where(and(eq(patternMatchStates.patternId, patternRow.id), eq(patternMatchStates.sessionId, sessionId)))
                .limit(1);
            // A terminal (matched/expired) state means this pattern has
            // already run its course for this session - don't re-evaluate.
            // Re-arming (letting a pattern fire again per session, or with a
            // cooldown) is a deliberate product decision left for later, not
            // an oversight.
            if (existingStateRow && (existingStateRow.status === "matched" || existingStateRow.status === "expired")) {
                continue;
            }
            const priorState = existingStateRow
                ? {
                    patternId: patternRow.id,
                    sessionId,
                    cursor: existingStateRow.cursor,
                    matchedSteps: existingStateRow.matchedSteps,
                    startedAt: existingStateRow.startedAt?.getTime() ?? null,
                    lastMatchedAt: existingStateRow.lastMatchedAt?.getTime() ?? null,
                    status: existingStateRow.status,
                }
                : createInitialMatchState(patternRow.id, sessionId);
            const nextState = advanceMatch(definition, priorState, events);
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
            }
            else {
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
//# sourceMappingURL=public-events.js.map