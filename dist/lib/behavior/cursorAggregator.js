import { elementIdentityFromSelector } from "./elementIdentity.js";
import { createClickEvent, createDwellEvent, createElementApproachEvent, createElementLeaveEvent, createHesitationEvent, createHoverIntentEvent, createPageEnterEvent, createRepeatedAttentionEvent, createReversalEvent, createScrollEvent, } from "./behavioralEvent.js";
export const DEFAULT_CURSOR_AGGREGATION_CONFIG = {
    minMovementDistancePx: 24,
    minDwellDurationMs: 500,
    approachRadiusPx: 80,
    hesitationDurationMs: 400,
    directionReversalThreshold: 2,
    repeatedAttentionWindowMs: 15_000,
    minHoverIntentDurationMs: 300,
};
/**
 * Not user-configurable - an internal cutoff distinguishing "hovered,
 * then immediately clicked the same element" (one continuous visit)
 * from "came back to this element later" (a genuine repeat visit for
 * `repeated_attention` purposes). Deliberately much smaller than
 * `repeatedAttentionWindowMs`, which governs the opposite end: how far
 * apart repeat visits can be and still count as "repeated" rather than
 * unrelated.
 */
const VISIT_CONTINUATION_WINDOW_MS = 1000;
function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
/**
 * Summarizes a run of cursor samples: how far it traveled in total,
 * how many times its direction reversed, and how long it took.
 * Consecutive deltas shorter than `minMovementDistancePx / 4` are
 * ignored when counting direction changes, so that sub-pixel-scale
 * jitter between samples can't itself register as a "reversal".
 */
function computeRunStats(run, minMovementDistancePx) {
    if (run.length === 0) {
        return { sampleCount: 0, totalDistance: 0, directionChanges: 0, durationMs: 0 };
    }
    let totalDistance = 0;
    for (let i = 1; i < run.length; i++) {
        totalDistance += distance(run[i - 1], run[i]);
    }
    const jitterFloor = minMovementDistancePx / 4;
    const vectors = [];
    for (let i = 1; i < run.length; i++) {
        const dx = run[i].x - run[i - 1].x;
        const dy = run[i].y - run[i - 1].y;
        if (Math.hypot(dx, dy) >= jitterFloor)
            vectors.push({ x: dx, y: dy });
    }
    let directionChanges = 0;
    for (let i = 1; i < vectors.length; i++) {
        const dot = vectors[i - 1].x * vectors[i].x + vectors[i - 1].y * vectors[i].y;
        if (dot < 0)
            directionChanges++;
    }
    const durationMs = run[run.length - 1].timestamp - run[0].timestamp;
    return { sampleCount: run.length, totalDistance, directionChanges, durationMs };
}
function round(value) {
    return Math.round(value * 100) / 100;
}
/**
 * Classifies a run of cursor samples that occurred *before* a new
 * element became the focus (a hover or click). Emits `element_approach`
 * when the run made real net progress toward the target, and/or
 * `reversal` when the run's direction changed enough times over enough
 * distance to look like a deliberate change of mind rather than a
 * smooth path.
 */
function classifyApproachRun(run, target, boundaryTimestamp, config, clickableSelectors) {
    if (run.length === 0)
        return [];
    const stats = computeRunStats(run, config.minMovementDistancePx);
    if (stats.totalDistance < config.minMovementDistancePx)
        return []; // noise gate
    const events = [];
    const element = target.selector ? elementIdentityFromSelector(target.selector) : undefined;
    if (stats.directionChanges >= config.directionReversalThreshold) {
        events.push(createReversalEvent(boundaryTimestamp, element, {
            distanceMoved: round(stats.totalDistance),
            numberOfDirectionChanges: stats.directionChanges,
            durationMs: stats.durationMs,
            sampleCount: stats.sampleCount,
        }));
    }
    if (target.position) {
        const startDistance = distance(run[0], target.position);
        const endDistance = distance(run[run.length - 1], target.position);
        const gotCloser = startDistance - endDistance >= config.minMovementDistancePx;
        if (gotCloser) {
            events.push(createElementApproachEvent(boundaryTimestamp, element, {
                distanceMoved: round(stats.totalDistance),
                durationMs: stats.durationMs,
                sampleCount: stats.sampleCount,
                minDistanceToTarget: round(Math.min(startDistance, endDistance)),
                maxDistanceToTarget: round(Math.max(startDistance, endDistance)),
                targetIsClickable: target.selector ? clickableSelectors.has(target.selector) : undefined,
            }));
        }
    }
    return events;
}
/**
 * Classifies a run of cursor samples that occurred *after* the user's
 * attention landed on an element (an "anchor"). Decides between
 * `hesitation` (stayed near, but wavered), `dwell` (stayed near and
 * settled), and `element_leave` (moved away beyond the radius) - at
 * most one of the three, since they describe mutually exclusive
 * outcomes for the same run.
 */
function classifyAfterAnchorRun(run, anchor, boundaryTimestamp, config, clickableSelectors) {
    if (run.length === 0 || !anchor.position || !anchor.selector)
        return [];
    const position = anchor.position;
    const distances = run.map((sample) => distance(sample, position));
    const stats = computeRunStats(run, config.minMovementDistancePx);
    const durationMs = boundaryTimestamp - anchor.since;
    const withinRadiusCount = distances.filter((d) => d <= config.approachRadiusPx).length;
    const allWithinRadius = withinRadiusCount === distances.length;
    const element = elementIdentityFromSelector(anchor.selector);
    const evidenceBase = {
        distanceMoved: round(stats.totalDistance),
        durationMs,
        sampleCount: stats.sampleCount,
        minDistanceToTarget: round(Math.min(...distances)),
        maxDistanceToTarget: round(Math.max(...distances)),
    };
    if (allWithinRadius && stats.directionChanges >= config.directionReversalThreshold && durationMs >= config.hesitationDurationMs) {
        return [
            createHesitationEvent(boundaryTimestamp, {
                element,
                durationMs,
                evidence: { ...evidenceBase, numberOfDirectionChanges: stats.directionChanges },
            }),
        ];
    }
    if (allWithinRadius && durationMs >= config.minDwellDurationMs) {
        return [createDwellEvent(boundaryTimestamp, element, durationMs, evidenceBase)];
    }
    const lastDistance = distances[distances.length - 1];
    if (lastDistance > config.approachRadiusPx && stats.totalDistance >= config.minMovementDistancePx) {
        return [
            createElementLeaveEvent(boundaryTimestamp, element, {
                ...evidenceBase,
                targetIsClickable: clickableSelectors.has(anchor.selector),
            }),
        ];
    }
    return [];
}
// ---------------------------------------------------------------------------
// Position resolution
// ---------------------------------------------------------------------------
function hasCoordinates(event) {
    return typeof event.x === "number" && typeof event.y === "number";
}
function resolvePosition(event, lastKnownPosition) {
    if (hasCoordinates(event))
        return { x: event.x, y: event.y };
    const selector = event.element?.selector;
    if (selector && lastKnownPosition.has(selector))
        return lastKnownPosition.get(selector);
    return null;
}
// ---------------------------------------------------------------------------
// Repeated attention - a session-wide pass over every hover/click "visit" to
// each element, independent of cursor geometry (selector matching alone is
// enough evidence for this signal).
// ---------------------------------------------------------------------------
function computeRepeatedAttentionEvents(visitsBySelector, config) {
    const events = [];
    for (const [selector, rawTimestamps] of visitsBySelector) {
        const timestamps = [...rawTimestamps].sort((a, b) => a - b);
        let clusterStart = 0;
        for (let i = 1; i <= timestamps.length; i++) {
            const gapExceeded = i === timestamps.length || timestamps[i] - timestamps[i - 1] > config.repeatedAttentionWindowMs;
            if (!gapExceeded)
                continue;
            const cluster = timestamps.slice(clusterStart, i);
            if (cluster.length >= 2) {
                events.push(createRepeatedAttentionEvent(cluster[cluster.length - 1], elementIdentityFromSelector(selector), cluster.length, {
                    windowMs: config.repeatedAttentionWindowMs,
                    sampleCount: cluster.length,
                    durationMs: cluster[cluster.length - 1] - cluster[0],
                }));
            }
            clusterStart = i;
        }
    }
    return events;
}
// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
/**
 * Aggregates one session's ordered raw events into a small, meaningful
 * `BehavioralEvent[]`. Cursor samples are never emitted 1:1 - they are
 * consumed as evidence for the derived/intent signals listed in the
 * module doc comment above. Non-cursor events (`page_view`, `click`,
 * `scroll`, `hover`) are normalized into their direct behavioral
 * counterparts as part of the same pass, so the returned sequence is a
 * single, chronologically ordered, ready-to-use behavioral stream.
 *
 * Safe on sessions with no cursor data at all (falls back to the
 * direct mappings), sessions with missing selectors (skips geometry
 * for those events rather than throwing), and sessions with hundreds
 * or thousands of cursor samples (the whole point: those collapse to a
 * handful of signals, not thousands of tokens).
 */
export function aggregateBehavioralEvents(events, configOverrides = {}) {
    const config = { ...DEFAULT_CURSOR_AGGREGATION_CONFIG, ...configOverrides };
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const clickableSelectors = new Set();
    for (const event of sorted) {
        if (event.type === "click" && event.element?.selector)
            clickableSelectors.add(event.element.selector);
    }
    const output = [];
    const lastKnownPosition = new Map();
    const visitsBySelector = new Map();
    let pendingRun = [];
    let currentAnchor = null;
    function recordVisit(selector, timestamp) {
        if (!selector)
            return;
        const list = visitsBySelector.get(selector);
        if (list)
            list.push(timestamp);
        else
            visitsBySelector.set(selector, [timestamp]);
    }
    function handleBoundaryReset(resetTimestamp) {
        if (currentAnchor) {
            output.push(...classifyAfterAnchorRun(pendingRun, currentAnchor, resetTimestamp, config, clickableSelectors));
        }
        pendingRun = [];
        currentAnchor = null;
    }
    function handleAnchorEvent(event) {
        const newSelector = event.element?.selector;
        const newPosition = resolvePosition(event, lastKnownPosition);
        if (currentAnchor) {
            output.push(...classifyAfterAnchorRun(pendingRun, currentAnchor, event.timestamp, config, clickableSelectors));
            if (newSelector && newSelector !== currentAnchor.selector) {
                output.push(...classifyApproachRun(pendingRun, { selector: newSelector, position: newPosition }, event.timestamp, config, clickableSelectors));
            }
        }
        else if (pendingRun.length > 0) {
            output.push(...classifyApproachRun(pendingRun, { selector: newSelector, position: newPosition }, event.timestamp, config, clickableSelectors));
        }
        pendingRun = [];
        if (newSelector && newPosition)
            lastKnownPosition.set(newSelector, newPosition);
        const isContinuationOfCurrentAnchor = currentAnchor !== null &&
            newSelector === currentAnchor.selector &&
            event.timestamp - currentAnchor.since < VISIT_CONTINUATION_WINDOW_MS;
        if (!isContinuationOfCurrentAnchor)
            recordVisit(newSelector, event.timestamp);
        if (event.type === "hover") {
            const durationMs = event.durationMs ?? 0;
            if (durationMs >= config.minHoverIntentDurationMs) {
                output.push(createHoverIntentEvent(event.timestamp, elementIdentityFromSelector(newSelector), durationMs));
            }
        }
        else {
            output.push(createClickEvent(event.timestamp, elementIdentityFromSelector(newSelector)));
        }
        currentAnchor = newSelector
            ? { selector: newSelector, position: newPosition ?? lastKnownPosition.get(newSelector) ?? null, since: event.timestamp }
            : null;
    }
    for (const event of sorted) {
        switch (event.type) {
            case "cursor": {
                if (hasCoordinates(event))
                    pendingRun.push({ timestamp: event.timestamp, x: event.x, y: event.y });
                // Cursor samples without coordinates carry no usable evidence -
                // ignored, never turned into a standalone event either way.
                break;
            }
            case "page_view": {
                handleBoundaryReset(event.timestamp);
                output.push(createPageEnterEvent(event.timestamp));
                break;
            }
            case "scroll": {
                handleBoundaryReset(event.timestamp);
                output.push(createScrollEvent(event.timestamp, event.scrollPercent ?? 0));
                break;
            }
            case "hover":
            case "click": {
                handleAnchorEvent(event);
                break;
            }
            default:
                break;
        }
    }
    // Final flush: whatever's left in the last anchor's context.
    if (currentAnchor && pendingRun.length > 0) {
        const lastTimestamp = pendingRun[pendingRun.length - 1].timestamp;
        output.push(...classifyAfterAnchorRun(pendingRun, currentAnchor, lastTimestamp, config, clickableSelectors));
    }
    // Otherwise (no anchor context, or nothing pending): discard - there is no
    // element to attribute leftover movement to, so no signal is fabricated.
    output.push(...computeRepeatedAttentionEvents(visitsBySelector, config));
    // repeated_attention events were computed out-of-band above; a final
    // stable sort brings the whole stream back into chronological order.
    output.sort((a, b) => a.timestamp - b.timestamp);
    return output;
}
//# sourceMappingURL=cursorAggregator.js.map