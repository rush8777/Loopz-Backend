import { aggregateBehavioralEvents } from "./cursorAggregator.js";
/**
 * Compiles one session's ordered raw events into a clean, chronological
 * `BehavioralEvent[]` - the "BEHAVIOR COMPILATION" stage. Cursor
 * samples never appear in the output; they are only ever evidence
 * consumed by the underlying aggregator.
 *
 * Cross-batch contract: when `previousEvents` is supplied, aggregation
 * runs over `[...previousEvents, ...events]` combined (so a run
 * spanning the batch boundary is evaluated with full context), but the
 * result is filtered down to only the signals whose own timestamp
 * falls at or after the start of the new batch - i.e. signals that
 * were "decided" using at least some evidence from `events` itself.
 * This is a simple, explainable heuristic, not a guarantee of perfect
 * exactly-once delivery across arbitrarily-sliced batches; the caller
 * is expected to persist/track what it has already emitted if that
 * guarantee matters. No internal state is kept between calls - the
 * function is pure.
 */
export function compileBehavioralEvents(events, options = {}) {
    const { previousEvents = [], aggregationConfig } = options;
    if (events.length === 0)
        return [];
    const combined = [...previousEvents, ...events].sort((a, b) => a.timestamp - b.timestamp);
    const newBatchStart = Math.min(...events.map((event) => event.timestamp));
    const compiled = aggregateBehavioralEvents(combined, aggregationConfig);
    const attributableToThisBatch = compiled.filter((event) => event.timestamp >= newBatchStart);
    return attachProvenance(attributableToThisBatch, combined);
}
/**
 * How far back (from a compiled event's own timestamp) to look for raw
 * events to attribute as evidence, for event kinds that carry no
 * duration of their own (i.e. neither a top-level `durationMs` nor
 * `evidence.durationMs`) - a plain `click`/`page_enter`/`scroll`, whose
 * provenance is just "the one raw event that produced it".
 */
const DEFAULT_PROVENANCE_WINDOW_MS = 0;
function getEvidenceWindowMs(event) {
    if ("durationMs" in event && typeof event.durationMs === "number")
        return event.durationMs;
    if ("evidence" in event && event.evidence?.durationMs != null)
        return event.evidence.durationMs;
    return DEFAULT_PROVENANCE_WINDOW_MS;
}
/**
 * Best-effort provenance: attaches the ids of raw input events whose
 * timestamp falls inside the evidence window that produced each
 * compiled event, via the `sourceEventIds` field already defined on
 * `BehavioralEvent` (see `behavioralEvent.ts`). This is a simple
 * "what raw telemetry was in scope" answer based on the evidence
 * duration a signal already reports - not a precise per-classification
 * trace back through the aggregator's internals, which would require
 * threading ids through `cursorAggregator.ts`'s classification
 * functions. That's more machinery than this task calls for; the
 * `evidence` fields already explain *why* a signal fired; this adds
 * *which raw rows*, when the caller can supply ids at all.
 *
 * A no-op when none of the raw events carry an `id` (e.g. compiling
 * from in-memory `IncomingEvent`s with no DB row yet).
 */
function attachProvenance(events, rawEvents) {
    const withIds = rawEvents.filter((event) => typeof event.id === "string");
    if (withIds.length === 0)
        return events;
    return events.map((event) => {
        const windowMs = getEvidenceWindowMs(event);
        const windowStart = event.timestamp - windowMs;
        const sourceEventIds = withIds.filter((raw) => raw.timestamp >= windowStart && raw.timestamp <= event.timestamp).map((raw) => raw.id);
        if (sourceEventIds.length === 0)
            return event;
        return { ...event, sourceEventIds };
    });
}
//# sourceMappingURL=behaviorCompiler.js.map