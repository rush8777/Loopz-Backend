import type { IncomingEvent } from "../patterns/event.js";
import { elementIdentityFromRaw } from "./elementIdentity.js";
import { isRawTelemetryEvent } from "./rawTelemetry.js";
import { createClickEvent, createHoverIntentEvent, createPageEnterEvent, createScrollEvent, type BehavioralEvent } from "./behavioralEvent.js";

/**
 * Maps one raw `IncomingEvent` to one `BehavioralEvent`, for the subset
 * of raw types with an unambiguous 1:1 behavioral meaning today:
 *
 *   - page_view -> page_enter
 *   - click     -> click
 *   - hover     -> hover_intent (raw hover already carries durationMs,
 *                  so today's SDK evidence is sufficient for this to
 *                  be a direct mapping rather than requiring
 *                  aggregation)
 *   - scroll    -> scroll
 *
 * Returns `null` for anything that should NOT become a standalone
 * behavioral event at this layer:
 *
 *   - cursor: raw telemetry (see rawTelemetry.ts). A single cursor
 *     sample carries no meaningful behavioral signal on its own - only
 *     a run of them, aggregated, does (approach/dwell/hesitation/
 *     reversal). That aggregation is a future pass, not this function.
 *     This is precisely what keeps cursor telemetry from becoming
 *     thousands of sequence tokens.
 *
 * Kinds that require correlating *multiple* raw events (`dwell`,
 * `element_approach`, `element_leave`, `hesitation`,
 * `repeated_action`, `possible_failed_action`) or that the SDK doesn't
 * send evidence for yet (`input`, `navigation`) are intentionally not
 * produced here - their constructors exist in behavioralEvent.ts for a
 * future aggregation/compilation pass to call once it has cross-event
 * context this function deliberately doesn't have.
 */
export function compileToBehavioralEvent(event: IncomingEvent): BehavioralEvent | null {
  if (isRawTelemetryEvent(event)) return null;

  switch (event.type) {
    case "page_view":
      return createPageEnterEvent(event.timestamp);
    case "click":
      return createClickEvent(event.timestamp, elementIdentityFromRaw(event.element));
    case "hover":
      return createHoverIntentEvent(event.timestamp, elementIdentityFromRaw(event.element), event.durationMs ?? 0);
    case "scroll":
      return createScrollEvent(event.timestamp, event.scrollPercent ?? 0);
    default:
      // Exhaustive over IncomingEvent["type"] given the isRawTelemetryEvent
      // check above already handled "cursor". Anything else unrecognized
      // is safely ignored rather than thrown - forward-compatible with a
      // future raw event type this layer doesn't know about yet.
      return null;
  }
}

/**
 * Compiles a batch of raw events into behavioral events, preserving
 * order and silently dropping anything that doesn't produce a
 * behavioral event (telemetry, unrecognized types). This is the
 * function that makes "thousands of cursor pings in a batch" collapse
 * to "zero behavioral events from those pings" rather than thousands
 * of sequence tokens.
 */
export function compileBatch(events: IncomingEvent[]): BehavioralEvent[] {
  const out: BehavioralEvent[] = [];
  for (const event of events) {
    const compiled = compileToBehavioralEvent(event);
    if (compiled) out.push(compiled);
  }
  return out;
}
