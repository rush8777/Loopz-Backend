import { z } from "zod";

const MAX_STEPS = 10; // sane ceiling for a "sequence of expected actions" - nothing in the UI needs more, and it bounds the evaluator's per-step queries

const funnelEventStepSchema = z.object({
  type: z.literal("event"),
  eventName: z.string().min(1).max(200),
  label: z.string().max(200).optional(),
});

const funnelPageStepSchema = z.object({
  type: z.literal("page"),
  pageId: z.string().min(1).max(64),
  label: z.string().max(200).optional(),
});

export const funnelStepSchema = z.discriminatedUnion("type", [funnelEventStepSchema, funnelPageStepSchema]);

/** Task brief section 9's option set (1 hour / 24 hours / 3 / 7 / 14 / 30 days), stored as a single "value * unit" pair rather than persisting raw minutes from the client - the backend computes the minute count, matching validation's "never trust arbitrary frontend JSON" posture used for Segments. */
const conversionWindowSchema = z.object({
  value: z.number().int().positive().max(90),
  unit: z.enum(["hours", "days"]),
});

export function conversionWindowToMinutes(window: { value: number; unit: "hours" | "days" }): number {
  return window.unit === "hours" ? window.value * 60 : window.value * 60 * 24;
}

export const createFunnelSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  steps: z.array(funnelStepSchema).min(1).max(MAX_STEPS),
  conversionWindow: conversionWindowSchema.optional(),
});

export const updateFunnelSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  steps: z.array(funnelStepSchema).min(1).max(MAX_STEPS).optional(),
  conversionWindow: conversionWindowSchema.optional(),
});
