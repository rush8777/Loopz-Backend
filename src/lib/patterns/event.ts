export interface IncomingEvent {
  type: "page_view" | "hover" | "click" | "scroll" | "cursor";
  timestamp: number; // epoch ms
  element?: { selector: string };
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
