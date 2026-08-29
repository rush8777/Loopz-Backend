export function createInitialMatchState(patternId, sessionId) {
    return {
        patternId,
        sessionId,
        cursor: 0,
        matchedSteps: [],
        startedAt: null,
        lastMatchedAt: null,
        status: "pending",
    };
}
function verbToEventType(verb) {
    switch (verb) {
        case "enter":
            return "page_view";
        case "hover":
            return "hover";
        case "click":
            return "click";
        case "scroll_past":
            return "scroll";
        case "custom":
            return "custom";
    }
}
function stepIsSatisfiedBy(step, event) {
    if (event.type !== verbToEventType(step.verb))
        return false;
    if (step.target && event.element?.selector !== step.target.selector)
        return false;
    if (step.verb === "hover" && step.minDurationMs != null) {
        if ((event.durationMs ?? 0) < step.minDurationMs)
            return false;
    }
    if (step.verb === "scroll_past" && step.minScrollPercent != null) {
        if ((event.scrollPercent ?? 0) < step.minScrollPercent)
            return false;
    }
    // A "custom" step matches by application event name, not by DOM
    // target - a pattern referencing analytics.event("checkout_completed")
    // is asking "did this business event happen", never "was this
    // selector clicked". See PatternStep.eventName's doc comment.
    if (step.verb === "custom" && step.eventName != null && event.name !== step.eventName)
        return false;
    return true;
}
/**
 * Advances a pattern match attempt by feeding it a new batch of events.
 * Pure function - safe to call repeatedly as new batches arrive over the
 * lifetime of a session (this is what makes matching "live" without
 * needing every event held in memory at once: only the small MatchState
 * needs to persist between calls, not the full event history).
 *
 * Terminal states (`matched`, `expired`) are returned unchanged - once a
 * pattern completes or times out, the caller decides whether to start a
 * fresh attempt (new MatchState) if the pattern should be re-evaluated
 * for this session again.
 */
export function advanceMatch(pattern, state, events) {
    if (state.status === "matched" || state.status === "expired")
        return state;
    let cursor = state.cursor;
    const matchedSteps = state.matchedSteps.slice();
    let startedAt = state.startedAt;
    let lastMatchedAt = state.lastMatchedAt;
    let status = state.status;
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    eventLoop: for (const event of sorted) {
        while (cursor < pattern.steps.length) {
            const step = pattern.steps[cursor];
            // Overall pattern time budget, counted from the first matched step.
            if (startedAt != null && event.timestamp - startedAt > pattern.matchWindowMs) {
                status = "expired";
                break eventLoop;
            }
            if (stepIsSatisfiedBy(step, event)) {
                matchedSteps.push({ stepId: step.id, timestamp: event.timestamp });
                if (startedAt == null)
                    startedAt = event.timestamp;
                lastMatchedAt = event.timestamp;
                cursor += 1;
                status = cursor >= pattern.steps.length ? "matched" : "in_progress";
                continue eventLoop; // event consumed - move to the next event
            }
            // This event doesn't satisfy the current step. Decide whether to
            // keep waiting for a future event, or give up on this step.
            const referenceTime = lastMatchedAt ?? startedAt;
            const gapExceeded = step.maxGapMs != null && referenceTime != null && event.timestamp - referenceTime > step.maxGapMs;
            if (!gapExceeded) {
                // Still within budget (or no budget set) - just wait for a later event.
                continue eventLoop;
            }
            if (step.required === false) {
                // Optional step's window passed - skip it, retry this same event against the next step.
                cursor += 1;
                continue;
            }
            status = "expired";
            break eventLoop;
        }
    }
    return { ...state, cursor, matchedSteps, startedAt, lastMatchedAt, status };
}
//# sourceMappingURL=matcher.js.map