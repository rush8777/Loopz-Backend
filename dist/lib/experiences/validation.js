import { z } from "zod";
import { builderCssIsSafe, builderHtmlIsSafe } from "./builderContentContract.js";
import { pageRuleSchema } from "../pages/validation.js";
const selectorSchema = z.string().trim().min(1).max(1000);
const safeColorSchema = z.string().trim().min(1).max(40).regex(/^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s-]+\)|[a-z]{1,20})$/i, "unsupported color value");
const actionSchema = z.object({
    label: z.string().trim().min(1).max(80),
    type: z.enum(["dismiss", "next_step", "open_url", "track_event"]),
    url: z.url().max(2000).optional(),
    eventName: z.string().trim().min(1).max(200).optional(),
}).superRefine((action, ctx) => {
    if (action.type === "open_url" && !action.url)
        ctx.addIssue({ code: "custom", path: ["url"], message: "url is required" });
    if (action.url && !/^https?:\/\//i.test(action.url))
        ctx.addIssue({ code: "custom", path: ["url"], message: "only http(s) URLs are allowed" });
    if (action.type === "track_event" && !action.eventName)
        ctx.addIssue({ code: "custom", path: ["eventName"], message: "eventName is required" });
});
export const contentSchema = z.object({
    heading: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(2000),
    primaryAction: actionSchema.optional(),
    secondaryAction: z.object({ label: z.string().trim().min(1).max(80), type: z.literal("dismiss") }).optional(),
});
export const targetSchema = z.object({
    primarySelector: selectorSchema,
    fallbackSelectors: z.array(selectorSchema).max(5),
    label: z.string().max(200).optional(),
    role: z.string().max(80).optional(),
    tagName: z.string().max(40).optional(),
    reliability: z.enum(["reliable", "moderate", "fragile"]),
    targetContext: z.object({ pagePath: z.string().min(1).max(2048) }).strict().optional(),
});
const sizeSchema = z.object({
    width: z.discriminatedUnion("mode", [z.object({ mode: z.literal("auto") }).strict(), z.object({ mode: z.literal("fixed"), value: z.number().int().min(1).max(4000) }).strict(), z.object({ mode: z.literal("full") }).strict()]),
    height: z.discriminatedUnion("mode", [z.object({ mode: z.literal("auto") }).strict(), z.object({ mode: z.literal("fixed"), value: z.number().int().min(1).max(4000) }).strict(), z.object({ mode: z.literal("viewport") }).strict()]),
}).strict();
const designSchema = z.object({
    width: z.enum(["sm", "md", "lg"]),
    size: sizeSchema.optional(),
    theme: z.object({
        background: safeColorSchema,
        foreground: safeColorSchema,
        primary: safeColorSchema,
        borderRadius: z.enum(["sm", "md", "lg"]),
    }),
});
function builderProjectValueIsSafe(value) {
    if (typeof value === "string")
        return !/<\s*script\b|\son[a-z]+\s*=|javascript\s*:/i.test(value);
    if (Array.isArray(value))
        return value.every(builderProjectValueIsSafe);
    if (!value || typeof value !== "object")
        return true;
    return Object.entries(value).every(([key, nested]) => !/^on[a-z]+$/i.test(key) && !/^script(?:-|$)/i.test(key) && builderProjectValueIsSafe(nested));
}
const builderShape = {
    version: z.literal(1),
    projectData: z.record(z.string(), z.unknown()).refine(builderProjectValueIsSafe, "unsafe builder project data"),
    css: z.string().max(250_000).refine(builderCssIsSafe, "builder CSS must be safe and scoped under .movecues-widget"),
    canvas: z.object({ zoom: z.number().finite().min(25).max(200), panX: z.number().finite(), panY: z.number().finite() }).strict().optional(),
};
const builderSchema = z.object({ ...builderShape, html: z.string().max(500_000).refine(value => builderHtmlIsSafe(value), "unsafe builder HTML") }).strict();
const surveyBuilderSchema = z.object({ ...builderShape, html: z.string().max(500_000).refine(value => builderHtmlIsSafe(value, true), "unsafe survey builder HTML") }).strict();
const layerSchema = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto") }).strict(),
    z.object({ mode: z.literal("relative"), relation: z.enum(["above", "below"]), target: targetSchema }).strict(),
    z.object({ mode: z.literal("always_on_top") }).strict(),
    z.object({ mode: z.literal("custom"), zIndex: z.number().int().min(1).max(2147483647) }).strict(),
]);
const behaviorSchema = z.object({
    dismissible: z.boolean(),
    layer: layerSchema.optional(),
    zIndex: z.number().int().min(1).max(2147483647).optional(),
    placement: z.enum(["auto", "top", "right", "bottom", "left"]).optional(),
    alignment: z.enum(["start", "center", "end"]).optional(),
    offset: z.number().int().min(0).max(100).optional(),
    pointer: z.object({ enabled: z.boolean().optional(), size: z.number().int().min(4).max(30).optional() }).strict().optional(),
    toastPosition: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).optional(),
    autoDismissMs: z.number().int().min(500).max(300000).nullable().optional(),
    cursorOffset: z.object({ x: z.number().int().min(-200).max(200), y: z.number().int().min(-200).max(200) }).optional(),
    modalLayout: z.enum(["center", "fullscreen"]).optional(),
    backdrop: z.boolean().optional(),
    backdropOpacity: z.number().min(0).max(0.9).optional(),
    closeOnBackdrop: z.boolean().optional(),
    slideoutPosition: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "center-left", "center-right"]).optional(),
    bannerPosition: z.enum(["top", "bottom"]).optional(),
    hotspotStyle: z.enum(["pulse", "dot", "question"]).optional(),
    hotspotColor: safeColorSchema.optional(),
});
const targetingSchema = z.object({
    pageRules: z.array(pageRuleSchema).max(30),
    audience: z.discriminatedUnion("type", [
        z.object({ type: z.literal("all") }),
        z.object({ type: z.literal("segment"), segmentId: z.string().min(1).max(64) }),
        z.object({ type: z.literal("segment_rules"), logic: z.enum(["all", "any"]), conditions: z.array(z.object({ id: z.string().min(1).max(64), segmentId: z.string().min(1).max(64), operator: z.enum(["matches", "not_matches"]) })).min(1).max(20) }),
    ]),
    trigger: z.discriminatedUnion("type", [
        z.object({ type: z.literal("page_load") }),
        z.object({ type: z.literal("custom_event"), eventName: z.string().trim().min(1).max(200) }),
    ]),
    frequency: z.object({
        mode: z.enum(["once", "once_per_session", "every_time"]),
        cooldownHours: z.number().int().min(1).max(8760).optional(),
        maxImpressions: z.number().int().min(1).max(10000).optional(),
    }),
    priority: z.number().int().min(-1000).max(1000),
    interruptPolicy: z.enum(["queue", "interrupt"]).optional(),
    schedule: z.object({ startsAt: z.iso.datetime().optional(), endsAt: z.iso.datetime().optional() }).optional().superRefine((value, ctx) => { if (value?.startsAt && value.endsAt && value.startsAt >= value.endsAt)
        ctx.addIssue({ code: "custom", message: "end must be after start" }); }),
    allowedOrigins: z.array(z.url().transform(value => new URL(value).origin)).max(20).optional(),
});
export const widgetDefinitionSchema = z.object({
    content: contentSchema,
    design: designSchema,
    behavior: behaviorSchema,
    builder: builderSchema.optional(),
    target: targetSchema.optional(),
    targeting: targetingSchema,
    survey: z.lazy(() => surveyConfigSchema).optional(),
}).strict().superRefine((definition, ctx) => {
    if (definition.content.primaryAction?.type === "next_step")
        ctx.addIssue({ code: "custom", path: ["content", "primaryAction", "type"], message: "next_step is only supported by guides" });
});
const surveyIdSchema = z.string().trim().min(1).max(64);
const surveyOptionSchema = z.object({ id: surveyIdSchema, label: z.string().trim().min(1).max(200) }).strict();
const surveyQuestionBase = { id: surveyIdSchema, label: z.string().trim().min(1).max(500), required: z.boolean().optional() };
export const surveyQuestionSchema = z.discriminatedUnion("type", [
    z.object({ ...surveyQuestionBase, type: z.literal("single_choice"), options: z.array(surveyOptionSchema).min(1).max(20) }).strict(),
    z.object({ ...surveyQuestionBase, type: z.literal("multiple_choice"), options: z.array(surveyOptionSchema).min(1).max(20) }).strict(),
    z.object({ ...surveyQuestionBase, type: z.literal("short_text"), placeholder: z.string().max(500).optional(), maxLength: z.number().int().min(1).max(10_000).optional() }).strict(),
    z.object({ ...surveyQuestionBase, type: z.literal("long_text"), placeholder: z.string().max(500).optional(), maxLength: z.number().int().min(1).max(10_000).optional() }).strict(),
    z.object({ ...surveyQuestionBase, type: z.literal("rating"), min: z.number().int().min(0).max(100), max: z.number().int().min(1).max(100) }).strict().refine(value => value.max > value.min && value.max - value.min <= 20, { message: "rating range must be ascending and contain at most 21 values" }),
    z.object({ ...surveyQuestionBase, type: z.literal("nps") }).strict(),
]);
const surveyStepSchema = z.object({
    id: surveyIdSchema,
    content: z.object({ heading: z.string().trim().max(500), body: z.string().trim().max(2000) }).strict(),
    questions: z.array(surveyQuestionSchema).max(20),
    builder: surveyBuilderSchema.optional(),
    size: sizeSchema.optional(),
}).strict().superRefine((step, ctx) => {
    const questionIds = new Set();
    step.questions.forEach((question, questionIndex) => {
        if (questionIds.has(question.id))
            ctx.addIssue({ code: "custom", path: ["questions", questionIndex, "id"], message: "question IDs must be unique" });
        questionIds.add(question.id);
        if ("options" in question) {
            const optionIds = new Set();
            question.options.forEach((option, optionIndex) => { if (optionIds.has(option.id))
                ctx.addIssue({ code: "custom", path: ["questions", questionIndex, "options", optionIndex, "id"], message: "option IDs must be unique" }); optionIds.add(option.id); });
        }
    });
    if (step.builder) {
        const markers = Array.from(step.builder.html.matchAll(/<[^>]*\bdata-movecues-question-id\s*=\s*["']([^"']+)["'][^>]*>/gi));
        const structured = new Map(step.questions.map(question => [question.id, question.type]));
        const counts = new Map();
        markers.forEach(marker => {
            const id = marker[1];
            counts.set(id, (counts.get(id) ?? 0) + 1);
            const type = /\bdata-movecues-question-type\s*=\s*["']([^"']+)["']/i.exec(marker[0])?.[1];
            if (!structured.has(id) || structured.get(id) !== type)
                ctx.addIssue({ code: "custom", path: ["builder", "html"], message: "survey question markup must match structured question IDs and types" });
        });
        step.questions.forEach(question => { if (counts.get(question.id) !== 1)
            ctx.addIssue({ code: "custom", path: ["builder", "html"], message: `question ${question.id} must appear exactly once in builder HTML` }); });
    }
});
export const surveyConfigSchema = z.object({
    steps: z.array(surveyStepSchema).min(1).max(20),
    showProgress: z.boolean(),
    allowBack: z.boolean(),
    submitLabel: z.string().trim().min(1).max(80),
}).strict().superRefine((survey, ctx) => {
    const stepIds = new Set();
    const questionIds = new Set();
    survey.steps.forEach((step, stepIndex) => {
        if (stepIds.has(step.id))
            ctx.addIssue({ code: "custom", path: ["steps", stepIndex, "id"], message: "step IDs must be unique" });
        stepIds.add(step.id);
        step.questions.forEach((question, questionIndex) => { if (questionIds.has(question.id))
            ctx.addIssue({ code: "custom", path: ["steps", stepIndex, "questions", questionIndex, "id"], message: "question IDs must be unique across the survey" }); questionIds.add(question.id); });
    });
});
const guideStepSchema = z.object({
    id: z.string().min(1).max(64),
    pattern: z.enum(["anchored_card", "modal"]).optional(),
    content: contentSchema,
    builder: builderSchema.optional(),
    size: sizeSchema.optional(),
    advance: z.discriminatedUnion("type", [
        z.object({ type: z.literal("button") }).strict(),
        z.object({ type: z.literal("element_click") }).strict(),
        z.object({ type: z.literal("element_hover"), durationMs: z.number().int().min(100).max(60_000).optional() }).strict(),
        z.object({ type: z.literal("custom_event"), eventName: z.string().trim().min(1).max(200) }).strict(),
        z.object({ type: z.literal("route"), pageRules: z.array(pageRuleSchema).min(1).max(30).refine(rules => rules.some(rule => rule.kind === "include"), "at least one include rule is required") }).strict(),
    ]).optional(),
    target: targetSchema.optional(),
    behavior: behaviorSchema.pick({ placement: true, alignment: true, offset: true, pointer: true, dismissible: true }),
}).superRefine((step, ctx) => {
    if (step.pattern === "modal" && (step.advance?.type === "element_click" || step.advance?.type === "element_hover"))
        ctx.addIssue({ code: "custom", path: ["advance"], message: "modal guide steps cannot advance from a DOM target" });
});
export const guideDefinitionSchema = z.object({
    steps: z.array(guideStepSchema).min(1).max(20),
    design: designSchema,
    behavior: z.object({ layer: layerSchema.optional() }).strict().optional(),
    targeting: targetingSchema,
}).strict();
export const createExperienceSchema = z.object({
    kind: z.enum(["guide", "widget"]),
    widgetType: z.enum(["anchored_card", "toast", "cursor_follow", "modal", "slideout", "hotspot", "banner", "survey"]).nullable().optional(),
    name: z.string().trim().min(1).max(200),
    buildPageId: z.string().min(1).max(64).nullable().optional(),
    buildUrl: z.url().max(2000).nullable().optional(),
    template: z.literal("blank").default("blank"),
    useBuildPageAsTarget: z.boolean().default(false),
}).superRefine((value, ctx) => {
    if (value.kind === "widget" && !value.widgetType)
        ctx.addIssue({ code: "custom", path: ["widgetType"], message: "widgetType is required" });
    if (value.kind === "guide" && value.widgetType)
        ctx.addIssue({ code: "custom", path: ["widgetType"], message: "guides do not have a widgetType" });
    if (!value.buildPageId && !value.buildUrl)
        ctx.addIssue({ code: "custom", path: ["buildUrl"], message: "a build page or URL is required" });
});
export const updateDraftSchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    definition: z.unknown().optional(),
}).refine((value) => value.name !== undefined || value.definition !== undefined, "at least one field is required");
export const manifestQuerySchema = z.object({
    url: z.url().max(2000),
    anonymousId: z.string().min(1).max(200),
    trackedUserId: z.string().min(1).max(200).optional(),
    sessionId: z.string().min(1).max(200),
    trigger: z.string().min(1).max(200).optional(),
    activeGuideId: z.string().min(1).max(64).optional(),
    activeGuideVersionId: z.string().min(1).max(64).optional(),
}).refine(value => Boolean(value.activeGuideId) === Boolean(value.activeGuideVersionId), { message: "active Guide ID and version must be provided together" });
export const impressionSchema = z.object({
    experienceId: z.string().min(1).max(64),
    versionId: z.string().min(1).max(64),
    anonymousId: z.string().min(1).max(200).optional(),
    trackedUserId: z.string().min(1).max(200).optional(),
    sessionId: z.string().min(1).max(200).optional(),
    pageViewId: z.string().min(1).max(200).optional(),
    event: z.enum(["shown", "dismissed", "completed", "action", "interaction"]),
    eventType: z.enum(["experience_shown", "guide_step_shown", "guide_step_completed", "guide_completed", "guide_dismissed", "survey_started", "survey_step_completed", "survey_submitted", "survey_abandoned", "widget_interacted", "widget_dismissed"]).optional(),
    impressionId: z.string().min(1).max(64).optional(),
    stepId: z.string().min(1).max(64).optional(),
    stepIndex: z.number().int().min(0).max(1000).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    action: z.string().min(1).max(80).optional(),
    timestamp: z.number().int().positive().default(() => Date.now()),
}).superRefine((value, ctx) => {
    if (value.event !== "shown" && !value.impressionId)
        ctx.addIssue({ code: "custom", path: ["impressionId"], message: "impression ID is required" });
    if (value.eventType?.startsWith("guide_step_") && (!value.stepId || value.stepIndex === undefined))
        ctx.addIssue({ code: "custom", path: ["stepId"], message: "Guide step events require a step ID and index" });
});
const surveyAnswerValueSchema = z.union([z.string().max(10_000), z.array(z.string().max(64)).max(20), z.number().int()]);
const surveyIdentityShape = {
    experienceId: z.string().min(1).max(64), versionId: z.string().min(1).max(64), impressionId: z.string().min(1).max(64),
    anonymousId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), trackedUserId: z.string().min(1).max(200).optional(),
};
export const createSurveyResponseSchema = z.object(surveyIdentityShape).strict();
export const updateSurveyResponseSchema = z.object({
    ...surveyIdentityShape,
    currentStepId: z.string().min(1).max(64).nullable().optional(),
    answers: z.record(z.string().min(1).max(64), surveyAnswerValueSchema),
    submitted: z.boolean().optional(),
    abandoned: z.boolean().optional(),
}).strict().refine(value => !(value.submitted && value.abandoned), "a response cannot be submitted and abandoned together");
export function definitionSchemaFor(kind, widgetType) {
    if (kind === "guide")
        return guideDefinitionSchema;
    return widgetDefinitionSchema.superRefine((definition, ctx) => {
        if (widgetType === "survey" && !definition.survey)
            ctx.addIssue({ code: "custom", path: ["survey"], message: "survey config is required for survey widgets" });
        if (widgetType !== "survey" && definition.survey)
            ctx.addIssue({ code: "custom", path: ["survey"], message: "survey config is only supported by survey widgets" });
    });
}
//# sourceMappingURL=validation.js.map