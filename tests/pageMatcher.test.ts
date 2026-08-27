import { describe, it, expect } from "vitest";
import { matchesRules, filterMatchingPaths } from "../src/lib/pages/pageMatcher.js";
import type { PageRule } from "../src/lib/pages/types.js";

function rule(overrides: Partial<PageRule>): PageRule {
  return { id: "r1", kind: "include", operator: "equals", value: "/", ...overrides };
}

describe("matchesRules", () => {
  it("matches equals only on an exact pagePath", () => {
    const rules = [rule({ operator: "equals", value: "/pricing" })];
    expect(matchesRules("/pricing", rules)).toBe(true);
    expect(matchesRules("/pricing/enterprise", rules)).toBe(false);
  });

  it("matches starts_with as a prefix", () => {
    const rules = [rule({ operator: "starts_with", value: "/settings" })];
    expect(matchesRules("/settings", rules)).toBe(true);
    expect(matchesRules("/settings/profile", rules)).toBe(true);
    expect(matchesRules("/account/settings", rules)).toBe(false);
  });

  it("matches ends_with as a suffix", () => {
    const rules = [rule({ operator: "ends_with", value: "/billing" })];
    expect(matchesRules("/settings/billing", rules)).toBe(true);
    expect(matchesRules("/billing/history", rules)).toBe(false);
  });

  it("matches contains as a substring anywhere", () => {
    const rules = [rule({ operator: "contains", value: "checkout" })];
    expect(matchesRules("/cart/checkout/step-1", rules)).toBe(true);
    expect(matchesRules("/cart", rules)).toBe(false);
  });

  it("matches matches_pattern with a wildcard, anchored on both ends", () => {
    const rules = [rule({ operator: "matches_pattern", value: "/products/*" })];
    expect(matchesRules("/products/123", rules)).toBe(true);
    expect(matchesRules("/products/123/reviews", rules)).toBe(true);
    expect(matchesRules("/product/123", rules)).toBe(false);
    expect(matchesRules("/products", rules)).toBe(false);
  });

  it("escapes regex-special characters in a wildcard pattern that aren't the wildcard itself", () => {
    const rules = [rule({ operator: "matches_pattern", value: "/a.b/*" })];
    expect(matchesRules("/a.b/123", rules)).toBe(true);
    // "." must be literal, not "any character" - "/aXb/123" should NOT match.
    expect(matchesRules("/aXb/123", rules)).toBe(false);
  });

  it("OR's multiple include rules together", () => {
    const rules = [
      rule({ id: "r1", operator: "equals", value: "/pricing" }),
      rule({ id: "r2", operator: "equals", value: "/plans" }),
    ];
    expect(matchesRules("/pricing", rules)).toBe(true);
    expect(matchesRules("/plans", rules)).toBe(true);
    expect(matchesRules("/features", rules)).toBe(false);
  });

  it("an exclude match wins even when an include rule also matches", () => {
    const rules = [
      rule({ id: "r1", kind: "include", operator: "starts_with", value: "/products" }),
      rule({ id: "r2", kind: "exclude", operator: "equals", value: "/products/new" }),
    ];
    expect(matchesRules("/products/123", rules)).toBe(true);
    expect(matchesRules("/products/new", rules)).toBe(false);
  });

  it("never matches anything when there are no include rules", () => {
    const rules = [rule({ kind: "exclude", operator: "contains", value: "admin" })];
    expect(matchesRules("/anything", rules)).toBe(false);
    expect(matchesRules("/admin/users", rules)).toBe(false);
  });
});

describe("filterMatchingPaths", () => {
  it("returns only the paths that match", () => {
    const rules = [rule({ operator: "starts_with", value: "/settings" })];
    const paths = ["/settings", "/settings/billing", "/dashboard", "/products/1"];
    expect(filterMatchingPaths(paths, rules)).toEqual(["/settings", "/settings/billing"]);
  });
});
