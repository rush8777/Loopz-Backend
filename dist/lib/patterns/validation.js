import { z } from "zod";
export const patternStepSchema = z.object({
    id: z.string().min(1).max(64),
    verb: z.enum(["enter", "hover", "click", "scroll_past", "custom"]),
    target: z.object({ selector: z.string().min(1).max(500) }).optional(),
    minDurationMs: z.number().int().positive().optional(),
    minScrollPercent: z.number().min(0).max(100).optional(),
    // verb === "custom" only - the developer-defined event name this
    // step matches against (analytics.event(name, ...)'s name). See
    // PatternStep.eventName in types.ts.
    eventName: z.string().min(1).max(200).optional(),
    required: z.boolean().optional(),
    maxGapMs: z.number().int().positive().optional(),
});
export const createPatternSchema = z.object({
    name: z.string().min(1).max(200),
    matchWindowMs: z.number().int().positive().max(24 * 60 * 60 * 1000), // sanity cap: 24h
    steps: z.array(patternStepSchema).min(1).max(20),
    feedback: z.object({
        message: z.string().min(1).max(2000),
        targetSelector: z.string().min(1).max(500),
    }),
});
export const updatePatternSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    status: z.enum(["DRAFT", "ACTIVE", "PAUSED"]).optional(),
    matchWindowMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
    steps: z.array(patternStepSchema).min(1).max(20).optional(),
    feedback: z
        .object({ message: z.string().min(1).max(2000), targetSelector: z.string().min(1).max(500) })
        .optional(),
});
/**
 * A single identify() trait value - whatever survives JSON.stringify on
 * the customer's arbitrary attributes object. Nested objects/arrays are
 * deliberately not modeled here: they're accepted (z.unknown() below)
 * and stored as their JSON-stringified form with valueType "object",
 * but the property store is not a document store - dynamic *property
 * names* are supported per task brief section 5, not deep querying into
 * nested trait shapes.
 */
export const identifyTraitValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.unknown()]);
const jsonValueSchema = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]));
export const incomingEventSchema = z
    .object({
    type: z.enum(["page_view", "hover", "click", "scroll", "cursor", "identify", "session_start", "custom"]),
    timestamp: z.number().int().nonnegative(),
    // The SDK's durable anonymous visitor id (SessionManager.getAnonymousId()).
    // Optional for backward compatibility with any client still on an
    // older SDK build that doesn't send it - those events just won't
    // resolve to a tracked user's identity.
    anonymousId: z.string().min(1).max(200).optional(),
    // The SDK-generated id for this specific event (AnalyticsEvent.eventId -
    // see core/Analytics.ts's buildAndEnqueue on the SDK side). Lets
    // ingestion dedupe a retried event/batch at the (siteId, eventId)
    // level - see the unique index on session_events. Optional for
    // backward compatibility with any client still on an older SDK build
    // that doesn't send one - those events simply aren't deduped, same
    // tradeoff already made for anonymousId above.
    eventId: z.string().min(1).max(200).optional(),
    // The SDK's page-view lifecycle id active when this event was captured
    // (AnalyticsEvent.pageViewId - see SessionManager's getPageViewId()/
    // newPageView() on the SDK side). The SDK alone owns when this
    // advances (route change); this backend only ever persists whatever
    // value it's sent, never generates or mutates one. Optional for the
    // same backward-compatibility reason as eventId/anonymousId.
    pageViewId: z.string().min(1).max(200).optional(),
    element: z
        .object({
        selector: z.string().min(1).max(500),
        label: z.string().min(1).max(200).optional(),
        role: z.string().min(1).max(100).optional(),
    })
        .optional(),
    durationMs: z.number().int().nonnegative().optional(),
    scrollPercent: z.number().min(0).max(100).optional(),
    x: z.number().int().min(0).max(20000).optional(),
    y: z.number().int().min(0).max(200000).optional(), // pages can be tall - generous bound, not a real screen limit
    viewportWidth: z.number().int().positive().max(20000).optional(),
    viewportHeight: z.number().int().positive().max(200000).optional(),
    // page_view only - PageContext.path, e.g. "/pricing". What lets the
    // user-profile activity feed say "Viewed /pricing" and what
    // first_page/last_page are derived from.
    path: z.string().min(1).max(2000).optional(),
    // identify only - the customer's own user id and (optionally)
    // whatever attributes they passed. See resolveIdentity.ts.
    externalUserId: z.string().min(1).max(200).optional(),
    traits: z.record(z.string().min(1).max(200), identifyTraitValueSchema).optional(),
    // session_start only - automatically-collected environment context.
    // See EnvironmentContext.ts on the SDK side for what these are and
    // why nothing more invasive (fingerprinting, IP) is captured.
    browserName: z.string().min(1).max(50).optional(),
    browserVersion: z.string().min(1).max(50).optional(),
    osName: z.string().min(1).max(50).optional(),
    osVersion: z.string().min(1).max(50).optional(),
    deviceType: z.enum(["desktop", "mobile", "tablet"]).optional(),
    language: z.string().min(1).max(35).optional(),
    timezone: z.string().min(1).max(100).optional(),
    screenWidth: z.number().int().positive().max(20000).optional(),
    screenHeight: z.number().int().positive().max(20000).optional(),
    referrer: z.string().min(1).max(2000).optional(),
    // custom only - the developer-defined event contract
    // (analytics.event(name, properties?) on the SDK). `name` is
    // required whenever type === "custom" (enforced by the .refine
    // below, since it's cross-field with `type`); `properties` is
    // optional and, when present, must be JSON-serializable - see
    // jsonValueSchema above. Both are simply ignored for every other
    // event type, same as every other type-specific field here.
    name: z.string().min(1).max(200).optional(),
    properties: z.record(z.string().min(1).max(200), jsonValueSchema).optional(),
})
    .refine((event) => event.type !== "custom" || (event.name != null && event.name.length > 0), {
    message: "custom events require a non-empty name",
    path: ["name"],
});
export const trackEventsBodySchema = z.object({
    sessionId: z.string().min(1).max(200),
    events: z.array(incomingEventSchema).min(1).max(200), // one batch shouldn't be unbounded - matches the SDK's own batch size cap
});
export const crawledElementSchema = z.object({
    selector: z.string().min(1).max(500),
    tagName: z.string().min(1).max(50),
    label: z.string().min(1).max(200).optional(),
    role: z.string().min(1).max(100).optional(),
});
export const trackElementsBodySchema = z.object({
    elements: z.array(crawledElementSchema).min(1).max(500), // matches the SDK's ElementCrawler per-crawl cap
});
/**
 * Raw rrweb event shape - deliberately loose on `data` (rrweb's internal
 * event payloads are complex and versioned; this backend stores them
 * opaquely and never interprets them, same principle as the SDK's own
 * RRWebRecorder never transforming rrweb events).
 */
export const replayEventSchema = z.object({
    type: z.number().int().nonnegative(), // rrweb's own numeric event type (2 = FullSnapshot, etc.)
    timestamp: z.number().int().nonnegative(),
    data: z.unknown(),
});
export const trackReplayBodySchema = z.object({
    sessionId: z.string().min(1).max(200),
    events: z.array(replayEventSchema).min(1).max(500),
});
//# sourceMappingURL=validation.js.map