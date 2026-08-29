import { describe, it, expect } from "vitest";
import {
  BEHAVIORAL_EVENT_CATEGORY,
  createPageEnterEvent,
  createClickEvent,
  createScrollEvent,
  createInputEvent,
  createNavigationEvent,
  createHoverIntentEvent,
  createDwellEvent,
  createElementApproachEvent,
  createElementLeaveEvent,
  createHesitationEvent,
  createRepeatedActionEvent,
  createPossibleFailedActionEvent,
  createCustomEvent,
  isBehavioralEvent,
  isDiscreteAction,
  isIntentSignal,
  isDerivedSignal,
  isApplicationEvent,
  isClickEvent,
  isHoverIntentEvent,
  isHesitationEvent,
  isCustomEvent,
  type BehavioralEventKind,
} from "../src/lib/behavior/behavioralEvent.js";
import {
  elementIdentityFromSelector,
  hasStableIdentity,
  describeElementIdentity,
  UNKNOWN_ELEMENT_IDENTITY,
} from "../src/lib/behavior/elementIdentity.js";
import { isRawTelemetryEvent } from "../src/lib/behavior/rawTelemetry.js";
import { compileToBehavioralEvent, compileBatch } from "../src/lib/behavior/compileEvent.js";
import type { IncomingEvent } from "../src/lib/patterns/event.js";

describe("behavioral event types are valid", () => {
  it("every declared kind maps to exactly one of the four BehavioralEvent categories", () => {
    const kinds = Object.keys(BEHAVIORAL_EVENT_CATEGORY) as BehavioralEventKind[];
    expect(kinds.sort()).toEqual(
      [
        "page_enter",
        "click",
        "scroll",
        "input",
        "navigation",
        "hover_intent",
        "dwell",
        "element_approach",
        "element_leave",
        "hesitation",
        "reversal",
        "repeated_action",
        "repeated_attention",
        "possible_failed_action",
        "custom",
      ].sort()
    );
    for (const kind of kinds) {
      expect(["discrete_action", "intent_signal", "derived_signal", "application_event"]).toContain(
        BEHAVIORAL_EVENT_CATEGORY[kind]
      );
    }
  });

  it("discrete action constructors produce events tagged discrete_action", () => {
    const events = [
      createPageEnterEvent(0),
      createClickEvent(100, elementIdentityFromSelector("#cta")),
      createScrollEvent(200, 50),
      createInputEvent(300, elementIdentityFromSelector("#email")),
      createNavigationEvent(400, { fromPath: "/a", toPath: "/b" }),
    ];
    for (const e of events) {
      expect(e.category).toBe("discrete_action");
      expect(isDiscreteAction(e)).toBe(true);
      expect(isIntentSignal(e)).toBe(false);
      expect(isDerivedSignal(e)).toBe(false);
      expect(isBehavioralEvent(e)).toBe(true);
    }
  });

  it("intent/attention signal constructors produce events tagged intent_signal", () => {
    const events = [
      createHoverIntentEvent(0, elementIdentityFromSelector("#hero"), 1200),
      createDwellEvent(100, elementIdentityFromSelector("#hero"), 3000),
    ];
    for (const e of events) {
      expect(e.category).toBe("intent_signal");
      expect(isIntentSignal(e)).toBe(true);
      expect(isDiscreteAction(e)).toBe(false);
      expect(isDerivedSignal(e)).toBe(false);
    }
  });

  it("derived behavioral signal constructors produce events tagged derived_signal", () => {
    const events = [
      createElementApproachEvent(0, elementIdentityFromSelector("#cta")),
      createElementLeaveEvent(100, elementIdentityFromSelector("#cta")),
      createHesitationEvent(200, { element: elementIdentityFromSelector("#pricing"), durationMs: 800 }),
      createRepeatedActionEvent(300, "click", 4, elementIdentityFromSelector("#submit")),
      createPossibleFailedActionEvent(400, { element: elementIdentityFromSelector("#submit"), reason: "rapid_reclick_no_navigation" }),
    ];
    for (const e of events) {
      expect(e.category).toBe("derived_signal");
      expect(isDerivedSignal(e)).toBe(true);
      expect(isDiscreteAction(e)).toBe(false);
      expect(isIntentSignal(e)).toBe(false);
    }
  });

  it("kind-specific type guards narrow correctly and reject other kinds", () => {
    const click = createClickEvent(0, elementIdentityFromSelector("#cta"));
    const hover = createHoverIntentEvent(0, elementIdentityFromSelector("#hero"), 1000);
    const hesitation = createHesitationEvent(0);

    expect(isClickEvent(click)).toBe(true);
    expect(isClickEvent(hover)).toBe(false);
    expect(isHoverIntentEvent(hover)).toBe(true);
    expect(isHoverIntentEvent(click)).toBe(false);
    expect(isHesitationEvent(hesitation)).toBe(true);
    expect(isHesitationEvent(click)).toBe(false);
  });

  it("isBehavioralEvent rejects malformed or foreign values", () => {
    expect(isBehavioralEvent(null)).toBe(false);
    expect(isBehavioralEvent(undefined)).toBe(false);
    expect(isBehavioralEvent("click")).toBe(false);
    expect(isBehavioralEvent({ kind: "click" })).toBe(false); // missing timestamp/category
    expect(isBehavioralEvent({ kind: "not_a_real_kind", timestamp: 0, category: "discrete_action" })).toBe(false);
    expect(isBehavioralEvent({ kind: "click", timestamp: 0, category: "intent_signal" })).toBe(false); // category/kind mismatch
  });
});

describe("custom (application/business) events", () => {
  it("createCustomEvent produces an event tagged application_event, never one of the observed-behavior categories", () => {
    const event = createCustomEvent(1000, "checkout_completed", { plan: "pro", amount: 49 });
    expect(event.category).toBe("application_event");
    expect(isApplicationEvent(event)).toBe(true);
    expect(isDiscreteAction(event)).toBe(false);
    expect(isIntentSignal(event)).toBe(false);
    expect(isDerivedSignal(event)).toBe(false);
    expect(isBehavioralEvent(event)).toBe(true);
  });

  it("preserves name and properties verbatim, and has no element field", () => {
    const properties = { plan: "pro", amount: 49, currency: "USD" };
    const event = createCustomEvent(1000, "checkout_completed", properties);
    expect(event.name).toBe("checkout_completed");
    expect(event.properties).toEqual(properties);
    expect(event).not.toHaveProperty("element");
  });

  it("supports no properties", () => {
    const event = createCustomEvent(1000, "video_played");
    expect(event.name).toBe("video_played");
    expect(event.properties).toBeUndefined();
  });

  it("isCustomEvent narrows correctly and rejects other kinds", () => {
    const custom = createCustomEvent(0, "signed_up");
    const click = createClickEvent(0, elementIdentityFromSelector("#cta"));
    expect(isCustomEvent(custom)).toBe(true);
    expect(isCustomEvent(click)).toBe(false);
  });

  it("compileToBehavioralEvent maps a raw custom IncomingEvent 1:1, name and properties intact", () => {
    const raw: IncomingEvent = {
      type: "custom",
      timestamp: 5000,
      name: "checkout_completed",
      properties: { plan: "pro", amount: 49 },
    };
    const compiled = compileToBehavioralEvent(raw);
    expect(compiled).not.toBeNull();
    expect(compiled).toMatchObject({
      kind: "custom",
      category: "application_event",
      timestamp: 5000,
      name: "checkout_completed",
      properties: { plan: "pro", amount: 49 },
    });
  });

  it("compileToBehavioralEvent never produces a click/hover-shaped event for a custom event", () => {
    const raw: IncomingEvent = { type: "custom", timestamp: 0, name: "signed_up" };
    const compiled = compileToBehavioralEvent(raw);
    expect(compiled?.kind).not.toBe("click");
    expect(compiled?.kind).not.toBe("hover_intent");
    expect(compiled).not.toHaveProperty("element");
  });

  it("compileBatch preserves custom events alongside DOM-interaction events, in order", () => {
    const events: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      { type: "click", timestamp: 100, element: { selector: "#pricing-cta" } },
      { type: "custom", timestamp: 200, name: "checkout_started" },
      { type: "hover", timestamp: 300, element: { selector: "#payment-field" }, durationMs: 500 },
      { type: "custom", timestamp: 400, name: "payment_submitted" },
      { type: "custom", timestamp: 500, name: "checkout_completed", properties: { plan: "pro" } },
    ];
    const compiled = compileBatch(events);
    expect(compiled.map((e) => e.kind)).toEqual(["page_enter", "click", "custom", "hover_intent", "custom", "custom"]);
    const customs = compiled.filter(isCustomEvent);
    expect(customs.map((e) => e.name)).toEqual(["checkout_started", "payment_submitted", "checkout_completed"]);
  });
});

describe("element identities can be created from current raw events", () => {
  it("builds a selector-sourced identity from a raw event's element.selector", () => {
    const raw: IncomingEvent = { type: "click", timestamp: 0, element: { selector: "#cta" } };
    const identity = elementIdentityFromSelector(raw.element?.selector);

    expect(identity).toEqual({ selector: "#cta", source: "selector" });
    expect(hasStableIdentity(identity)).toBe(true);
    expect(describeElementIdentity(identity)).toBe("#cta");
  });

  it("only selector is populated - role/label/region/fingerprint stay absent since the SDK doesn't send them today", () => {
    const identity = elementIdentityFromSelector("#hero")!;
    expect(identity.role).toBeUndefined();
    expect(identity.label).toBeUndefined();
    expect(identity.region).toBeUndefined();
    expect(identity.fingerprint).toBeUndefined();
  });
});

describe("raw telemetry and behavioral events are conceptually separated", () => {
  it("classifies cursor as raw telemetry and other raw types as not", () => {
    expect(isRawTelemetryEvent({ type: "cursor" })).toBe(true);
    expect(isRawTelemetryEvent({ type: "click" })).toBe(false);
    expect(isRawTelemetryEvent({ type: "hover" })).toBe(false);
    expect(isRawTelemetryEvent({ type: "scroll" })).toBe(false);
    expect(isRawTelemetryEvent({ type: "page_view" })).toBe(false);
  });

  it("no BehavioralEventKind represents raw cursor telemetry directly", () => {
    const kinds = Object.keys(BEHAVIORAL_EVENT_CATEGORY);
    expect(kinds).not.toContain("cursor");
  });

  it("compileToBehavioralEvent never produces a behavioral event for a cursor sample", () => {
    const cursorEvent: IncomingEvent = { type: "cursor", timestamp: 1000, x: 10, y: 20 };
    expect(compileToBehavioralEvent(cursorEvent)).toBeNull();
  });

  it("compiles the direct 1:1 raw types into their behavioral counterparts", () => {
    const events: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 100, element: { selector: "#hero" }, durationMs: 5000 },
      { type: "scroll", timestamp: 200, scrollPercent: 50 },
      { type: "click", timestamp: 300, element: { selector: "#cta" } },
    ];

    const behavioral = compileBatch(events);
    expect(behavioral.map((e) => e.kind)).toEqual(["page_enter", "hover_intent", "scroll", "click"]);
    expect(behavioral.every(isBehavioralEvent)).toBe(true);
  });

  it("a session with thousands of cursor pings and a few real actions compiles to only the real actions", () => {
    const cursorPings: IncomingEvent[] = Array.from({ length: 5000 }, (_, i) => ({
      type: "cursor",
      timestamp: i,
      x: i % 100,
      y: i % 50,
    }));
    const events: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      ...cursorPings,
      { type: "click", timestamp: 6000, element: { selector: "#cta" } },
    ];

    const behavioral = compileBatch(events);

    // Exactly the two real actions - none of the 5000 cursor samples became a token.
    expect(behavioral).toHaveLength(2);
    expect(behavioral.map((e) => e.kind)).toEqual(["page_enter", "click"]);
  });
});

describe("missing selector information is handled safely", () => {
  it("elementIdentityFromSelector returns undefined (not a throw) for null/undefined/empty selectors", () => {
    expect(elementIdentityFromSelector(undefined)).toBeUndefined();
    expect(elementIdentityFromSelector(null)).toBeUndefined();
    expect(elementIdentityFromSelector("")).toBeUndefined();
  });

  it("hasStableIdentity and describeElementIdentity handle a missing identity without throwing", () => {
    expect(hasStableIdentity(undefined)).toBe(false);
    expect(describeElementIdentity(undefined)).toBe("(no element)");
    expect(describeElementIdentity(UNKNOWN_ELEMENT_IDENTITY)).toBe("(unknown element)");
  });

  it("compiling a click with no element/selector still produces a valid ClickEvent with element undefined", () => {
    const event: IncomingEvent = { type: "click", timestamp: 100 };
    const behavioral = compileToBehavioralEvent(event);

    expect(behavioral).not.toBeNull();
    expect(behavioral!.kind).toBe("click");
    expect(isClickEvent(behavioral!) && behavioral!.element).toBeUndefined();
    expect(isBehavioralEvent(behavioral)).toBe(true);
  });

  it("createClickEvent and createHoverIntentEvent accept an undefined element without throwing", () => {
    const click = createClickEvent(0, undefined);
    expect(click.element).toBeUndefined();
    expect(click.category).toBe("discrete_action");

    const hover = createHoverIntentEvent(0, undefined, 1500);
    expect(hover.element).toBeUndefined();
    expect(hover.durationMs).toBe(1500);
  });
});
