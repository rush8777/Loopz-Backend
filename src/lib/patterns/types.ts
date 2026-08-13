/**
 * Shared pattern schema. Both human-authored patterns (built through the
 * authoring UI) and ML-discovered patterns (found via batch mining,
 * later promoted through human review) compile into this exact shape.
 * The live matcher below never knows or cares which origin produced a
 * given pattern - that's the whole point of having one shared format.
 *
 * Target matching is selector-based for this pass (matches
 * ElementDescriptor.selector from the SDK's event payloads). The
 * conceptually "correct" version uses structural fingerprints (role +
 * region + size-bucket) so patterns survive a site redesign - that
 * fingerprinting layer doesn't exist in the SDK yet, so selector match
 * is the honest, buildable-today substitute. Swapping the matching
 * strategy later only touches `matchesTarget()` below, not the FSM.
 */

export type PatternStepVerb = "enter" | "hover" | "click" | "scroll_past";

export interface PatternStepTarget {
  /** Matches ElementDescriptor.selector from an SDK event payload. Exact match for this pass. */
  selector: string;
}

export interface PatternStep {
  id: string;
  verb: PatternStepVerb;
  /** Omitted for "enter" (page-level, no target element). */
  target?: PatternStepTarget;
  /** verb === "hover": minimum dwell time to count. verb === "scroll_past": minimum scroll percent (0-100). */
  minDurationMs?: number;
  minScrollPercent?: number;
  /**
   * If false, this step doesn't reset the match when skipped - it's
   * "nice to have but the pattern still counts without it" (per the
   * fuzzy-matching design). If true (default), skipping it past its
   * gap budget expires the whole match attempt.
   */
  required?: boolean;
  /** Max ms allowed between the previous matched step and this one before the match attempt expires. */
  maxGapMs?: number;
}

export interface PatternDefinition {
  id: string;
  siteId: string;
  name: string;
  steps: PatternStep[];
  /** Overall time budget from the first matched step to the last. */
  matchWindowMs: number;
  origin: "AUTHORED" | "DISCOVERED";
  status: "DRAFT" | "ACTIVE" | "PAUSED";
  /** What to render when this pattern completes - kept intentionally minimal for this pass. */
  feedback: {
    message: string;
    targetSelector: string; // element to anchor the popup near
  };
}
