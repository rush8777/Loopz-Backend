import { describe, expect, it } from "vitest";
import { buildSessionActivityGroups } from "../src/lib/behavior/sessionActivity.js";
import type { sessionEvents } from "../src/db/schema.js";

type Row = typeof sessionEvents.$inferSelect;
let sequence = 0;

function row(overrides: Partial<Row> & Pick<Row, "type" | "timestamp">): Row {
  sequence += 1;
  return {
    id: `row_${String(sequence).padStart(3, "0")}`,
    siteId: "site_1",
    sessionId: "session_1",
    anonymousId: "anon_1",
    eventId: `event_${sequence}`,
    pageViewId: null,
    pagePath: null,
    selector: null,
    elementLabel: null,
    elementRole: null,
    durationMs: null,
    scrollPercent: null,
    x: null,
    y: null,
    viewportWidth: null,
    viewportHeight: null,
    eventName: null,
    eventProperties: null,
    createdAt: overrides.timestamp,
    ...overrides,
  };
}

describe("session activity presentation", () => {
  it("preserves separate visits to the same path and isolates selector-derived state", () => {
    const groups = buildSessionActivityGroups([
      row({ type: "page_view", timestamp: new Date(1_000), pageViewId: "pv_1", pagePath: "/pricing" }),
      row({ type: "click", timestamp: new Date(2_000), pageViewId: "pv_1", selector: "#cta", x: 50, y: 50, viewportWidth: 1000, viewportHeight: 800 }),
      row({ type: "page_view", timestamp: new Date(3_000), pageViewId: "pv_2", pagePath: "/pricing" }),
      row({ type: "click", timestamp: new Date(4_000), pageViewId: "pv_2", selector: "#cta", x: 50, y: 50, viewportWidth: 1000, viewportHeight: 800 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.path)).toEqual(["/pricing", "/pricing"]);
    expect(groups.flatMap((group) => group.items).filter((item) => item.signalKind === "repeated_attention")).toHaveLength(0);
  });

  it("shows 20,000ms hovers inclusively and excludes short hovers as timeline rows or derived anchors", () => {
    const [group] = buildSessionActivityGroups([
      row({ type: "page_view", timestamp: new Date(1_000), pageViewId: "pv_hover", pagePath: "/" }),
      row({ type: "hover", timestamp: new Date(22_000), pageViewId: "pv_hover", selector: "#short", durationMs: 19_999, x: 10, y: 10, viewportWidth: 1000, viewportHeight: 800 }),
      row({ type: "hover", timestamp: new Date(43_000), pageViewId: "pv_hover", selector: "#long", durationMs: 20_000, x: 20, y: 20, viewportWidth: 1000, viewportHeight: 800 }),
    ]);

    expect(group.items.filter((item) => item.kind === "long_hover")).toHaveLength(1);
    expect(group.items.find((item) => item.kind === "long_hover")?.element?.selector).toBe("#long");
    expect(group.items.some((item) => item.signalKind === "repeated_attention")).toBe(false);
  });

  it("uses maximum valid recorded scroll and distinguishes no recorded scroll from zero", () => {
    const groups = buildSessionActivityGroups([
      row({ type: "page_view", timestamp: new Date(1_000), pageViewId: "pv_scroll", pagePath: "/one" }),
      row({ type: "scroll", timestamp: new Date(2_000), pageViewId: "pv_scroll", scrollPercent: 0 }),
      row({ type: "scroll", timestamp: new Date(3_000), pageViewId: "pv_scroll", scrollPercent: 78 }),
      row({ type: "scroll", timestamp: new Date(4_000), pageViewId: "pv_scroll", scrollPercent: 55 }),
      row({ type: "page_view", timestamp: new Date(5_000), pageViewId: "pv_none", pagePath: "/two" }),
    ]);
    expect(groups[0]).toMatchObject({ deepestScrollPercent: 78, scrollSampleCount: 3 });
    expect(groups[1]).toMatchObject({ deepestScrollPercent: null, scrollSampleCount: 0 });
  });

  it("preserves custom names/properties without rendering them as clicks and stays deterministic out of order", () => {
    const rows = [
      row({ type: "custom", timestamp: new Date(2_000), pageViewId: "pv_custom", eventName: "checkout_started", eventProperties: { plan: "pro" } }),
      row({ type: "page_view", timestamp: new Date(1_000), pageViewId: "pv_custom", pagePath: "/checkout" }),
    ];
    const first = buildSessionActivityGroups(rows);
    const second = buildSessionActivityGroups([...rows].reverse());
    expect(first).toEqual(second);
    expect(first[0].items).toEqual([
      expect.objectContaining({ kind: "custom", name: "checkout_started", properties: { plan: "pro" } }),
    ]);
    expect(first[0].items.some((item) => item.kind === "click")).toBe(false);
  });

  it("infers only pure legacy boundaries and otherwise uses an unknown group", () => {
    const legacy = buildSessionActivityGroups([
      row({ type: "page_view", timestamp: new Date(1_000), pagePath: "/legacy-a" }),
      row({ type: "click", timestamp: new Date(2_000), selector: "#a" }),
      row({ type: "page_view", timestamp: new Date(3_000), pagePath: "/legacy-b" }),
      row({ type: "click", timestamp: new Date(4_000), selector: "#b" }),
    ]);
    expect(legacy.map((group) => [group.path, group.attribution])).toEqual([["/legacy-a", "inferred"], ["/legacy-b", "inferred"]]);

    const mixed = buildSessionActivityGroups([
      row({ type: "page_view", timestamp: new Date(1_000), pageViewId: "pv_modern", pagePath: "/modern" }),
      row({ type: "click", timestamp: new Date(2_000), selector: "#missing-page-id" }),
    ]);
    expect(mixed.some((group) => group.attribution === "unknown" && group.path === null)).toBe(true);
  });
});
