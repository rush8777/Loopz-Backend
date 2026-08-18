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
 * today. Every field except `source` is optional, and only `selector`
 * is ever populated by the constructors in this file - `role`,
 * `label`, `region`, and `fingerprint` are reserved for later SDK
 * versions (richer event payloads) or a later server-side pass
 * (structural fingerprinting) to fill in. Nothing downstream should
 * assume any field other than `source` is present.
 */

/** How an ElementIdentity was constructed - lets downstream matching decide how much to trust it. */
export type ElementIdentitySource = "selector" | "fingerprint" | "unknown";

export interface ElementIdentity {
  /** Exact CSS selector, verbatim from the SDK. The primary/most precise identity when present - never removed or deprioritized by this type. */
  selector?: string;
  /** Semantic element type, e.g. "button", "link", "heading" - ARIA role or tag name. Not sent by the SDK today; reserved for future evidence. */
  role?: string;
  /** Visible text or aria-label, when captured. Not sent by the SDK today; reserved for future evidence. */
  label?: string;
  /** Coarse page-region hint, e.g. "hero", "nav", "footer". Not sent by the SDK today; reserved for future evidence. */
  region?: string;
  /**
   * A stable structural fingerprint (e.g. role + region + size-bucket)
   * computed server-side so an element's identity survives selector
   * churn across a redesign. Not computed by this layer - reserved for
   * a later analysis pass.
   */
  fingerprint?: string;
  source: ElementIdentitySource;
}

/** Explicit "we know an element was involved but have no identifying evidence for it" value - never throw, use this instead. */
export const UNKNOWN_ELEMENT_IDENTITY: ElementIdentity = { source: "unknown" };

/**
 * Builds an ElementIdentity from the selector on a raw incoming event.
 * Safe to call with `undefined`/`null`/empty string (no target element,
 * or the SDK didn't capture one) - returns `undefined` rather than a
 * placeholder object, so callers can tell "no element" apart from
 * "element with unknown identity" (`UNKNOWN_ELEMENT_IDENTITY`).
 */
export function elementIdentityFromSelector(selector: string | null | undefined): ElementIdentity | undefined {
  if (!selector) return undefined;
  return { selector, source: "selector" };
}

/** True when an identity carries at least one field precise enough to re-identify the same element across sessions (a selector or a fingerprint). */
export function hasStableIdentity(identity: ElementIdentity | undefined): identity is ElementIdentity {
  if (!identity) return false;
  return Boolean(identity.selector || identity.fingerprint);
}

/** Human-readable label for an identity, for logs/debugging/insight text - never throws on missing data. */
export function describeElementIdentity(identity: ElementIdentity | undefined): string {
  if (!identity) return "(no element)";
  if (identity.selector) return identity.selector;
  if (identity.fingerprint) return `fingerprint:${identity.fingerprint}`;
  if (identity.label) return `label:${identity.label}`;
  if (identity.role) return `role:${identity.role}`;
  return "(unknown element)";
}
