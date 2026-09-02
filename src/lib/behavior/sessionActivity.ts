import type { sessionEvents } from "../../db/schema.js";
import type { BehavioralEvent, BehavioralEventEvidence } from "./behavioralEvent.js";
import { compileBehavioralEvents, type CompilableRawEvent } from "./behaviorCompiler.js";
import type { IncomingEvent } from "../patterns/event.js";

type StoredSessionEvent = typeof sessionEvents.$inferSelect;

const LONG_HOVER_MS = 20_000;
const MAX_SOURCE_REFERENCES = 20;

export interface SessionActivityItem {
  id: string;
  kind: "click" | "custom" | "long_hover" | "derived_signal";
  signalKind?: BehavioralEvent["kind"];
  timestamp: string;
  estimatedStartTimestamp?: string;
  element?: { selector?: string; label?: string; role?: string };
  durationMs?: number;
  name?: string;
  properties?: Record<string, unknown>;
  count?: number;
  evidence?: BehavioralEventEvidence & {
    sourceEventIds?: string[];
    sourceEventCount?: number;
    provenance: "best_effort_time_window";
  };
}

export interface SessionActivityPageGroup {
  id: string;
  pageViewId: string | null;
  path: string | null;
  pageName: string | null;
  attribution: "recorded" | "inferred" | "unknown";
  firstObserved: string;
  lastObserved: string;
  deepestScrollPercent: number | null;
  scrollSampleCount: number;
  items: SessionActivityItem[];
  pointerSignalsAvailable: number;
  geometryEvidenceUsable: boolean;
}

interface MutableGroup {
  id: string;
  pageViewId: string | null;
  path: string | null;
  attribution: "recorded" | "inferred" | "unknown";
  rows: StoredSessionEvent[];
}

/** Small typed storage adapter. Millisecond conversion is explicit at this boundary. */
export function storedRowToCompilableEvent(row: StoredSessionEvent): CompilableRawEvent {
  return {
    id: row.id,
    type: row.type as IncomingEvent["type"],
    timestamp: row.timestamp.getTime(),
    element: row.selector
      ? {
          selector: row.selector,
          ...(row.elementLabel ? { label: row.elementLabel } : {}),
          ...(row.elementRole ? { role: row.elementRole } : {}),
        }
      : undefined,
    durationMs: row.durationMs ?? undefined,
    scrollPercent: row.scrollPercent ?? undefined,
    x: row.x ?? undefined,
    y: row.y ?? undefined,
    viewportWidth: row.viewportWidth ?? undefined,
    viewportHeight: row.viewportHeight ?? undefined,
    name: row.eventName ?? undefined,
    properties: (row.eventProperties as CompilableRawEvent["properties"]) ?? undefined,
  };
}

function stableRows(rows: readonly StoredSessionEvent[]): StoredSessionEvent[] {
  return [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id));
}

function groupRows(rows: readonly StoredSessionEvent[]): MutableGroup[] {
  const sorted = stableRows(rows);
  const pageViews = sorted.filter((row) => row.type === "page_view");
  const allLegacy = pageViews.every((row) => !row.pageViewId) && sorted.every((row) => !row.pageViewId);
  const groups = new Map<string, MutableGroup>();

  for (const row of pageViews) {
    const key = row.pageViewId ? `page:${row.pageViewId}` : `legacy:${row.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        pageViewId: row.pageViewId,
        path: row.pagePath,
        attribution: row.pageViewId ? "recorded" : "inferred",
        rows: [],
      });
    }
    groups.get(key)!.rows.push(row);
  }

  let activeLegacyKey: string | null = null;
  for (const row of sorted) {
    if (row.type === "page_view") {
      activeLegacyKey = !row.pageViewId && allLegacy ? `legacy:${row.id}` : null;
      continue;
    }

    let key: string;
    if (row.pageViewId) key = `page:${row.pageViewId}`;
    else if (activeLegacyKey) key = activeLegacyKey;
    else key = "unknown";

    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        pageViewId: row.pageViewId,
        path: null,
        attribution: row.pageViewId ? "recorded" : "unknown",
        rows: [],
      });
    }
    groups.get(key)!.rows.push(row);
  }

  return [...groups.values()]
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => {
      const time = a.rows[0].timestamp.getTime() - b.rows[0].timestamp.getTime();
      return time || a.id.localeCompare(b.id);
    });
}

function elementOf(event: BehavioralEvent) {
  if (!("element" in event) || !event.element) return undefined;
  return {
    ...(event.element.selector ? { selector: event.element.selector } : {}),
    ...(event.element.label ? { label: event.element.label } : {}),
    ...(event.element.role ? { role: event.element.role } : {}),
  };
}

function boundedEvidence(event: BehavioralEvent): SessionActivityItem["evidence"] | undefined {
  const details = "evidence" in event ? event.evidence : undefined;
  const ids = event.sourceEventIds ?? [];
  if (!details && ids.length === 0) return undefined;
  return {
    ...details,
    ...(ids.length ? { sourceEventIds: ids.slice(0, MAX_SOURCE_REFERENCES), sourceEventCount: ids.length } : {}),
    provenance: "best_effort_time_window",
  };
}

function compatibleCoordinateFrame(rows: readonly StoredSessionEvent[]): boolean {
  const coordinateRows = rows.filter((row) => row.x != null && row.y != null);
  if (coordinateRows.length === 0) return false;
  if (coordinateRows.some((row) => row.viewportWidth == null || row.viewportHeight == null)) return false;
  // Scroll rows do not carry x/y, but their viewport still marks a coordinate-frame change.
  // Include every recorded viewport so geometry is suppressed across resize/orientation boundaries.
  const frameRows = rows.filter((row) => row.viewportWidth != null || row.viewportHeight != null);
  const frames = new Set(
    frameRows.map((row) =>
      row.viewportWidth != null && row.viewportHeight != null ? `${row.viewportWidth}x${row.viewportHeight}` : "missing"
    )
  );
  return frames.size === 1 && !frames.has("missing");
}

function derivedItem(event: BehavioralEvent, index: number): SessionActivityItem | null {
  if (event.kind === "hover_intent") {
    return {
      id: `long-hover:${event.timestamp}:${index}`,
      kind: "long_hover",
      signalKind: event.kind,
      timestamp: new Date(event.timestamp).toISOString(),
      estimatedStartTimestamp: new Date(event.timestamp - event.durationMs).toISOString(),
      element: elementOf(event),
      durationMs: event.durationMs,
      evidence: boundedEvidence(event),
    };
  }
  if (event.category !== "derived_signal" && event.kind !== "dwell") return null;
  return {
    id: `derived:${event.kind}:${event.timestamp}:${index}`,
    kind: "derived_signal",
    signalKind: event.kind,
    timestamp: new Date(event.timestamp).toISOString(),
    element: elementOf(event),
    ...("durationMs" in event && typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
    ...("count" in event && typeof event.count === "number" ? { count: event.count } : {}),
    evidence: boundedEvidence(event),
  };
}

export function buildSessionActivityGroups(
  rows: readonly StoredSessionEvent[],
  resolvePageName: (path: string) => string | null = () => null
): SessionActivityPageGroup[] {
  return groupRows(rows).map((group) => {
    const ordered = stableRows(group.rows);
    const frameUsable = group.attribution !== "unknown" && compatibleCoordinateFrame(ordered);
    // Short hovers are intentionally omitted from this presentation-only compile input so they cannot
    // become anchors that reintroduce hover noise through derived rows. Raw storage is untouched.
    const compilable = ordered
      .filter((row) => row.type !== "hover" || (row.durationMs ?? 0) >= LONG_HOVER_MS)
      .map(storedRowToCompilableEvent);
    const compiled = compileBehavioralEvents(compilable, { aggregationConfig: { minHoverIntentDurationMs: LONG_HOVER_MS } });
    const derived = compiled
      .map(derivedItem)
      .filter((item): item is SessionActivityItem => Boolean(item))
      .filter((item) => item.kind === "long_hover" || item.signalKind === "repeated_attention" || frameUsable);

    const direct = ordered.flatMap<SessionActivityItem>((row) => {
      if (row.type === "click") {
        return [{
          id: `click:${row.id}`,
          kind: "click" as const,
          timestamp: row.timestamp.toISOString(),
          element: {
            ...(row.selector ? { selector: row.selector } : {}),
            ...(row.elementLabel ? { label: row.elementLabel } : {}),
            ...(row.elementRole ? { role: row.elementRole } : {}),
          },
        }];
      }
      if (row.type === "custom" && row.eventName) {
        return [{
          id: `custom:${row.id}`,
          kind: "custom" as const,
          timestamp: row.timestamp.toISOString(),
          name: row.eventName,
          ...((row.eventProperties as Record<string, unknown> | null) ? { properties: row.eventProperties as Record<string, unknown> } : {}),
        }];
      }
      return [];
    });

    const items = [...direct, ...derived].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id)
    );
    const scrollValues = ordered
      .filter((row) => row.type === "scroll" && row.scrollPercent != null && row.scrollPercent >= 0 && row.scrollPercent <= 100)
      .map((row) => row.scrollPercent!);
    const firstMs = ordered[0].timestamp.getTime();
    const lastMs = ordered[ordered.length - 1].timestamp.getTime();
    const safeEstimatedItems = items.map((item) =>
      item.estimatedStartTimestamp && Date.parse(item.estimatedStartTimestamp) < firstMs
        ? { ...item, estimatedStartTimestamp: undefined }
        : item
    );

    return {
      id: group.id,
      pageViewId: group.pageViewId,
      path: group.path,
      pageName: group.path ? resolvePageName(group.path) : null,
      attribution: group.attribution,
      firstObserved: new Date(firstMs).toISOString(),
      lastObserved: new Date(lastMs).toISOString(),
      deepestScrollPercent: scrollValues.length ? Math.max(...scrollValues) : null,
      scrollSampleCount: scrollValues.length,
      items: safeEstimatedItems,
      pointerSignalsAvailable: safeEstimatedItems.filter((item) => item.kind === "derived_signal").length,
      geometryEvidenceUsable: frameUsable,
    };
  });
}

export const SESSION_LONG_HOVER_MS = LONG_HOVER_MS;
