import { describe, it, expect } from "vitest";
import { aggregateBehavioralEvents, DEFAULT_CURSOR_AGGREGATION_CONFIG } from "../src/lib/behavior/cursorAggregator.js";
import {
  isBehavioralEvent,
  isClickEvent,
  isCustomEvent,
  isDwellEvent,
  isElementApproachEvent,
  isElementLeaveEvent,
  isHesitationEvent,
  isHoverIntentEvent,
  isPageEnterEvent,
  isRepeatedAttentionEvent,
  isReversalEvent,
} from "../src/lib/behavior/behavioralEvent.js";
import type { IncomingEvent } from "../src/lib/patterns/event.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A straight-line cursor path from (x0,y0) to (x1,y1), sampled every `stepMs`. */
function cursorPath(opts: {
  startTimestamp: number;
  stepMs: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  steps: number;
}): IncomingEvent[] {
  const { startTimestamp, stepMs, from, to, steps } = opts;
  const events: IncomingEvent[] = [];
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

/** Cursor samples jittering in a tiny radius around a fixed point - simulates a resting hand, not real movement. */
function jitter(opts: { startTimestamp: number; stepMs: number; center: { x: number; y: number }; count: number; radiusPx: number }): IncomingEvent[] {
  const { startTimestamp, stepMs, center, count, radiusPx } = opts;
  const events: IncomingEvent[] = [];
  for (let i = 0; i < count; i++) {
    const offset = i % 2 === 0 ? radiusPx : -radiusPx;
    events.push({ type: "cursor", timestamp: startTimestamp + i * stepMs, x: center.x + offset, y: center.y });
  }
  return events;
}

/** Cursor samples bouncing back and forth near a fixed point - simulates hesitation/reversal. */
function backAndForth(opts: {
  startTimestamp: number;
  stepMs: number;
  center: { x: number; y: number };
  amplitudePx: number;
  cycles: number;
}): IncomingEvent[] {
  const { startTimestamp, stepMs, center, amplitudePx, cycles } = opts;
  const events: IncomingEvent[] = [];
  let t = startTimestamp;
  for (let c = 0; c < cycles; c++) {
    events.push({ type: "cursor", timestamp: t, x: center.x - amplitudePx, y: center.y });
    t += stepMs;
    events.push({ type: "cursor", timestamp: t, x: center.x + amplitudePx, y: center.y });
    t += stepMs;
  }
  return events;
}

function hover(timestamp: number, selector: string, durationMs: number, pos: { x: number; y: number }): IncomingEvent {
  return { type: "hover", timestamp, element: { selector }, durationMs, x: pos.x, y: pos.y };
}

function click(timestamp: number, selector: string, pos: { x: number; y: number }): IncomingEvent {
  return { type: "click", timestamp, element: { selector }, x: pos.x, y: pos.y };
}

function pageView(timestamp: number): IncomingEvent {
  return { type: "page_view", timestamp };
}

const BUTTON_POS = { x: 500, y: 300 };

describe("simple approach", () => {
  it("emits element_approach when a cursor run moves steadily toward a hovered element", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 100, y: 100 }, to: { x: 480, y: 290 }, steps: 6 }),
      hover(500, "#signup", 0, BUTTON_POS),
    ];

    const result = aggregateBehavioralEvents(events);
    const approach = result.find(isElementApproachEvent);

    expect(approach).toBeDefined();
    expect(approach!.element?.selector).toBe("#signup");
    expect(approach!.evidence?.distanceMoved).toBeGreaterThan(0);
    expect(approach!.evidence?.durationMs).toBeGreaterThan(0);
    expect(result.every(isBehavioralEvent)).toBe(true);
  });

  it("does not emit approach for a run that never gets meaningfully closer to the target", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      // Moves sideways, staying roughly the same distance from the button.
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 100, y: 500 }, to: { x: 120, y: 500 }, steps: 4 }),
      hover(400, "#signup", 0, BUTTON_POS),
    ];

    const result = aggregateBehavioralEvents(events);
    expect(result.find(isElementApproachEvent)).toBeUndefined();
  });
});

describe("dwell", () => {
  it("emits dwell when the cursor stays near a hovered element long enough", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 100, y: 100 }, to: { x: 480, y: 290 }, steps: 6 }),
      hover(500, "#signup", 350, BUTTON_POS),
      // radiusPx kept below the jitter floor (minMovementDistancePx / 4) so
      // this reads as "resting near the target", not oscillation.
      ...jitter({ startTimestamp: 600, stepMs: 100, center: BUTTON_POS, count: 8, radiusPx: 2 }),
      click(1400, "#signup", BUTTON_POS),
    ];

    const result = aggregateBehavioralEvents(events);
    const dwell = result.find(isDwellEvent);

    expect(dwell).toBeDefined();
    expect(dwell!.element?.selector).toBe("#signup");
    expect(dwell!.durationMs).toBeGreaterThanOrEqual(DEFAULT_CURSOR_AGGREGATION_CONFIG.minDwellDurationMs);
    expect(dwell!.evidence?.maxDistanceToTarget).toBeLessThanOrEqual(DEFAULT_CURSOR_AGGREGATION_CONFIG.approachRadiusPx);

    // Matches the shape of the worked example in the task: approach, hover_intent, dwell, click, in order.
    const kinds = result.filter((e) => !isReversalEvent(e)).map((e) => e.kind);
    expect(kinds).toEqual(["page_enter", "element_approach", "hover_intent", "dwell", "click"]);
  });

  it("does not emit dwell for a short stay under the minimum duration", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      hover(100, "#signup", 200, BUTTON_POS),
      ...jitter({ startTimestamp: 150, stepMs: 20, center: BUTTON_POS, count: 3, radiusPx: 3 }),
      click(220, "#signup", BUTTON_POS),
    ];

    const result = aggregateBehavioralEvents(events);
    expect(result.find(isDwellEvent)).toBeUndefined();
  });
});

describe("hesitation", () => {
  it("emits hesitation when the cursor wavers back and forth near an element for long enough", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      hover(100, "#checkout", 100, BUTTON_POS),
      ...backAndForth({ startTimestamp: 200, stepMs: 150, center: BUTTON_POS, amplitudePx: 30, cycles: 4 }),
      click(1600, "#checkout", BUTTON_POS),
    ];

    const result = aggregateBehavioralEvents(events);
    const hesitation = result.find(isHesitationEvent);

    expect(hesitation).toBeDefined();
    expect(hesitation!.element?.selector).toBe("#checkout");
    expect(hesitation!.evidence?.numberOfDirectionChanges).toBeGreaterThanOrEqual(
      DEFAULT_CURSOR_AGGREGATION_CONFIG.directionReversalThreshold
    );
    expect(hesitation!.durationMs).toBeGreaterThanOrEqual(DEFAULT_CURSOR_AGGREGATION_CONFIG.hesitationDurationMs);
    // Hesitation supersedes dwell for the same run - they describe the same evidence differently.
    expect(result.find(isDwellEvent)).toBeUndefined();
  });
});

describe("movement away", () => {
  it("emits element_leave when the cursor moves away from a hovered element beyond the radius", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      hover(100, "#promo", 200, BUTTON_POS),
      ...cursorPath({ startTimestamp: 300, stepMs: 50, from: BUTTON_POS, to: { x: 900, y: 700 }, steps: 6 }),
      pageView(700), // boundary that forces the leave run to flush
    ];

    const result = aggregateBehavioralEvents(events);
    const leave = result.find(isElementLeaveEvent);

    expect(leave).toBeDefined();
    expect(leave!.element?.selector).toBe("#promo");
    expect(leave!.evidence?.distanceMoved).toBeGreaterThan(0);
  });

  it("marks evidence.targetIsClickable when the left element was later clicked", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      hover(100, "#cta", 200, BUTTON_POS),
      ...cursorPath({ startTimestamp: 300, stepMs: 50, from: BUTTON_POS, to: { x: 900, y: 700 }, steps: 6 }),
      click(700, "#cta", { x: 900, y: 700 }),
    ];

    const result = aggregateBehavioralEvents(events);
    const leave = result.find(isElementLeaveEvent);
    expect(leave?.evidence?.targetIsClickable).toBe(true);
  });
});

describe("repeated attention", () => {
  it("emits repeated_attention when the same element is visited multiple times within the window", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      hover(100, "#pricing-toggle", 200, BUTTON_POS),
      hover(3000, "#pricing-toggle", 200, BUTTON_POS),
      hover(6000, "#pricing-toggle", 200, BUTTON_POS),
    ];

    const result = aggregateBehavioralEvents(events);
    const repeated = result.find(isRepeatedAttentionEvent);

    expect(repeated).toBeDefined();
    expect(repeated!.element?.selector).toBe("#pricing-toggle");
    expect(repeated!.count).toBe(3);
    expect(repeated!.evidence?.windowMs).toBe(DEFAULT_CURSOR_AGGREGATION_CONFIG.repeatedAttentionWindowMs);
  });

  it("does not emit repeated_attention for visits far apart outside the window", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      hover(0, "#pricing-toggle", 200, BUTTON_POS),
      hover(DEFAULT_CURSOR_AGGREGATION_CONFIG.repeatedAttentionWindowMs * 10, "#pricing-toggle", 200, BUTTON_POS),
    ];

    const result = aggregateBehavioralEvents(events);
    expect(result.find(isRepeatedAttentionEvent)).toBeUndefined();
  });

  it("does not emit repeated_attention for a single visit", () => {
    const events: IncomingEvent[] = [pageView(0), hover(100, "#pricing-toggle", 200, BUTTON_POS)];
    const result = aggregateBehavioralEvents(events);
    expect(result.find(isRepeatedAttentionEvent)).toBeUndefined();
  });
});

describe("multiple elements", () => {
  it("attributes leave/approach signals to the correct element when attention moves between two targets", () => {
    const posA = { x: 200, y: 200 };
    const posB = { x: 800, y: 600 };

    const events: IncomingEvent[] = [
      pageView(0),
      hover(100, "#element-a", 350, posA),
      ...cursorPath({ startTimestamp: 300, stepMs: 50, from: posA, to: posB, steps: 8 }),
      hover(750, "#element-b", 350, posB),
    ];

    const result = aggregateBehavioralEvents(events);

    const leaveA = result.find((e) => isElementLeaveEvent(e) && e.element?.selector === "#element-a");
    const approachB = result.find((e) => isElementApproachEvent(e) && e.element?.selector === "#element-b");

    expect(leaveA).toBeDefined();
    expect(approachB).toBeDefined();

    const hoverIntents = result.filter(isHoverIntentEvent);
    expect(hoverIntents.map((e) => e.element?.selector)).toEqual(["#element-a", "#element-b"]);
  });

  it("keeps evidence and targets independent across three distinct elements", () => {
    const positions: Record<string, { x: number; y: number }> = {
      "#one": { x: 100, y: 100 },
      "#two": { x: 500, y: 100 },
      "#three": { x: 900, y: 100 },
    };

    const events: IncomingEvent[] = [
      pageView(0),
      hover(100, "#one", 200, positions["#one"]),
      ...cursorPath({ startTimestamp: 300, stepMs: 50, from: positions["#one"], to: positions["#two"], steps: 6 }),
      hover(600, "#two", 200, positions["#two"]),
      ...cursorPath({ startTimestamp: 800, stepMs: 50, from: positions["#two"], to: positions["#three"], steps: 6 }),
      click(1100, "#three", positions["#three"]),
    ];

    const result = aggregateBehavioralEvents(events);
    const selectorsWithSignals = new Set(result.map((e) => e.element?.selector).filter(Boolean));

    expect(selectorsWithSignals.has("#one")).toBe(true);
    expect(selectorsWithSignals.has("#two")).toBe(true);
    expect(selectorsWithSignals.has("#three")).toBe(true);
    expect(result.find(isClickEvent)?.element?.selector).toBe("#three");
  });
});

describe("missing selectors", () => {
  it("does not throw when a hover event has no element/selector - still an attention signal, just with an unknown target", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 0, y: 0 }, to: { x: 400, y: 400 }, steps: 6 }),
      { type: "hover", timestamp: 500, durationMs: 400 }, // no element at all
    ];

    expect(() => aggregateBehavioralEvents(events)).not.toThrow();
    const result = aggregateBehavioralEvents(events);

    const hoverIntent = result.find(isHoverIntentEvent);
    expect(hoverIntent).toBeDefined();
    expect(hoverIntent!.element).toBeUndefined();
    // No selector means no geometric target to approach toward.
    expect(result.find(isElementApproachEvent)).toBeUndefined();
    expect(result.every(isBehavioralEvent)).toBe(true);
  });

  it("does not throw when a click has no coordinates at all (no geometry evidence anywhere)", () => {
    const events: IncomingEvent[] = [pageView(0), { type: "click", timestamp: 100, element: { selector: "#mystery" } }];

    expect(() => aggregateBehavioralEvents(events)).not.toThrow();
    const result = aggregateBehavioralEvents(events);
    expect(result.find(isClickEvent)?.element?.selector).toBe("#mystery");
    expect(result.find(isElementApproachEvent)).toBeUndefined();
  });

  it("handles a session that mixes selector-bearing and selector-less events without crashing", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      { type: "cursor", timestamp: 50, x: 10, y: 10 },
      { type: "cursor", timestamp: 60 }, // cursor sample missing x/y entirely
      hover(100, "#known", 300, BUTTON_POS),
      { type: "click", timestamp: 200 }, // click with no element at all
    ];

    expect(() => aggregateBehavioralEvents(events)).not.toThrow();
  });
});

describe("empty / no-cursor sessions", () => {
  it("returns an empty array for an empty event list", () => {
    expect(aggregateBehavioralEvents([])).toEqual([]);
  });

  it("handles a session with only a page_view and no other events", () => {
    const result = aggregateBehavioralEvents([pageView(0)]);
    expect(result).toHaveLength(1);
    expect(isPageEnterEvent(result[0])).toBe(true);
  });

  it("handles a session with click/hover/scroll but zero cursor events", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      hover(100, "#cta", 500, BUTTON_POS),
      { type: "scroll", timestamp: 600, scrollPercent: 40 },
      click(700, "#other-cta", { x: 200, y: 900 }),
    ];

    const result = aggregateBehavioralEvents(events);
    expect(result.map((e) => e.kind)).toEqual(["page_enter", "hover_intent", "scroll", "click"]);
    // No geometric signals possible with zero cursor samples.
    expect(result.find(isDwellEvent)).toBeUndefined();
    expect(result.find(isElementApproachEvent)).toBeUndefined();
  });
});

describe("noisy cursor movement", () => {
  it("does not emit any signal from pure small-radius jitter with no real movement or anchor", () => {
    const events: IncomingEvent[] = [pageView(0), ...jitter({ startTimestamp: 100, stepMs: 30, center: { x: 300, y: 300 }, count: 40, radiusPx: 3 })];

    const result = aggregateBehavioralEvents(events);
    // Only the page_enter - jitter alone, with no anchor, produces nothing.
    expect(result).toHaveLength(1);
    expect(isPageEnterEvent(result[0])).toBe(true);
  });

  it("filters jitter around an anchor into dwell rather than noise/hesitation", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      hover(100, "#cta", 350, BUTTON_POS),
      ...jitter({ startTimestamp: 300, stepMs: 80, center: BUTTON_POS, count: 20, radiusPx: 2 }),
      click(2000, "#cta", BUTTON_POS),
    ];

    const result = aggregateBehavioralEvents(events);
    expect(result.find(isDwellEvent)).toBeDefined();
    expect(result.find(isHesitationEvent)).toBeUndefined();
    expect(result.find(isReversalEvent)).toBeUndefined();
  });
});

describe("high-frequency cursor events", () => {
  it("collapses hundreds of raw cursor samples into a small handful of behavioral events", () => {
    const events: IncomingEvent[] = [pageView(0)];

    // ~600 cursor samples: dense jitter near a starting point, a long approach,
    // dense dwell jitter near the button, then a click.
    events.push(...jitter({ startTimestamp: 10, stepMs: 5, center: { x: 50, y: 50 }, count: 200, radiusPx: 2 }));
    events.push(...cursorPath({ startTimestamp: 1100, stepMs: 5, from: { x: 50, y: 50 }, to: { x: 490, y: 295 }, steps: 200 }));
    events.push(hover(2200, "#signup", 350, BUTTON_POS));
    events.push(...jitter({ startTimestamp: 2300, stepMs: 5, center: BUTTON_POS, count: 200, radiusPx: 2 }));
    events.push(click(3400, "#signup", BUTTON_POS));

    const rawCursorCount = events.filter((e) => e.type === "cursor").length;
    expect(rawCursorCount).toBeGreaterThan(500);

    const result = aggregateBehavioralEvents(events);

    // Dramatically smaller than the raw cursor volume, and no raw "cursor"
    // kind ever appears in the output.
    expect(result.length).toBeLessThan(10);
    expect(result.some((e) => (e as { kind: string }).kind === "cursor")).toBe(false);

    const kinds = result.map((e) => e.kind);
    expect(kinds).toContain("page_enter");
    expect(kinds).toContain("element_approach");
    expect(kinds).toContain("hover_intent");
    expect(kinds).toContain("dwell");
    expect(kinds).toContain("click");
  });

  it("stays well under the raw event count for a full realistic session fixture", () => {
    const events: IncomingEvent[] = [pageView(0)];
    let t = 10;

    // Simulate a realistic browsing session: idle jitter, three approach/dwell
    // cycles across different elements, a hesitant pause, and a final click.
    const elements: Array<{ selector: string; pos: { x: number; y: number } }> = [
      { selector: "#nav-features", pos: { x: 150, y: 60 } },
      { selector: "#pricing-card", pos: { x: 600, y: 400 } },
      { selector: "#signup-button", pos: { x: 950, y: 500 } },
    ];

    let cursorPos = { x: 20, y: 20 };
    for (const el of elements) {
      events.push(...jitter({ startTimestamp: t, stepMs: 6, center: cursorPos, count: 60, radiusPx: 3 }));
      t += 60 * 6 + 20;
      events.push(...cursorPath({ startTimestamp: t, stepMs: 6, from: cursorPos, to: el.pos, steps: 120 }));
      t += 120 * 6 + 20;
      events.push(hover(t, el.selector, 220, el.pos));
      t += 20;
      events.push(...jitter({ startTimestamp: t, stepMs: 6, center: el.pos, count: 100, radiusPx: 4 }));
      t += 100 * 6 + 20;
      cursorPos = el.pos;
    }
    events.push(click(t, "#signup-button", elements[2].pos));

    const rawCursorCount = events.filter((e) => e.type === "cursor").length;
    expect(rawCursorCount).toBeGreaterThan(700);

    const result = aggregateBehavioralEvents(events);

    // The whole point of the aggregator: a huge raw volume collapses to a
    // handful of meaningful, explainable signals.
    expect(result.length).toBeLessThan(30);
    expect(result.length).toBeLessThan(rawCursorCount / 20);
    expect(result.every(isBehavioralEvent)).toBe(true);
  });
});

describe("configurability", () => {
  it("respects a custom (very high) minMovementDistancePx by suppressing an approach that would otherwise fire", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 100, y: 100 }, to: { x: 480, y: 290 }, steps: 6 }),
      hover(500, "#signup", 0, BUTTON_POS),
    ];

    const permissive = aggregateBehavioralEvents(events);
    const strict = aggregateBehavioralEvents(events, { minMovementDistancePx: 100_000 });

    expect(permissive.find(isElementApproachEvent)).toBeDefined();
    expect(strict.find(isElementApproachEvent)).toBeUndefined();
  });

  it("respects a custom minHoverIntentDurationMs threshold", () => {
    const events: IncomingEvent[] = [pageView(0), hover(100, "#cta", 100, BUTTON_POS)];

    const lax = aggregateBehavioralEvents(events, { minHoverIntentDurationMs: 50 });
    const strict = aggregateBehavioralEvents(events, { minHoverIntentDurationMs: 1000 });

    expect(lax.find(isHoverIntentEvent)).toBeDefined();
    expect(strict.find(isHoverIntentEvent)).toBeUndefined();
  });
});

describe("raw telemetry is never rewritten or deleted by the aggregator", () => {
  it("returns a new derived array without mutating the input events", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 100, y: 100 }, to: { x: 480, y: 290 }, steps: 6 }),
      hover(500, "#signup", 200, BUTTON_POS),
    ];
    const snapshot = JSON.parse(JSON.stringify(events));

    aggregateBehavioralEvents(events);

    expect(events).toEqual(snapshot);
  });
});

describe("custom (application/business) events pass through the real production pipeline", () => {
  function custom(timestamp: number, name: string, properties?: Record<string, unknown>): IncomingEvent {
    return { type: "custom", timestamp, name, properties };
  }

  it("appears in the output as a custom BehavioralEvent with name/properties intact", () => {
    const events: IncomingEvent[] = [pageView(0), custom(100, "checkout_completed", { plan: "pro", amount: 49 })];
    const result = aggregateBehavioralEvents(events);

    const customs = result.filter(isCustomEvent);
    expect(customs).toHaveLength(1);
    expect(customs[0]).toMatchObject({ name: "checkout_completed", properties: { plan: "pro", amount: 49 } });
  });

  it("does not reset or flush an in-progress hover/cursor anchor run", () => {
    // A custom event fired mid-hover must not truncate the hover's
    // dwell/hesitation read - see cursorAggregator.ts's "custom" case
    // doc comment.
    const events: IncomingEvent[] = [
      pageView(0),
      hover(100, "#signup", 50, BUTTON_POS),
      ...backAndForth({ startTimestamp: 150, stepMs: 40, center: BUTTON_POS, amplitudePx: 30, cycles: 4 }),
      custom(300, "form_started"),
      ...backAndForth({ startTimestamp: 350, stepMs: 40, center: BUTTON_POS, amplitudePx: 30, cycles: 4 }),
      hover(700, "#signup", 250, BUTTON_POS),
    ];

    const withCustom = aggregateBehavioralEvents(events);
    const withoutCustom = aggregateBehavioralEvents(events.filter((e) => e.type !== "custom"));

    // Same derived-signal kinds fire whether or not the custom event is
    // interleaved - its presence must be strictly additive, not
    // disruptive to the anchor state machine.
    const kindsOf = (evts: typeof withCustom) => evts.filter((e) => e.kind !== "custom").map((e) => e.kind);
    expect(kindsOf(withCustom)).toEqual(kindsOf(withoutCustom));
    expect(withCustom.some(isCustomEvent)).toBe(true);
  });

  it("never produces a click/hover-shaped event and carries no element", () => {
    const events: IncomingEvent[] = [pageView(0), custom(100, "signed_up")];
    const result = aggregateBehavioralEvents(events);
    const signedUp = result.find(isCustomEvent);
    expect(signedUp).toBeDefined();
    expect(signedUp).not.toHaveProperty("element");
  });

  it("preserves multiple distinct custom events in timestamp order alongside DOM events", () => {
    const events: IncomingEvent[] = [
      pageView(0),
      click(100, "#pricing-cta", BUTTON_POS),
      custom(200, "checkout_started"),
      custom(300, "payment_submitted"),
      custom(400, "checkout_completed", { plan: "pro" }),
    ];
    const result = aggregateBehavioralEvents(events);
    const kinds = result.map((e) => e.kind);
    expect(kinds).toEqual(["page_enter", "click", "custom", "custom", "custom"]);
    expect(result.filter(isCustomEvent).map((e) => e.name)).toEqual([
      "checkout_started",
      "payment_submitted",
      "checkout_completed",
    ]);
  });
});
