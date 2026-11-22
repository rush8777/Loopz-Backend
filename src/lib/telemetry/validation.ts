import { z } from "zod";

/**
 * A single identify() trait value - whatever survives JSON.stringify on
 * the customer's arbitrary attributes object. Nested objects/arrays are
 * deliberately not modeled here: they're accepted (z.unknown() below)
 * and stored as their JSON-stringified form with valueType "object",
 * but the property store is not a document store - dynamic *property
 * names* are supported per task brief section 5, not deep querying into
 * nested trait shapes.
 */
const identifyTraitValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.unknown()]);

/**
 * A JSON-serializable value, recursively - what `analytics.event()`'s
 * `properties` argument is validated against. Unlike
 * `identifyTraitValueSchema` above (which accepts literally anything
 * via its trailing `z.unknown()` arm, an established looser precedent
 * for trait values), this is a real structural check: strings,
 * numbers, booleans, null, arrays of JSON values, and plain objects of
 * JSON values - not functions, not `undefined` inside an array/object,
 * not any other non-JSON runtime value. `z.lazy` is required because
 * the type is self-referential (an array/object of JsonValue).
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

const incomingEventSchema = z
  .object({
    type: z.enum(["page_view", "hover", "click", "scroll", "cursor", "rage_click", "identify", "session_start", "custom"]),
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
    documentX: z.number().int().min(0).max(20000).optional(),
    documentY: z.number().int().min(0).max(200000).optional(),
    documentWidth: z.number().int().positive().max(20000).optional(),
    documentHeight: z.number().int().positive().max(200000).optional(),
    deviceClass: z.enum(["desktop", "tablet", "mobile"]).optional(),
    heatmapStateId: z.string().min(1).max(200).optional(),
    rageClickCount: z.number().int().min(3).max(100).optional(),
    // Immutable raw PageContext.path, e.g. "/pricing". New SDKs include it
    // on all events so Pages and Session Activity can classify interactions.
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
