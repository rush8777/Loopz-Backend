import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { funnels, pageDefinitions, segments, sessionContexts, sessionEvents, trackedUserProperties } from "../../db/schema.js";
import { evaluateFunnel, getFunnelStepUsers } from "../funnels/evaluator.js";
import type { FunnelStep } from "../funnels/types.js";
import { hydrateIdentities } from "../identity/hydrate.js";
import { matchesRules } from "../pages/pageMatcher.js";
import type { PageRule } from "../pages/types.js";
import { evaluateSegment } from "../segments/evaluator.js";
import type { SegmentDefinition } from "../segments/types.js";
import { METRIC_CATALOG } from "./catalog.js";
import { createBuckets, floorUtc } from "./buckets.js";
import { computeRetention } from "./retention.js";
import type { CardConfiguration, DashboardFilters, MetricConfiguration } from "./validation.js";

export class AnalyticsError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }
type Fact = { id: string; identity: string; trackedUserId: string | null; anonymousId: string | null; sessionId: string; type: string; eventName: string | null; at: Date; pagePath: string | null };
type Context = { browserName: string | null; osName: string | null; deviceType: string | null; language: string | null; referrer: string | null };

async function loadFacts(db: Db, siteId: string, since: Date, until: Date): Promise<Fact[]> {
  const rows = await db.select({ id: sessionEvents.id, anonymousId: sessionEvents.anonymousId, trackedUserId: sessionEvents.trackedUserId, sessionId: sessionEvents.sessionId, type: sessionEvents.type, eventName: sessionEvents.eventName, at: sessionEvents.timestamp, pagePath: sessionEvents.pagePath })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.siteId, siteId), gte(sessionEvents.timestamp, since), lte(sessionEvents.timestamp, until)));
  return rows.map((r) => ({ ...r, identity: r.trackedUserId ?? r.anonymousId })).filter((r): r is Fact => Boolean(r.identity));
}
const round = (n: number) => Math.round(n * 100) / 100;
const meaningful = (f: Fact, excluded: Set<string>) => ["page_view", "click", "scroll", "custom"].includes(f.type) && !(f.type === "custom" && f.eventName && excluded.has(f.eventName));
const customNamed = (f: Fact, names?: string[]) => f.type === "custom" && (!names || names.includes(f.eventName ?? ""));
const unique = (facts: Fact[], key: "identity" | "sessionId") => new Set(facts.map((f) => f[key])).size;

function applyEventPool(facts: Fact[], config: MetricConfiguration, excluded: Set<string>, eventName?: string): Fact[] {
  if (eventName) return facts.filter((f) => customNamed(f, [eventName]) && !excluded.has(eventName));
  if (config.events) return facts.filter((f) => customNamed(f, config.events!.eventNames) && !excluded.has(f.eventName ?? ""));
  return config.metricId.startsWith("events.") ? facts.filter((f) => f.type === "custom" && !excluded.has(f.eventName ?? "")) : facts.filter((f) => meaningful(f, excluded));
}

function qualifyAll(facts: Fact[], config: MetricConfiguration, key: "identity" | "sessionId"): Fact[] {
  if (config.events?.match !== "all") return facts;
  const byEntity = new Map<string, Set<string>>();
  for (const f of facts) if (f.eventName) { const set = byEntity.get(f[key]) ?? new Set(); set.add(f.eventName); byEntity.set(f[key], set); }
  const allowed = new Set([...byEntity].filter(([, names]) => config.events!.eventNames.every((n) => names.has(n))).map(([id]) => id));
  return facts.filter((f) => allowed.has(f[key]));
}

function metricValue(allFacts: Fact[], config: MetricConfiguration, excluded: Set<string>, eventName?: string): number {
  if (config.metricId.endsWith("conversion_rate")) {
    const key = config.metricId.startsWith("users.") ? "identity" : "sessionId";
    const denominator = config.conversion!.denominatorEvent
      ? allFacts.filter((f) => customNamed(f, [config.conversion!.denominatorEvent!]) && !excluded.has(f.eventName ?? ""))
      : allFacts.filter((f) => meaningful(f, excluded));
    const denominatorIds = new Set(denominator.map((f) => f[key]));
    const numeratorIds = new Set(allFacts.filter((f) => customNamed(f, [config.conversion!.numeratorEvent]) && !excluded.has(f.eventName ?? "") && denominatorIds.has(f[key])).map((f) => f[key]));
    return denominatorIds.size ? round(numeratorIds.size / denominatorIds.size * 100) : 0;
  }
  let pool = applyEventPool(allFacts, config, excluded, eventName);
  if (config.metricId.startsWith("users.")) return unique(qualifyAll(pool, config, "identity"), "identity");
  if (config.metricId === "sessions.count") return unique(qualifyAll(pool, config, "sessionId"), "sessionId");
  if (config.metricId === "sessions.observed_duration") {
    const qualified = new Set(qualifyAll(pool, config, "sessionId").map((f) => f.sessionId));
    const durations = [...qualified].map((id) => { const rows = allFacts.filter((f) => f.sessionId === id); return Math.max(...rows.map((r) => r.at.getTime())) - Math.min(...rows.map((r) => r.at.getTime())); });
    return durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  }
  if (config.metricId === "events.occurrences") return pool.length;
  if (config.metricId === "events.per_user") return unique(pool, "identity") ? round(pool.length / unique(pool, "identity")) : 0;
  if (config.metricId === "events.per_session") return unique(pool, "sessionId") ? round(pool.length / unique(pool, "sessionId")) : 0;
  return 0;
}

async function segmentMembers(db: Db, siteId: string, segmentId?: string) {
  if (!segmentId) return undefined;
  const [row] = await db.select().from(segments).where(and(eq(segments.id, segmentId), eq(segments.siteId, siteId))).limit(1);
  if (!row) throw new AnalyticsError("segment_not_found", "The selected Segment does not belong to this site.");
  return evaluateSegment(db, siteId, row.definition as SegmentDefinition);
}

async function executeMetric(db: Db, siteId: string, filters: DashboardFilters, config: MetricConfiguration) {
  const catalog = METRIC_CATALOG.find((m) => m.id === config.metricId)!;
  if (config.breakdown && !(catalog.breakdowns as readonly string[]).includes(config.breakdown.dimension)) throw new AnalyticsError("unsupported_combination", "This metric does not support the selected breakdown.");
  const since = new Date(filters.since), until = new Date(filters.until), exclusions = new Set(filters.excludedEventNames);
  const lookbackSince = config.metricId === "users.stickiness" ? new Date(since.getTime() - 30 * 86_400_000) : since;
  let facts = await loadFacts(db, siteId, lookbackSince, until);
  const members = await segmentMembers(db, siteId, filters.segmentId);
  if (members) facts = facts.filter((f) => members.has(f.identity));
  const rangeFacts = facts.filter((f) => f.at >= since && f.at <= until);
  const series = config.events?.match === "each" ? config.events.eventNames.map((name) => ({ key: name, label: name })) : [{ key: "value", label: catalog.label }];

  if (config.metricId === "users.stickiness") {
    const daily: { at: Date; value: number }[] = [];
    for (let d = floorUtc(since, "day"); d <= until; d = new Date(d.getTime() + 86_400_000)) {
      const end = new Date(d.getTime() + 86_400_000), start30 = new Date(end.getTime() - 30 * 86_400_000);
      const dau = metricValue(facts.filter((f) => f.at >= d && f.at < end), { ...config, metricId: "users.unique" }, exclusions);
      const mau = metricValue(facts.filter((f) => f.at >= start30 && f.at < end), { ...config, metricId: "users.unique" }, exclusions);
      daily.push({ at: d, value: mau ? round(dau / mau * 100) : 0 });
    }
    const buckets = createBuckets(filters).map((b) => { const values = daily.filter((d) => d.at >= b.start && d.at < b.end).map((d) => d.value); return { key: b.key, label: b.label, incomplete: b.incomplete, values: { value: values.length ? round(values.reduce((a, v) => a + v, 0) / values.length) : 0 } }; });
    if (config.mode === "trend") return { kind: "timeseries" as const, series, buckets };
    const values = daily.map((d) => d.value);
    return { kind: "scalar" as const, values: [{ seriesKey: "value", value: values.length ? round(values.reduce((a, v) => a + v, 0) / values.length) : 0, recentValue: values.at(-1) ?? 0, previousValue: null, deltaPercent: null }] };
  }

  if (config.mode === "trend") {
    const buckets = createBuckets(filters).map((b) => ({ key: b.key, label: b.label, incomplete: b.incomplete, values: Object.fromEntries(series.map((s) => [s.key, metricValue(rangeFacts.filter((f) => f.at >= b.start && f.at < b.end), config, exclusions, s.key === "value" ? undefined : s.key)])) }));
    return { kind: "timeseries" as const, series, buckets };
  }
  if (config.mode === "single") {
    const duration = until.getTime() - since.getTime(), previousFacts = await loadFacts(db, siteId, new Date(since.getTime() - duration), new Date(since.getTime() - 1));
    const previousScoped = members ? previousFacts.filter((f) => members.has(f.identity)) : previousFacts;
    const lastBucket = createBuckets(filters).at(-1);
    return { kind: "scalar" as const, values: series.map((s) => { const value = metricValue(rangeFacts, config, exclusions, s.key === "value" ? undefined : s.key); const recentValue = lastBucket ? metricValue(rangeFacts.filter((f) => f.at >= lastBucket.start && f.at < lastBucket.end), config, exclusions, s.key === "value" ? undefined : s.key) : 0; const previousValue = metricValue(previousScoped, config, exclusions, s.key === "value" ? undefined : s.key); return { seriesKey: s.key, value, recentValue, previousValue, deltaPercent: previousValue ? round((value - previousValue) / previousValue * 100) : null }; }) };
  }
  return executeBreakdown(db, siteId, rangeFacts, config, exclusions);
}

async function executeBreakdown(db: Db, siteId: string, facts: Fact[], config: MetricConfiguration, exclusions: Set<string>) {
  const breakdown = config.breakdown!;
  const groups = new Map<string, { label: string; facts: Fact[] }>();
  const add = (key: string, label: string, fact: Fact) => { const g = groups.get(key) ?? { label, facts: [] }; g.facts.push(fact); groups.set(key, g); };
  if (breakdown.dimension === "segment") {
    for (const id of breakdown.segmentIds) {
      const [row] = await db.select().from(segments).where(and(eq(segments.id, id), eq(segments.siteId, siteId))).limit(1);
      if (!row) throw new AnalyticsError("segment_not_found", "A breakdown Segment does not belong to this site.");
      const members = await evaluateSegment(db, siteId, row.definition as SegmentDefinition);
      groups.set(id, { label: row.name, facts: facts.filter((f) => members.has(f.identity)) });
    }
  } else {
    const [contexts, pages, properties] = await Promise.all([
      db.select().from(sessionContexts).where(eq(sessionContexts.siteId, siteId)),
      db.select().from(pageDefinitions).where(eq(pageDefinitions.siteId, siteId)),
      breakdown.dimension === "user_property" ? db.select().from(trackedUserProperties).where(and(eq(trackedUserProperties.siteId, siteId), eq(trackedUserProperties.name, breakdown.propertyName))) : Promise.resolve([]),
    ]);
    const contextMap = new Map(contexts.map((c) => [c.sessionId, c]));
    const propertyMap = new Map(properties.map((p) => [p.trackedUserId, p.value]));
    for (const fact of facts) {
      const c = contextMap.get(fact.sessionId); let values: { key: string; label: string }[] = [];
      if (breakdown.dimension === "event") values = fact.type === "custom" && fact.eventName ? [{ key: fact.eventName, label: fact.eventName }] : [];
      else if (breakdown.dimension === "identity") values = [{ key: fact.trackedUserId ? "identified" : "anonymous", label: fact.trackedUserId ? "Identified" : "Anonymous" }];
      else if (breakdown.dimension === "device") values = [{ key: c?.deviceType ?? "unknown", label: c?.deviceType ?? "Unknown" }];
      else if (breakdown.dimension === "browser") values = [{ key: c?.browserName ?? "unknown", label: c?.browserName ?? "Unknown" }];
      else if (breakdown.dimension === "os") values = [{ key: c?.osName ?? "unknown", label: c?.osName ?? "Unknown" }];
      else if (breakdown.dimension === "language") values = [{ key: c?.language ?? "unknown", label: c?.language ?? "Unknown" }];
      else if (breakdown.dimension === "referrer") values = [{ key: c?.referrer ?? "direct", label: c?.referrer ?? "Direct / unknown" }];
      else if (breakdown.dimension === "user_property") { const v = fact.trackedUserId ? propertyMap.get(fact.trackedUserId) : undefined; values = [{ key: v ?? "unknown", label: v ?? "Unknown" }]; }
      else if (["page", "page_area", "page_type"].includes(breakdown.dimension) && fact.pagePath) values = pages.filter((p) => matchesRules(fact.pagePath!, p.rules as PageRule[])).map((p) => breakdown.dimension === "page" ? { key: p.id, label: p.name } : breakdown.dimension === "page_area" ? { key: p.area ?? "unknown", label: p.area ?? "Unknown" } : { key: p.pageType ?? "unknown", label: p.pageType ?? "Unknown" });
      for (const value of new Map(values.map((v) => [v.key, v])).values()) add(value.key, value.label, fact);
    }
  }
  const rows = [...groups].map(([key, group]) => ({ key, label: group.label, value: metricValue(group.facts, config, exclusions) })).sort((a, b) => b.value - a.value).slice(0, 50);
  return { kind: "breakdown" as const, rows };
}

function metadata(filters: DashboardFilters, query: CardConfiguration, result: { kind: string }) {
  const metric = query.kind === "metric" ? METRIC_CATALOG.find((m) => m.id === query.metricId) : undefined;
  return { metricId: query.kind === "metric" ? query.metricId : query.kind === "funnel" ? `funnel:${query.funnelId}` : "retention", definition: metric?.definition ?? (query.kind === "funnel" ? "Ordered conversion through the saved Funnel." : "Percentage of each cohort returning in a specific later period."), resolvedDateRange: { since: filters.since, until: filters.until }, granularity: filters.granularity, appliedFilters: filters, breakdown: query.kind === "metric" ? query.breakdown ?? null : null, dataFreshness: new Date().toISOString(), resultShape: result.kind, timezone: "UTC", drilldown: query.kind === "metric" ? metric?.drilldown ?? [] : query.kind === "funnel" ? ["users"] : ["users"] };
}

export async function executeAnalyticsQuery(db: Db, siteId: string, filters: DashboardFilters, query: CardConfiguration) {
  let result;
  if (query.kind === "metric") result = await executeMetric(db, siteId, filters, query);
  else if (query.kind === "retention") result = await computeRetention(db, siteId, filters, query);
  else {
    const [row] = await db.select().from(funnels).where(and(eq(funnels.id, query.funnelId), eq(funnels.siteId, siteId))).limit(1);
    if (!row) throw new AnalyticsError("funnel_not_found", "The saved Funnel does not belong to this site.");
    result = { kind: "funnel" as const, ...(await evaluateFunnel(db, siteId, row.steps as FunnelStep[], { since: new Date(filters.since), until: new Date(filters.until) }, row.conversionWindowMinutes, { segmentId: filters.segmentId })) };
  }
  return { metadata: metadata(filters, query, result), result };
}

export async function executeDrilldown(db: Db, siteId: string, filters: DashboardFilters, query: CardConfiguration, selection: { bucketStart?: string; bucketEnd?: string; stepIndex?: number; offset: number; limit: number }) {
  if (query.kind === "funnel") {
    const [row] = await db.select().from(funnels).where(and(eq(funnels.id, query.funnelId), eq(funnels.siteId, siteId))).limit(1);
    if (!row) throw new AnalyticsError("funnel_not_found", "The saved Funnel does not belong to this site.");
    const page = await getFunnelStepUsers(db, siteId, row.steps as FunnelStep[], { since: new Date(filters.since), until: new Date(filters.until) }, row.conversionWindowMinutes, selection.stepIndex ?? 0, { segmentId: filters.segmentId, offset: selection.offset, limit: selection.limit });
    return { kind: "users", ...page, limit: selection.limit, offset: selection.offset };
  }
  const since = new Date(selection.bucketStart ?? filters.since), until = new Date(selection.bucketEnd ?? filters.until);
  let facts = await loadFacts(db, siteId, since, until); const members = await segmentMembers(db, siteId, filters.segmentId); if (members) facts = facts.filter((f) => members.has(f.identity));
  if (query.kind === "retention" || query.metricId.startsWith("users.")) {
    // Use the exact event qualification path as the metric so a Unique
    // users card and its drilldown always describe the same identities.
    const config: MetricConfiguration = query.kind === "metric" ? query : { schemaVersion: 1, kind: "metric", metricId: "users.unique", mode: "single", visualization: "total" };
    const ids = [...new Set(qualifyAll(applyEventPool(facts, config, new Set(filters.excludedEventNames)), config, "identity").map((f) => f.identity))];
    const items = await hydrateIdentities(db, siteId, ids.slice(selection.offset, selection.offset + selection.limit));
    return { kind: "users", items, total: ids.length, limit: selection.limit, offset: selection.offset };
  }
  if (query.metricId.startsWith("sessions.")) {
    const ids = [...new Set(facts.map((f) => f.sessionId))];
    return { kind: "sessions", items: ids.slice(selection.offset, selection.offset + selection.limit).map((sessionId) => ({ sessionId })), total: ids.length, limit: selection.limit, offset: selection.offset };
  }
  const pool = applyEventPool(facts, query, new Set(filters.excludedEventNames));
  return { kind: "occurrences", items: pool.slice(selection.offset, selection.offset + selection.limit).map((f) => ({ id: f.id, eventName: f.eventName, sessionId: f.sessionId, trackedUserId: f.trackedUserId, anonymousId: f.anonymousId, timestamp: f.at.toISOString() })), total: pool.length, limit: selection.limit, offset: selection.offset };
}
