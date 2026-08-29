import { z } from "zod";
import type { SegmentGroup, SegmentNode } from "./types.js";

/** Mirrors incomingEventSchema's window/time conventions elsewhere in this codebase - days only for V1, matching the brief's "within last 7/14/30 days" examples. */
const timeWindowSchema = z.object({
  value: z.number().int().positive().max(365), // sanity cap - a year is already a generous lookback for V1
  unit: z.literal("days"),
});

const eventConditionSchema = z.object({
  type: z.literal("event"),
  eventName: z.string().min(1).max(200),
  operator: z.enum(["performed", "not_performed"]),
  timeWindow: timeWindowSchema.optional(),
});

const propertyValueSchema = z.union([z.string().max(2000), z.number(), z.boolean()]);

const userPropertyConditionSchema = z
  .object({
    type: z.literal("user_property"),
    propertyName: z.string().min(1).max(200),
    operator: z.enum([
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "exists",
      "not_exists",
      "greater_than",
      "less_than",
      "greater_than_or_equal",
      "less_than_or_equal",
    ]),
    value: propertyValueSchema.optional(),
  })
  .refine((c) => c.operator === "exists" || c.operator === "not_exists" || c.value !== undefined, {
    message: "value is required for this operator",
    path: ["value"],
  });

const pageConditionSchema = z.object({
  type: z.literal("page"),
  pageId: z.string().min(1).max(64),
  operator: z.enum(["visited", "not_visited"]),
  timeWindow: timeWindowSchema.optional(),
});

const conditionSchema = z.discriminatedUnion("type", [eventConditionSchema, userPropertyConditionSchema, pageConditionSchema]);

/**
 * Recursive group schema - `z.lazy` because a group's `conditions`
 * array can contain either a leaf condition or another group (task
 * brief section 2's nested-group requirement). Same recursive-schema
 * pattern as `jsonValueSchema` in lib/patterns/validation.ts.
 */
const MAX_GROUP_DEPTH = 6; // defensive cap - nothing in the UI needs deeper nesting, and unbounded recursion is an easy DoS vector for arbitrary client JSON
const MAX_CONDITIONS_PER_GROUP = 20;

function groupSchema(depth: number): z.ZodType<SegmentGroup> {
  const nodeSchema: z.ZodType<SegmentNode> =
    depth >= MAX_GROUP_DEPTH ? conditionSchema : z.union([conditionSchema, z.lazy(() => groupSchema(depth + 1))]);
  return z.object({
    logic: z.enum(["and", "or"]),
    conditions: z.array(nodeSchema).min(1).max(MAX_CONDITIONS_PER_GROUP),
  });
}

/** The full `segments.definition` shape - always a group at the top level (task brief section 2's top-level example is itself `{ logic, conditions }`). */
export const segmentDefinitionSchema: z.ZodType<SegmentGroup> = groupSchema(0);

export const createSegmentSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  definition: segmentDefinitionSchema,
});

export const updateSegmentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  definition: segmentDefinitionSchema.optional(),
});

export const previewSegmentSchema = z.object({
  definition: segmentDefinitionSchema,
});
