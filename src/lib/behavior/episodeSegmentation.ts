import type { BehavioralEvent } from "./behavioralEvent.js";

/**
 * Episode segmentation.
 *
 * BEHAVIOR COMPILATION -> EPISODE SEGMENTATION
 *
 * A whole session is not one meaningful sequence - a visitor who reads
 * an article, navigates to pricing, gets distracted for ten minutes,
 * and comes back to check out has really gone through three distinct
 * behavioral episodes, not one giant one. Treating the entire session
 * as a single sequence (what `sequenceSimilarity.ts`/`kmeans.ts`
 * currently do, unchanged by this task) is exactly what later
 * pattern-detection work needs a cleaner unit than.
 *
 * `segmentIntoEpisodes()` splits an already-compiled, chronologically
 * ordered `BehavioralEvent[]` (the output of `behaviorCompiler.ts`)
 * into `Episode`s using two simple, deterministic boundary rules:
 *
 *   1. A `page_enter` event always starts a new episode (except the
 *      very first event of the session, which just starts episode 0).
 *   2. A gap between two consecutive events larger than `idleGapMs`
 *      starts a new episode, even with no page change.
 *
 * A session with no further page changes and no gap larger than
 * `idleGapMs` stays exactly one episode - the "don't over-segment"
 * default this task asks for.
 */

export type EpisodeBoundaryReason = "page_enter" | "idle_gap" | "session_start" | "session_end";

export interface Episode {
  /** Deterministic within a call - `${sessionId}_episode_${index}`, stable given the same input. Not a global uniqueness guarantee across separately-run compilations of the same session; see the module doc if this is ever persisted. */
  id: string;
  sessionId: string;
  startedAt: number;
  endedAt: number;
  events: BehavioralEvent[];
  startReason: EpisodeBoundaryReason;
  endReason: EpisodeBoundaryReason;
}

export interface EpisodeSegmentationConfig {
  /**
   * Gap (ms) between two consecutive behavioral events beyond which a
   * new episode starts, even with no page change - the "meaningful
   * idle gap" boundary rule.
   */
  idleGapMs: number;
}

export const DEFAULT_EPISODE_SEGMENTATION_CONFIG: EpisodeSegmentationConfig = {
  idleGapMs: 30_000,
};

/**
 * Segments one session's compiled `BehavioralEvent[]` into `Episode`s.
 * Pure and deterministic: the same events and config always produce
 * the same episodes with the same ids. Returns `[]` for an empty
 * event list; a single-event session produces exactly one episode.
 */
export function segmentIntoEpisodes(
  sessionId: string,
  events: readonly BehavioralEvent[],
  configOverrides: Partial<EpisodeSegmentationConfig> = {}
): Episode[] {
  if (events.length === 0) return [];

  const config: EpisodeSegmentationConfig = { ...DEFAULT_EPISODE_SEGMENTATION_CONFIG, ...configOverrides };
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  const episodes: Episode[] = [];
  let episodeIndex = 0;
  let currentEvents: BehavioralEvent[] = [sorted[0]];
  let startReason: EpisodeBoundaryReason = sorted[0].kind === "page_enter" ? "page_enter" : "session_start";

  const closeEpisode = (endReason: EpisodeBoundaryReason): void => {
    const first = currentEvents[0];
    const last = currentEvents[currentEvents.length - 1];
    episodes.push({
      id: `${sessionId}_episode_${episodeIndex}`,
      sessionId,
      startedAt: first.timestamp,
      endedAt: last.timestamp,
      events: currentEvents,
      startReason,
      endReason,
    });
    episodeIndex += 1;
  };

  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    const previous = sorted[i - 1];
    const gapMs = event.timestamp - previous.timestamp;

    const isNewPage = event.kind === "page_enter";
    const isIdleGap = gapMs > config.idleGapMs;

    if (isNewPage || isIdleGap) {
      // A page change takes priority as the reported reason when both
      // conditions happen to coincide (a page_enter after a long gap) -
      // it's the more specific, intentional signal of the two.
      const reason: EpisodeBoundaryReason = isNewPage ? "page_enter" : "idle_gap";
      closeEpisode(reason);
      currentEvents = [event];
      startReason = reason;
    } else {
      currentEvents.push(event);
    }
  }

  closeEpisode("session_end");

  return episodes;
}
