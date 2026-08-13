import { z } from "zod";

export const patternStepSchema = z.object({
  id: z.string().min(1).max(64),
  verb: z.enum(["enter", "hover", "click", "scroll_past"]),
  target: z.object({ selector: z.string().min(1).max(500) }).optional(),
  minDurationMs: z.number().int().positive().optional(),
  minScrollPercent: z.number().min(0).max(100).optional(),
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

export const incomingEventSchema = z.object({
  type: z.enum(["page_view", "hover", "click", "scroll", "cursor"]),
  timestamp: z.number().int().nonnegative(),
  element: z.object({ selector: z.string().min(1).max(500) }).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  scrollPercent: z.number().min(0).max(100).optional(),
  x: z.number().int().min(0).max(20000).optional(),
  y: z.number().int().min(0).max(200000).optional(), // pages can be tall - generous bound, not a real screen limit
  viewportWidth: z.number().int().positive().max(20000).optional(),
  viewportHeight: z.number().int().positive().max(200000).optional(),
});

export const trackEventsBodySchema = z.object({
  sessionId: z.string().min(1).max(200),
  events: z.array(incomingEventSchema).min(1).max(200), // one batch shouldn't be unbounded - matches the SDK's own batch size cap
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
