import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sites, sessionEvents, trackedUserAliases } from "../db/schema.js";
import { trackEventsBodySchema } from "../lib/patterns/validation.js";
import type { IncomingEvent } from "../lib/patterns/event.js";
import { resolveIdentity } from "../lib/identity/resolveIdentity.js";
import { recordSessionStart } from "../lib/identity/environmentContext.js";

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
    // Process the SDK's ordered event stream in order.  This gives events
    // following identify() an immutable owner while still letting identify()
    // claim earlier unresolved events in the same batch.
    const currentIdentity = new Map<string, string | null>();
    const ownerFor = async (anonymousId?: string) => {
      if (!anonymousId) return null;
      if (currentIdentity.has(anonymousId)) return currentIdentity.get(anonymousId) ?? null;
      const [alias] = await db.select({ trackedUserId: trackedUserAliases.trackedUserId }).from(trackedUserAliases)
        .where(and(eq(trackedUserAliases.siteId, site.id), eq(trackedUserAliases.anonymousId, anonymousId))).limit(1);
      const owner = alias?.trackedUserId ?? null;
      currentIdentity.set(anonymousId, owner);
      return owner;
    };

    for (const event of events) {
      if (event.type === "identify") {
        if (!event.externalUserId) continue;
        const { trackedUserId } = await resolveIdentity(db, { siteId: site.id, anonymousId: event.anonymousId, externalUserId: event.externalUserId, traits: event.traits, timestamp: event.timestamp });
        if (event.anonymousId) currentIdentity.set(event.anonymousId, trackedUserId);
        continue;
      }
      if (event.type === "session_start") {
        if (!event.anonymousId) continue;
        await recordSessionStart(db, { siteId: site.id, sessionId, anonymousId: event.anonymousId, timestamp: event.timestamp, browserName: event.browserName, browserVersion: event.browserVersion, osName: event.osName, osVersion: event.osVersion, deviceType: event.deviceType, language: event.language, timezone: event.timezone, screenWidth: event.screenWidth, screenHeight: event.screenHeight, referrer: event.referrer });
        continue;
      }
      const e = event as IncomingEvent & { anonymousId?: string; path?: string; eventId?: string; pageViewId?: string };
      await db
        .insert(sessionEvents)
        .values({
            siteId: site.id,
            sessionId,
            anonymousId: e.anonymousId ?? null,
            trackedUserId: await ownerFor(e.anonymousId),
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
          })
        .onConflictDoNothing({ target: [sessionEvents.siteId, sessionEvents.eventId] });
    }

    // The authored Pattern matcher is retired. Keep the response shape for
    // older SDK transports while ingestion remains fully operational.
    return reply.send({ triggers: [] });
  });
}
