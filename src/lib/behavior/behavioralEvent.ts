import type { ElementIdentity } from "./elementIdentity.js";

/**
 * The normalized behavioral event layer.
 *
 * RAW SESSION EVENTS (page_view | click | hover | scroll | cursor,
 * `../patterns/event.js`) are what the SDK sends and what
 * `session_events` stores. They are a faithful telemetry log, not a
 * behavioral vocabulary - in particular, `cursor` alone can produce
 * thousands of rows in a single session, which is unusable as
 * sequence-matching input (see `rawTelemetry.ts`).
 *
 * A `BehavioralEvent` represents something meaningful a user did or
 * showed intent/attention toward, at a grain suitable for sequence
 * matching, clustering, and (later) episode/pattern work. Every
 * `BehavioralEvent` falls into exactly one of four conceptual buckets;
 * the first three are represented as `BehavioralEventCategory` values
 * on the event itself, the fourth deliberately never produces a
 * `BehavioralEvent` at all:
 *
 *   1. Discrete actions   ("discrete_action")  - a concrete thing the
 *      user did, unambiguous and instantaneous: entering a page,
 *      clicking, scrolling, submitting input, navigating.
 *   2. Intent/attention signals ("intent_signal") - not an action, but
 *      evidence of where attention went and for how long: hovering
 *      with meaningful dwell, sustained dwell near/on an element.
 *   3. Derived behavioral signals ("derived_signal") - inferred from
 *      patterns *across* multiple raw observations rather than read
 *      off a single one: approaching or leaving an element,
 *      hesitating, repeating an action, a possibly-failed action.
 *   4. Raw telemetry - `cursor` samples and anything like them. These
 *      never become a `BehavioralEvent` on their own (see
 *      `rawTelemetry.ts` / `compileEvent.ts`); they are only ever
 *      *input* to a future aggregation pass that produces category-3
 *      derived signals. There is no `BehavioralEventCategory` value
 *      for this bucket because, by design, nothing in this domain
 *      model represents raw telemetry directly - that's the whole
 *      point of the layer.
 *
 * IMPORTANT: not every kind below is producible from today's SDK
 * payloads. `compileEvent.ts` implements the direct, unambiguous 1:1
 * mappings (page_view -> page_enter, click -> click, hover ->
 * hover_intent, scroll -> scroll) with no cross-event reasoning.
 * `cursorAggregator.ts` implements the kinds that require looking
 * across multiple raw cursor/hover observations (`dwell`,
 * `element_approach`, `element_leave`, `hesitation`, `reversal`,
 * `repeated_attention`) plus threshold-gated `hover_intent`. Kinds the
 * SDK doesn't emit evidence for at all yet (`input`, `navigation`) and
 * `repeated_action`/`possible_failed_action` (which need click-timing
 * heuristics, not cursor geometry) are still fully modeled and
 * constructible here so a future pass has a stable target type, but
 * nothing yet synthesizes them from raw events.
 */

export type BehavioralEventCategory = "discrete_action" | "intent_signal" | "derived_signal" | "application_event";

export type BehavioralEventKind =
  | "page_enter"
  | "click"
  | "scroll"
  | "input"
  | "navigation"
  | "hover_intent"
  | "dwell"
  | "element_approach"
  | "element_leave"
  | "hesitation"
  | "reversal"
  | "repeated_action"
  | "repeated_attention"
  | "possible_failed_action"
  | "custom";

/**
 * A fifth bucket sits alongside the three above, deliberately NOT
 * folded into any of them: `"application_event"` - a developer-defined
 * business event (`analytics.event(name, properties?)` on the SDK,
 * `type === "custom"` on the wire). This is NOT observed behavior the
 * way discrete_action/intent_signal/derived_signal are - it's the
 * application telling this system something happened
 * ("checkout_completed"), with whatever meaning the developer assigned
 * it. Application events are never DOM-target-shaped (no `element`),
 * never inferred from cursor/click geometry, and never reclassified as
 * one of the observed-behavior categories - see `kind: "custom"`
 * below. Keeping this a separate category is what lets a later insight
 * layer ask "what did the user do" and "what did the application
 * report" as two different, combinable questions instead of one
 * blended one.
 */

/** Single source of truth for which bucket each kind belongs to - constructors below read from this so an event's `category` can never drift from its `kind`. */
export const BEHAVIORAL_EVENT_CATEGORY: Record<BehavioralEventKind, BehavioralEventCategory> = {
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
  // 4 (5th bucket). Application/business events - see the comment above.
  custom: "application_event",
};

/**
 * Structured evidence for WHY a derived signal was emitted, so a later
 * classification/insight pass can explain a behavior instead of just
 * naming it. Populated by whichever pass derived the signal (e.g. the
 * cursor/hover telemetry aggregator - see `cursorAggregator.ts`); every
 * field is optional because not every signal has evidence for every
 * dimension (e.g. a signal derived with no positional data available
 * won't have distanceMoved).
 */
export interface BehavioralEventEvidence {
  /** Total path length the cursor traveled while producing this signal, in px (sum of consecutive sample distances, not straight-line). */
  distanceMoved?: number;
  /** How many times movement direction reversed while producing this signal. */
  numberOfDirectionChanges?: number;
  /** How many raw cursor samples contributed evidence for this signal. */
  sampleCount?: number;
  /** Closest observed distance to the target element's known position, in px. */
  minDistanceToTarget?: number;
  /** Furthest observed distance to the target element's known position, in px. */
  maxDistanceToTarget?: number;
  /** Duration (ms) the evidence for this signal spans. */
  durationMs?: number;
  /** Time window (ms) used to decide whether separate visits counted as "repeated", when relevant. */
  windowMs?: number;
  /** Whether the target element was clicked at some point in the session - marks "toward/away from a clickable element" per the aggregation spec. */
  targetIsClickable?: boolean;
}

interface BehavioralEventCommon {
  timestamp: number; // epoch ms, same units as IncomingEvent.timestamp
  /** Always derived from BEHAVIORAL_EVENT_CATEGORY[kind] by the create* functions below - never set independently. */
  category: BehavioralEventCategory;
  /**
   * Ids of the raw session_events row(s) this was derived from, once
   * persisted and once a compilation pass has DB row ids to reference.
   * Not populated by the constructors in this file (they operate on
   * in-memory IncomingEvent data with no row ids yet) - reserved for
   * the pipeline that will call these constructors from stored data,
   * so derived signals stay traceable back to raw evidence.
   */
  sourceEventIds?: string[];
}

/** Discrete action: a session began viewing a page. Page-level - no target element. */
export interface PageEnterEvent extends BehavioralEventCommon {
  kind: "page_enter";
}

/** Discrete action: the user clicked something. */
export interface ClickEvent extends BehavioralEventCommon {
  kind: "click";
  element?: ElementIdentity;
}

/** Discrete action: the user scrolled. `scrollPercent` is the normalized 0-100 depth reached, matching IncomingEvent's existing convention. */
export interface ScrollEvent extends BehavioralEventCommon {
  kind: "scroll";
  scrollPercent: number;
}

/**
 * Discrete action: the user entered/submitted data into a form field.
 * Not emitted by the current SDK (no raw `input` event type exists
 * yet) - modeled for forward compatibility once the SDK captures form
 * interaction.
 */
export interface InputEvent extends BehavioralEventCommon {
  kind: "input";
  element?: ElementIdentity;
}

/**
 * Discrete action: a client-side route/view change distinct from a
 * fresh page load (page_enter). Not emitted by the current SDK (only
 * whole-page `page_view` exists today) - modeled for forward
 * compatibility with SPA route tracking.
 */
export interface NavigationEvent extends BehavioralEventCommon {
  kind: "navigation";
  fromPath?: string;
  toPath?: string;
}

/**
 * Intent/attention signal: the user hovered an element long enough to
 * count as attention rather than incidental pointer movement.
 * Directly derivable from a single raw `hover` event's `durationMs` -
 * see compileEvent.ts.
 */
export interface HoverIntentEvent extends BehavioralEventCommon {
  kind: "hover_intent";
  element?: ElementIdentity;
  /** The dwell time that crossed the "counts as intent" threshold. */
  durationMs: number;
}

/**
 * Intent/attention signal: sustained attention on/near an element,
 * aggregated across multiple raw observations (e.g. cursor dwell near
 * an element, not necessarily a DOM hover). Not producible from
 * today's raw events in isolation - reserved for the future cursor
 * aggregation pass.
 */
export interface DwellEvent extends BehavioralEventCommon {
  kind: "dwell";
  element?: ElementIdentity;
  durationMs: number;
  evidence?: BehavioralEventEvidence;
}

/**
 * Derived signal: cursor movement trending toward an element, inferred
 * from a run of raw cursor telemetry (see `cursorAggregator.ts`).
 * `evidence.targetIsClickable` distinguishes "movement toward a
 * clickable element" from approach toward a non-interactive one.
 */
export interface ElementApproachEvent extends BehavioralEventCommon {
  kind: "element_approach";
  element?: ElementIdentity;
  evidence?: BehavioralEventEvidence;
}

/** Derived signal: cursor movement trending away from an element, the counterpart to ElementApproachEvent. Same aggregation source. */
export interface ElementLeaveEvent extends BehavioralEventCommon {
  kind: "element_leave";
  element?: ElementIdentity;
  evidence?: BehavioralEventEvidence;
}

/**
 * Derived signal: a pause/back-and-forth pattern near an element
 * suggesting indecision, inferred across multiple raw observations
 * (cursor movement and/or hover/click timing) rather than read off one
 * event. See `cursorAggregator.ts`.
 */
export interface HesitationEvent extends BehavioralEventCommon {
  kind: "hesitation";
  element?: ElementIdentity;
  durationMs?: number;
  evidence?: BehavioralEventEvidence;
}

/**
 * Derived signal: cursor movement direction reversed enough times, over
 * enough distance, to be a deliberate change of mind rather than
 * jitter - distinct from `hesitation` in that it describes *how* the
 * cursor moved (direction quality) rather than the fact that it
 * lingered near a target. See `cursorAggregator.ts`.
 */
export interface ReversalEvent extends BehavioralEventCommon {
  kind: "reversal";
  element?: ElementIdentity;
  evidence?: BehavioralEventEvidence;
}

/**
 * Derived signal: the same discrete action repeated on the same target
 * within a short window (e.g. rapid re-clicking). `actionKind`
 * identifies which underlying action repeated. Requires looking across
 * multiple raw events of the same type - out of scope for this task.
 */
export interface RepeatedActionEvent extends BehavioralEventCommon {
  kind: "repeated_action";
  element?: ElementIdentity;
  /** Which discrete action kind repeated, e.g. "click". */
  actionKind: BehavioralEventKind;
  /** How many times it repeated within the detection window. */
  count: number;
  evidence?: BehavioralEventEvidence;
}

/**
 * Derived signal: the user's attention (hover/click) returned to the
 * same element multiple times within a bounded time window, rather
 * than one continuous visit - e.g. leaving and coming back to the same
 * button. See `cursorAggregator.ts`.
 */
export interface RepeatedAttentionEvent extends BehavioralEventCommon {
  kind: "repeated_attention";
  element?: ElementIdentity;
  /** How many separate visits to this element fell within the detection window. */
  count: number;
  evidence?: BehavioralEventEvidence;
}

/**
 * Derived signal: interaction pattern consistent with an action that
 * didn't produce the expected effect (e.g. clicking something that
 * doesn't visibly respond). Inherently inferential - requires
 * aggregation/heuristics across multiple raw events, out of scope for
 * this task.
 */
export interface PossibleFailedActionEvent extends BehavioralEventCommon {
  kind: "possible_failed_action";
  element?: ElementIdentity;
  /** Short machine-readable reason code for why this was flagged, e.g. "rapid_reclick_no_navigation". */
  reason?: string;
  evidence?: BehavioralEventEvidence;
}

/**
 * Application/business event bucket: a developer-defined event
 * (`analytics.event(name, properties?)` on the SDK) reported as-is,
 * not derived from any DOM interaction or cursor evidence. Directly
 * 1:1 from a raw `custom` `IncomingEvent` - see `compileEvent.ts` and
 * `cursorAggregator.ts`'s `"custom"` cases, both of which just carry
 * `name`/`properties` through unchanged. `element` is deliberately
 * absent from this interface: custom events are never DOM-selector-
 * scoped, by construction (task constraint: "do not make custom events
 * dependent on DOM selectors").
 */
export interface CustomEvent extends BehavioralEventCommon {
  kind: "custom";
  name: string;
  properties?: Record<string, unknown>;
}

export type BehavioralEvent =
  | PageEnterEvent
  | ClickEvent
  | ScrollEvent
  | InputEvent
  | NavigationEvent
  | HoverIntentEvent
  | DwellEvent
  | ElementApproachEvent
  | ElementLeaveEvent
  | HesitationEvent
  | ReversalEvent
  | RepeatedActionEvent
  | RepeatedAttentionEvent
  | PossibleFailedActionEvent
  | CustomEvent;

// ---------------------------------------------------------------------------
// Constructors. Each one is the only place that sets `category`, so category
// can never be set inconsistently with kind by a caller.
// ---------------------------------------------------------------------------

export function createPageEnterEvent(timestamp: number): PageEnterEvent {
  return { kind: "page_enter", category: BEHAVIORAL_EVENT_CATEGORY.page_enter, timestamp };
}

export function createClickEvent(timestamp: number, element?: ElementIdentity): ClickEvent {
  return { kind: "click", category: BEHAVIORAL_EVENT_CATEGORY.click, timestamp, element };
}

export function createScrollEvent(timestamp: number, scrollPercent: number): ScrollEvent {
  return { kind: "scroll", category: BEHAVIORAL_EVENT_CATEGORY.scroll, timestamp, scrollPercent };
}

export function createInputEvent(timestamp: number, element?: ElementIdentity): InputEvent {
  return { kind: "input", category: BEHAVIORAL_EVENT_CATEGORY.input, timestamp, element };
}

export function createNavigationEvent(
  timestamp: number,
  opts: { fromPath?: string; toPath?: string } = {}
): NavigationEvent {
  return { kind: "navigation", category: BEHAVIORAL_EVENT_CATEGORY.navigation, timestamp, ...opts };
}

export function createHoverIntentEvent(timestamp: number, element: ElementIdentity | undefined, durationMs: number): HoverIntentEvent {
  return { kind: "hover_intent", category: BEHAVIORAL_EVENT_CATEGORY.hover_intent, timestamp, element, durationMs };
}

export function createDwellEvent(
  timestamp: number,
  element: ElementIdentity | undefined,
  durationMs: number,
  evidence?: BehavioralEventEvidence
): DwellEvent {
  return { kind: "dwell", category: BEHAVIORAL_EVENT_CATEGORY.dwell, timestamp, element, durationMs, evidence };
}

export function createElementApproachEvent(
  timestamp: number,
  element?: ElementIdentity,
  evidence?: BehavioralEventEvidence
): ElementApproachEvent {
  return { kind: "element_approach", category: BEHAVIORAL_EVENT_CATEGORY.element_approach, timestamp, element, evidence };
}

export function createElementLeaveEvent(
  timestamp: number,
  element?: ElementIdentity,
  evidence?: BehavioralEventEvidence
): ElementLeaveEvent {
  return { kind: "element_leave", category: BEHAVIORAL_EVENT_CATEGORY.element_leave, timestamp, element, evidence };
}

export function createHesitationEvent(
  timestamp: number,
  opts: { element?: ElementIdentity; durationMs?: number; evidence?: BehavioralEventEvidence } = {}
): HesitationEvent {
  return { kind: "hesitation", category: BEHAVIORAL_EVENT_CATEGORY.hesitation, timestamp, ...opts };
}

export function createReversalEvent(
  timestamp: number,
  element?: ElementIdentity,
  evidence?: BehavioralEventEvidence
): ReversalEvent {
  return { kind: "reversal", category: BEHAVIORAL_EVENT_CATEGORY.reversal, timestamp, element, evidence };
}

export function createRepeatedActionEvent(
  timestamp: number,
  actionKind: BehavioralEventKind,
  count: number,
  element?: ElementIdentity,
  evidence?: BehavioralEventEvidence
): RepeatedActionEvent {
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

export function createRepeatedAttentionEvent(
  timestamp: number,
  element: ElementIdentity | undefined,
  count: number,
  evidence?: BehavioralEventEvidence
): RepeatedAttentionEvent {
  return {
    kind: "repeated_attention",
    category: BEHAVIORAL_EVENT_CATEGORY.repeated_attention,
    timestamp,
    element,
    count,
    evidence,
  };
}

export function createPossibleFailedActionEvent(
  timestamp: number,
  opts: { element?: ElementIdentity; reason?: string; evidence?: BehavioralEventEvidence } = {}
): PossibleFailedActionEvent {
  return { kind: "possible_failed_action", category: BEHAVIORAL_EVENT_CATEGORY.possible_failed_action, timestamp, ...opts };
}

export function createCustomEvent(timestamp: number, name: string, properties?: Record<string, unknown>): CustomEvent {
  return { kind: "custom", category: BEHAVIORAL_EVENT_CATEGORY.custom, timestamp, name, properties };
}

// ---------------------------------------------------------------------------
// Type guards / helpers
// ---------------------------------------------------------------------------

const ALL_BEHAVIORAL_EVENT_KINDS: ReadonlySet<string> = new Set(Object.keys(BEHAVIORAL_EVENT_CATEGORY));

/** Runtime shape check - true for any well-formed BehavioralEvent, regardless of kind. Useful at boundaries (e.g. deserializing from storage) where the static type isn't trusted yet. */
export function isBehavioralEvent(value: unknown): value is BehavioralEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.kind === "string" &&
    ALL_BEHAVIORAL_EVENT_KINDS.has(v.kind) &&
    typeof v.timestamp === "number" &&
    v.category === BEHAVIORAL_EVENT_CATEGORY[v.kind as BehavioralEventKind]
  );
}

export function isDiscreteAction(event: BehavioralEvent): boolean {
  return event.category === "discrete_action";
}

export function isIntentSignal(event: BehavioralEvent): boolean {
  return event.category === "intent_signal";
}

export function isDerivedSignal(event: BehavioralEvent): boolean {
  return event.category === "derived_signal";
}

/** Application/business events (see the module doc comment) - never observed behavior, never DOM-derived. */
export function isApplicationEvent(event: BehavioralEvent): boolean {
  return event.category === "application_event";
}

/** Builds a `kind === "..."` type guard for one specific BehavioralEvent kind, narrowing to that kind's interface. */
function kindGuard<K extends BehavioralEventKind>(kind: K) {
  return (event: BehavioralEvent): event is Extract<BehavioralEvent, { kind: K }> => event.kind === kind;
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
export const isCustomEvent = kindGuard("custom");
