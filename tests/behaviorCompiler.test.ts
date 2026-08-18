import { describe, it, expect } from "vitest";
import { compileBehavioralEvents, type CompilableRawEvent } from "../src/lib/behavior/behaviorCompiler.js";
import {
  isBehavioralEvent,
  isClickEvent,
  isDwellEvent,
  isElementApproachEvent,
  isHoverIntentEvent,
  isPageEnterEvent,
  isScrollEvent,
} from "../src/lib/behavior/behavioralEvent.js";

const BUTTON_POS = { x: 500, y: 300 };

function cursorPath(opts: {
  startTimestamp: number;
  stepMs: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  steps: number;
}): CompilableRawEvent[] {
  const { startTimestamp, stepMs, from, to, steps } = opts;
  const events: CompilableRawEvent[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    events.push({
      type: "cursor",
      timestamp: startTimestamp + i * stepMs,
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
    });
  }
  return events;
}

function jitter(opts: { startTimestamp: number; stepMs: number; center: { x: number; y: number }; count: number; radiusPx: number }): CompilableRawEvent[] {
  const { startTimestamp, stepMs, center, count, radiusPx } = opts;
  const events: CompilableRawEvent[] = [];
  for (let i = 0; i < count; i++) {
    const offset = i % 2 === 0 ? radiusPx : -radiusPx;
    events.push({ type: "cursor", timestamp: startTimestamp + i * stepMs, x: center.x + offset, y: center.y });
  }
  return events;
}

function pageView(timestamp: number, id?: string): CompilableRawEvent {
  return { type: "page_view", timestamp, ...(id ? { id } : {}) };
}
function click(timestamp: number, selector: string, pos: { x: number; y: number }, id?: string): CompilableRawEvent {
  return { type: "click", timestamp, element: { selector }, x: pos.x, y: pos.y, ...(id ? { id } : {}) };
}
function hover(timestamp: number, selector: string, durationMs: number, pos: { x: number; y: number }, id?: string): CompilableRawEvent {
  return { type: "hover", timestamp, element: { selector }, durationMs, x: pos.x, y: pos.y, ...(id ? { id } : {}) };
}
function scroll(timestamp: number, scrollPercent: number, id?: string): CompilableRawEvent {
  return { type: "scroll", timestamp, scrollPercent, ...(id ? { id } : {}) };
}

describe("direct mappings survive compilation", () => {
  it("page_view -> page_enter", () => {
    const result = compileBehavioralEvents([pageView(0)]);
    expect(result).toHaveLength(1);
    expect(isPageEnterEvent(result[0])).toBe(true);
  });

  it("click survives as a click event, including its element", () => {
    const result = compileBehavioralEvents([pageView(0), click(100, "#cta", BUTTON_POS)]);
    const clickEvent = result.find(isClickEvent);
    expect(clickEvent).toBeDefined();
    expect(clickEvent!.element?.selector).toBe("#cta");
  });

  it("hover aggregation survives - a sufficiently long hover becomes hover_intent", () => {
    const result = compileBehavioralEvents([pageView(0), hover(100, "#cta", 500, BUTTON_POS)]);
    const hoverIntent = result.find(isHoverIntentEvent);
    expect(hoverIntent).toBeDefined();
    expect(hoverIntent!.element?.selector).toBe("#cta");
    expect(hoverIntent!.durationMs).toBe(500);
  });

  it("scroll survives as a scroll event with its percent", () => {
    const result = compileBehavioralEvents([pageView(0), scroll(100, 65)]);
    const scrollEvent = result.find(isScrollEvent);
    expect(scrollEvent).toBeDefined();
    expect(scrollEvent!.scrollPercent).toBe(65);
  });
});

describe("cursor samples never appear as behavioral events", () => {
  it("produces no 'cursor' kind anywhere in the output", () => {
    const events: CompilableRawEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 10, stepMs: 20, from: { x: 0, y: 0 }, to: { x: 400, y: 400 }, steps: 50 }),
      click(1200, "#cta", { x: 400, y: 400 }),
    ];
    const result = compileBehavioralEvents(events);
    expect(result.some((e) => (e as { kind: string }).kind === "cursor")).toBe(false);
    expect(result.every(isBehavioralEvent)).toBe(true);
  });
});

describe("derived cursor signals are merged into the output", () => {
  it("includes element_approach and dwell alongside the direct mappings", () => {
    const events: CompilableRawEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 50, y: 50 }, to: { x: 480, y: 290 }, steps: 8 }),
      hover(600, "#signup", 400, BUTTON_POS),
      ...jitter({ startTimestamp: 1000, stepMs: 100, center: BUTTON_POS, count: 8, radiusPx: 2 }),
      click(2000, "#signup", BUTTON_POS),
    ];

    const result = compileBehavioralEvents(events);
    const kinds = result.map((e) => e.kind);

    expect(kinds).toContain("page_enter");
    expect(kinds).toContain("element_approach");
    expect(kinds).toContain("hover_intent");
    expect(kinds).toContain("dwell");
    expect(kinds).toContain("click");
    expect(result.find(isElementApproachEvent)?.element?.selector).toBe("#signup");
    expect(result.find(isDwellEvent)?.element?.selector).toBe("#signup");
  });
});

describe("chronological ordering", () => {
  it("returns events sorted by timestamp regardless of input order", () => {
    const events: CompilableRawEvent[] = [
      click(500, "#b", { x: 10, y: 10 }),
      pageView(0),
      scroll(250, 40),
    ];
    // Shuffle the input to make sure compilation doesn't rely on input order.
    const shuffled = [events[2], events[0], events[1]];

    const result = compileBehavioralEvents(shuffled);
    const timestamps = result.map((e) => e.timestamp);
    const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sortedTimestamps);
  });
});

describe("multiple elements remain distinguishable", () => {
  it("keeps signals for different selectors separate", () => {
    const posA = { x: 100, y: 100 };
    const posB = { x: 800, y: 600 };

    const events: CompilableRawEvent[] = [
      pageView(0),
      hover(100, "#a", 400, posA),
      ...cursorPath({ startTimestamp: 600, stepMs: 50, from: posA, to: posB, steps: 8 }),
      hover(1050, "#b", 400, posB),
      click(1500, "#b", posB),
    ];

    const result = compileBehavioralEvents(events);
    const selectors = new Set(result.map((e) => e.element?.selector).filter(Boolean));

    expect(selectors.has("#a")).toBe(true);
    expect(selectors.has("#b")).toBe(true);
    expect(result.find(isClickEvent)?.element?.selector).toBe("#b");
  });
});

describe("missing selector does not crash", () => {
  it("compiles a click with no element at all without throwing", () => {
    expect(() => compileBehavioralEvents([pageView(0), { type: "click", timestamp: 100 }])).not.toThrow();
    const result = compileBehavioralEvents([pageView(0), { type: "click", timestamp: 100 }]);
    expect(result.find(isClickEvent)?.element).toBeUndefined();
  });

  it("compiles an empty event list to an empty result", () => {
    expect(compileBehavioralEvents([])).toEqual([]);
  });
});

describe("evidence/provenance survives compilation", () => {
  it("keeps the evidence bag on derived signals (e.g. element_approach) unchanged", () => {
    const events: CompilableRawEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 50, y: 50 }, to: { x: 480, y: 290 }, steps: 8 }),
      hover(600, "#signup", 0, BUTTON_POS),
    ];
    const result = compileBehavioralEvents(events);
    const approach = result.find(isElementApproachEvent);
    expect(approach?.evidence?.distanceMoved).toBeGreaterThan(0);
    expect(approach?.evidence?.durationMs).toBeGreaterThan(0);
  });

  it("attaches sourceEventIds when raw events carry an id", () => {
    const events: CompilableRawEvent[] = [pageView(0, "evt_1"), click(100, "#cta", BUTTON_POS, "evt_2")];
    const result = compileBehavioralEvents(events);

    const clickEvent = result.find(isClickEvent);
    expect(clickEvent?.sourceEventIds).toEqual(["evt_2"]);

    const pageEnter = result.find(isPageEnterEvent);
    expect(pageEnter?.sourceEventIds).toEqual(["evt_1"]);
  });

  it("attaches multiple sourceEventIds spanning a derived signal's evidence window", () => {
    const events: CompilableRawEvent[] = [
      pageView(0, "evt_page"),
      hover(100, "#cta", 400, BUTTON_POS, "evt_hover"),
      ...jitter({ startTimestamp: 200, stepMs: 50, center: BUTTON_POS, count: 6, radiusPx: 2 }).map((e, i) => ({
        ...e,
        id: `evt_cursor_${i}`,
      })),
      click(700, "#cta", BUTTON_POS, "evt_click"),
    ];

    const result = compileBehavioralEvents(events);
    const dwell = result.find(isDwellEvent);
    expect(dwell).toBeDefined();
    expect(dwell!.sourceEventIds).toBeDefined();
    expect(dwell!.sourceEventIds!.length).toBeGreaterThan(0);
    // Every attached id should be one we actually gave a raw event.
    const knownIds = new Set(events.map((e) => e.id).filter(Boolean));
    for (const id of dwell!.sourceEventIds!) {
      expect(knownIds.has(id)).toBe(true);
    }
  });

  it("does not attach sourceEventIds when no raw event carries an id", () => {
    const events: CompilableRawEvent[] = [pageView(0), click(100, "#cta", BUTTON_POS)];
    const result = compileBehavioralEvents(events);
    for (const event of result) {
      expect(event.sourceEventIds).toBeUndefined();
    }
  });
});

describe("cross-batch context", () => {
  it("supplying previousEvents does not re-emit signals already attributable to the earlier batch", () => {
    const previousEvents: CompilableRawEvent[] = [pageView(0), hover(100, "#cta", 400, BUTTON_POS)];
    const newBatch: CompilableRawEvent[] = [click(700, "#cta", BUTTON_POS)];

    const result = compileBehavioralEvents(newBatch, { previousEvents });

    // The page_enter and hover_intent belong entirely to the previous
    // batch (both timestamps are before newBatch's start) and should
    // not reappear in this call's output.
    expect(result.some(isPageEnterEvent)).toBe(false);
    expect(result.some(isHoverIntentEvent)).toBe(false);
    expect(result.some(isClickEvent)).toBe(true);
  });

  it("uses previousEvents as context for a run that spans the batch boundary", () => {
    // A cursor approach run starts in the "previous" batch and the
    // hover that resolves it arrives in the new batch.
    const previousEvents: CompilableRawEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 50, y: 50 }, to: { x: 300, y: 200 }, steps: 4 }),
    ];
    const newBatch: CompilableRawEvent[] = [
      ...cursorPath({ startTimestamp: 350, stepMs: 50, from: { x: 300, y: 200 }, to: { x: 480, y: 290 }, steps: 4 }),
      hover(600, "#signup", 0, BUTTON_POS),
    ];

    const withoutContext = compileBehavioralEvents(newBatch);
    const withContext = compileBehavioralEvents(newBatch, { previousEvents });

    // With the full approach path available, the evidence for the
    // approach signal should reflect more total movement than
    // compiling the second half of the run alone.
    const approachWithout = withoutContext.find(isElementApproachEvent);
    const approachWith = withContext.find(isElementApproachEvent);
    expect(approachWith).toBeDefined();
    if (approachWithout && approachWith) {
      expect(approachWith.evidence?.distanceMoved ?? 0).toBeGreaterThanOrEqual(approachWithout.evidence?.distanceMoved ?? 0);
    }
  });

  it("is a pure function - the same input always produces the same output", () => {
    const events: CompilableRawEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 50, y: 50 }, to: { x: 480, y: 290 }, steps: 6 }),
      hover(400, "#cta", 400, BUTTON_POS),
      click(900, "#cta", BUTTON_POS),
    ];

    const first = compileBehavioralEvents(events);
    const second = compileBehavioralEvents(events);
    expect(first).toEqual(second);
  });
});
