/**
 * Normalized element identity.
 *
 * The current SDK only ever gives us a CSS selector (see
 * `IncomingEvent.element.selector` in `../patterns/event.js`), and
 * `PatternStepTarget` in `../patterns/types.js` already flags exact
 * selector matching as a stand-in for something better: selectors work
 * fine until a site redesign or A/B test changes the DOM shape
 * underneath them, and the same real-world element then looks like two
 * unrelated targets to anything matching on selector alone.
 *
 * `ElementIdentity` is intentionally wider than what the SDK sends
 * today. Every field except `source` is optional. As of the SDK's
 * ElementLabeler work, `label`/`role` ARE now sent (see
 * `elementIdentityFromRaw` below) - `region` and `fingerprint` remain
 * reserved for later SDK versions / a later server-side pass. Nothing
 * downstream should assume any field other than `source` is present.
 *
 * IDENTITY VS. DISPLAY: `selector` (and eventually `fingerprint`)
 * remain the only fields used for identity/matching/grouping
 * throughout the behavioral pipeline (see `describeElementIdentity`,
 * used by `behavioralSequence.ts`'s tokenization) - `label`/`role` are
 * carried through purely for display. This matters because a label
 * computed from visible text can legitimately vary in ways a selector
 * shouldn't (e.g. a badge whose text is a live count); if label ever
 * became part of grouping identity, that variance would fragment
 * patterns that selector-based identity already handles correctly.
 */
/** Explicit "we know an element was involved but have no identifying evidence for it" value - never throw, use this instead. */
export const UNKNOWN_ELEMENT_IDENTITY = { source: "unknown" };
/**
 * Builds an ElementIdentity from the selector on a raw incoming event.
 * Safe to call with `undefined`/`null`/empty string (no target element,
 * or the SDK didn't capture one) - returns `undefined` rather than a
 * placeholder object, so callers can tell "no element" apart from
 * "element with unknown identity" (`UNKNOWN_ELEMENT_IDENTITY`).
 */
export function elementIdentityFromSelector(selector) {
    if (!selector)
        return undefined;
    return { selector, source: "selector" };
}
/**
 * Builds an ElementIdentity from a raw incoming event's full element
 * object, including the SDK's optional `label`/`role` when present -
 * the richer counterpart to `elementIdentityFromSelector` above (kept
 * separate rather than replacing it, since some callers only ever have
 * a bare selector string to work with). Safe to call with
 * `undefined`/`null`, or an element with no selector - returns
 * `undefined` in both cases, same contract as `elementIdentityFromSelector`.
 */
export function elementIdentityFromRaw(element) {
    if (!element?.selector)
        return undefined;
    return {
        selector: element.selector,
        source: "selector",
        ...(element.label && { label: element.label }),
        ...(element.role && { role: element.role }),
    };
}
/** True when an identity carries at least one field precise enough to re-identify the same element across sessions (a selector or a fingerprint). */
export function hasStableIdentity(identity) {
    if (!identity)
        return false;
    return Boolean(identity.selector || identity.fingerprint);
}
/** Human-readable label for an identity, for logs/debugging/insight text - never throws on missing data. */
export function describeElementIdentity(identity) {
    if (!identity)
        return "(no element)";
    if (identity.selector)
        return identity.selector;
    if (identity.fingerprint)
        return `fingerprint:${identity.fingerprint}`;
    if (identity.label)
        return `label:${identity.label}`;
    if (identity.role)
        return `role:${identity.role}`;
    return "(unknown element)";
}
//# sourceMappingURL=elementIdentity.js.map