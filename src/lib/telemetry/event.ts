export interface IncomingEvent {
  type: "page_view" | "hover" | "click" | "scroll" | "cursor" | "rage_click" | "custom";
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
  documentX?: number;
  documentY?: number;
  documentWidth?: number;
  documentHeight?: number;
  deviceClass?: "desktop" | "tablet" | "mobile";
  heatmapStateId?: string;
  /** Existing SDK rage-click detector's aggregate cluster size. */
  rageClickCount?: number;
  /**
   * `custom` events only - the developer-defined event contract
   * (`analytics.event(name, properties?)` on the SDK). `name` identifies
   * *which* application event this is; `properties` is whatever
   * JSON-serializable data the caller passed, carried through as an
   * opaque bag - never interpreted or flattened by this layer, the same
   * way identify()'s `traits` are handled.
   */
  name?: string;
  properties?: Record<string, JsonValue>;
}

/**
 * A JSON-serializable value, recursively - the shape `custom` events'
 * `properties` are validated against at the ingestion boundary (see
 * validation.ts's structurally-identical `jsonValueSchema`) and
 * therefore guaranteed to already have by the time an `IncomingEvent`
 * exists.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
