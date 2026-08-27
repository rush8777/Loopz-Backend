import { describe, it, expect } from "vitest";
import { formatEvidence, formatVerboseAnnotation, formatBehavioralEventVerbose } from "../src/lib/behavior/evidenceFormat.js";
import { createHesitationEvent, createClickEvent, createDwellEvent } from "../src/lib/behavior/behavioralEvent.js";
import { elementIdentityFromSelector } from "../src/lib/behavior/elementIdentity.js";

describe("formatEvidence", () => {
  it("returns null for missing/empty evidence", () => {
    expect(formatEvidence(null)).toBeNull();
    expect(formatEvidence(undefined)).toBeNull();
    expect(formatEvidence({})).toBeNull();
  });

  it("renders only the populated fields", () => {
    const text = formatEvidence({ durationMs: 420, distanceMoved: 38.2, numberOfDirectionChanges: 3, sampleCount: 9 });
    expect(text).toBe("durationMs=420, distanceMoved=38.2px, directionChanges=3, sampleCount=9");
  });

  it("includes targetIsClickable when explicitly false, not just when true", () => {
    const text = formatEvidence({ targetIsClickable: false });
    expect(text).toBe("targetIsClickable=false");
  });
});

describe("formatVerboseAnnotation", () => {
  it("returns null when there is nothing to show", () => {
    expect(formatVerboseAnnotation({})).toBeNull();
  });

  it("combines durationMs, count, and evidence into one line", () => {
    const text = formatVerboseAnnotation({ durationMs: 100, count: 3, evidence: { sampleCount: 5 } });
    expect(text).toBe("durationMs=100, count=3, sampleCount=5");
  });

  it("does not print durationMs twice when it appears both top-level and inside evidence (e.g. hesitation)", () => {
    const text = formatVerboseAnnotation({ durationMs: 510, evidence: { durationMs: 510, distanceMoved: 18, sampleCount: 4 } });
    expect(text).toBe("durationMs=510, distanceMoved=18px, sampleCount=4");
  });

  it("still shows evidence.durationMs if it genuinely differs from the top-level one", () => {
    const text = formatVerboseAnnotation({ durationMs: 500, evidence: { durationMs: 200 } });
    expect(text).toBe("durationMs=500, durationMs=200");
  });
});

describe("formatBehavioralEventVerbose", () => {
  it("returns just the token for an event with no evidence/duration/count", () => {
    const click = createClickEvent(0, elementIdentityFromSelector("#cta"));
    expect(formatBehavioralEventVerbose(click, "click:#cta")).toBe("click:#cta");
  });

  it("adds an indented evidence line for a derived signal", () => {
    const hesitation = createHesitationEvent(0, {
      element: elementIdentityFromSelector("#save"),
      durationMs: 420,
      evidence: { durationMs: 420, distanceMoved: 38.2, numberOfDirectionChanges: 3, sampleCount: 9 },
    });
    const rendered = formatBehavioralEventVerbose(hesitation, "hesitation:#save");
    expect(rendered).toBe("hesitation:#save\n    (durationMs=420, distanceMoved=38.2px, directionChanges=3, sampleCount=9)");
  });

  it("shows durationMs even without a separate evidence bag (e.g. dwell)", () => {
    const dwell = createDwellEvent(0, elementIdentityFromSelector("#cta"), 900);
    const rendered = formatBehavioralEventVerbose(dwell, "dwell:#cta");
    expect(rendered).toBe("dwell:#cta\n    (durationMs=900)");
  });
});
