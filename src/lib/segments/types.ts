/**
 * Segment definition shapes (task brief sections 2-3). This is the
 * "source of truth" schema for `segments.definition` - a nested tree
 * of AND/OR groups over a small set of V1 condition types, deliberately
 * NOT flattened into database columns (task brief section 2) so groups
 * can nest arbitrarily deep and new condition types can be added later
 * (task brief section 4) without a schema migration.
 *
 * Reused as-is by the evaluator (evaluator.ts) and by validation.ts's
 * zod schema - this file is the single source of truth for the shape,
 * `validation.ts` is what actually enforces it at the API boundary.
 */

export type SegmentTimeWindowUnit = "days";

export interface SegmentTimeWindow {
  value: number;
  unit: SegmentTimeWindowUnit;
}

export type EventOperator = "performed" | "not_performed";

/** "checkout_started performed [within last 14 days]" - task brief section 3B. Reuses session_events' existing custom-event representation (type === "custom", eventName), never a second event model. */
export interface EventCondition {
  type: "event";
  eventName: string;
  operator: EventOperator;
  timeWindow?: SegmentTimeWindow;
}

export type PropertyOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "exists"
  | "not_exists"
  | "greater_than"
  | "less_than"
  | "greater_than_or_equal"
  | "less_than_or_equal";

/** "plan equals free" - task brief section 3A. Reuses the existing tracked_user_properties store; only ever matches *identified* users, since anonymous visitors never have identify() traits. */
export interface UserPropertyCondition {
  type: "user_property";
  propertyName: string;
  operator: PropertyOperator;
  // Omitted for exists/not_exists, which don't compare against a value.
  value?: string | number | boolean;
}

export type PageOperator = "visited" | "not_visited";

/** "visited page [Pricing] [within last 30 days]" - task brief section 3C. References an existing page_definitions row (semantic Page identity) rather than a raw URL, per the brief's "reuse the current page-definition system" instruction. */
export interface PageCondition {
  type: "page";
  pageId: string;
  operator: PageOperator;
  timeWindow?: SegmentTimeWindow;
}

export type SegmentCondition = EventCondition | UserPropertyCondition | PageCondition;

export type SegmentLogic = "and" | "or";

/** A logical group - conditions and/or nested groups, combined with `logic`. The segment's top-level `definition` is itself a SegmentGroup (task brief section 2's nested-group example), so groups and the whole definition share one recursive shape. */
export interface SegmentGroup {
  logic: SegmentLogic;
  conditions: SegmentNode[];
}

export type SegmentNode = SegmentCondition | SegmentGroup;

export type SegmentDefinition = SegmentGroup;

export function isGroup(node: SegmentNode): node is SegmentGroup {
  return "logic" in node && "conditions" in node;
}
