import { describe, expect, it } from "vitest";
import { resolveAiTimeRange, workspaceTimezone } from "../src/lib/ai/timeRange.js";

describe("AI deterministic time ranges", () => {
  const now = new Date("2026-11-08T06:30:00.000Z"); // Sunday noon in Sri Lanka
  it("resolves the previous completed calendar week in the workspace timezone", () => {
    const range = resolveAiTimeRange("Show me what changed last week", now, "Asia/Colombo");
    expect(range.since.toISOString()).toBe("2026-10-25T18:30:00.000Z");
    expect(range.until.toISOString()).toBe("2026-11-01T18:30:00.000Z");
    expect(range.previousSince.toISOString()).toBe("2026-10-18T18:30:00.000Z");
    expect(range.partial).toBe(false);
  });
  it("keeps rolling days distinct from calendar periods", () => {
    const range = resolveAiTimeRange("Graph daily active users for the last 7 days", now, "UTC");
    expect(range.until.toISOString()).toBe(now.toISOString());
    expect(range.until.getTime() - range.since.getTime()).toBe(7 * 86_400_000);
    expect(range.partial).toBe(true);
  });
  it("uses UTC for missing or invalid workspace configuration", () => {
    expect(workspaceTimezone({ timezone: "Mars/Olympus" })).toBe("UTC");
    expect(workspaceTimezone({ timezone: "Asia/Colombo" })).toBe("Asia/Colombo");
  });
});
