/**
 * Sequence diffing.
 *
 * `sequenceSimilarity.ts` answers "how similar are these two token
 * sequences" as a single number. That's the right shape for grouping
 * decisions (patternObserver.ts), but it's useless for answering "WHY
 * didn't these two sessions match" - a 0.55 similarity score doesn't
 * say which token differed. This module adds that: a full Levenshtein
 * alignment (same DP as `levenshteinDistance`, but with backtracking
 * to recover the actual edit operations) so a human can see exactly
 * which tokens were extra, missing, or swapped.
 *
 * This is a diagnostic/debugging tool, not part of the pattern
 * observation pipeline - nothing in patternObserver.ts or
 * sequenceSimilarity.ts depends on it, and it doesn't change how
 * either of those behave.
 */

export type DiffOpType = "equal" | "substitute" | "insert" | "delete";

export interface DiffOp {
  type: DiffOpType;
  /** Token from the first sequence - absent for a pure insert (a token that only exists in the second sequence). */
  a?: string;
  /** Token from the second sequence - absent for a pure delete (a token that only exists in the first sequence). */
  b?: string;
}

export interface SequenceDiff {
  ops: DiffOp[];
  distance: number;
  similarity: number;
  /** Tokens present in the first sequence but missing from the second (deletions), in order. */
  onlyInA: string[];
  /** Tokens present in the second sequence but missing from the first (insertions), in order. */
  onlyInB: string[];
  /** Positions where a token in A was swapped for a different token in B, in order. */
  substitutions: { a: string; b: string }[];
}

/**
 * Full Levenshtein alignment between two token sequences: the same
 * edit-distance DP as `levenshteinDistance` (sequenceSimilarity.ts),
 * but with a backtrace over the DP table to recover which tokens were
 * kept, swapped, inserted, or deleted - not just the total edit count.
 */
export function diffSequences(a: readonly string[], b: readonly string[]): SequenceDiff {
  const m = a.length;
  const n = b.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // delete a[i-1]
        dp[i][j - 1] + 1, // insert b[j-1]
        dp[i - 1][j - 1] + cost // keep or substitute
      );
    }
  }

  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      ops.push({ type: "equal", a: a[i - 1], b: b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push({ type: "substitute", a: a[i - 1], b: b[j - 1] });
      i--;
      j--;
    } else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      ops.push({ type: "insert", b: b[j - 1] });
      j--;
    } else {
      ops.push({ type: "delete", a: a[i - 1] });
      i--;
    }
  }
  ops.reverse();

  const distance = dp[m][n];
  const maxLen = Math.max(m, n);
  const similarity = maxLen === 0 ? 1 : 1 - distance / maxLen;

  const onlyInA = ops.filter((op) => op.type === "delete").map((op) => op.a!);
  const onlyInB = ops.filter((op) => op.type === "insert").map((op) => op.b!);
  const substitutions = ops.filter((op) => op.type === "substitute").map((op) => ({ a: op.a!, b: op.b! }));

  return { ops, distance, similarity, onlyInA, onlyInB, substitutions };
}

/**
 * Renders a diff as aligned two-line text, e.g.:
 *
 *   A: page_enter  click:#a  click:#b            click:#save
 *   B: page_enter  click:#a  click:#b  hover:#x  click:#save
 *                                       ^^^^^^^^ (insert)
 *
 * A plain-text visualization for CLI/log output - not used by any
 * programmatic caller, just a convenience for humans reading the diff.
 */
export function formatDiff(diff: SequenceDiff): string {
  const lineA: string[] = [];
  const lineB: string[] = [];
  const marker: string[] = [];

  for (const op of diff.ops) {
    const cellA = op.a ?? "";
    const cellB = op.b ?? "";
    const width = Math.max(cellA.length, cellB.length, 1);
    lineA.push(cellA.padEnd(width));
    lineB.push(cellB.padEnd(width));
    marker.push(op.type === "equal" ? " ".repeat(width) : "^".repeat(width));
  }

  const tag = (op: DiffOp): string => (op.type === "equal" ? "" : ` (${op.type})`);
  const annotatedMarker = diff.ops.map((op, idx) => marker[idx] + tag(op)).join("  ");

  return [`A: ${lineA.join("  ")}`, `B: ${lineB.join("  ")}`, `   ${annotatedMarker}`].join("\n");
}
