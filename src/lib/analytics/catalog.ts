import { ANALYTICS_LIMITS } from "./validation.js";

const commonBreakdowns = ["page", "page_area", "page_type", "identity", "device", "browser", "os", "language", "referrer", "segment", "user_property"];
export const METRIC_CATALOG = [
  { id: "users.unique", group: "Users", label: "Unique users", definition: "Distinct users with qualifying activity during the selected period.", matches: ["each", "any", "all"], breakdowns: commonBreakdowns, drilldown: ["users"] },
  { id: "users.conversion_rate", group: "Users", label: "Conversion rate", definition: "Target-event users divided by meaningful active users or explicit denominator-event users.", matches: [], breakdowns: commonBreakdowns, drilldown: ["users"] },
  { id: "users.stickiness", group: "Users", label: "Stickiness", definition: "Daily active users divided by trailing-30-day active users.", matches: ["each", "any", "all"], breakdowns: [], drilldown: ["users"] },
  { id: "sessions.count", group: "Sessions", label: "Session count", definition: "Distinct sessions with qualifying activity.", matches: ["each", "any", "all"], breakdowns: commonBreakdowns, drilldown: ["sessions"] },
  { id: "sessions.conversion_rate", group: "Sessions", label: "Session conversion rate", definition: "Target-event sessions divided by meaningful sessions or explicit denominator-event sessions.", matches: [], breakdowns: commonBreakdowns, drilldown: ["sessions"] },
  { id: "sessions.observed_duration", group: "Sessions", label: "Observed session duration", definition: "Average elapsed time from the first to last persisted event in qualifying sessions.", matches: ["each", "any", "all"], breakdowns: ["device", "browser", "os", "language", "referrer", "segment"], drilldown: ["sessions"] },
  { id: "events.occurrences", group: "Events", label: "Event occurrence count", definition: "Persisted custom-event occurrences.", matches: ["each", "any"], breakdowns: ["event", ...commonBreakdowns], drilldown: ["occurrences"] },
  { id: "events.per_user", group: "Events", label: "Occurrences per unique user", definition: "Custom-event occurrences divided by distinct identity-resolved performers.", matches: ["each", "any"], breakdowns: ["event", ...commonBreakdowns], drilldown: ["occurrences", "users"] },
  { id: "events.per_session", group: "Events", label: "Occurrences per session", definition: "Custom-event occurrences divided by distinct sessions containing them.", matches: ["each", "any"], breakdowns: ["event", ...commonBreakdowns], drilldown: ["occurrences", "sessions"] },
] as const;

export function analyticsCatalog() {
  return { schemaVersion: 1, timezone: "UTC", metrics: METRIC_CATALOG, granularities: ["day", "week", "month"], limits: ANALYTICS_LIMITS };
}
