/**
 * Release-locked MVP1 storage policy. Changing these values requires an
 * intentional backend release; environment drift cannot re-enable the
 * high-volume sinks.
 *
 * MVP2 should use spatial heatmap buckets, compressed cursor trace chunks,
 * aggregated selector hover metrics, and object storage for screenshots
 * instead of restoring raw samples/base64 images as individual SQLite rows.
 */
export const MVP1_STORAGE_POLICY = Object.freeze({
  cursorEvents: false,
  hoverEvents: false,
  sessionReplay: false,
  heatmaps: false,
});

export function shouldPersistSessionEvent(type: string): boolean {
  if (type === "cursor") return MVP1_STORAGE_POLICY.cursorEvents;
  if (type === "hover") return MVP1_STORAGE_POLICY.hoverEvents;
  return true;
}
