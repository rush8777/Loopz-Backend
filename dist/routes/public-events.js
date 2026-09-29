import { and, eq, inArray } from "drizzle-orm";
import { sites, sessionEvents, trackedUserAliases } from "../db/schema.js";
import { trackEventsBodySchema } from "../lib/patterns/validation.js";
import { resolveIdentity } from "../lib/identity/resolveIdentity.js";
import { recordSessionStart } from "../lib/identity/environmentContext.js";
import { shouldPersistSessionEvent } from "../lib/mvpPolicy.js";
/**
 * Public, unauthenticated (same trust model as /public/config - see the
 * comment there) endpoint the SDK calls as event batches are ready to
 * send. It durably stores interaction telemetry for Sessions, Events,
 * Funnels, Heatmaps, and behavioral episode compilation. The retired
 * authored Pattern matcher no longer runs here.
 *
 * `custom` events (analytics.event(name, properties?) on the SDK) are a
 * first-class event type here, alongside page_view/click/hover/scroll/
 * cursor - not a parallel pipeline. They flow through the exact same
 * validation -> session_events persistence path as
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
        // Resolve every anonymous id already known at the start of this request in
        // one query. identify() can re-point an alias later in the ordered stream,
        // so this remains mutable request-local state rather than a static lookup.
        const anonymousIds = [...new Set(events.flatMap((event) => event.anonymousId ? [event.anonymousId] : []))];
        const currentIdentity = new Map();
        for (const anonymousId of anonymousIds)
            currentIdentity.set(anonymousId, null);
        if (anonymousIds.length > 0) {
            const aliases = await db
                .select({ anonymousId: trackedUserAliases.anonymousId, trackedUserId: trackedUserAliases.trackedUserId })
                .from(trackedUserAliases)
                .where(and(eq(trackedUserAliases.siteId, site.id), inArray(trackedUserAliases.anonymousId, anonymousIds)));
            for (const alias of aliases)
                currentIdentity.set(alias.anonymousId, alias.trackedUserId);
        }
        const ownerFor = (anonymousId) => {
            if (!anonymousId)
                return null;
            return currentIdentity.get(anonymousId) ?? null;
        };
        // Rows are bulk-inserted between side-effect boundaries. In particular we
        // must flush before identify(): resolveIdentity deliberately claims older
        // unresolved rows, while rows after identify() must capture the new owner.
        // Flushing also preserves the route's existing partial-write ordering if a
        // later identify/session-context operation fails.
        let pendingRows = [];
        const flushPendingRows = async () => {
            if (pendingRows.length === 0)
                return;
            const rows = pendingRows;
            pendingRows = [];
            await db
                .insert(sessionEvents)
                .values(rows)
                .onConflictDoNothing({ target: [sessionEvents.siteId, sessionEvents.eventId] });
        };
        for (const event of events) {
            if (event.type === "identify") {
                if (!event.externalUserId)
                    continue;
                await flushPendingRows();
                const { trackedUserId } = await resolveIdentity(db, { siteId: site.id, anonymousId: event.anonymousId, externalUserId: event.externalUserId, traits: event.traits, timestamp: event.timestamp });
                if (event.anonymousId)
                    currentIdentity.set(event.anonymousId, trackedUserId);
                continue;
            }
            if (event.type === "session_start") {
                if (!event.anonymousId)
                    continue;
                await flushPendingRows();
                await recordSessionStart(db, { siteId: site.id, sessionId, anonymousId: event.anonymousId, timestamp: event.timestamp, browserName: event.browserName, browserVersion: event.browserVersion, osName: event.osName, osVersion: event.osVersion, deviceType: event.deviceType, language: event.language, timezone: event.timezone, screenWidth: event.screenWidth, screenHeight: event.screenHeight, referrer: event.referrer });
                continue;
            }
            // Keep legacy cursor/hover values in validation so a mixed batch stays
            // valid, then discard only the high-volume rows under the MVP1 policy.
            if (!shouldPersistSessionEvent(event.type))
                continue;
            const e = event;
            pendingRows.push({
                siteId: site.id,
                sessionId,
                anonymousId: e.anonymousId ?? null,
                trackedUserId: ownerFor(e.anonymousId),
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
            });
        }
        await flushPendingRows();
        // The authored Pattern matcher is retired. Keep the response shape for
        // older SDK transports while ingestion remains fully operational.
        return reply.send({ triggers: [] });
    });
}
//# sourceMappingURL=public-events.js.map