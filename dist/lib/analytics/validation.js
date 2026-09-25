import { z } from "zod";
export const ANALYTICS_LIMITS = {
    maxRangeDays: 400,
    maxCards: 24,
    maxSeries: 10,
    maxSegments: 10,
    maxBuckets: 400,
    maxBreakdownRows: 50,
    maxResultCells: 5000,
    maxDrilldownRows: 100,
    maxExcludedEvents: 50,
};
export const granularitySchema = z.enum(["day", "week", "month"]);
export const dashboardFiltersSchema = z.object({
    since: z.string().datetime(),
    until: z.string().datetime(),
    granularity: granularitySchema,
    segmentId: z.string().min(1).max(64).optional(),
    excludedEventNames: z.array(z.string().min(1).max(200)).max(ANALYTICS_LIMITS.maxExcludedEvents).default([]),
}).superRefine((value, ctx) => {
    const since = new Date(value.since).getTime();
    const until = new Date(value.until).getTime();
    if (until <= since)
        ctx.addIssue({ code: "custom", message: "until must be after since", path: ["until"] });
    if (until - since > ANALYTICS_LIMITS.maxRangeDays * 86_400_000) {
        ctx.addIssue({ code: "custom", message: `date range cannot exceed ${ANALYTICS_LIMITS.maxRangeDays} days`, path: ["until"] });
    }
});
export const metricIdSchema = z.enum([
    "users.unique", "users.conversion_rate", "users.stickiness",
    "sessions.count", "sessions.conversion_rate", "sessions.observed_duration",
    "events.occurrences", "events.per_user", "events.per_session",
]);
export const breakdownSchema = z.discriminatedUnion("dimension", [
    z.object({ dimension: z.enum(["page", "page_area", "page_type", "event", "identity", "device", "browser", "os", "language", "referrer"]) }),
    z.object({ dimension: z.literal("segment"), segmentIds: z.array(z.string().min(1).max(64)).min(1).max(ANALYTICS_LIMITS.maxSegments) }),
    z.object({ dimension: z.literal("user_property"), propertyName: z.string().min(1).max(100) }),
]);
const eventSetSchema = z.object({
    eventNames: z.array(z.string().min(1).max(200)).min(1).max(ANALYTICS_LIMITS.maxSeries),
    match: z.enum(["each", "any", "all"]),
});
const targetSchema = z.object({ value: z.number().finite(), direction: z.enum(["at_least", "at_most"]), intent: z.enum(["achieve", "maintain"]) });
export const metricConfigurationSchema = z.object({
    schemaVersion: z.literal(1), kind: z.literal("metric"), metricId: metricIdSchema,
    events: eventSetSchema.optional(),
    conversion: z.object({ numeratorEvent: z.string().min(1).max(200), denominatorEvent: z.string().min(1).max(200).optional() }).optional(),
    mode: z.enum(["trend", "breakdown", "single"]),
    breakdown: breakdownSchema.optional(),
    visualization: z.enum(["line", "bars", "stacked_bars", "horizontal_bars", "table", "total", "recent", "previous_period"]),
    target: targetSchema.optional(),
}).superRefine((value, ctx) => {
    const conversion = value.metricId.endsWith("conversion_rate");
    if (conversion !== Boolean(value.conversion))
        ctx.addIssue({ code: "custom", message: conversion ? "conversion definition is required" : "conversion is only valid for conversion metrics", path: ["conversion"] });
    if (conversion && value.events)
        ctx.addIssue({ code: "custom", message: "conversion metrics do not use event matching", path: ["events"] });
    if (value.metricId.startsWith("events.") && value.events?.match === "all")
        ctx.addIssue({ code: "custom", message: "All is not supported for occurrence metrics", path: ["events", "match"] });
    if ((value.mode === "breakdown") !== Boolean(value.breakdown))
        ctx.addIssue({ code: "custom", message: value.mode === "breakdown" ? "breakdown is required" : "breakdown is only valid in breakdown mode", path: ["breakdown"] });
    const allowed = value.mode === "trend" ? ["line", "bars", "stacked_bars", "table"] : value.mode === "breakdown" ? ["bars", "horizontal_bars", "table"] : ["total", "recent", "previous_period"];
    if (!allowed.includes(value.visualization))
        ctx.addIssue({ code: "custom", message: "visualization is not valid for this result mode", path: ["visualization"] });
    if (value.target && value.visualization === "table")
        ctx.addIssue({ code: "custom", message: "targets are not supported by tables", path: ["target"] });
    if (value.events?.match === "each" && value.breakdown)
        ctx.addIssue({ code: "custom", message: "Each cannot be combined with a second breakdown", path: ["breakdown"] });
});
const retentionEventSchema = z.union([
    z.object({ type: z.literal("any_meaningful") }),
    z.object({ type: z.literal("event"), eventName: z.string().min(1).max(200) }),
]);
export const funnelConfigurationSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("funnel"), funnelId: z.string().min(1).max(64) });
export const retentionConfigurationSchema = z.object({
    schemaVersion: z.literal(1), kind: z.literal("retention"), startEvent: retentionEventSchema, returnEvent: retentionEventSchema,
    cohort: z.union([
        z.object({ type: z.literal("start_date") }),
        z.object({ type: z.literal("segments"), segmentIds: z.array(z.string().min(1).max(64)).min(1).max(ANALYTICS_LIMITS.maxSegments) }),
    ]),
    visualization: z.enum(["grid", "trend"]),
});
export const experienceConfigurationSchema = z.object({
    schemaVersion: z.literal(1), kind: z.literal("experience"), experienceType: z.enum(["guide", "survey", "widget", "checklist"]), experienceId: z.string().min(1).max(64),
    metric: z.enum(["users_seen", "completions", "completion_rate", "dismissals", "step_reach", "step_drop_off", "responses", "response_rate", "abandonment_rate", "impressions", "interactions", "interaction_rate"]),
    visualization: z.enum(["total", "bars", "horizontal_bars", "table"]),
});
export const cardConfigurationSchema = z.discriminatedUnion("kind", [metricConfigurationSchema, funnelConfigurationSchema, retentionConfigurationSchema, experienceConfigurationSchema]);
export const dashboardCardInputSchema = z.object({
    id: z.string().min(1).max(64).optional(), title: z.string().trim().min(1).max(120),
    cardType: z.enum(["metric", "funnel", "retention", "experience"]), width: z.enum(["small", "medium", "full"]), configuration: cardConfigurationSchema,
}).superRefine((value, ctx) => { if (value.cardType !== value.configuration.kind)
    ctx.addIssue({ code: "custom", message: "cardType must match configuration kind", path: ["configuration", "kind"] }); });
export const dashboardCreateSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).nullable().optional(), cards: z.array(dashboardCardInputSchema).max(ANALYTICS_LIMITS.maxCards).default([]) });
export const dashboardUpdateSchema = dashboardCreateSchema.partial().refine((v) => Object.keys(v).length > 0, "At least one field is required");
export const analyticsQuerySchema = z.object({ filters: dashboardFiltersSchema, query: cardConfigurationSchema });
export const analyticsBatchSchema = z.object({ filters: dashboardFiltersSchema, queries: z.array(z.object({ requestId: z.string().min(1).max(100), query: cardConfigurationSchema })).min(1).max(ANALYTICS_LIMITS.maxCards) });
export const drilldownSchema = analyticsQuerySchema.extend({ selection: z.object({ bucketStart: z.string().datetime().optional(), bucketEnd: z.string().datetime().optional(), seriesKey: z.string().max(200).optional(), breakdownKey: z.string().max(200).optional(), stepIndex: z.number().int().min(0).optional(), cohortKey: z.string().max(200).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(ANALYTICS_LIMITS.maxDrilldownRows).default(50) }) });
//# sourceMappingURL=validation.js.map