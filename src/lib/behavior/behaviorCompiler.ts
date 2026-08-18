import type { IncomingEvent } from "../patterns/event.js";
import { aggregateBehavioralEvents, type CursorAggregationConfig } from "./cursorAggregator.js";
import type { BehavioralEvent } from "./behavioralEvent.js";

/**
 * Behavior compilation.
 *
 * RAW EVENTS -> TELEMETRY AGGREGATION -> BEHAVIOR COMPILATION
 *
 * `aggregateBehavioralEvents()` (`cursorAggregator.ts`) already merges
 * the two things this stage is conceptually responsible for: direct
 * 1:1 mappings for unambiguous raw types (`page_view`, `click`,
 * `scroll`, and threshold-gated `hover`) and evidence-driven derived
 * signals from cursor/hover telemetry (`element_approach`,
 * `element_leave`, `dwell`, `hesitation`, `reversal`,
 * `repeated_attention`) - sorted chronologically, with `cursor`
 * samples never emitted as events. That IS the compiled output this
 * task asks for.
 *
 * `compileToBehavioralEvent()` (`compileEvent.ts`) is intentionally
 * NOT also called here. It implements a simpler, unconditional
 * hover -> hover_intent mapping with no duration threshold, which
 * disagrees with `aggregateBehavioralEvents()`'s evidence-gated
 * version of the same mapping ("hover -> hover_intent where the
 * existing evidence supports it", per this task's own brief). Calling
 * both and merging would either double-emit discrete events
 * (page_enter/click/scroll/hover_intent already come out of the
 * aggregator) or require reconciling two different opinions about the
 * same raw hover event. Reusing `aggregateBehavioralEvents()` alone
 * avoids both problems without duplicating its logic.
 *
 * This module adds exactly two things on top of the aggregator:
 *
 *   1. Cross-batch context (`previousEvents`) - a way for a future
 *      incremental caller to supply trailing raw events from an
 *      earlier batch so aggregation has the evidence it needs (e.g. a
 *      hover that started before this batch), without this module
 *      holding any state itself. Not wired into live ingestion in
 *      this task - see `compileBehavioralEvents`'s doc comment for the
 *      exact contract.
 *   2. Best-effort provenance - when raw events carry an `id` (e.g.
 *      once read back from `session_events`), each compiled event is
 *      annotated with the ids of the raw events inside the time
 *      window that produced it, via the existing `sourceEventIds`
 *      field on `BehavioralEvent`.
 */

/**
 * A raw event as read from storage, optionally carrying the id of the
 * `session_events` row it came from. Purely additive over
 * `IncomingEvent` - not a change to that type, and every
 * `IncomingEvent` is a valid `CompilableRawEvent` with `id` simply
 * absent.
 */
export type CompilableRawEvent = IncomingEvent & { id?: string };

export interface BehaviorCompilationOptions {
  /**
   * Raw events from earlier in the same session, immediately preceding
   * `events` chronologically, supplied so cross-batch signals can be
   * aggregated correctly (e.g. a cursor run that started in a previous
   * batch and only reaches an element in this one). Purely contextual:
   * none of `previousEvents` is re-emitted in the result even if it
   * would otherwise produce a signal - only events attributable to the
   * current batch are returned (see the function doc comment for the
   * exact rule). Omit for a one-shot compile over an entire session's
   * history, which is the only mode actually exercised by this task.
   */
  previousEvents?: readonly CompilableRawEvent[];
  /** Overrides for the underlying cursor/hover aggregation thresholds - see `CursorAggregationConfig`. */
  aggregationConfig?: Partial<CursorAggregationConfig>;
}

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
export function compileBehavioralEvents(
  events: readonly CompilableRawEvent[],
  options: BehaviorCompilationOptions = {}
): BehavioralEvent[] {
  const { previousEvents = [], aggregationConfig } = options;

  if (events.length === 0) return [];

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

function getEvidenceWindowMs(event: BehavioralEvent): number {
  if ("durationMs" in event && typeof event.durationMs === "number") return event.durationMs;
  if ("evidence" in event && event.evidence?.durationMs != null) return event.evidence.durationMs;
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
function attachProvenance(events: BehavioralEvent[], rawEvents: readonly CompilableRawEvent[]): BehavioralEvent[] {
  const withIds = rawEvents.filter((event): event is CompilableRawEvent & { id: string } => typeof event.id === "string");
  if (withIds.length === 0) return events;

  return events.map((event) => {
    const windowMs = getEvidenceWindowMs(event);
    const windowStart = event.timestamp - windowMs;

    const sourceEventIds = withIds.filter((raw) => raw.timestamp >= windowStart && raw.timestamp <= event.timestamp).map((raw) => raw.id);

    if (sourceEventIds.length === 0) return event;
    return { ...event, sourceEventIds };
  });
}
