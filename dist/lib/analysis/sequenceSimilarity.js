/**
 * Standard Levenshtein edit distance (insertions/deletions/substitutions)
 * over arrays of tokens rather than characters - same algorithm, applied
 * to action tokens like "hover:#hero" instead of letters.
 */
export function levenshteinDistance(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0)
        return n;
    if (n === 0)
        return m;
    let prevRow = Array.from({ length: n + 1 }, (_, j) => j);
    let currRow = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
        currRow[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            currRow[j] = Math.min(prevRow[j] + 1, // deletion
            currRow[j - 1] + 1, // insertion
            prevRow[j - 1] + cost // substitution
            );
        }
        [prevRow, currRow] = [currRow, prevRow];
    }
    return prevRow[n];
}
/**
 * Similarity in [0, 1]: 1 means identical sequences, 0 means completely
 * unrelated. This is what turns "5-step session vs 8-step session
 * doing the same underlying thing" into a graded score instead of a
 * binary match/no-match - a session with a couple of extra clicks
 * interspersed still scores highly, rather than failing to match at all
 * the way the strict FSM matcher would if steps came in an unexpected
 * order.
 */
export function sequenceSimilarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0)
        return 1;
    const distance = levenshteinDistance(a, b);
    return 1 - distance / maxLen;
}
/**
 * Scores every session's action-token sequence against a single
 * reference sequence, returning matches at or above `threshold`, sorted
 * by similarity descending. Order-of-magnitude cheaper and more
 * forgiving than trying to express "roughly this behavior, some
 * variation allowed" as more and more optional/maxGapMs steps in the
 * strict pattern schema.
 */
export function findSimilarSessions(sessions, referenceTokens, threshold = 0.6) {
    return sessions
        .map((s) => ({ sessionId: s.sessionId, actionTokens: s.actionTokens, similarity: sequenceSimilarity(s.actionTokens, referenceTokens) }))
        .filter((m) => m.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity);
}
//# sourceMappingURL=sequenceSimilarity.js.map