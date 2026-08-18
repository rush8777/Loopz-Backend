import { describe, it, expect } from "vitest";
import { observePatterns, DEFAULT_PATTERN_OBSERVER_CONFIG, type PatternCandidate } from "../src/lib/analysis/patternObserver.js";
import type { Episode } from "../src/lib/behavior/episodeSegmentation.js";
import { segmentIntoEpisodes } from "../src/lib/behavior/episodeSegmentation.js";
import { compileBehavioralEvents, type CompilableRawEvent } from "../src/lib/behavior/behaviorCompiler.js";
import { createClickEvent, type BehavioralEvent } from "../src/lib/behavior/behavioralEvent.js";
import { elementIdentityFromSelector } from "../src/lib/behavior/elementIdentity.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a synthetic Episode whose behavioral sequence tokenizes to
 * exactly `click:#<step>` for each step name given - a convenient
 * shorthand for the "dashboard -> projects -> create" style examples
 * in the task brief, expressed as real BehavioralEvents (via the
 * actual createClickEvent constructor and element-identity helper, not
 * hand-rolled objects) so these fixtures exercise the real token
 * format the observer will see in production.
 */
function makeEpisode(id: string, sessionId: string, steps: string[], startedAt: number, stepGapMs = 1000): Episode {
  const events: BehavioralEvent[] = steps.map((step, i) =>
    createClickEvent(startedAt + i * stepGapMs, step === "__none__" ? undefined : elementIdentityFromSelector(`#${step}`))
  );
  const endedAt = events.length > 0 ? events[events.length - 1].timestamp : startedAt;
  return {
    id,
    sessionId,
    startedAt,
    endedAt,
    events,
    startReason: "session_start",
    endReason: "session_end",
  };
}

const WORKFLOW_A_FULL = ["dashboard", "projects", "create", "configure", "save"];
const WORKFLOW_A_SHORT = ["dashboard", "projects", "create", "save"];
const WORKFLOW_A_LONGER = ["dashboard", "projects", "create", "configure", "review", "save"];
const WORKFLOW_UNRELATED = ["settings", "profile", "password"];

describe("A. identical sequences", () => {
  it("10 episodes with the same sequence produce one strong recurring candidate", () => {
    const episodes = Array.from({ length: 10 }, (_, i) => makeEpisode(`ep_${i}`, `sess_${i}`, WORKFLOW_A_FULL, i * 100_000));

    const result = observePatterns(episodes);

    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(10);
    expect(result[0].uniqueSessionCount).toBe(10);
    expect(result[0].representativeSequence).toEqual(WORKFLOW_A_FULL.map((s) => `click:#${s}`));
    expect(result[0].similarity.average).toBe(1);
    expect(result[0].similarity.minimum).toBe(1);
    expect(result[0].quality.overallScore).toBeGreaterThan(0.5);
  });
});

describe("B. small variations", () => {
  it("recognizes A/B/C variants of the same workflow as one related candidate", () => {
    const episodes: Episode[] = [
      ...Array.from({ length: 4 }, (_, i) => makeEpisode(`epA_${i}`, `sessA_${i}`, WORKFLOW_A_SHORT, i * 10_000)),
      ...Array.from({ length: 4 }, (_, i) => makeEpisode(`epB_${i}`, `sessB_${i}`, WORKFLOW_A_FULL, i * 10_000 + 5000)),
      ...Array.from({ length: 4 }, (_, i) => makeEpisode(`epC_${i}`, `sessC_${i}`, WORKFLOW_A_LONGER, i * 10_000 + 9000)),
    ];

    const result = observePatterns(episodes);

    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(12);
    expect(result[0].uniqueSessionCount).toBe(12);
    // Similarity is high but not perfect - the variants genuinely differ.
    expect(result[0].similarity.average).toBeGreaterThan(0.65);
    expect(result[0].similarity.minimum).toBeLessThan(1);
  });
});

describe("C. completely unrelated behavior", () => {
  it("keeps two unrelated workflows as separate candidates", () => {
    const episodes: Episode[] = [
      ...Array.from({ length: 5 }, (_, i) => makeEpisode(`epA_${i}`, `sessA_${i}`, WORKFLOW_A_FULL, i * 10_000)),
      ...Array.from({ length: 5 }, (_, i) => makeEpisode(`epU_${i}`, `sessU_${i}`, WORKFLOW_UNRELATED, i * 10_000 + 100_000)),
    ];

    const result = observePatterns(episodes);

    expect(result).toHaveLength(2);
    const workflowACandidate = result.find((c) => c.representativeSequence.some((t) => t.includes("dashboard")) && !c.representativeSequence.some((t) => t.includes("settings")));
    const unrelatedCandidate = result.find((c) => c.representativeSequence.some((t) => t.includes("settings")));

    expect(workflowACandidate).toBeDefined();
    expect(unrelatedCandidate).toBeDefined();
    for (const token of WORKFLOW_UNRELATED.map((s) => `click:#${s}`)) {
      expect(workflowACandidate!.representativeSequence.includes(token)).toBe(false);
    }
    for (const token of WORKFLOW_A_FULL.map((s) => `click:#${s}`)) {
      expect(unrelatedCandidate!.representativeSequence.includes(token)).toBe(false);
    }
  });
});

describe("D. cursor noise never affects the observed sequence", () => {
  function buildNoisySession(sessionId: string, startedAt: number): Episode {
    const events: CompilableRawEvent[] = [{ type: "page_view", timestamp: startedAt }];
    let t = startedAt + 10;

    for (let i = 0; i < 150; i++) {
      events.push({ type: "cursor", timestamp: t, x: 50 + (i % 2 === 0 ? 2 : -2), y: 50 });
      t += 5;
    }
    for (let i = 0; i <= 100; i++) {
      const frac = i / 100;
      events.push({ type: "cursor", timestamp: t, x: Math.round(50 + frac * 440), y: Math.round(50 + frac * 250) });
      t += 5;
    }
    events.push({ type: "hover", timestamp: t, element: { selector: "#signup" }, durationMs: 350, x: 500, y: 300 });
    t += 10;
    for (let i = 0; i < 150; i++) {
      events.push({ type: "cursor", timestamp: t, x: 500 + (i % 2 === 0 ? 2 : -2), y: 300 });
      t += 5;
    }
    events.push({ type: "click", timestamp: t, element: { selector: "#signup" }, x: 500, y: 300 });

    const compiled = compileBehavioralEvents(events);
    const episodes = segmentIntoEpisodes(sessionId, compiled);
    return episodes[0];
  }

  it("a session with hundreds of cursor samples still produces a clean, cursor-free candidate", () => {
    const rawCursorCount = 150 + 101 + 150;
    expect(rawCursorCount).toBeGreaterThan(300);

    const episodes = Array.from({ length: 4 }, (_, i) => buildNoisySession(`sess_${i}`, i * 100_000));
    const result = observePatterns(episodes, { minimumOccurrences: 3 });

    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(4);
    for (const token of result[0].representativeSequence) {
      expect(token).not.toBe("cursor");
      expect(token.startsWith("cursor")).toBe(false);
    }
    expect(result[0].representativeSequence).toContain("click:#signup");
  });
});

describe("E. repeated session", () => {
  it("distinguishes occurrenceCount from uniqueSessionCount when one session repeats a workflow", () => {
    const episodes = Array.from({ length: 20 }, (_, i) => makeEpisode(`ep_${i}`, "sess_repeat", WORKFLOW_A_FULL, i * 60_000));

    const result = observePatterns(episodes);

    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(20);
    expect(result[0].uniqueSessionCount).toBe(1);
    expect(result[0].quality.coverageScore).toBeCloseTo(1 / 20, 5);
  });
});

describe("F. multiple users/sessions", () => {
  it("reports high coverage when the same workflow spans many distinct sessions", () => {
    const episodes = Array.from({ length: 40 }, (_, i) => makeEpisode(`ep_${i}`, `sess_${i}`, WORKFLOW_A_FULL, i * 10_000));

    const result = observePatterns(episodes);

    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(40);
    expect(result[0].uniqueSessionCount).toBe(40);
    expect(result[0].quality.coverageScore).toBe(1);
  });
});

describe("G. duplicate prevention", () => {
  it("does not flood the output with near-duplicate fragment candidates", () => {
    const fragments = [
      ["dashboard", "projects", "create"],
      ["dashboard", "projects", "create", "save"],
      ["dashboard", "projects", "create", "configure", "save"],
    ];

    const episodes: Episode[] = fragments.flatMap((steps, groupIndex) =>
      Array.from({ length: 4 }, (_, i) => makeEpisode(`ep_${groupIndex}_${i}`, `sess_${groupIndex}_${i}`, steps, groupIndex * 50_000 + i * 5_000))
    );

    const result = observePatterns(episodes);

    expect(result.length).toBeLessThan(fragments.length);
    expect(result.length).toBe(1);
    expect(result[0].occurrenceCount).toBe(12);
  });
});

describe("H. minimum occurrence threshold", () => {
  it("a sequence occurring once is not reported as recurring when minimumOccurrences > 1", () => {
    const episodes = [makeEpisode("ep_0", "sess_0", WORKFLOW_A_FULL, 0)];
    const result = observePatterns(episodes, { minimumOccurrences: 2 });
    expect(result).toEqual([]);
  });

  it("the same sequence clears the bar once it recurs enough times", () => {
    const episodes = Array.from({ length: 3 }, (_, i) => makeEpisode(`ep_${i}`, `sess_${i}`, WORKFLOW_A_FULL, i * 10_000));
    const result = observePatterns(episodes, { minimumOccurrences: 3 });
    expect(result).toHaveLength(1);
  });
});

describe("I. determinism", () => {
  it("the same input twice produces the same candidates, ranking, and representative sequences", () => {
    const episodes: Episode[] = [
      ...Array.from({ length: 6 }, (_, i) => makeEpisode(`epA_${i}`, `sessA_${i}`, WORKFLOW_A_FULL, i * 10_000)),
      ...Array.from({ length: 5 }, (_, i) => makeEpisode(`epB_${i}`, `sessB_${i}`, WORKFLOW_A_SHORT, i * 10_000 + 200_000)),
      ...Array.from({ length: 4 }, (_, i) => makeEpisode(`epU_${i}`, `sessU_${i}`, WORKFLOW_UNRELATED, i * 10_000 + 400_000)),
    ];

    const first = observePatterns(episodes);
    const second = observePatterns(episodes);

    expect(first).toEqual(second);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
  });
});

describe("J. empty input", () => {
  it("returns [] for no episodes", () => {
    expect(observePatterns([])).toEqual([]);
  });
});

describe("K. missing element identity", () => {
  it("does not crash when an episode contains an event with no element", () => {
    const steps = ["dashboard", "projects", "__none__", "save"];
    const episodes = Array.from({ length: 3 }, (_, i) => makeEpisode(`ep_${i}`, `sess_${i}`, steps, i * 10_000));

    expect(() => observePatterns(episodes)).not.toThrow();
    const result = observePatterns(episodes);
    expect(result).toHaveLength(1);
    expect(result[0].representativeSequence).toContain("click");
  });
});

describe("L. maximum bounds", () => {
  it("maximumEpisodes only considers the most recent episodes", () => {
    const oldEpisodes = Array.from({ length: 5 }, (_, i) => makeEpisode(`old_${i}`, `sess_old_${i}`, WORKFLOW_UNRELATED, i * 1_000));
    const newEpisodes = Array.from({ length: 5 }, (_, i) => makeEpisode(`new_${i}`, `sess_new_${i}`, WORKFLOW_A_FULL, 10_000_000 + i * 1_000));

    const result = observePatterns([...oldEpisodes, ...newEpisodes], { maximumEpisodes: 5 });

    expect(result).toHaveLength(1);
    expect(result[0].representativeSequence).toEqual(WORKFLOW_A_FULL.map((s) => `click:#${s}`));
  });

  it("maximumPatternLength truncates the representative sequence", () => {
    const longWorkflow = Array.from({ length: 20 }, (_, i) => `step${i}`);
    const episodes = Array.from({ length: 3 }, (_, i) => makeEpisode(`ep_${i}`, `sess_${i}`, longWorkflow, i * 10_000));

    const result = observePatterns(episodes, { maximumPatternLength: 5 });

    expect(result).toHaveLength(1);
    expect(result[0].representativeSequence).toHaveLength(5);
    expect(result[0].representativeSequence).toEqual(longWorkflow.slice(0, 5).map((s) => `click:#${s}`));
  });

  it("minimumPatternLength excludes sequences that are too short to be meaningful", () => {
    const episodes = Array.from({ length: 3 }, (_, i) => makeEpisode(`ep_${i}`, `sess_${i}`, ["dashboard"], i * 10_000));
    const result = observePatterns(episodes, { minimumPatternLength: 2 });
    expect(result).toEqual([]);
  });
});

describe("realistic product fixture", () => {
  it("discovers a small number of meaningful recurring candidates from ~100 varied episodes", () => {
    const episodes: Episode[] = [];
    let cursor = 0;

    const workflowAVariants = [WORKFLOW_A_SHORT, WORKFLOW_A_FULL, WORKFLOW_A_LONGER];
    for (let i = 0; i < 40; i++) {
      const steps = workflowAVariants[i % workflowAVariants.length];
      episodes.push(makeEpisode(`epA_${i}`, `sessA_${i}`, steps, cursor));
      cursor += 5_000;
    }

    const workflowB = ["dashboard", "reports", "filter", "export"];
    for (let i = 0; i < 25; i++) {
      episodes.push(makeEpisode(`epB_${i}`, `sessB_${i}`, workflowB, cursor));
      cursor += 5_000;
    }

    const workflowC = ["settings", "members", "invite"];
    for (let i = 0; i < 8; i++) {
      episodes.push(makeEpisode(`epC_${i}`, `sessC_${i}`, workflowC, cursor));
      cursor += 5_000;
    }

    for (let i = 0; i < 20; i++) {
      episodes.push(makeEpisode(`epX_${i}`, `sessX_${i}`, [`onepage${i}`, `oneclick${i}`], cursor));
      cursor += 5_000;
    }

    expect(episodes.length).toBe(40 + 25 + 8 + 20);

    const result = observePatterns(episodes);

    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeLessThan(10);

    const byOccurrence = [...result].sort((a, b) => b.occurrenceCount - a.occurrenceCount);
    const projectCreation = byOccurrence.find((c) => c.representativeSequence.some((t) => t.includes("create")));
    const exportWorkflow = result.find((c) => c.representativeSequence.some((t) => t.includes("export")));
    const inviteWorkflow = result.find((c) => c.representativeSequence.some((t) => t.includes("invite")));

    expect(projectCreation).toBeDefined();
    expect(projectCreation!.occurrenceCount).toBe(40);

    expect(exportWorkflow).toBeDefined();
    expect(exportWorkflow!.occurrenceCount).toBe(25);
    expect(exportWorkflow!.representativeSequence.some((t) => t.includes("create"))).toBe(false);
    expect(exportWorkflow!.representativeSequence.some((t) => t.includes("invite"))).toBe(false);

    expect(inviteWorkflow).toBeDefined();
    expect(inviteWorkflow!.occurrenceCount).toBe(8);
    expect(inviteWorkflow!.representativeSequence.some((t) => t.includes("export"))).toBe(false);

    const unrelatedCandidate = result.find((c) => c.representativeSequence.some((t) => t.includes("onepage")));
    expect(unrelatedCandidate).toBeUndefined();

    // All discovered occurrence counts are accounted for by real workflow volume.
    expect(Math.max(...result.map((c) => c.occurrenceCount))).toBe(40);
  });
});

describe("output contract sanity", () => {
  it("exposes the default config values used when no overrides are given", () => {
    expect(DEFAULT_PATTERN_OBSERVER_CONFIG.similarityThreshold).toBeGreaterThan(0);
    expect(DEFAULT_PATTERN_OBSERVER_CONFIG.minimumOccurrences).toBeGreaterThanOrEqual(1);
  });

  it("every candidate exposes the full quality/similarity component breakdown, not just an opaque score", () => {
    const episodes = Array.from({ length: 5 }, (_, i) => makeEpisode(`ep_${i}`, `sess_${i}`, WORKFLOW_A_FULL, i * 10_000));
    const [candidate]: PatternCandidate[] = observePatterns(episodes);

    expect(candidate.quality).toEqual(
      expect.objectContaining({
        frequencyScore: expect.any(Number),
        coverageScore: expect.any(Number),
        consistencyScore: expect.any(Number),
        recencyScore: expect.any(Number),
        overallScore: expect.any(Number),
      })
    );
    expect(candidate.similarity).toEqual(
      expect.objectContaining({ average: expect.any(Number), minimum: expect.any(Number), maximum: expect.any(Number) })
    );
  });
});
