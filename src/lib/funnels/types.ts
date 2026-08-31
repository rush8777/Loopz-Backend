/**
 * Funnel step shapes (task brief sections 2-4). `funnels.steps` is an
 * ordered array of these - deliberately JSON rather than a normalized
 * steps table (task brief section 2: "can be stored as structured
 * JSON if that matches the existing architecture"), same precedent as
 * `segments.definition`/`patterns.steps`.
 */

export type FunnelStepType = "event" | "page";

/** A step matched by custom event name (task brief section 3's "Custom Event"). Reuses session_events' existing custom-event representation - never a second event model. */
export interface FunnelEventStep {
  type: "event";
  eventName: string;
  /** Display-only (task brief section 4) - the eventName is always the canonical identity, never the label. */
  label?: string;
}

/** A step matched by an existing Page definition (task brief section 3's "Page View"). References a page_definitions row, same "reuse the page-definition system" precedent as Segments' page condition. */
export interface FunnelPageStep {
  type: "page";
  pageId: string;
  label?: string;
}

export type FunnelStep = FunnelEventStep | FunnelPageStep;

export function funnelStepLabel(step: FunnelStep): string {
  if (step.label) return step.label;
  return step.type === "event" ? step.eventName : step.pageId;
}
