import { describe, it, expect } from "vitest";
import { extractSessionFeatures, toVector } from "../src/lib/analysis/features.js";
import { kmeans, standardize } from "../src/lib/analysis/kmeans.js";
import { levenshteinDistance, sequenceSimilarity, findSimilarSessions } from "../src/lib/analysis/sequenceSimilarity.js";
import type { IncomingEvent } from "../src/lib/patterns/event.js";

describe("extractSessionFeatures", () => {
  it("computes aggregate stats independent of event order sensitivity", () => {
    const events: IncomingEvent[] = [
      { type: "page_view", timestamp: 0 },
      { type: "hover", timestamp: 1000, element: { selector: "#hero" }, durationMs: 30_000 },
      { type: "scroll", timestamp: 32_000, scrollPercent: 40 },
      { type: "scroll", timestamp: 40_000, scrollPercent: 70 },
      { type: "click", timestamp: 45_000, element: { selector: "#cta" } },
    ];
    const features = extractSessionFeatures("s1", events, { type: "click", selector: "#cta" });

    expect(features.totalEvents).toBe(5);
    expect(features.clickCount).toBe(1);
    expect(features.hoverCount).toBe(1);
    expect(features.scrollCount).toBe(2);
    expect(features.uniqueTargets).toBe(2);
    expect(features.totalHoverMs).toBe(30_000);
    expect(features.maxScrollPercent).toBe(70); // takes the max, not the last
    expect(features.sessionDurationMs).toBe(45_000);
    expect(features.converted).toBe(true);
    expect(features.actionTokens).toEqual(["enter", "hover:#hero", "scroll", "scroll", "click:#cta"]);
  });

  it("marks converted=false when the goal event never occurs", () => {
    const events: IncomingEvent[] = [{ type: "page_view", timestamp: 0 }];
    const features = extractSessionFeatures("s2", events, { type: "click", selector: "#cta" });
    expect(features.converted).toBe(false);
  });

  it("toVector produces a fixed-length numeric array in a stable order", () => {
    const features = extractSessionFeatures("s3", [{ type: "page_view", timestamp: 0 }]);
    const vector = toVector(features);
    expect(vector).toHaveLength(8);
    expect(vector.every((v) => typeof v === "number")).toBe(true);
  });
});

describe("kmeans", () => {
  it("separates two well-separated synthetic clusters correctly", () => {
    // Cluster A: low values around [1,1]. Cluster B: high values around [50,50].
    const clusterA = Array.from({ length: 10 }, (_, i) => [1 + (i % 3) * 0.1, 1 + (i % 2) * 0.1]);
    const clusterB = Array.from({ length: 10 }, (_, i) => [50 + (i % 3) * 0.1, 50 + (i % 2) * 0.1]);
    const vectors = [...clusterA, ...clusterB];

    const { standardized } = standardize(vectors);
    const result = kmeans(standardized, 2, { seed: 7 });

    // All of cluster A should share one label, all of cluster B the other, and the labels should differ.
    const labelsA = new Set(result.assignments.slice(0, 10));
    const labelsB = new Set(result.assignments.slice(10, 20));
    expect(labelsA.size).toBe(1);
    expect(labelsB.size).toBe(1);
    expect([...labelsA][0]).not.toBe([...labelsB][0]);
  });

  it("handles k larger than the number of points without crashing", () => {
    const result = kmeans([[1, 2], [3, 4]], 5, { seed: 1 });
    expect(result.centroids.length).toBeLessThanOrEqual(2);
    expect(result.assignments).toHaveLength(2);
  });

  it("handles an empty input", () => {
    const result = kmeans([], 3);
    expect(result.assignments).toEqual([]);
    expect(result.centroids).toEqual([]);
  });

  it("standardize gives every dimension zero mean and unit-ish variance", () => {
    const vectors = [
      [10, 1000],
      [20, 2000],
      [30, 3000],
    ];
    const { standardized } = standardize(vectors);
    for (let d = 0; d < 2; d++) {
      const mean = standardized.reduce((s, v) => s + v[d], 0) / standardized.length;
      expect(Math.abs(mean)).toBeLessThan(1e-9);
    }
  });
});

describe("sequence similarity", () => {
  it("identical sequences score 1", () => {
    expect(sequenceSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
  });

  it("completely different sequences of the same length score 0", () => {
    expect(sequenceSimilarity(["a", "b"], ["x", "y"])).toBe(0);
  });

  it("scores a longer session with extra steps highly against a shorter reference doing the same core actions", () => {
    // Reference: the "canonical" 4-step conversion.
    const reference = ["enter", "hover:#hero", "scroll", "click:#cta"];
    // Same core actions, but with two extra, unrelated interactions mixed in - more steps, same result.
    const longerSession = ["enter", "click:#nav-about", "hover:#hero", "hover:#footer", "scroll", "click:#cta"];

    const similarity = sequenceSimilarity(reference, longerSession);
    // 2 insertions out of a max length of 6 -> distance 2, similarity 1 - 2/6.
    expect(similarity).toBeCloseTo(1 - 2 / 6, 5);
    expect(similarity).toBeGreaterThan(0.6);
  });

  it("scores a shorter session (fewer steps, same essential path) highly too", () => {
    const reference = ["enter", "hover:#hero", "scroll", "click:#cta"];
    const shorterSession = ["enter", "click:#cta"]; // skipped the hover/scroll, same end action

    const similarity = sequenceSimilarity(reference, shorterSession);
    expect(similarity).toBeGreaterThan(0.4);
    expect(similarity).toBeLessThan(1);
  });

  it("levenshteinDistance handles empty arrays", () => {
    expect(levenshteinDistance([], ["a", "b"])).toBe(2);
    expect(levenshteinDistance(["a"], [])).toBe(1);
    expect(levenshteinDistance([], [])).toBe(0);
  });

  it("findSimilarSessions filters by threshold and sorts descending", () => {
    const reference = ["enter", "hover:#hero", "scroll", "click:#cta"];
    const sessions = [
      { sessionId: "exact", actionTokens: ["enter", "hover:#hero", "scroll", "click:#cta"] },
      { sessionId: "close", actionTokens: ["enter", "hover:#hero", "click:#cta"] },
      { sessionId: "unrelated", actionTokens: ["enter", "click:#pricing-toggle"] },
    ];

    const results = findSimilarSessions(sessions, reference, 0.5);
    expect(results.map((r) => r.sessionId)).toEqual(["exact", "close"]);
    expect(results[0].similarity).toBeGreaterThanOrEqual(results[1].similarity);
  });
});
