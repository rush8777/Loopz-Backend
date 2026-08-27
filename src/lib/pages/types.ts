export type PageRuleKind = "include" | "exclude";

export type PageRuleOperator = "equals" | "starts_with" | "ends_with" | "contains" | "matches_pattern";

/**
 * One condition in a Page's matching rules (see pageDefinitions.rules
 * in db/schema.ts). `value` is matched against `session_events.pagePath`
 * - `matches_pattern` supports a single wildcard character (an
 * asterisk) meaning "zero or more of any character", e.g. a rule
 * value of "/products/" followed by a wildcard matches every product
 * detail path. Modeled after Pendo's Page tagging rule syntax without
 * its fuller contains/query-parameter/parameter-capture vocabulary,
 * which v1 doesn't need since `contains`/`starts_with`/`ends_with`
 * already cover the common cases directly.
 */
export interface PageRule {
  id: string;
  kind: PageRuleKind;
  operator: PageRuleOperator;
  value: string;
}

export type PageType =
  | "landing"
  | "marketing"
  | "dashboard"
  | "list"
  | "detail"
  | "settings"
  | "checkout"
  | "authentication"
  | "pricing"
  | "documentation"
  | "other";

export const PAGE_TYPES: PageType[] = [
  "landing",
  "marketing",
  "dashboard",
  "list",
  "detail",
  "settings",
  "checkout",
  "authentication",
  "pricing",
  "documentation",
  "other",
];
