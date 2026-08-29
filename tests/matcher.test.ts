import { describe, it, expect } from "vitest";
import { advanceMatch, createInitialMatchState } from "../src/lib/patterns/matcher.js";
import type { PatternDefinition } from "../src/lib/patterns/types.js";
import type { IncomingEvent } from "../src/lib/patterns/event.js";

const basePattern: PatternDefinition = {
  id: "pat_1",
  siteId: "site_1",
  name: "Hero to CTA",
  matchWindowMs: 5 * 60 * 1000,
  origin: "AUTHORED",
  status: "ACTIVE",
  feedback: { message: "Looks like you're comparing plans - need help?", targetSelector: "#cta" },
  steps: [
    { id: "s1", verb: "enter", required: true },
    { id: "s2", verb: "hover", target: { selector: "#hero" }, minDurationMs: 60_000, required: true, maxGapMs: 120_000 },
    { id: "s3", verb: "scroll_past", minScrollPercent: 50, required: true, maxGapMs: 60_000 },
    { id: "s4", verb: "click", target: { selector: "#cta" }, required: true, maxGapMs: 120_000 },
  ],
};

describe("advanceMatch", () => {
  it("matches the full hero -> hover 60s -> scroll -> CTA click sequence", () => {
    const events: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 5_000, element: { selector: "#hero" }, durationMs: 61_000 },
      { type: "scroll", timestamp: 70_000, scrollPercent: 55 },
      { type: "click", timestamp: 90_000, element: { selector: "#cta" } },
    ];

    let state = createInitialMatchState(basePattern.id, "sess_1");
    state = advanceMatch(basePattern, state, events);

    expect(state.status).toBe("matched");
    expect(state.matchedSteps.map((m) => m.stepId)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("does not match if hover duration is under the threshold", () => {
    const events: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 5_000, element: { selector: "#hero" }, durationMs: 30_000 }, // too short
      { type: "scroll", timestamp: 70_000, scrollPercent: 55 },
      { type: "click", timestamp: 90_000, element: { selector: "#cta" } },
    ];

    let state = createInitialMatchState(basePattern.id, "sess_2");
    state = advanceMatch(basePattern, state, events);

    // Stuck waiting on s2 forever - hover never satisfied it, no maxGapMs breach yet since gap is measured from lastMatchedAt/startedAt, not from step availability.
    expect(state.status).toBe("in_progress");
    expect(state.cursor).toBe(1);
  });

  it("expires if the gap between steps exceeds maxGapMs", () => {
    const events: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 5_000, element: { selector: "#hero" }, durationMs: 61_000 },
      // scroll arrives way past s3's 60s maxGapMs from the hover match
      { type: "scroll", timestamp: 5_000 + 61_000 + 5 * 60_000, scrollPercent: 55 },
    ];

    let state = createInitialMatchState(basePattern.id, "sess_3");
    state = advanceMatch(basePattern, state, events);

    expect(state.status).toBe("expired");
  });

  it("expires if the overall matchWindowMs is exceeded even with valid steps", () => {
    const shortWindowPattern: PatternDefinition = { ...basePattern, matchWindowMs: 10_000 };
    const events: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 1_000, element: { selector: "#hero" }, durationMs: 61_000 },
      { type: "scroll", timestamp: 20_000, scrollPercent: 55 }, // past the 10s overall window
      { type: "click", timestamp: 21_000, element: { selector: "#cta" } },
    ];

    let state = createInitialMatchState(shortWindowPattern.id, "sess_4");
    state = advanceMatch(shortWindowPattern, state, events);

    expect(state.status).toBe("expired");
  });

  it("ignores unrelated events interspersed between real steps", () => {
    const events: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      { type: "click", timestamp: 1_000, element: { selector: "#nav-about" } }, // noise
      { type: "hover", timestamp: 5_000, element: { selector: "#hero" }, durationMs: 61_000 },
      { type: "hover", timestamp: 40_000, element: { selector: "#footer" }, durationMs: 3_000 }, // noise
      { type: "scroll", timestamp: 70_000, scrollPercent: 55 },
      { type: "click", timestamp: 90_000, element: { selector: "#cta" } },
    ];

    let state = createInitialMatchState(basePattern.id, "sess_5");
    state = advanceMatch(basePattern, state, events);

    expect(state.status).toBe("matched");
  });

  it("skips an optional step whose gap window has passed, without expiring the whole match", () => {
    const withOptionalStep: PatternDefinition = {
      ...basePattern,
      steps: [
        basePattern.steps[0],
        { id: "s_optional", verb: "hover", target: { selector: "#testimonials" }, required: false, maxGapMs: 5_000 },
        basePattern.steps[1],
        basePattern.steps[2],
        basePattern.steps[3],
      ],
    };

    const events: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      // no hover on #testimonials within 5s - optional step should be skipped, not block the match
      { type: "hover", timestamp: 20_000, element: { selector: "#hero" }, durationMs: 61_000 },
      { type: "scroll", timestamp: 90_000, scrollPercent: 55 },
      { type: "click", timestamp: 110_000, element: { selector: "#cta" } },
    ];

    let state = createInitialMatchState(withOptionalStep.id, "sess_6");
    state = advanceMatch(withOptionalStep, state, events);

    expect(state.status).toBe("matched");
    expect(state.matchedSteps.map((m) => m.stepId)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("processes incremental batches across multiple calls, matching the same as one big batch", () => {
    const batch1: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 5_000, element: { selector: "#hero" }, durationMs: 61_000 },
    ];
    const batch2: IncomingEvent[] = [{ type: "scroll", timestamp: 70_000, scrollPercent: 55 }];
    const batch3: IncomingEvent[] = [{ type: "click", timestamp: 90_000, element: { selector: "#cta" } }];

    let state = createInitialMatchState(basePattern.id, "sess_7");
    state = advanceMatch(basePattern, state, batch1);
    expect(state.status).toBe("in_progress");
    state = advanceMatch(basePattern, state, batch2);
    expect(state.status).toBe("in_progress");
    state = advanceMatch(basePattern, state, batch3);

    expect(state.status).toBe("matched");
  });

  it("is a no-op once a match has already terminated (matched or expired)", () => {
    let state = createInitialMatchState(basePattern.id, "sess_8");
    state = advanceMatch(basePattern, state, [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 5_000, element: { selector: "#hero" }, durationMs: 61_000 },
      { type: "scroll", timestamp: 70_000, scrollPercent: 55 },
      { type: "click", timestamp: 90_000, element: { selector: "#cta" } },
    ]);
    expect(state.status).toBe("matched");

    const afterMore = advanceMatch(basePattern, state, [
      { type: "click", timestamp: 200_000, element: { selector: "#cta" } },
    ]);
    expect(afterMore).toEqual(state);
  });
});

describe("advanceMatch - custom (application/business) event steps", () => {
  const funnelPattern: PatternDefinition = {
    id: "pat_funnel",
    siteId: "site_1",
    name: "Checkout funnel",
    matchWindowMs: 10 * 60 * 1000,
    origin: "AUTHORED",
    status: "ACTIVE",
    feedback: { message: "Nice work completing checkout!", targetSelector: "#cta" },
    steps: [
      { id: "f1", verb: "click", target: { selector: "#pricing-cta" }, required: true, maxGapMs: 60_000 },
      { id: "f2", verb: "custom", eventName: "checkout_started", required: true, maxGapMs: 60_000 },
      { id: "f3", verb: "custom", eventName: "checkout_completed", required: true, maxGapMs: 120_000 },
    ],
  };

  it("matches a sequence of DOM interactions and application events together", () => {
    const events: IncomingEvent[] = [
      { type: "click", timestamp: 0, element: { selector: "#pricing-cta" } },
      { type: "custom", timestamp: 5_000, name: "checkout_started" },
      { type: "custom", timestamp: 30_000, name: "checkout_completed", properties: { plan: "pro", amount: 49 } },
    ];

    let state = createInitialMatchState(funnelPattern.id, "sess_funnel_1");
    state = advanceMatch(funnelPattern, state, events);

    expect(state.status).toBe("matched");
    expect(state.matchedSteps.map((m) => m.stepId)).toEqual(["f1", "f2", "f3"]);
  });

  it("does not match a differently-named custom event", () => {
    const events: IncomingEvent[] = [
      { type: "click", timestamp: 0, element: { selector: "#pricing-cta" } },
      { type: "custom", timestamp: 5_000, name: "newsletter_signup" }, // wrong name
    ];

    let state = createInitialMatchState(funnelPattern.id, "sess_funnel_2");
    state = advanceMatch(funnelPattern, state, events);

    expect(state.status).toBe("in_progress");
    expect(state.cursor).toBe(1); // stuck waiting for f2, never satisfied by a wrongly-named custom event
  });

  it("never lets a click/hover event satisfy a custom step, or vice versa", () => {
    const events: IncomingEvent[] = [
      { type: "click", timestamp: 0, element: { selector: "#pricing-cta" } },
      // A click on some element named the same as the event, and a
      // custom event, arrive in the wrong order/shape - only the
      // correctly-typed, correctly-named custom event may satisfy f2.
      { type: "click", timestamp: 1_000, element: { selector: "checkout_started" } },
      { type: "custom", timestamp: 5_000, name: "checkout_started" },
      { type: "custom", timestamp: 10_000, name: "checkout_completed" },
    ];

    let state = createInitialMatchState(funnelPattern.id, "sess_funnel_3");
    state = advanceMatch(funnelPattern, state, events);

    expect(state.status).toBe("matched");
    expect(state.matchedSteps.map((m) => m.stepId)).toEqual(["f1", "f2", "f3"]);
  });

  it("a custom step with no eventName matches any custom event (name-agnostic)", () => {
    const anyCustomPattern: PatternDefinition = {
      ...funnelPattern,
      steps: [{ id: "any1", verb: "custom", required: true }],
    };
    const events: IncomingEvent[] = [{ type: "custom", timestamp: 0, name: "literally_anything" }];

    let state = createInitialMatchState(anyCustomPattern.id, "sess_funnel_4");
    state = advanceMatch(anyCustomPattern, state, events);

    expect(state.status).toBe("matched");
  });
});
