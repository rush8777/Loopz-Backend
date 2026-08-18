export const DEFAULT_EPISODE_SEGMENTATION_CONFIG = {
    idleGapMs: 30_000,
};
/**
 * Segments one session's compiled `BehavioralEvent[]` into `Episode`s.
 * Pure and deterministic: the same events and config always produce
 * the same episodes with the same ids. Returns `[]` for an empty
 * event list; a single-event session produces exactly one episode.
 */
export function segmentIntoEpisodes(sessionId, events, configOverrides = {}) {
    if (events.length === 0)
        return [];
    const config = { ...DEFAULT_EPISODE_SEGMENTATION_CONFIG, ...configOverrides };
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const episodes = [];
    let episodeIndex = 0;
    let currentEvents = [sorted[0]];
    let startReason = sorted[0].kind === "page_enter" ? "page_enter" : "session_start";
    const closeEpisode = (endReason) => {
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
            const reason = isNewPage ? "page_enter" : "idle_gap";
            closeEpisode(reason);
            currentEvents = [event];
            startReason = reason;
        }
        else {
            currentEvents.push(event);
        }
    }
    closeEpisode("session_end");
    return episodes;
}
//# sourceMappingURL=episodeSegmentation.js.map