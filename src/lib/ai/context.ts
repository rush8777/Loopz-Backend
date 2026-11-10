import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { dashboardCards, dashboards, funnels, segments, sessionEvents, sites } from "../../db/schema.js";
import { analyticsCatalog, METRIC_CATALOG } from "../analytics/catalog.js";
import { executeAnalyticsQuery } from "../analytics/queryService.js";
import { cardConfigurationSchema, type MetricConfiguration } from "../analytics/validation.js";
import { listEventDefinitions } from "../events/eventQueries.js";
import { listExperienceAnalytics } from "../experiences/analytics.js";
import { evaluateFunnel } from "../funnels/evaluator.js";
import type { FunnelStep } from "../funnels/types.js";
import { getSegmentAudienceCount } from "../segments/evaluator.js";
import type { SegmentDefinition } from "../segments/types.js";
import { withChartIds, type AiContentBlock } from "./content.js";
import { resolveAiTimeRange, workspaceTimezone } from "./timeRange.js";

export interface AiEvidenceItem { source: string; label: string; range?: { since: string; until: string }; sampleSize?: number; limitation?: string }
type Result = Awaited<ReturnType<typeof executeAnalyticsQuery>>;
const metric = (metricId: MetricConfiguration["metricId"], mode: MetricConfiguration["mode"] = "single", extras: Partial<MetricConfiguration> = {}): MetricConfiguration => ({ schemaVersion: 1, kind: "metric", metricId, mode, visualization: mode === "trend" ? "line" : mode === "breakdown" ? "bars" : "previous_period", ...extras } as MetricConfiguration);
const formatFor = (id: string) => id.includes("rate") || id === "users.stickiness" ? "percent" as const : id === "sessions.observed_duration" ? "duration_ms" as const : "number" as const;
const safeDelta = (value: number, previous: number) => previous ? Math.round((value - previous) / previous * 10_000) / 100 : null;

function scalarBlock(items: Array<{ label: string; metricId: string; result: Result }>): AiContentBlock | null {
  const metrics = items.flatMap(item => item.result.result.kind === "scalar" ? item.result.result.values.slice(0, 1).map(value => ({ label: item.label, value: value.value, format: formatFor(item.metricId), previousValue: value.previousValue, deltaPercent: value.deltaPercent })) : []);
  return metrics.length ? { type: "metrics", metrics } : null;
}
function trendBlock(title: string, result: Result, format: "number" | "percent" | "duration_ms" = "number"): AiContentBlock | null {
  if (result.result.kind !== "timeseries") return null;
  return { type: "chart", chart: { type: "area", title, format, series: result.result.series.map(series => ({ key: series.key, label: series.label })), data: result.result.buckets.map(bucket => ({ label: bucket.label, values: bucket.values })) } };
}
function breakdownBlock(title: string, result: Result, format: "number" | "percent" | "duration_ms" = "number"): AiContentBlock | null {
  if (result.result.kind !== "breakdown") return null;
  return { type: "chart", chart: { type: "bar", title, format, series: [{ key: "value", label: "Value" }], data: result.result.rows.map(row => ({ label: row.label, values: { value: row.value } })) } };
}
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(compact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !["email", "anonymousId", "trackedUserId", "externalUserId", "eventProperties", "latestFeedback"].includes(key)).map(([key, item]) => [key, compact(item)]));
  return typeof value === "string" && value.length > 1000 ? value.slice(0, 1000) + "…" : value;
}

export async function buildAiContext(db: Db, orgId: string, siteId: string, prompt: string, maxChars: number, history: Array<{ role: string; content: string }> = [], now = new Date()) {
  const [site] = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1);
  if (!site) return null;
  const priorUser = [...history].reverse().find(turn => turn.role === "user")?.content ?? "";
  const followUp = /\b(that|those|previous period|break (?:it|that) down|compare it)\b/i.test(prompt);
  const effectivePrompt = followUp ? `${priorUser}\nFollow-up: ${prompt}` : prompt;
  const range = resolveAiTimeRange(effectivePrompt, now, workspaceTimezone(site.publicConfig));
  const filters = { since: range.since.toISOString(), until: range.until.toISOString(), granularity: range.granularity, excludedEventNames: [] as string[] };
  const lower = effectivePrompt.toLowerCase(); const evidence: AiEvidenceItem[] = []; const blocks: AiContentBlock[] = []; const retrieved: Record<string, unknown> = {}; const toolNames: string[] = [];
  const rangeEvidence = (source: string, label: string, sampleSize?: number): AiEvidenceItem => ({ source, label, range: { since: filters.since, until: filters.until }, ...(sampleSize === undefined ? {} : { sampleSize }) });

  if (/^(hi|hello|hey|thanks|thank you|what can you do)[!?.\s]*$/i.test(prompt.trim())) {
    toolNames.push("discover_metrics"); retrieved.availableMetrics = analyticsCatalog().metrics;
  } else if (/\b(onboarding|funnel|drop[- ]?off|conversion step)\b/.test(lower)) {
    const rows = await db.select().from(funnels).where(eq(funnels.siteId, siteId)).orderBy(desc(funnels.updatedAt)).limit(20);
    const selected = rows.find(row => lower.includes(row.name.toLowerCase())) ?? rows.find(row => /onboard/i.test(row.name)) ?? rows[0]; toolNames.push("query_funnel");
    if (selected) {
      const result = await evaluateFunnel(db, siteId, selected.steps as FunnelStep[], { since: range.since, until: range.until }, selected.conversionWindowMinutes);
      retrieved.funnel = { id: selected.id, name: selected.name, result };
      blocks.push({ type: "chart", chart: { type: "funnel", title: selected.name, subtitle: range.label, format: "number", series: [{ key: "users", label: "Users" }], data: result.steps.map(step => ({ label: step.label, values: { users: step.users } })) } });
      blocks.push({ type: "table", table: { title: "Step conversion and drop-off", columns: [{ key: "step", label: "Step" }, { key: "users", label: "Users", format: "number" }, { key: "conversion", label: "From previous", format: "percent" }, { key: "dropOff", label: "Drop-off", format: "number" }], rows: result.steps.map(step => ({ step: step.label, users: step.users, conversion: step.conversionFromPrevious, dropOff: step.droppedBeforeNext })) } });
      evidence.push(rangeEvidence("funnels.evaluate", selected.name, result.totalUsers));
    }
  } else if (/\b(segments?|cohorts?|audiences?)\b/.test(lower)) {
    toolNames.push("query_segments"); const rows = await db.select().from(segments).where(eq(segments.siteId, siteId)).orderBy(desc(segments.updatedAt)).limit(20);
    const counts = await Promise.all(rows.map(async row => ({ name: row.name, audience: await getSegmentAudienceCount(db, siteId, row.definition as SegmentDefinition) })));
    blocks.push({ type: "chart", chart: { type: "bar", title: "Current segment audiences", format: "number", series: [{ key: "audience", label: "Audience" }], data: counts.map(row => ({ label: row.name, values: { audience: row.audience } })) } }); retrieved.segments = counts; evidence.push({ source: "segments.evaluate", label: "Current saved Segment membership", sampleSize: counts.length, limitation: "Segment membership is evaluated at query time, not reconstructed historically." });
  } else if (/\b(journey|page engagement|top pages?)\b/.test(lower)) {
    toolNames.push("query_page_engagement"); const rows = await db.select({ path: sessionEvents.pagePath, events: sql<number>`count(*)`, sessions: sql<number>`count(distinct ${sessionEvents.sessionId})` }).from(sessionEvents).where(and(eq(sessionEvents.siteId, siteId), gte(sessionEvents.timestamp, range.since), lte(sessionEvents.timestamp, range.until), sql`${sessionEvents.pagePath} is not null`)).groupBy(sessionEvents.pagePath).orderBy(desc(sql`count(*)`)).limit(20);
    blocks.push({ type: "chart", chart: { type: "bar", title: "Page engagement", subtitle: range.label, format: "number", series: [{ key: "sessions", label: "Sessions" }, { key: "events", label: "Events" }], data: rows.map(row => ({ label: row.path ?? "Unknown", values: { sessions: row.sessions, events: row.events } })) } }); retrieved.pages = rows; evidence.push(rangeEvidence("session_events.pages", "Aggregated page and journey activity", rows.length));
  } else if (/\b(guides?|widgets?|checklists?|surveys?|experiences?)\b/.test(lower)) {
    toolNames.push("query_experiences");
    const [current, previous] = await Promise.all([listExperienceAnalytics(db, siteId, { since: range.since, until: range.until }), listExperienceAnalytics(db, siteId, { since: range.previousSince, until: range.previousUntil })]);
    const kind = /guides?/.test(lower) ? "guide" : /checklists?/.test(lower) ? "checklist" : /surveys?/.test(lower) ? "survey" : /widgets?/.test(lower) ? "widget" : null;
    const currentRows = current.experiences.filter(item => item && (!kind || item.experience.kind === kind || item.experience.widgetType === kind));
    const previousById = new Map(previous.experiences.filter(Boolean).map(item => [item!.experience.id, item!]));
    const metrics = currentRows.slice(0, 12).map(item => { const prior = previousById.get(item!.experience.id); return { label: item!.experience.name, value: item!.summary.usersSeen, format: "number" as const, previousValue: prior?.summary.usersSeen ?? 0, deltaPercent: safeDelta(item!.summary.usersSeen, prior?.summary.usersSeen ?? 0) }; });
    if (metrics.length) blocks.push({ type: "metrics", metrics });
    blocks.push({ type: "chart", chart: { type: "bar", title: `${kind ? kind[0].toUpperCase() + kind.slice(1) : "Experience"} performance`, subtitle: `${range.label} vs preceding period`, format: "number", series: [{ key: "current", label: "Current" }, { key: "previous", label: "Previous" }], data: currentRows.slice(0, 10).map(item => ({ label: item!.experience.name, values: { current: item!.summary.usersSeen, previous: previousById.get(item!.experience.id)?.summary.usersSeen ?? 0 } })) } });
    const guide = currentRows.find(item => item!.guide?.steps.length);
    if (guide?.guide) blocks.push({ type: "chart", chart: { type: "funnel", title: `${guide.experience.name} step reach`, format: "number", series: [{ key: "users", label: "Users reached" }], data: guide.guide.steps.map(step => ({ label: `Step ${step.stepIndex + 1}`, values: { users: step.usersReached } })) } });
    retrieved.experiences = currentRows; evidence.push(rangeEvidence("experience.analytics", "Guide, Widget, Survey, and Checklist analytics", currentRows.length));
  } else if (/\bdashboard\b/.test(lower)) {
    toolNames.push("query_saved_dashboard");
    const saved = await db.select().from(dashboards).where(eq(dashboards.siteId, siteId)).orderBy(desc(dashboards.updatedAt)).limit(20); const selected = saved.find(row => lower.includes(row.name.toLowerCase())) ?? saved[0];
    if (selected) {
      const cards = await db.select().from(dashboardCards).where(eq(dashboardCards.dashboardId, selected.id)).orderBy(asc(dashboardCards.position)).limit(24); const values: Array<{ title: string; configuration: ReturnType<typeof cardConfigurationSchema.parse>; result: Result }> = [];
      for (const card of cards) { const parsed = cardConfigurationSchema.safeParse(card.configuration); if (!parsed.success) continue; try { values.push({ title: card.title, configuration: parsed.data, result: await executeAnalyticsQuery(db, siteId, filters, parsed.data) }); } catch { /* unavailable cards remain isolated */ } }
      retrieved.dashboard = { id: selected.id, name: selected.name, cards: values };
      for (const value of values) { const block = value.result.result.kind === "timeseries" ? trendBlock(value.title, value.result) : value.result.result.kind === "breakdown" ? breakdownBlock(value.title, value.result) : scalarBlock([{ label: value.title, metricId: value.configuration.kind === "metric" ? value.configuration.metricId : "", result: value.result }]); if (block) blocks.push(block); }
      evidence.push(rangeEvidence("dashboards.cards", selected.name, values.length));
    }
  } else {
    const eventCatalog = await listEventDefinitions(db, siteId, { since: range.since, until: range.until, limit: 50, offset: 0 });
    const matchedEvent = eventCatalog.events.find(event => lower.includes(event.name.toLowerCase().replace(/_/g, " ")) || lower.includes(event.name.toLowerCase()));
    const isEvent = /\bevent|activation|signup|purchase|checkout/.test(lower) || Boolean(matchedEvent); const breakdown = /\b(by|break.*down).*\b(device|browser|os|event|page)\b/.exec(lower)?.[2] as "device" | "browser" | "os" | "event" | "page" | undefined;
    const metricId: MetricConfiguration["metricId"] = /\b(active users?|dau|users?)\b/.test(lower) ? "users.unique" : /\bsessions?\b/.test(lower) ? "sessions.count" : "events.occurrences"; const label = METRIC_CATALOG.find(item => item.id === metricId)!.label;
    const eventFilter = matchedEvent ? { events: { eventNames: [matchedEvent.name], match: "any" as const } } : {};
    if (/what changed|perform|overview/.test(lower)) {
      toolNames.push("compare_metrics"); const configs = [metric("users.unique"), metric("sessions.count"), metric("events.occurrences")]; const results = await Promise.all(configs.map(config => executeAnalyticsQuery(db, siteId, filters, config)));
      const summary = scalarBlock(results.map((result, index) => ({ label: METRIC_CATALOG.find(item => item.id === configs[index].metricId)!.label, metricId: configs[index].metricId, result }))); if (summary) blocks.push(summary);
      const trends = await Promise.all(["users.unique", "sessions.count", "events.occurrences"].map(metricId => executeAnalyticsQuery(db, siteId, filters, metric(metricId as MetricConfiguration["metricId"], "trend"))));
      const trendTitles = ["Active users over time", "Sessions over time", "Event activity over time"];
      for (const [index, trend] of trends.entries()) { const chart = trendBlock(trendTitles[index], trend); if (chart) blocks.push(chart); }
      const eventBreakdown = await executeAnalyticsQuery(db, siteId, filters, metric("events.occurrences", "breakdown", { breakdown: { dimension: "event" } }));
      const eventBreakdownChart = breakdownBlock("Event activity by name", eventBreakdown); if (eventBreakdownChart) blocks.push(eventBreakdownChart);
      retrieved.metrics = results; retrieved.trends = trends;
    } else if (breakdown) {
      toolNames.push("query_metric_breakdown"); const result = await executeAnalyticsQuery(db, siteId, filters, metric(metricId, "breakdown", { ...eventFilter, breakdown: { dimension: breakdown } })); const chart = breakdownBlock(`${matchedEvent?.name ?? label} by ${breakdown}`, result, formatFor(metricId)); if (chart) blocks.push(chart); retrieved.metric = result;
    } else {
      toolNames.push("query_metric_timeseries"); const result = await executeAnalyticsQuery(db, siteId, filters, metric(metricId, "trend", eventFilter)); const chart = trendBlock(`${matchedEvent?.name ?? label} — ${range.label}`, result, formatFor(metricId)); if (chart) blocks.push(chart); retrieved.metric = result;
    }
    if (isEvent) retrieved.eventCatalog = eventCatalog.events;
    evidence.push(rangeEvidence("analytics.query", label));
  }
  const contentBlocks = withChartIds(blocks.slice(0, 12));
  const availableCharts = contentBlocks.filter((block): block is Extract<AiContentBlock, { type: "chart" }> => block.type === "chart").map(block => ({ chartId: block.chartId, title: block.chart.title, type: block.chart.type, subtitle: block.chart.subtitle }));
  const context = compact({ generatedAt: now.toISOString(), timezone: range.timezone, site: { id: site.id, name: site.name }, range: { label: range.label, since: filters.since, until: filters.until, previousSince: range.previousSince.toISOString(), previousUntil: range.previousUntil.toISOString(), partial: range.partial }, metricDefinitions: analyticsCatalog().metrics, availableCharts, retrieved }); const serialized = JSON.stringify(context);
  return { contextJson: serialized.length > maxChars ? serialized.slice(0, maxChars) + "\n[context truncated]" : serialized, evidence, contentBlocks, toolNames, range };
}
