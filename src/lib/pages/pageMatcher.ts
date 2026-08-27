import type { PageRule } from "./types.js";

/**
 * Compiles a `matches_pattern` rule's `*`-wildcard value into a RegExp.
 * Every other character is escaped literally, so `/products/*` matches
 * `/products/123` and `/products/123/reviews` but not `/product/123`.
 * A pattern with no `*` behaves like an exact match.
 */
function compilePattern(value: string): RegExp {
  const escaped = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesRule(pagePath: string, rule: PageRule): boolean {
  switch (rule.operator) {
    case "equals":
      return pagePath === rule.value;
    case "starts_with":
      return pagePath.startsWith(rule.value);
    case "ends_with":
      return pagePath.endsWith(rule.value);
    case "contains":
      return pagePath.includes(rule.value);
    case "matches_pattern":
      return compilePattern(rule.value).test(pagePath);
    default:
      return false;
  }
}

/**
 * A pagePath matches a Page's rule set when it matches none of the
 * exclude rules and at least one include rule - the same
 * exclude-checked-first, include-rules-are-OR'd semantics Pendo uses
 * for Page tagging rules. A rule set with no include rules never
 * matches anything (the create/update schemas require at least one,
 * but this stays defensive for callers that bypass validation, e.g.
 * the live-preview endpoint mid-edit).
 */
export function matchesRules(pagePath: string, rules: PageRule[]): boolean {
  const excludeRules = rules.filter((r) => r.kind === "exclude");
  const includeRules = rules.filter((r) => r.kind === "include");
  if (includeRules.length === 0) return false;
  if (excludeRules.some((r) => matchesRule(pagePath, r))) return false;
  return includeRules.some((r) => matchesRule(pagePath, r));
}

/** Filters a list of distinct pagePaths down to the ones a rule set matches. */
export function filterMatchingPaths(pagePaths: string[], rules: PageRule[]): string[] {
  return pagePaths.filter((path) => matchesRules(path, rules));
}
