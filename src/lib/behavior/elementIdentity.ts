/**
 * Normalized element identity.
 *
 * CSS selectors give Session Activity a target identity. The SDK also
 * sends optional label and role metadata for display. Changes in the
 * DOM can change a selector, and visible text may vary between events.
 */

/** How an ElementIdentity was constructed - lets downstream matching decide how much to trust it. */
export type ElementIdentitySource = "selector" | "fingerprint" | "unknown";

export interface ElementIdentity {
  /** Exact CSS selector, verbatim from the SDK. The primary/most precise identity when present - never removed or deprioritized by this type. */
  selector?: string;
  /** Semantic element type, e.g. "button", "link", "heading" - ARIA role or tag name. */
  role?: string;
  /** Visible text or aria-label, when captured. */
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

/**
 * Builds an ElementIdentity from a raw incoming event's full element
 * object, including the SDK's optional `label`/`role` when present -
 * the richer counterpart to `elementIdentityFromSelector` above (kept
 * separate rather than replacing it, since some callers only ever have
 * a bare selector string to work with). Safe to call with
 * `undefined`/`null`, or an element with no selector - returns
 * `undefined` in both cases, same contract as `elementIdentityFromSelector`.
 */
export function elementIdentityFromRaw(
  element: { selector?: string; label?: string; role?: string } | null | undefined
): ElementIdentity | undefined {
  if (!element?.selector) return undefined;
  return {
    selector: element.selector,
    source: "selector",
    ...(element.label && { label: element.label }),
    ...(element.role && { role: element.role }),
  };
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
