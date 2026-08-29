/**
 * Presentation-only helpers for CLI/diagnostic output. Nothing in the
 * observation pipeline (behaviorCompiler.ts, cursorAggregator.ts,
 * patternObserver.ts) depends on this module - it exists purely to
 * turn the `evidence` a signal already carries into a human-readable
 * line, for tools like `scripts/diagnose-similarity.ts`,
 * `scripts/inspect-episode.ts`, and `scripts/run-observation-cli.ts`.
 */
/** Renders a BehavioralEventEvidence bag as a compact "key=value, key=value" string, omitting any field that wasn't populated. Returns null if there's nothing to show. */
export function formatEvidence(evidence) {
    if (!evidence)
        return null;
    const parts = [];
    if (evidence.durationMs != null)
        parts.push(`durationMs=${evidence.durationMs}`);
    if (evidence.distanceMoved != null)
        parts.push(`distanceMoved=${evidence.distanceMoved}px`);
    if (evidence.numberOfDirectionChanges != null)
        parts.push(`directionChanges=${evidence.numberOfDirectionChanges}`);
    if (evidence.sampleCount != null)
        parts.push(`sampleCount=${evidence.sampleCount}`);
    if (evidence.minDistanceToTarget != null)
        parts.push(`minDistToTarget=${evidence.minDistanceToTarget}px`);
    if (evidence.maxDistanceToTarget != null)
        parts.push(`maxDistToTarget=${evidence.maxDistanceToTarget}px`);
    if (evidence.windowMs != null)
        parts.push(`windowMs=${evidence.windowMs}`);
    if (evidence.targetIsClickable != null)
        parts.push(`targetIsClickable=${evidence.targetIsClickable}`);
    return parts.length > 0 ? parts.join(", ") : null;
}
/** Combines a signal's own durationMs/count (top-level fields on some BehavioralEvent kinds) with its evidence bag into one annotation line. Returns null if the event carries no extra detail worth showing (e.g. a plain click/page_enter/scroll). */
export function formatVerboseAnnotation(opts) {
    const bits = [];
    if (opts.durationMs != null)
        bits.push(`durationMs=${opts.durationMs}`);
    if (opts.count != null)
        bits.push(`count=${opts.count}`);
    // Some kinds (e.g. hesitation) carry the same duration both as a
    // top-level field and inside `evidence` - drop the evidence copy
    // once it's already been shown above so it isn't printed twice.
    const evidenceWithoutDuplicateDuration = opts.durationMs != null && opts.evidence?.durationMs === opts.durationMs
        ? { ...opts.evidence, durationMs: undefined }
        : opts.evidence;
    const evidenceText = formatEvidence(evidenceWithoutDuplicateDuration);
    if (evidenceText)
        bits.push(evidenceText);
    return bits.length > 0 ? bits.join(", ") : null;
}
function durationMsOf(event) {
    return "durationMs" in event && typeof event.durationMs === "number" ? event.durationMs : null;
}
function countOf(event) {
    return "count" in event && typeof event.count === "number" ? event.count : null;
}
function evidenceOf(event) {
    return "evidence" in event ? (event.evidence ?? null) : null;
}
/**
 * Verbose two-line rendering for one in-memory BehavioralEvent:
 *
 *   hesitation:#save
 *       durationMs=420, distanceMoved=38.2px, directionChanges=3, sampleCount=9
 *
 * `token` is the already-computed `tokenForBehavioralEvent()` string
 * (behavioralSequence.ts) - this function doesn't recompute it, just
 * adds the evidence line beneath it. Returns just the token line, with
 * no second line, when there's nothing extra to show.
 */
export function formatBehavioralEventVerbose(event, token, indent = "    ") {
    const annotation = formatVerboseAnnotation({ durationMs: durationMsOf(event), count: countOf(event), evidence: evidenceOf(event) });
    return annotation ? `${token}\n${indent}(${annotation})` : token;
}
//# sourceMappingURL=evidenceFormat.js.map