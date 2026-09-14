import type { Db } from "../../db/client.js";
import { segments, sessionEvents } from "../../db/schema.js";
import { and, eq, gte, lte } from "drizzle-orm";
import { evaluateSegment } from "../segments/evaluator.js";
import type { SegmentDefinition } from "../segments/types.js";
import { addBucket, bucketKey, createBuckets, floorUtc } from "./buckets.js";
import type { DashboardFilters, RetentionConfiguration } from "./validation.js";

type EventRef = RetentionConfiguration["startEvent"];
interface RetentionFact { identity: string; type: string; eventName: string | null; at: Date }

function meaningful(f: RetentionFact, exclusions: Set<string>) {
  return ["page_view", "click", "scroll", "custom"].includes(f.type) && !(f.type === "custom" && f.eventName && exclusions.has(f.eventName));
}
function matches(f: RetentionFact, ref: EventRef, exclusions: Set<string>) {
  return ref.type === "event" ? f.type === "custom" && f.eventName === ref.eventName : meaningful(f, exclusions);
}
function offsetBetween(start: Date, value: Date, grain: DashboardFilters["granularity"]): number {
  let cursor = floorUtc(start, grain), offset = 0;
  const target = floorUtc(value, grain).getTime();
  while (cursor.getTime() < target && offset <= 400) { cursor = addBucket(cursor, grain); offset++; }
  return cursor.getTime() === target ? offset : -1;
}

export async function computeRetention(db: Db, siteId: string, filters: DashboardFilters, config: RetentionConfiguration) {
  const exclusions = new Set(filters.excludedEventNames);
  const facts = (await db.select({ type: sessionEvents.type, eventName: sessionEvents.eventName, at: sessionEvents.timestamp, anonymousId: sessionEvents.anonymousId, trackedUserId: sessionEvents.trackedUserId })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.siteId, siteId), gte(sessionEvents.timestamp, new Date(filters.since)), lte(sessionEvents.timestamp, new Date(filters.until)))))
    .map((r) => ({ identity: r.trackedUserId ?? r.anonymousId, type: r.type, eventName: r.eventName, at: r.at })).filter((r): r is RetentionFact => Boolean(r.identity));

  let allowed: Set<string> | undefined;
  if (filters.segmentId) {
    const [row] = await db.select().from(segments).where(and(eq(segments.id, filters.segmentId), eq(segments.siteId, siteId))).limit(1);
    allowed = row ? await evaluateSegment(db, siteId, row.definition as SegmentDefinition) : new Set();
  }
  const scoped = allowed ? facts.filter((f) => allowed!.has(f.identity)) : facts;
  const firstStarts = new Map<string, Date>();
  for (const f of scoped.filter((x) => matches(x, config.startEvent, exclusions)).sort((a, b) => a.at.getTime() - b.at.getTime())) if (!firstStarts.has(f.identity)) firstStarts.set(f.identity, f.at);
  const returns = new Map<string, Date[]>();
  for (const f of scoped.filter((x) => matches(x, config.returnEvent, exclusions))) { const list = returns.get(f.identity) ?? []; list.push(f.at); returns.set(f.identity, list); }

  const cohorts: { key: string; label: string; identities: Set<string>; currentSegmentComparison?: boolean }[] = [];
  if (config.cohort.type === "start_date") {
    for (const bucket of createBuckets(filters)) cohorts.push({ key: bucket.key, label: bucket.label, identities: new Set([...firstStarts].filter(([, at]) => bucketKey(at, filters.granularity) === bucket.key).map(([id]) => id)) });
  } else {
    for (const segmentId of config.cohort.segmentIds) {
      const [row] = await db.select().from(segments).where(and(eq(segments.id, segmentId), eq(segments.siteId, siteId))).limit(1);
      if (!row) continue;
      const members = await evaluateSegment(db, siteId, row.definition as SegmentDefinition);
      cohorts.push({ key: segmentId, label: row.name, identities: new Set([...firstStarts.keys()].filter((id) => members.has(id))), currentSegmentComparison: true });
    }
  }
  const observable = Math.min(new Date(filters.until).getTime(), Date.now());
  const maxOffsets = Math.max(0, createBuckets(filters).length - 1);
  const rows = cohorts.filter((c) => c.identities.size > 0).map((cohort) => {
    const cells = Array.from({ length: maxOffsets + 1 }, (_, offset) => {
      let retained = 0, eligible = 0;
      for (const id of cohort.identities) {
        const start = firstStarts.get(id)!;
        const end = addBucket(floorUtc(start, filters.granularity), filters.granularity, offset + 1);
        if (floorUtc(start, filters.granularity).getTime() > observable || addBucket(floorUtc(start, filters.granularity), filters.granularity, offset).getTime() > observable) continue;
        eligible++;
        if ((returns.get(id) ?? []).some((at) => at >= start && offsetBetween(start, at, filters.granularity) === offset)) retained++;
        void end;
      }
      const sampleStart = [...cohort.identities][0] ? firstStarts.get([...cohort.identities][0])! : new Date(filters.since);
      const incomplete = addBucket(floorUtc(sampleStart, filters.granularity), filters.granularity, offset + 1).getTime() > observable;
      return { offset, label: `${filters.granularity === "day" ? "D" : filters.granularity === "week" ? "W" : "M"}${offset}`, retainedUsers: retained, percentage: eligible ? Math.round(retained / cohort.identities.size * 1000) / 10 : 0, incomplete };
    });
    return { key: cohort.key, label: cohort.label, size: cohort.identities.size, smallCohort: cohort.identities.size < 20, currentSegmentComparison: Boolean(cohort.currentSegmentComparison), cells };
  });
  const trend = Array.from({ length: maxOffsets + 1 }, (_, offset) => ({ offset, label: `${filters.granularity === "day" ? "D" : filters.granularity === "week" ? "W" : "M"}${offset}`, values: Object.fromEntries(rows.map((r) => [r.key, r.cells[offset]?.percentage ?? 0])) }));
  return { kind: "retention" as const, rows, trend };
}
