import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { dashboards, funnels, pageDefinitions, segments, sessionEvents, sites } from "../../db/schema.js";
import { analyticsCatalog } from "../analytics/catalog.js";
import { executeAnalyticsQuery } from "../analytics/queryService.js";
import type { MetricConfiguration } from "../analytics/validation.js";
import { listEventDefinitions } from "../events/eventQueries.js";
import { listExperienceAnalytics } from "../experiences/analytics.js";

const DAY = 86_400_000;
const privateKeys = new Set(["email", "anonymousId", "trackedUserId", "externalUserId", "eventProperties"]);

function minimize(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 50).map(minimize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !privateKeys.has(key))
    .map(([key, item]) => [key, minimize(item)]));
  return typeof value === "string" && value.length > 1500 ? `${value.slice(0, 1500)}…` : value;
}

function metric(metricId: MetricConfiguration["metricId"]): MetricConfiguration {
  return { schemaVersion: 1, kind: "metric", metricId, mode: "single", visualization: "previous_period" } as MetricConfiguration;
}

export interface AiEvidenceItem { source: string; label: string; range?: { since: string; until: string }; sampleSize?: number; limitation?: string }

export async function buildAiContext(db: Db, orgId: string, siteId: string, prompt: string, maxChars: number) {
  const [site] = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1);
  if (!site) return null;
  const until = new Date();
  const since = new Date(until.getTime() - 30 * DAY);
  const range = { since: since.toISOString(), until: until.toISOString() };
  const filters = { ...range, granularity: "day" as const, excludedEventNames: [] as string[] };
  const wantsSessions = /\bsession|journey|timeline\b/i.test(prompt);

  const [usersMetric, sessionsMetric, eventsMetric, eventCatalog, experienceAnalytics, savedDashboards, savedSegments, savedFunnels, pages, pageActivity, recentSessions] = await Promise.all([
    executeAnalyticsQuery(db, siteId, filters, metric("users.unique")),
    executeAnalyticsQuery(db, siteId, filters, metric("sessions.count")),
    executeAnalyticsQuery(db, siteId, filters, metric("events.occurrences")),
    listEventDefinitions(db, siteId, { since, until, limit: 20, offset: 0 }),
    listExperienceAnalytics(db, siteId, { since, until }),
    db.select({ id: dashboards.id, name: dashboards.name, description: dashboards.description }).from(dashboards).where(eq(dashboards.siteId, siteId)).orderBy(desc(dashboards.updatedAt)).limit(20),
    db.select({ id: segments.id, name: segments.name, description: segments.description, definition: segments.definition }).from(segments).where(eq(segments.siteId, siteId)).orderBy(desc(segments.updatedAt)).limit(20),
    db.select({ id: funnels.id, name: funnels.name, description: funnels.description, steps: funnels.steps, conversionWindowMinutes: funnels.conversionWindowMinutes }).from(funnels).where(eq(funnels.siteId, siteId)).orderBy(desc(funnels.updatedAt)).limit(20),
    db.select({ id: pageDefinitions.id, name: pageDefinitions.name, area: pageDefinitions.area, pageType: pageDefinitions.pageType }).from(pageDefinitions).where(eq(pageDefinitions.siteId, siteId)).limit(100),
    db.select({ path: sessionEvents.pagePath, events: sql<number>`count(*)`, sessions: sql<number>`count(distinct ${sessionEvents.sessionId})` }).from(sessionEvents)
      .where(and(eq(sessionEvents.siteId, siteId), gte(sessionEvents.timestamp, since), lte(sessionEvents.timestamp, until), sql`${sessionEvents.pagePath} is not null`))
      .groupBy(sessionEvents.pagePath).orderBy(desc(sql`count(*)`)).limit(20),
    wantsSessions ? db.select({ sessionId: sessionEvents.sessionId, firstObserved: sql<number>`min(${sessionEvents.timestamp})`, lastObserved: sql<number>`max(${sessionEvents.timestamp})`, eventCount: sql<number>`count(*)` })
      .from(sessionEvents).where(and(eq(sessionEvents.siteId, siteId), gte(sessionEvents.timestamp, since), lte(sessionEvents.timestamp, until)))
      .groupBy(sessionEvents.sessionId).orderBy(desc(sql`max(${sessionEvents.timestamp})`)).limit(12) : Promise.resolve([]),
  ]);

  const evidence: AiEvidenceItem[] = [
    { source: "analytics.query", label: "Unique users, sessions, and custom-event occurrences", range },
    { source: "events.catalog", label: "Top event definitions", range, sampleSize: eventCatalog.events.length },
    { source: "experience.analytics", label: "Guide, Widget, Survey, and Checklist performance", range, sampleSize: experienceAnalytics.experiences.length },
    { source: "session_events", label: "Page and session activity", range, limitation: "Observed activity only; replay and causal interpretation are excluded." },
  ];
  const context = minimize({
    generatedAt: until.toISOString(), timezone: "UTC", site: { id: site.id, name: site.name, domain: site.domain }, range,
    metricDefinitions: analyticsCatalog().metrics,
    performance: { uniqueUsers: usersMetric, sessions: sessionsMetric, customEvents: eventsMetric },
    events: eventCatalog.events,
    experiences: experienceAnalytics.experiences,
    pages: { definitions: pages, activity: pageActivity },
    savedResources: { dashboards: savedDashboards, segments: savedSegments, funnels: savedFunnels },
    recentSessions,
  });
  const serialized = JSON.stringify(context);
  return { contextJson: serialized.length > maxChars ? `${serialized.slice(0, maxChars)}\n[context truncated]` : serialized, evidence };
}
