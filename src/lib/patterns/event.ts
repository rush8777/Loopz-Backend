export interface IncomingEvent {
  type: "page_view" | "hover" | "click" | "scroll" | "cursor";
  timestamp: number; // epoch ms
  /**
   * `label`/`role` are optional, SDK-computed display metadata (see the
   * SDK's ElementLabeler) - human-readable text and a coarse semantic
   * role, purely for display. `selector` remains the sole identity/
   * matching mechanism throughout the behavioral pipeline; label/role
   * are carried through (see elementIdentity.ts's `elementIdentityFromRaw`)
   * but never used for grouping, so a dynamic or inconsistent label
   * can't fragment or merge patterns that selector-based identity
   * already gets right.
   */
  element?: { selector: string; label?: string; role?: string };
  /** hover events only. */
  durationMs?: number;
  /** scroll events only, 0-100. */
  scrollPercent?: number;
  /** click/hover/cursor events only - page-relative coordinates, for spatial (heatmap) analysis. */
  x?: number;
  y?: number;
  /** Viewport size active when x/y was captured, for normalizing across screen sizes. */
  viewportWidth?: number;
  viewportHeight?: number;
}
