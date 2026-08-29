import { describeElementIdentity, hasStableIdentity } from "./elementIdentity.js";
/**
 * Clean sequence representation.
 *
 * EPISODE SEGMENTATION -> CLEAN BEHAVIORAL SEQUENCES
 *
 * The token/string form of an episode's compiled events - the input
 * shape a later pattern-detection stage will consume (not implemented
 * here; this task only produces the clean input for it).
 * `sequenceSimilarity.ts` is deliberately left untouched by this task.
 *
 * A token is always derived from an already-compiled `BehavioralEvent`
 * (see `behaviorCompiler.ts`), never from a raw event directly - since
 * there is no `BehavioralEventKind` for raw cursor telemetry (see
 * `behavioralEvent.ts` / `rawTelemetry.ts`), a `"cursor"` token can
 * never appear here by construction, regardless of how many raw
 * cursor samples the session contained.
 */
/**
 * One token per behavioral event: `"<kind>"` for events with no
 * identifiable target element, or `"<kind>:<element>"` when the event
 * has one - e.g. `"click:#cta"`, `"dwell:#signup"`, `"scroll"`,
 * `"page_enter"`. Uses the existing element-identity description
 * (`elementIdentity.ts`), so a plain selector is enough to produce a
 * qualified token - no fingerprint required, matching what the current
 * SDK can actually provide.
 *
 * `"custom"` events have no element (see behavioralEvent.ts's
 * `CustomEvent` - deliberately never DOM-selector-scoped) but do have
 * a developer-chosen `name`, which is the qualifier that actually
 * distinguishes them from one another: `"custom:checkout_completed"`,
 * `"custom:checkout_started"`. Without this, every distinct business
 * event would collapse to the same bare `"custom"` token and become
 * indistinguishable in a sequence - exactly the ambiguity element-
 * qualification exists to avoid for DOM events.
 */
export function tokenForBehavioralEvent(event) {
    if (event.kind === "custom") {
        return `custom:${event.name}`;
    }
    const element = "element" in event ? event.element : undefined;
    if (element && hasStableIdentity(element)) {
        return `${event.kind}:${describeElementIdentity(element)}`;
    }
    return event.kind;
}
/** Ordered tokens for one episode's compiled events. */
export function behavioralSequenceForEpisode(episode) {
    return episode.events.map(tokenForBehavioralEvent);
}
/** Ordered tokens for an arbitrary already-compiled event list, for callers not yet working in terms of Episodes. */
export function behavioralSequenceForEvents(events) {
    return [...events].sort((a, b) => a.timestamp - b.timestamp).map(tokenForBehavioralEvent);
}
//# sourceMappingURL=behavioralSequence.js.map