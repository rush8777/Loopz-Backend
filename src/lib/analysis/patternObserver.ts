import type { Episode } from "../behavior/episodeSegmentation.js";
import { behavioralSequenceForEpisode } from "../behavior/behavioralSequence.js";
import { sequenceSimilarity } from "./sequenceSimilarity.js";

/**
 * Pattern Observer.
 *
 * CLEAN BEHAVIORAL SEQUENCES -> SEQUENCE SIMILARITY -> GROUPING -> RECURRING PATTERN CANDIDATES
 *
 * Answers "what are users repeatedly doing?" rather than "did this
 * predefined pattern match?" (the live FSM matcher in
 * `../patterns/matcher.ts`, unchanged by this module). Given a batch of
 * `Episode`s (from `episodeSegmentation.ts`), groups the ones whose
 * behavioral sequences are similar to each other and reports each
 * group as a `PatternCandidate` - a neutral, evidence-only statement
 * that "this sequence occurs repeatedly", never a judgment about
 * whether that's good, bad, friction, or success. That judgment is a
 * separate future classification stage this module deliberately does
 * not implement.
 *
 * REUSE, NOT DUPLICATION: this module does not reimplement sequence
 * similarity. `sequenceSimilarity()` (`sequenceSimilarity.ts`) already
 * does exactly what's needed here - a normalized Levenshtein score
 * over token arrays - and is generic over any two `string[]`, not
 * specific to sessions, so it's used as-is. `behavioralSequenceForEpisode()`
 * (`behavioralSequence.ts`) is reused to turn each `Episode` into
 * tokens, so a raw `cursor` sample can never become part of a compared
 * sequence - that guarantee comes for free from the existing pipeline,
 * not from anything reimplemented here.
 *
 * SITE SCOPING: `Episode` (episodeSegmentation.ts) carries no `siteId`,
 * so neither does `PatternCandidate` - this module is a pure function
 * over whatever episodes it's given. Scoping "only this site's
 * episodes" is the caller's responsibility (e.g. a future route that
 * loads episodes for one site before calling `observePatterns`).
 *
 * USER IDENTITY: the current schema has no stable visitor/user identity
 * distinct from `sessionId` (see `src/db/schema.ts` - `session_events`
 * and `episodes` are keyed by `sessionId` only; `users`/`memberships`
 * are dashboard login accounts, not tracked-site visitors). Per this
 * task's brief, this module does not invent one: only
 * `uniqueSessionCount` is reported, not a user count. If a stable
 * visitor identity is added later, a `uniqueUserCount` field can be
 * added the same way `uniqueSessionCount` works today.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PatternObserverConfig {
  /**
   * Minimum `sequenceSimilarity()` score (0-1) for two episodes to be
   * considered the same underlying behavior. The existing
   * `/analysis/similar-sessions` route (`../../routes/analysis.ts`)
   * defaults its single-reference threshold to 0.6; this is set a bit
   * higher (0.65) because grouping chains comparisons transitively
   * (episode B can join a group by matching episode A, then episode C
   * joins by matching B) - a slightly stricter per-pair bar keeps that
   * chaining from drifting a group away from its original behavior
   * over several hops.
   */
  similarityThreshold: number;
  /**
   * A group must contain at least this many episode occurrences before
   * it's reported as a recurring candidate. 3 is a deliberately low
   * but non-trivial bar: 1 occurrence is just an event, 2 could be
   * coincidence, 3+ starts to look like a repeated behavior. Tune
   * higher for noisier sites.
   */
  minimumOccurrences: number;
  /**
   * Hard cap on how many episodes a single `observePatterns()` call
   * will consider. When more are supplied, only the most recent
   * `maximumEpisodes` (by `startedAt`) are used - see the module doc's
   * Performance section for why this exists and what it does NOT do.
   */
  maximumEpisodes: number;
  /**
   * A candidate's representative sequence longer than this is
   * truncated (keeps candidates readable and bounds storage - see
   * `buildRepresentativeSequence`).
   */
  maximumPatternLength: number;
  /**
   * Episodes (and representative sequences) shorter than this contain
   * too little behavior to be a meaningful recurring pattern and are
   * excluded. 2 excludes single-token "did one thing" episodes while
   * still allowing short-but-real workflows.
   */
  minimumPatternLength: number;
}

export const DEFAULT_PATTERN_OBSERVER_CONFIG: PatternObserverConfig = {
  similarityThreshold: 0.65,
  minimumOccurrences: 3,
  maximumEpisodes: 2000,
  maximumPatternLength: 12,
  minimumPatternLength: 2,
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PatternCandidateSimilarityStats {
  /** Mean similarity of every member episode's sequence to the candidate's representativeSequence. */
  average: number;
  minimum: number;
  maximum: number;
}

export interface PatternCandidateQuality {
  /** occurrenceCount relative to the most frequent candidate in this batch (1.0 = the batch's most common pattern). Batch-relative, not an absolute/universal frequency measure. */
  frequencyScore: number;
  /** uniqueSessionCount / occurrenceCount - 1.0 means every occurrence came from a different session (broad adoption); low means one or a few sessions repeating the same thing. This is what keeps "1000 times from one session" from automatically outranking "300 times across 300 sessions" - see the module doc's Quality Score section. */
  coverageScore: number;
  /** How tightly member episodes cluster around the representative sequence: average similarity, penalized by half the min/max spread. 1.0 means every occurrence matched almost exactly. */
  consistencyScore: number;
  /** Where this candidate's lastSeenAt falls within the time range spanned by the whole input batch (0 = as old as the batch's earliest episode, 1 = as recent as its latest). Computed only from episode timestamps supplied by the caller - never from wall-clock time, so the result stays deterministic. */
  recencyScore: number;
  /** Unweighted mean of the four scores above. A ranking aid, not a statistical confidence value - see the module doc. */
  overallScore: number;
}

export interface PatternCandidate {
  /** Deterministic given the same input batch - see `assignDeterministicIds`. Not a global/persistent identity; a caller persisting candidates across runs is responsible for its own stable-identity/matching strategy (e.g. by representativeSequence). */
  id: string;
  /** The sequence judged most representative of this group - see `buildRepresentativeSequence`. Truncated to `maximumPatternLength` tokens. */
  representativeSequence: string[];
  /** Total episode occurrences in this group (may exceed uniqueSessionCount if one session repeats the behavior). */
  occurrenceCount: number;
  uniqueSessionCount: number;
  /** Sorted for determinism, not chronological. */
  episodeIds: string[];
  /** Sorted for determinism, not chronological. */
  sessionIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  quality: PatternCandidateQuality;
  similarity: PatternCandidateSimilarityStats;
}

// ---------------------------------------------------------------------------
// Internal working representation
// ---------------------------------------------------------------------------

interface ObservedEpisode {
  episodeId: string;
  sessionId: string;
  sequence: string[];
  startedAt: number;
  endedAt: number;
}

interface Group {
  /** The sequence new episodes are compared against while this group is being formed - the episode that started the group. Kept simple and deterministic; see the module doc's Representative Sequence section for why this isn't a fancier consensus/alignment sequence. */
  exemplar: string[];
  members: ObservedEpisode[];
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Deterministic total order used everywhere episodes need a stable processing order: earliest first, ties broken by id. */
function compareEpisodesChronologically(a: ObservedEpisode, b: ObservedEpisode): number {
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
  return a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0;
}

/**
 * Step 1 of the pipeline this module owns: Episode -> token sequence,
 * via the existing `behavioralSequenceForEpisode()` - no cursor sample
 * can appear here since that function only ever tokenizes already-
 * compiled `BehavioralEvent`s (see `behavioralSequence.ts`).
 */
function toObservedEpisodes(episodes: readonly Episode[]): ObservedEpisode[] {
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
function boundAndOrderEpisodes(episodes: ObservedEpisode[], maximumEpisodes: number): ObservedEpisode[] {
  const sorted = [...episodes].sort(compareEpisodesChronologically);
  if (sorted.length <= maximumEpisodes) return sorted;
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
function leaderCluster(episodes: readonly ObservedEpisode[], similarityThreshold: number): Group[] {
  const groups: Group[] = [];

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
    } else {
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
function groupsAreRelated(a: Group, b: Group, similarityThreshold: number): boolean {
  if (sequenceSimilarity(a.exemplar, b.exemplar) >= similarityThreshold) return true;

  for (const memberA of a.members) {
    for (const memberB of b.members) {
      if (sequenceSimilarity(memberA.sequence, memberB.sequence) >= similarityThreshold) return true;
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
function mergeSimilarGroups(groups: Group[], similarityThreshold: number): Group[] {
  let current = groups;
  let mergedSomething = true;

  while (mergedSomething) {
    mergedSomething = false;

    outer: for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        if (groupsAreRelated(current[i], current[j], similarityThreshold)) {
          const [smaller, larger] =
            current[i].members.length >= current[j].members.length ? [current[j], current[i]] : [current[i], current[j]];
          const merged: Group = { exemplar: larger.exemplar, members: [...larger.members, ...smaller.members] };
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
function buildRepresentativeSequence(group: Group, maximumPatternLength: number): string[] {
  return group.exemplar.slice(0, maximumPatternLength);
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

interface CandidateDraft {
  representativeSequence: string[];
  occurrenceCount: number;
  uniqueSessionCount: number;
  episodeIds: string[];
  sessionIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  similarity: PatternCandidateSimilarityStats;
}

function buildCandidateDraft(group: Group, config: PatternObserverConfig): CandidateDraft {
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
function computeQuality(
  draft: CandidateDraft,
  batchMaxOccurrence: number,
  batchTimeRange: { min: number; max: number }
): PatternCandidateQuality {
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
function assignDeterministicIds(drafts: CandidateDraft[]): Map<CandidateDraft, string> {
  const ordered = [...drafts].sort((a, b) => {
    const seqA = a.representativeSequence.join("|");
    const seqB = b.representativeSequence.join("|");
    if (seqA !== seqB) return seqA < seqB ? -1 : 1;
    if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt - b.firstSeenAt;
    const sessionA = a.sessionIds[0] ?? "";
    const sessionB = b.sessionIds[0] ?? "";
    return sessionA < sessionB ? -1 : sessionA > sessionB ? 1 : 0;
  });

  const ids = new Map<CandidateDraft, string>();
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
export function observePatterns(
  episodes: readonly Episode[],
  configOverrides: Partial<PatternObserverConfig> = {}
): PatternCandidate[] {
  const config: PatternObserverConfig = { ...DEFAULT_PATTERN_OBSERVER_CONFIG, ...configOverrides };

  if (episodes.length === 0) return [];

  const observed = boundAndOrderEpisodes(toObservedEpisodes(episodes), config.maximumEpisodes);
  if (observed.length === 0) return [];

  const groups = mergeSimilarGroups(leaderCluster(observed, config.similarityThreshold), config.similarityThreshold);

  const drafts = groups
    .map((group) => buildCandidateDraft(group, config))
    .filter((draft) => draft.occurrenceCount >= config.minimumOccurrences)
    .filter((draft) => draft.representativeSequence.length >= config.minimumPatternLength);

  if (drafts.length === 0) return [];

  const batchMaxOccurrence = Math.max(...drafts.map((d) => d.occurrenceCount));
  const batchTimeRange = {
    min: Math.min(...observed.map((e) => e.startedAt)),
    max: Math.max(...observed.map((e) => e.endedAt)),
  };

  const ids = assignDeterministicIds(drafts);

  const candidates: PatternCandidate[] = drafts.map((draft) => ({
    id: ids.get(draft)!,
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
    if (b.quality.overallScore !== a.quality.overallScore) return b.quality.overallScore - a.quality.overallScore;
    if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
