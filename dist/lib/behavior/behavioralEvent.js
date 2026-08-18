/** Single source of truth for which bucket each kind belongs to - constructors below read from this so an event's `category` can never drift from its `kind`. */
export const BEHAVIORAL_EVENT_CATEGORY = {
    // 1. Discrete actions
    page_enter: "discrete_action",
    click: "discrete_action",
    scroll: "discrete_action",
    input: "discrete_action",
    navigation: "discrete_action",
    // 2. Intent / attention signals
    hover_intent: "intent_signal",
    dwell: "intent_signal",
    // 3. Derived behavioral signals
    element_approach: "derived_signal",
    element_leave: "derived_signal",
    hesitation: "derived_signal",
    reversal: "derived_signal",
    repeated_action: "derived_signal",
    repeated_attention: "derived_signal",
    possible_failed_action: "derived_signal",
};
// ---------------------------------------------------------------------------
// Constructors. Each one is the only place that sets `category`, so category
// can never be set inconsistently with kind by a caller.
// ---------------------------------------------------------------------------
export function createPageEnterEvent(timestamp) {
    return { kind: "page_enter", category: BEHAVIORAL_EVENT_CATEGORY.page_enter, timestamp };
}
export function createClickEvent(timestamp, element) {
    return { kind: "click", category: BEHAVIORAL_EVENT_CATEGORY.click, timestamp, element };
}
export function createScrollEvent(timestamp, scrollPercent) {
    return { kind: "scroll", category: BEHAVIORAL_EVENT_CATEGORY.scroll, timestamp, scrollPercent };
}
export function createInputEvent(timestamp, element) {
    return { kind: "input", category: BEHAVIORAL_EVENT_CATEGORY.input, timestamp, element };
}
export function createNavigationEvent(timestamp, opts = {}) {
    return { kind: "navigation", category: BEHAVIORAL_EVENT_CATEGORY.navigation, timestamp, ...opts };
}
export function createHoverIntentEvent(timestamp, element, durationMs) {
    return { kind: "hover_intent", category: BEHAVIORAL_EVENT_CATEGORY.hover_intent, timestamp, element, durationMs };
}
export function createDwellEvent(timestamp, element, durationMs, evidence) {
    return { kind: "dwell", category: BEHAVIORAL_EVENT_CATEGORY.dwell, timestamp, element, durationMs, evidence };
}
export function createElementApproachEvent(timestamp, element, evidence) {
    return { kind: "element_approach", category: BEHAVIORAL_EVENT_CATEGORY.element_approach, timestamp, element, evidence };
}
export function createElementLeaveEvent(timestamp, element, evidence) {
    return { kind: "element_leave", category: BEHAVIORAL_EVENT_CATEGORY.element_leave, timestamp, element, evidence };
}
export function createHesitationEvent(timestamp, opts = {}) {
    return { kind: "hesitation", category: BEHAVIORAL_EVENT_CATEGORY.hesitation, timestamp, ...opts };
}
export function createReversalEvent(timestamp, element, evidence) {
    return { kind: "reversal", category: BEHAVIORAL_EVENT_CATEGORY.reversal, timestamp, element, evidence };
}
export function createRepeatedActionEvent(timestamp, actionKind, count, element, evidence) {
    return {
        kind: "repeated_action",
        category: BEHAVIORAL_EVENT_CATEGORY.repeated_action,
        timestamp,
        actionKind,
        count,
        element,
        evidence,
    };
}
export function createRepeatedAttentionEvent(timestamp, element, count, evidence) {
    return {
        kind: "repeated_attention",
        category: BEHAVIORAL_EVENT_CATEGORY.repeated_attention,
        timestamp,
        element,
        count,
        evidence,
    };
}
export function createPossibleFailedActionEvent(timestamp, opts = {}) {
    return { kind: "possible_failed_action", category: BEHAVIORAL_EVENT_CATEGORY.possible_failed_action, timestamp, ...opts };
}
// ---------------------------------------------------------------------------
// Type guards / helpers
// ---------------------------------------------------------------------------
const ALL_BEHAVIORAL_EVENT_KINDS = new Set(Object.keys(BEHAVIORAL_EVENT_CATEGORY));
/** Runtime shape check - true for any well-formed BehavioralEvent, regardless of kind. Useful at boundaries (e.g. deserializing from storage) where the static type isn't trusted yet. */
export function isBehavioralEvent(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const v = value;
    return (typeof v.kind === "string" &&
        ALL_BEHAVIORAL_EVENT_KINDS.has(v.kind) &&
        typeof v.timestamp === "number" &&
        v.category === BEHAVIORAL_EVENT_CATEGORY[v.kind]);
}
export function isDiscreteAction(event) {
    return event.category === "discrete_action";
}
export function isIntentSignal(event) {
    return event.category === "intent_signal";
}
export function isDerivedSignal(event) {
    return event.category === "derived_signal";
}
/** Builds a `kind === "..."` type guard for one specific BehavioralEvent kind, narrowing to that kind's interface. */
function kindGuard(kind) {
    return (event) => event.kind === kind;
}
export const isPageEnterEvent = kindGuard("page_enter");
export const isClickEvent = kindGuard("click");
export const isScrollEvent = kindGuard("scroll");
export const isInputEvent = kindGuard("input");
export const isNavigationEvent = kindGuard("navigation");
export const isHoverIntentEvent = kindGuard("hover_intent");
export const isDwellEvent = kindGuard("dwell");
export const isElementApproachEvent = kindGuard("element_approach");
export const isElementLeaveEvent = kindGuard("element_leave");
export const isHesitationEvent = kindGuard("hesitation");
export const isReversalEvent = kindGuard("reversal");
export const isRepeatedActionEvent = kindGuard("repeated_action");
export const isRepeatedAttentionEvent = kindGuard("repeated_attention");
export const isPossibleFailedActionEvent = kindGuard("possible_failed_action");
//# sourceMappingURL=behavioralEvent.js.map