import { describe, it, expect } from "vitest";
import { diffSequences, formatDiff } from "../src/lib/analysis/sequenceDiff.js";
import { sequenceSimilarity } from "../src/lib/analysis/sequenceSimilarity.js";

describe("diffSequences", () => {
  it("reports identical sequences as all-equal with distance 0 and similarity 1", () => {
    const seq = ["page_enter", "click:#a", "click:#b"];
    const diff = diffSequences(seq, seq);
    expect(diff.distance).toBe(0);
    expect(diff.similarity).toBe(1);
    expect(diff.ops.every((op) => op.type === "equal")).toBe(true);
    expect(diff.onlyInA).toEqual([]);
    expect(diff.onlyInB).toEqual([]);
    expect(diff.substitutions).toEqual([]);
  });

  it("identifies a single inserted token (B has one extra step)", () => {
    const a = ["page_enter", "click:#create", "click:#save"];
    const b = ["page_enter", "click:#create", "hesitation:#save", "click:#save"];
    const diff = diffSequences(a, b);

    expect(diff.distance).toBe(1);
    expect(diff.onlyInB).toEqual(["hesitation:#save"]);
    expect(diff.onlyInA).toEqual([]);
    expect(diff.substitutions).toEqual([]);
  });

  it("identifies a single deleted token (A has one extra step B doesn't)", () => {
    const a = ["page_enter", "click:#create", "hover_intent:#save", "click:#save"];
    const b = ["page_enter", "click:#create", "click:#save"];
    const diff = diffSequences(a, b);

    expect(diff.distance).toBe(1);
    expect(diff.onlyInA).toEqual(["hover_intent:#save"]);
    expect(diff.onlyInB).toEqual([]);
  });

  it("identifies a substitution (same position, different token)", () => {
    const a = ["page_enter", "click:#save"];
    const b = ["page_enter", "click:#submit"];
    const diff = diffSequences(a, b);

    expect(diff.distance).toBe(1);
    expect(diff.substitutions).toEqual([{ a: "click:#save", b: "click:#submit" }]);
    expect(diff.onlyInA).toEqual([]);
    expect(diff.onlyInB).toEqual([]);
  });

  it("handles completely disjoint sequences", () => {
    const a = ["click:#a", "click:#b"];
    const b = ["click:#x", "click:#y"];
    const diff = diffSequences(a, b);
    expect(diff.distance).toBe(2);
    expect(diff.similarity).toBe(0);
  });

  it("handles one empty sequence", () => {
    const diff = diffSequences([], ["click:#a", "click:#b"]);
    expect(diff.distance).toBe(2);
    expect(diff.onlyInB).toEqual(["click:#a", "click:#b"]);
    expect(diff.onlyInA).toEqual([]);
  });

  it("handles two empty sequences as identical (similarity 1, no ops)", () => {
    const diff = diffSequences([], []);
    expect(diff.distance).toBe(0);
    expect(diff.similarity).toBe(1);
    expect(diff.ops).toEqual([]);
  });

  it("agrees with the existing sequenceSimilarity() score", () => {
    const a = ["page_enter", "click:#a", "click:#b", "click:#c"];
    const b = ["page_enter", "click:#a", "hesitation:#b", "click:#b", "click:#c"];
    const diff = diffSequences(a, b);
    expect(diff.similarity).toBeCloseTo(sequenceSimilarity(a, b), 10);
  });

  it("formatDiff produces a readable three-line block without throwing", () => {
    const a = ["page_enter", "click:#create", "click:#save"];
    const b = ["page_enter", "click:#create", "hesitation:#save", "click:#save"];
    const text = formatDiff(diffSequences(a, b));
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith("A:")).toBe(true);
    expect(lines[1].startsWith("B:")).toBe(true);
    expect(text).toContain("(insert)");
  });
});
