import type { IncomingEvent } from "../patterns/event.js";

/**
 * Raw incoming event types that count as "telemetry" rather than
 * "behavior": high-frequency, low individual information value, and
 * never meant to become a token in a behavioral sequence on their own.
 *
 * `cursor` is the only one today - a single session can carry
 * thousands of cursor samples, and turning each one into its own
 * behavioral event (or sequence token) is exactly the problem this
 * module exists to name and contain. See `compileEvent.ts`, which
 * consults this set and deliberately does not produce a
 * `BehavioralEvent` for telemetry types.
 *
 * Telemetry events are NOT dropped from the raw log (`session_events`)
 * - they still get persisted exactly as ingested. This module only
 * governs whether an event type is eligible to become a standalone
 * `BehavioralEvent`. A later pass (cursor aggregation - out of scope
 * for this layer) will fold runs of raw telemetry into derived signals
 * like `element_approach` / `element_leave` / `hesitation` instead of
 * one-token-per-sample.
 */
const RAW_TELEMETRY_TYPES: ReadonlySet<IncomingEvent["type"]> = new Set(["cursor"]);

/** True when a raw event is telemetry (never a standalone behavioral event), as opposed to a discrete/intent-bearing action. */
export function isRawTelemetryEvent(event: Pick<IncomingEvent, "type">): boolean {
  return RAW_TELEMETRY_TYPES.has(event.type);
}
