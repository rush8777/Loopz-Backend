import { describe, it, expect } from "vitest";
import { compileBehavioralEvents, type CompilableRawEvent } from "../src/lib/behavior/behaviorCompiler.js";
import { segmentIntoEpisodes } from "../src/lib/behavior/episodeSegmentation.js";
import { behavioralSequenceForEpisode, behavioralSequenceForEvents, tokenForBehavioralEvent } from "../src/lib/behavior/behavioralSequence.js";
import { createClickEvent, createCustomEvent, createDwellEvent, createPageEnterEvent, createScrollEvent } from "../src/lib/behavior/behavioralEvent.js";
import { elementIdentityFromSelector } from "../src/lib/behavior/elementIdentity.js";

const BUTTON_POS = { x: 500, y: 300 };

function cursorPath(opts: { startTimestamp: number; stepMs: number; from: { x: number; y: number }; to: { x: number; y: number }; steps: number }): CompilableRawEvent[] {
  const { startTimestamp, stepMs, from, to, steps } = opts;
  const events: CompilableRawEvent[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    events.push({ type: "cursor", timestamp: startTimestamp + i * stepMs, x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t) });
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

function pageView(timestamp: number): CompilableRawEvent {
  return { type: "page_view", timestamp };
}
function hover(timestamp: number, selector: string, durationMs: number, pos: { x: number; y: number }): CompilableRawEvent {
  return { type: "hover", timestamp, element: { selector }, durationMs, x: pos.x, y: pos.y };
}
function click(timestamp: number, selector: string, pos: { x: number; y: number }): CompilableRawEvent {
  return { type: "click", timestamp, element: { selector }, x: pos.x, y: pos.y };
}

describe("token format", () => {
  it("produces '<kind>:<selector>' for an event with an identifiable element", () => {
    const token = tokenForBehavioralEvent(createClickEvent(0, elementIdentityFromSelector("#cta")));
    expect(token).toBe("click:#cta");
  });

  it("produces a bare '<kind>' token for an event with no element", () => {
    expect(tokenForBehavioralEvent(createPageEnterEvent(0))).toBe("page_enter");
    expect(tokenForBehavioralEvent(createScrollEvent(0, 50))).toBe("scroll");
  });

  it("produces a bare '<kind>' token when the element identity is present but unresolved", () => {
    const token = tokenForBehavioralEvent(createClickEvent(0, undefined));
    expect(token).toBe("click");
  });

  it("includes duration-bearing derived signals with their target", () => {
    const token = tokenForBehavioralEvent(createDwellEvent(0, elementIdentityFromSelector("#signup"), 900));
    expect(token).toBe("dwell:#signup");
  });

  it("produces 'custom:<name>' for a custom event, never a bare 'custom' token", () => {
    expect(tokenForBehavioralEvent(createCustomEvent(0, "checkout_completed"))).toBe("custom:checkout_completed");
  });

  it("distinguishes different custom event names, unlike DOM-event tokens which share a kind", () => {
    const started = tokenForBehavioralEvent(createCustomEvent(0, "checkout_started"));
    const completed = tokenForBehavioralEvent(createCustomEvent(100, "checkout_completed"));
    expect(started).not.toBe(completed);
  });
});

describe("episode sequence derivation", () => {
  it("converts an episode's compiled events into an ordered token list", () => {
    const events: CompilableRawEvent[] = [
      pageView(0),
      ...cursorPath({ startTimestamp: 100, stepMs: 50, from: { x: 50, y: 50 }, to: { x: 480, y: 290 }, steps: 6 }),
      hover(500, "#signup", 400, BUTTON_POS),
      ...jitter({ startTimestamp: 900, stepMs: 100, center: BUTTON_POS, count: 6, radiusPx: 2 }),
      click(1600, "#signup", BUTTON_POS),
    ];

    const compiled = compileBehavioralEvents(events);
    const episodes = segmentIntoEpisodes("sess_1", compiled);
    expect(episodes).toHaveLength(1);

    const tokens = behavioralSequenceForEpisode(episodes[0]);
    expect(tokens[0]).toBe("page_enter");
    expect(tokens).toContain("element_approach:#signup");
    expect(tokens).toContain("hover_intent:#signup");
    expect(tokens).toContain("dwell:#signup");
    expect(tokens).toContain("click:#signup");
    // Order matters: approach precedes intent, which precedes dwell, which precedes the click.
    const order = ["element_approach:#signup", "hover_intent:#signup", "dwell:#signup", "click:#signup"].map((t) => tokens.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // No raw telemetry token ever appears.
    expect(tokens.every((t) => !t.startsWith("cursor"))).toBe(true);
  });

  it("behavioralSequenceForEvents matches behavioralSequenceForEpisode for the same events", () => {
    const events: CompilableRawEvent[] = [pageView(0), click(500, "#a", BUTTON_POS)];
    const compiled = compileBehavioralEvents(events);
    const episodes = segmentIntoEpisodes("sess_1", compiled);

    expect(behavioralSequenceForEvents(compiled)).toEqual(behavioralSequenceForEpisode(episodes[0]));
  });
});

describe("hundreds of cursor events collapse to a handful of tokens", () => {
  it("a realistic high-frequency session produces a small, meaningful sequence - never raw cursor tokens", () => {
    const events: CompilableRawEvent[] = [pageView(0)];

    // ~500 raw cursor samples: idle jitter, an approach, dwell jitter near
    // the target, then a click - exactly the shape described in the task.
    events.push(...jitter({ startTimestamp: 10, stepMs: 5, center: { x: 50, y: 50 }, count: 150, radiusPx: 2 }));
    events.push(...cursorPath({ startTimestamp: 800, stepMs: 5, from: { x: 50, y: 50 }, to: { x: 490, y: 295 }, steps: 150 }));
    events.push(hover(1600, "#signup", 350, BUTTON_POS));
    events.push(...jitter({ startTimestamp: 1700, stepMs: 5, center: BUTTON_POS, count: 200, radiusPx: 2 }));
    events.push(click(2800, "#signup", BUTTON_POS));

    const rawCursorCount = events.filter((e) => e.type === "cursor").length;
    expect(rawCursorCount).toBeGreaterThanOrEqual(500);

    const compiled = compileBehavioralEvents(events);
    const episodes = segmentIntoEpisodes("sess_highfreq", compiled);
    expect(episodes).toHaveLength(1);

    const tokens = behavioralSequenceForEpisode(episodes[0]);

    // The whole point: hundreds of raw samples collapse to a small,
    // meaningful sequence, not hundreds of "cursor" tokens.
    expect(tokens.length).toBeLessThan(10);
    expect(tokens.length).toBeLessThan(rawCursorCount / 50);
    expect(tokens.every((t) => t !== "cursor")).toBe(true);

    expect(tokens).toEqual(
      expect.arrayContaining(["page_enter", "element_approach:#signup", "hover_intent:#signup", "dwell:#signup", "click:#signup"])
    );
  });
});

describe("custom events mixed into an episode sequence", () => {
  function custom(timestamp: number, name: string, properties?: Record<string, unknown>): CompilableRawEvent {
    return { type: "custom", timestamp, name, properties };
  }

  it("represents a mixed observed-behavior + application-event flow as one ordered sequence, per-event provenance intact", () => {
    // The task's own example: click pricing CTA -> checkout_started ->
    // (hover on payment field) -> payment_submitted -> checkout_completed.
    const events: CompilableRawEvent[] = [
      pageView(0),
      click(100, "#pricing-cta", BUTTON_POS),
      custom(200, "checkout_started"),
      hover(300, "#payment-field", 400, { x: 300, y: 400 }),
      custom(800, "payment_submitted"),
      custom(900, "checkout_completed", { plan: "pro", amount: 49 }),
    ];

    const compiled = compileBehavioralEvents(events);
    const episodes = segmentIntoEpisodes("sess_funnel", compiled);
    expect(episodes).toHaveLength(1);

    const tokens = behavioralSequenceForEpisode(episodes[0]);
    expect(tokens).toEqual([
      "page_enter",
      "click:#pricing-cta",
      "custom:checkout_started",
      "hover_intent:#payment-field",
      "custom:payment_submitted",
      "custom:checkout_completed",
    ]);
  });

  it("custom events never overwhelm or replace low-level behavioral tokens - both provenances coexist", () => {
    const events: CompilableRawEvent[] = [pageView(0), click(100, "#a", BUTTON_POS), custom(200, "signed_up")];
    const compiled = compileBehavioralEvents(events);
    const episodes = segmentIntoEpisodes("sess_1", compiled);
    const tokens = behavioralSequenceForEpisode(episodes[0]);

    expect(tokens).toContain("click:#a");
    expect(tokens).toContain("custom:signed_up");
    expect(compiled.find((e) => e.kind === "click")?.category).toBe("discrete_action");
    expect(compiled.find((e) => e.kind === "custom")?.category).toBe("application_event");
  });
});
