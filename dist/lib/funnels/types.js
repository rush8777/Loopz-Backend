/**
 * Funnel step shapes (task brief sections 2-4). `funnels.steps` is an
 * ordered array of these - deliberately JSON rather than a normalized
 * steps table (task brief section 2: "can be stored as structured
 * JSON if that matches the existing architecture"), same precedent as
 * `segments.definition`/`patterns.steps`.
 */
export function funnelStepLabel(step) {
    if (step.label)
        return step.label;
    return step.type === "event" ? step.eventName : step.pageId;
}
//# sourceMappingURL=types.js.map