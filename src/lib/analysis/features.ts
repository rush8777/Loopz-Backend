import type { IncomingEvent } from "../patterns/event.js";

export interface SessionFeatures {
  sessionId: string;
  totalEvents: number;
  clickCount: number;
  hoverCount: number;
  scrollCount: number;
  uniqueTargets: number;
  totalHoverMs: number;
  maxScrollPercent: number;
  sessionDurationMs: number;
  /** Whether a goal event occurred anywhere in the session - see extractSessionFeatures's `goal` param. */
  converted: boolean;
  /** Ordered action tokens, e.g. "enter", "hover:#hero", "click:#cta" - input to sequence-similarity scoring. */
  actionTokens: string[];
}

export interface GoalDefinition {
  type: IncomingEvent["type"];
  selector?: string;
}

function tokenFor(event: IncomingEvent): string {
  if (event.type === "page_view") return "enter";
  if (!event.element?.selector) return event.type; // e.g. plain "scroll" - no target element to qualify it with
  return `${event.type}:${event.element.selector}`;
}

function matchesGoal(event: IncomingEvent, goal: GoalDefinition): boolean {
  if (event.type !== goal.type) return false;
  if (goal.selector != null && event.element?.selector !== goal.selector) return false;
  return true;
}

/**
 * Reduces a session's raw event log to a fixed-shape numeric feature
 * vector plus an action-token sequence. Two sessions with completely
 * different step counts/orders can still land close together here if
 * their aggregate engagement shape is similar - that's the point: this
 * is deliberately NOT sequence-order-sensitive the way the FSM matcher
 * is, so it complements rather than duplicates it.
 */
export function extractSessionFeatures(
  sessionId: string,
  events: IncomingEvent[],
  goal?: GoalDefinition
): SessionFeatures {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  let clickCount = 0;
  let hoverCount = 0;
  let scrollCount = 0;
  let totalHoverMs = 0;
  let maxScrollPercent = 0;
  let converted = false;
  const targets = new Set<string>();
  const actionTokens: string[] = [];

  for (const event of sorted) {
    actionTokens.push(tokenFor(event));
    if (event.element?.selector) targets.add(event.element.selector);

    switch (event.type) {
      case "click":
        clickCount += 1;
        break;
      case "hover":
        hoverCount += 1;
        totalHoverMs += event.durationMs ?? 0;
        break;
      case "scroll":
        scrollCount += 1;
        maxScrollPercent = Math.max(maxScrollPercent, event.scrollPercent ?? 0);
        break;
    }

    if (goal && matchesGoal(event, goal)) converted = true;
  }

  const sessionDurationMs =
    sorted.length > 0 ? sorted[sorted.length - 1].timestamp - sorted[0].timestamp : 0;

  return {
    sessionId,
    totalEvents: sorted.length,
    clickCount,
    hoverCount,
    scrollCount,
    uniqueTargets: targets.size,
    totalHoverMs,
    maxScrollPercent,
    sessionDurationMs,
    converted,
    actionTokens,
  };
}

/** Numeric fields only, in a fixed order - what k-means actually clusters on. */
export const NUMERIC_FEATURE_KEYS = [
  "totalEvents",
  "clickCount",
  "hoverCount",
  "scrollCount",
  "uniqueTargets",
  "totalHoverMs",
  "maxScrollPercent",
  "sessionDurationMs",
] as const;

export function toVector(features: SessionFeatures): number[] {
  return NUMERIC_FEATURE_KEYS.map((key) => features[key]);
}
