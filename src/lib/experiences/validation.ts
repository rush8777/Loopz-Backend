import { z } from "zod";
import { pageRuleSchema } from "../pages/validation.js";

const selectorSchema = z.string().trim().min(1).max(1000);
const safeColorSchema = z.string().trim().min(1).max(40).regex(/^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s-]+\)|[a-z]{1,20})$/i, "unsupported color value");

const actionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  type: z.enum(["dismiss", "next_step", "open_url", "track_event"]),
  url: z.url().max(2000).optional(),
  eventName: z.string().trim().min(1).max(200).optional(),
}).superRefine((action, ctx) => {
  if (action.type === "open_url" && !action.url) ctx.addIssue({ code: "custom", path: ["url"], message: "url is required" });
  if (action.url && !/^https?:\/\//i.test(action.url)) ctx.addIssue({ code: "custom", path: ["url"], message: "only http(s) URLs are allowed" });
  if (action.type === "track_event" && !action.eventName) ctx.addIssue({ code: "custom", path: ["eventName"], message: "eventName is required" });
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
});

const designSchema = z.object({
  width: z.enum(["sm", "md", "lg"]),
  theme: z.object({
    background: safeColorSchema,
    foreground: safeColorSchema,
    primary: safeColorSchema,
    borderRadius: z.enum(["sm", "md", "lg"]),
  }),
});

function builderCssIsSafe(value: string): boolean {
  const css = value.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding/i.test(css)) return false;
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1].trim();
    if (!prelude || prelude.startsWith("@")) continue;
    if (prelude.split(",").some(selector => !selector.trim().includes(".loopz-widget"))) return false;
  }
  return true;
}

function builderProjectValueIsSafe(value: unknown): boolean {
  if (typeof value === "string") return !/<\s*script\b|\son[a-z]+\s*=|javascript\s*:/i.test(value);
  if (Array.isArray(value)) return value.every(builderProjectValueIsSafe);
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, nested]) => !/^on[a-z]+$/i.test(key) && !/^script(?:-|$)/i.test(key) && builderProjectValueIsSafe(nested));
}

const builderSchema = z.object({
  version: z.literal(1),
  projectData: z.record(z.string(), z.unknown()).refine(builderProjectValueIsSafe, "unsafe builder project data"),
  html: z.string().max(500_000).refine(value => !/<\s*(script|style|iframe|object|embed|form|input|textarea|select|video|audio)\b|\son[a-z]+\s*=|javascript\s*:/i.test(value), "unsafe builder HTML"),
  css: z.string().max(250_000).refine(builderCssIsSafe, "builder CSS must be safe and scoped under .loopz-widget"),
}).strict();

const behaviorSchema = z.object({
  dismissible: z.boolean(),
  zIndex: z.number().int().min(1).max(2147483647).optional(),
  placement: z.enum(["auto", "top", "right", "bottom", "left"]).optional(),
  alignment: z.enum(["start", "center", "end"]).optional(),
  offset: z.number().int().min(0).max(100).optional(),
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
  schedule: z.object({ startsAt: z.iso.datetime().optional(), endsAt: z.iso.datetime().optional() }).optional().superRefine((value, ctx) => { if (value?.startsAt && value.endsAt && value.startsAt >= value.endsAt) ctx.addIssue({ code: "custom", message: "end must be after start" }); }),
  allowedOrigins: z.array(z.url().transform(value => new URL(value).origin)).max(20).optional(),
});

export const widgetDefinitionSchema = z.object({
  content: contentSchema,
  design: designSchema,
  behavior: behaviorSchema,
  builder: builderSchema.optional(),
  target: targetSchema.optional(),
  targeting: targetingSchema,
}).strict().superRefine((definition, ctx) => {
  if (definition.content.primaryAction?.type === "next_step") ctx.addIssue({ code: "custom", path: ["content", "primaryAction", "type"], message: "next_step is only supported by guides" });
});

const guideStepSchema = z.object({
  id: z.string().min(1).max(64),
  content: contentSchema,
  target: targetSchema.optional(),
  behavior: behaviorSchema.pick({ placement: true, alignment: true, offset: true, dismissible: true }),
});

export const guideDefinitionSchema = z.object({
  steps: z.array(guideStepSchema).min(1).max(20),
  design: designSchema,
  targeting: targetingSchema,
}).strict();

export const createExperienceSchema = z.object({
  kind: z.enum(["guide", "widget"]),
  widgetType: z.enum(["anchored_card", "toast", "cursor_follow", "modal", "slideout", "hotspot", "banner"]).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  buildPageId: z.string().min(1).max(64).nullable().optional(),
  buildUrl: z.url().max(2000).nullable().optional(),
  template: z.literal("blank").default("blank"),
  useBuildPageAsTarget: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.kind === "widget" && !value.widgetType) ctx.addIssue({ code: "custom", path: ["widgetType"], message: "widgetType is required" });
  if (value.kind === "guide" && value.widgetType) ctx.addIssue({ code: "custom", path: ["widgetType"], message: "guides do not have a widgetType" });
  if (!value.buildPageId && !value.buildUrl) ctx.addIssue({ code: "custom", path: ["buildUrl"], message: "a build page or URL is required" });
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
});

export const impressionSchema = z.object({
  experienceId: z.string().min(1).max(64),
  versionId: z.string().min(1).max(64),
  anonymousId: z.string().min(1).max(200).optional(),
  trackedUserId: z.string().min(1).max(200).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  pageViewId: z.string().min(1).max(200).optional(),
  event: z.enum(["shown", "dismissed", "completed", "action"]),
  impressionId: z.string().min(1).max(64).optional(),
  action: z.string().min(1).max(80).optional(),
});

export function definitionSchemaFor(kind: "guide" | "widget") {
  return kind === "guide" ? guideDefinitionSchema : widgetDefinitionSchema;
}
