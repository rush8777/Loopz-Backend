import { behavioralSequenceForEpisode } from "../behavior/behavioralSequence.js";
import { sequenceSimilarity } from "./sequenceSimilarity.js";
export const DEFAULT_PATTERN_OBSERVER_CONFIG = {
    similarityThreshold: 0.65,
    minimumOccurrences: 3,
    maximumEpisodes: 2000,
    maximumPatternLength: 12,
    minimumPatternLength: 2,
};
function clamp01(value) {
    if (Number.isNaN(value))
        return 0;
    return Math.max(0, Math.min(1, value));
}
/** Deterministic total order used everywhere episodes need a stable processing order: earliest first, ties broken by id. */
function compareEpisodesChronologically(a, b) {
    if (a.startedAt !== b.startedAt)
        return a.startedAt - b.startedAt;
    return a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0;
}
/**
 * Step 1 of the pipeline this module owns: Episode -> token sequence,
 * via the existing `behavioralSequenceForEpisode()` - no cursor sample
 * can appear here since that function only ever tokenizes already-
 * compiled `BehavioralEvent`s (see `behavioralSequence.ts`).
 */
function toObservedEpisodes(episodes) {
    return episodes
        .map((episode) => ({
        episodeId: episode.id,
        sessionId: episode.sessionId,
        sequence: behavioralSequenceForEpisode(episode),
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
    }))
        .filter((e) => e.sequence.length > 0);
}
/**
 * Enforces `maximumEpisodes`: keeps the most recent N (by startedAt,
 * ties broken by id), then returns them in canonical chronological
 * order for deterministic downstream processing. Older episodes beyond
 * the cap are silently dropped from consideration - see the module
 * doc's Performance section.
 */
function boundAndOrderEpisodes(episodes, maximumEpisodes) {
    const sorted = [...episodes].sort(compareEpisodesChronologically);
    if (sorted.length <= maximumEpisodes)
        return sorted;
    return sorted.slice(sorted.length - maximumEpisodes);
}
/**
 * Sequential leader clustering (a standard, simple, deterministic
 * clustering technique - not a novel algorithm): walk episodes in
 * canonical order; for each one, compare it against every existing
 * group's exemplar and join the best-scoring group if that score meets
 * `similarityThreshold`, else start a new group with this episode as
 * the exemplar. Ties for "best group" are broken by earliest-formed
 * group, so the result is fully deterministic for a given input order.
 *
 * COMPLEXITY: O(episodes x groups) similarity comparisons, each
 * O(sequenceLength^2) for the underlying Levenshtein computation.
 * Group count is bounded by episode count, so this is O(n^2) in the
 * worst case (every episode forms its own group) - acceptable for the
 * bounded batch sizes `maximumEpisodes` targets, not a claim that this
 * scales to millions of episodes. See the module doc's Performance
 * section.
 */
function leaderCluster(episodes, similarityThreshold) {
    const groups = [];
    for (const episode of episodes) {
        let bestGroupIndex = -1;
        let bestScore = -1;
        for (let i = 0; i < groups.length; i++) {
            const score = sequenceSimilarity(episode.sequence, groups[i].exemplar);
            if (score > bestScore) {
                bestScore = score;
                bestGroupIndex = i;
            }
        }
        if (bestGroupIndex !== -1 && bestScore >= similarityThreshold) {
            groups[bestGroupIndex].members.push(episode);
        }
        else {
            groups.push({ exemplar: episode.sequence, members: [episode] });
        }
    }
    return groups;
}
/**
 * Two groups are considered related if their exemplars are similar
 * enough (the common, cheap case), OR if any member of one group is
 * similar enough to any member of the other - this catches a case
 * exemplar-only comparison misses: leader clustering can absorb a
 * closer variant as a plain *member* of a group without ever making it
 * the exemplar (e.g. a 4-step variant joins a 3-step group's exemplar,
 * then a 5-step group forms separately because it's too far from that
 * 3-step exemplar alone, even though it's close to the 4-step member
 * already sitting inside the first group). Still simple and
 * deterministic, no new threshold introduced - just a broader search
 * for the same evidence bar.
 *
 * COMPLEXITY: the member-pairwise fallback is O(membersA x membersB)
 * per group pair - fine for the small group counts/sizes an MVP-bounded
 * batch produces (see the module doc's Performance section), not
 * something this MVP claims scales unbounded.
 */
function groupsAreRelated(a, b, similarityThreshold) {
    if (sequenceSimilarity(a.exemplar, b.exemplar) >= similarityThreshold)
        return true;
    for (const memberA of a.members) {
        for (const memberB of b.members) {
            if (sequenceSimilarity(memberA.sequence, memberB.sequence) >= similarityThreshold)
                return true;
        }
    }
    return false;
}
/**
 * Dedup/merge pass (see the module doc's Duplicate Prevention section
 * for the tradeoff this addresses): leader clustering alone can leave
 * near-duplicate groups standing - e.g. one group anchored on a
 * 3-step prefix and another on the same workflow's 5-step full
 * version, each individually below threshold against episodes that
 * ended up in the other group purely because of processing order.
 * Repeatedly merges any two related groups (see `groupsAreRelated` -
 * same `similarityThreshold`, no new, laxer bar introduced) into the
 * larger group, keeping the larger group's exemplar. Deterministic:
 * each pass scans group pairs in a stable (index) order and merges the
 * first qualifying pair before rescanning; terminates because every
 * merge strictly reduces the group count, so at most `groups.length`
 * passes ever run.
 *
 * Deliberately NOT a general sequence-mining/consensus algorithm - see
 * the module doc for why a simple fixed-point merge is the right MVP
 * tradeoff here.
 */
function mergeSimilarGroups(groups, similarityThreshold) {
    let current = groups;
    let mergedSomething = true;
    while (mergedSomething) {
        mergedSomething = false;
        outer: for (let i = 0; i < current.length; i++) {
            for (let j = i + 1; j < current.length; j++) {
                if (groupsAreRelated(current[i], current[j], similarityThreshold)) {
                    const [smaller, larger] = current[i].members.length >= current[j].members.length ? [current[j], current[i]] : [current[i], current[j]];
                    const merged = { exemplar: larger.exemplar, members: [...larger.members, ...smaller.members] };
                    current = [...current.filter((_, index) => index !== i && index !== j), merged];
                    mergedSomething = true;
                    break outer;
                }
            }
        }
    }
    return current;
}
/**
 * The group's representative sequence is simply its exemplar - the
 * sequence every member was compared against to join the group (or,
 * after merging, the exemplar of whichever group was larger). This is
 * a deliberately simple choice: it's stable and deterministic by
 * construction (same input always picks the same exemplar), and every
 * member is guaranteed similarityThreshold-close to it. A fancier
 * consensus sequence (e.g. per-position majority vote / alignment)
 * could be more "average-looking", but that's real complexity for
 * limited MVP benefit - noted as a known limitation, not implemented
 * here (see the module doc / final report).
 *
 * Truncated to `maximumPatternLength` tokens, keeping the first N -
 * long enough to show the shape of the behavior, bounded so storage
 * and downstream display stay predictable.
 */
function buildRepresentativeSequence(group, maximumPatternLength) {
    return group.exemplar.slice(0, maximumPatternLength);
}
function sortUnique(values) {
    return [...new Set(values)].sort();
}
function buildCandidateDraft(group, config) {
    const representativeSequence = buildRepresentativeSequence(group, config.maximumPatternLength);
    const similarities = group.members.map((member) => sequenceSimilarity(member.sequence, representativeSequence));
    const average = similarities.reduce((sum, s) => sum + s, 0) / similarities.length;
    const minimum = Math.min(...similarities);
    const maximum = Math.max(...similarities);
    return {
        representativeSequence,
        occurrenceCount: group.members.length,
        uniqueSessionCount: new Set(group.members.map((m) => m.sessionId)).size,
        episodeIds: sortUnique(group.members.map((m) => m.episodeId)),
        sessionIds: sortUnique(group.members.map((m) => m.sessionId)),
        firstSeenAt: Math.min(...group.members.map((m) => m.startedAt)),
        lastSeenAt: Math.max(...group.members.map((m) => m.endedAt)),
        similarity: { average, minimum, maximum },
    };
}
/**
 * Quality score - see the module doc's Quality Score section and each
 * field's own doc comment on `PatternCandidateQuality` for what it
 * measures and why. `batchMaxOccurrence`/`batchTimeRange` make the
 * batch-relative components (frequency, recency) explicit inputs
 * rather than hidden global state, keeping `observePatterns` a pure
 * function of its arguments.
 */
function computeQuality(draft, batchMaxOccurrence, batchTimeRange) {
    const frequencyScore = batchMaxOccurrence > 0 ? clamp01(draft.occurrenceCount / batchMaxOccurrence) : 0;
    const coverageScore = draft.occurrenceCount > 0 ? clamp01(draft.uniqueSessionCount / draft.occurrenceCount) : 0;
    const consistencyScore = clamp01(draft.similarity.average - (draft.similarity.maximum - draft.similarity.minimum) / 2);
    const span = batchTimeRange.max - batchTimeRange.min;
    const recencyScore = span > 0 ? clamp01((draft.lastSeenAt - batchTimeRange.min) / span) : 1;
    const overallScore = (frequencyScore + coverageScore + consistencyScore + recencyScore) / 4;
    return { frequencyScore, coverageScore, consistencyScore, recencyScore, overallScore };
}
/**
 * Assigns ids from a purely content-derived sort order (representative
 * sequence, then firstSeenAt, then a session id for a final
 * tiebreaker) - independent of the order candidates happen to be
 * returned in, so ids stay stable across re-runs of the same input
 * even if quality-based ranking changes for unrelated reasons.
 */
function assignDeterministicIds(drafts) {
    const ordered = [...drafts].sort((a, b) => {
        const seqA = a.representativeSequence.join("|");
        const seqB = b.representativeSequence.join("|");
        if (seqA !== seqB)
            return seqA < seqB ? -1 : 1;
        if (a.firstSeenAt !== b.firstSeenAt)
            return a.firstSeenAt - b.firstSeenAt;
        const sessionA = a.sessionIds[0] ?? "";
        const sessionB = b.sessionIds[0] ?? "";
        return sessionA < sessionB ? -1 : sessionA > sessionB ? 1 : 0;
    });
    const ids = new Map();
    ordered.forEach((draft, index) => ids.set(draft, `cand_${index}`));
    return ids;
}
// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
/**
 * Observes a bounded batch of `Episode`s and returns recurring
 * `PatternCandidate`s: groups of episodes whose behavioral sequences
 * are similar enough to represent the same underlying behavior,
 * occurring at least `minimumOccurrences` times. Purely observational
 * - see the module doc for what this deliberately does NOT decide
 * (whether a pattern is good, bad, friction, or success; that's a
 * separate future classification stage).
 *
 * Deterministic: the same `episodes` and `config` always produce the
 * same candidates, same ids, same ranking. No randomness, no current-
 * time dependency, no network or LLM calls, no reliance on input
 * array order beyond what's explicitly sorted internally.
 */
export function observePatterns(episodes, configOverrides = {}) {
    const config = { ...DEFAULT_PATTERN_OBSERVER_CONFIG, ...configOverrides };
    if (episodes.length === 0)
        return [];
    const observed = boundAndOrderEpisodes(toObservedEpisodes(episodes), config.maximumEpisodes);
    if (observed.length === 0)
        return [];
    const groups = mergeSimilarGroups(leaderCluster(observed, config.similarityThreshold), config.similarityThreshold);
    const drafts = groups
        .map((group) => buildCandidateDraft(group, config))
        .filter((draft) => draft.occurrenceCount >= config.minimumOccurrences)
        .filter((draft) => draft.representativeSequence.length >= config.minimumPatternLength);
    if (drafts.length === 0)
        return [];
    const batchMaxOccurrence = Math.max(...drafts.map((d) => d.occurrenceCount));
    const batchTimeRange = {
        min: Math.min(...observed.map((e) => e.startedAt)),
        max: Math.max(...observed.map((e) => e.endedAt)),
    };
    const ids = assignDeterministicIds(drafts);
    const candidates = drafts.map((draft) => ({
        id: ids.get(draft),
        representativeSequence: draft.representativeSequence,
        occurrenceCount: draft.occurrenceCount,
        uniqueSessionCount: draft.uniqueSessionCount,
        episodeIds: draft.episodeIds,
        sessionIds: draft.sessionIds,
        firstSeenAt: draft.firstSeenAt,
        lastSeenAt: draft.lastSeenAt,
        quality: computeQuality(draft, batchMaxOccurrence, batchTimeRange),
        similarity: draft.similarity,
    }));
    return candidates.sort((a, b) => {
        if (b.quality.overallScore !== a.quality.overallScore)
            return b.quality.overallScore - a.quality.overallScore;
        if (b.occurrenceCount !== a.occurrenceCount)
            return b.occurrenceCount - a.occurrenceCount;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}
//# sourceMappingURL=patternObserver.js.map