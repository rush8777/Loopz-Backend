import { describe, it, expect } from "vitest";
import { segmentIntoEpisodes, DEFAULT_EPISODE_SEGMENTATION_CONFIG } from "../src/lib/behavior/episodeSegmentation.js";
import { createPageEnterEvent, createClickEvent, createScrollEvent, type BehavioralEvent } from "../src/lib/behavior/behavioralEvent.js";
import { elementIdentityFromSelector } from "../src/lib/behavior/elementIdentity.js";

const SESSION_ID = "sess_test";

describe("one continuous session", () => {
  it("stays a single episode with no page changes and no large idle gap", () => {
    const events: BehavioralEvent[] = [
      createPageEnterEvent(0),
      createClickEvent(1000, elementIdentityFromSelector("#a")),
      createScrollEvent(2000, 40),
      createClickEvent(3000, elementIdentityFromSelector("#b")),
    ];

    const episodes = segmentIntoEpisodes(SESSION_ID, events);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].events).toHaveLength(4);
    expect(episodes[0].startedAt).toBe(0);
    expect(episodes[0].endedAt).toBe(3000);
  });
});

describe("page boundaries", () => {
  it("a page_view creates a new episode boundary", () => {
    const events: BehavioralEvent[] = [
      createPageEnterEvent(0),
      createClickEvent(1000, elementIdentityFromSelector("#a")),
      createPageEnterEvent(2000),
      createClickEvent(2500, elementIdentityFromSelector("#b")),
    ];

    const episodes = segmentIntoEpisodes(SESSION_ID, events);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].endedAt).toBe(1000);
    expect(episodes[0].endReason).toBe("page_enter");
    expect(episodes[1].startedAt).toBe(2000);
    expect(episodes[1].startReason).toBe("page_enter");
  });

  it("multiple pages create multiple episodes", () => {
    const events: BehavioralEvent[] = [
      createPageEnterEvent(0),
      createPageEnterEvent(1000),
      createPageEnterEvent(2000),
      createPageEnterEvent(3000),
    ];

    const episodes = segmentIntoEpisodes(SESSION_ID, events);
    expect(episodes).toHaveLength(4);
    episodes.forEach((ep, i) => expect(ep.startedAt).toBe(i * 1000));
  });
});

describe("idle gaps", () => {
  it("a large idle gap creates a boundary", () => {
    const idleGapMs = DEFAULT_EPISODE_SEGMENTATION_CONFIG.idleGapMs;
    const events: BehavioralEvent[] = [
      createPageEnterEvent(0),
      createClickEvent(1000, elementIdentityFromSelector("#a")),
      createClickEvent(1000 + idleGapMs + 1, elementIdentityFromSelector("#b")),
    ];

    const episodes = segmentIntoEpisodes(SESSION_ID, events);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].endReason).toBe("idle_gap");
    expect(episodes[1].startReason).toBe("idle_gap");
  });

  it("a small idle gap does not create a boundary", () => {
    const idleGapMs = DEFAULT_EPISODE_SEGMENTATION_CONFIG.idleGapMs;
    const events: BehavioralEvent[] = [
      createPageEnterEvent(0),
      createClickEvent(1000, elementIdentityFromSelector("#a")),
      createClickEvent(1000 + idleGapMs - 1, elementIdentityFromSelector("#b")),
    ];

    const episodes = segmentIntoEpisodes(SESSION_ID, events);
    expect(episodes).toHaveLength(1);
  });

  it("respects a configured idleGapMs override", () => {
    const events: BehavioralEvent[] = [
      createPageEnterEvent(0),
      createClickEvent(5000, elementIdentityFromSelector("#a")),
    ];

    const withDefault = segmentIntoEpisodes(SESSION_ID, events);
    const withTightGap = segmentIntoEpisodes(SESSION_ID, events, { idleGapMs: 1000 });

    expect(withDefault).toHaveLength(1);
    expect(withTightGap).toHaveLength(2);
  });

  it("gives page_enter priority as the boundary reason when a page change and a large gap coincide", () => {
    const idleGapMs = DEFAULT_EPISODE_SEGMENTATION_CONFIG.idleGapMs;
    const events: BehavioralEvent[] = [createPageEnterEvent(0), createPageEnterEvent(idleGapMs + 5000)];

    const episodes = segmentIntoEpisodes(SESSION_ID, events);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].endReason).toBe("page_enter");
    expect(episodes[1].startReason).toBe("page_enter");
  });
});

describe("empty and single-event sessions", () => {
  it("returns an empty array for an empty session", () => {
    expect(segmentIntoEpisodes(SESSION_ID, [])).toEqual([]);
  });

  it("produces exactly one episode for a single-event session", () => {
    const episodes = segmentIntoEpisodes(SESSION_ID, [createClickEvent(500, elementIdentityFromSelector("#a"))]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].startedAt).toBe(500);
    expect(episodes[0].endedAt).toBe(500);
    expect(episodes[0].startReason).toBe("session_start");
    expect(episodes[0].endReason).toBe("session_end");
  });

  it("a single page_enter event still gets startReason page_enter", () => {
    const episodes = segmentIntoEpisodes(SESSION_ID, [createPageEnterEvent(0)]);
    expect(episodes[0].startReason).toBe("page_enter");
    expect(episodes[0].endReason).toBe("session_end");
  });
});

describe("event order and episode metadata", () => {
  it("retains chronological event order within an episode, even if input was shuffled", () => {
    const a = createClickEvent(300, elementIdentityFromSelector("#a"));
    const b = createClickEvent(100, elementIdentityFromSelector("#b"));
    const c = createClickEvent(200, elementIdentityFromSelector("#c"));

    const episodes = segmentIntoEpisodes(SESSION_ID, [a, b, c]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].events.map((e) => e.timestamp)).toEqual([100, 200, 300]);
  });

  it("episode timestamps match the first/last event in that episode", () => {
    const events: BehavioralEvent[] = [
      createPageEnterEvent(10),
      createClickEvent(50, elementIdentityFromSelector("#a")),
      createScrollEvent(90, 30),
    ];
    const episodes = segmentIntoEpisodes(SESSION_ID, events);
    expect(episodes[0].startedAt).toBe(10);
    expect(episodes[0].endedAt).toBe(90);
  });

  it("assigns deterministic, stable ids per episode", () => {
    const events: BehavioralEvent[] = [createPageEnterEvent(0), createPageEnterEvent(1000)];
    const first = segmentIntoEpisodes(SESSION_ID, events);
    const second = segmentIntoEpisodes(SESSION_ID, events);

    expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id));
    expect(first[0].id).toBe(`${SESSION_ID}_episode_0`);
    expect(first[1].id).toBe(`${SESSION_ID}_episode_1`);
  });

  it("stamps every episode with the given sessionId", () => {
    const events: BehavioralEvent[] = [createPageEnterEvent(0), createPageEnterEvent(1000)];
    const episodes = segmentIntoEpisodes(SESSION_ID, events);
    for (const ep of episodes) expect(ep.sessionId).toBe(SESSION_ID);
  });
});
