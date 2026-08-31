import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { sessionEvents, trackedUserAliases, pageDefinitions, segments as segmentsTable } from "../../db/schema.js";
import { resolveMatchedPagePaths, evaluateSegment } from "../segments/evaluator.js";
import type { SegmentDefinition } from "../segments/types.js";
import { hydrateIdentities, type IdentitySummary, type IdentityKey } from "../identity/hydrate.js";
import type { FunnelStep } from "./types.js";
import { funnelStepLabel } from "./types.js";

/**
 * The Funnel Evaluation Engine (task brief section 20) -
 * `evaluateFunnel(db, siteId, steps, range, options)`. Route handlers
 * (routes/funnels.ts) are thin wrappers around this, same
 * "reusable service, not route logic" precedent as
 * lib/segments/evaluator.ts and lib/events/eventQueries.ts.
 *
 * Reuses rather than re-derives (task brief section 21):
 * - Identity resolution: the exact `identityExpr` coalesce over
 *   `tracked_user_aliases` used by Segments and the Event Explorer.
 * - Page steps: `resolveMatchedPagePaths`, imported directly from
 *   lib/segments/evaluator.ts, not reimplemented here.
 * - Segment filtering (task brief section 17): calls
 *   `evaluateSegment` from lib/segments/evaluator.ts as-is - this
 *   file never modifies or duplicates that evaluator.
 * - Result hydration (task brief section 18): `hydrateIdentities`,
 *   shared with Segments' member list, so both link back to the same
 *   existing User Profile / Anonymous Visitor pages.
 *
 * No `funnel_results` table (task brief section 22): every call
 * recomputes progression from current session_events data.
 */

export interface DateRangeRequired {
  since: Date;
  until: Date;
}

const identityExpr = sql<string>`coalesce(${trackedUserAliases.trackedUserId}, ${sessionEvents.anonymousId})`;

// Defensive cap on rows pulled per step for in-memory sequence matching -
// keeps a single funnel evaluation bounded even for a very high-volume
// event. A real high-scale implementation would push the ordering/window
// logic into SQL (window functions); V1 keeps this in JS for clarity, and
// this cap is the honest acknowledgment of that tradeoff (see the
// "Performance" note in the final report).
const MAX_ROWS_PER_STEP = 50_000;

/** Every (identity, timestamp) pair for one funnel step within [since, until], as a per-identity sorted-ascending timestamp list - the raw material computeFunnelProgression sequence-matches against. */
async function fetchStepTimestamps(db: Db, siteId: string, step: FunnelStep, since: Date, until: Date): Promise<Map<IdentityKey, number[]>> {
  const result = new Map<IdentityKey, number[]>();

  const baseConditions = [eq(sessionEvents.siteId, siteId), gte(sessionEvents.timestamp, since), lte(sessionEvents.timestamp, until)];

  if (step.type === "event") {
    baseConditions.push(eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, step.eventName));
  } else {
    const matchedPaths = await resolveMatchedPagePaths(db, siteId, step.pageId);
    if (!matchedPaths || matchedPaths.length === 0) return result; // dangling/cross-site page reference or a Page nothing currently matches
    baseConditions.push(eq(sessionEvents.type, "page_view"), inArray(sessionEvents.pagePath, matchedPaths));
  }

  const rows = await db
    .select({ identity: identityExpr, timestamp: sessionEvents.timestamp })
    .from(sessionEvents)
    .leftJoin(
      trackedUserAliases,
      and(eq(trackedUserAliases.siteId, sessionEvents.siteId), eq(trackedUserAliases.anonymousId, sessionEvents.anonymousId))
    )
    .where(and(...baseConditions))
    .orderBy(sessionEvents.timestamp)
    .limit(MAX_ROWS_PER_STEP);

  for (const r of rows) {
    if (!r.identity) continue;
    const arr = result.get(r.identity);
    if (arr) arr.push(r.timestamp.getTime());
    else result.set(r.identity, [r.timestamp.getTime()]);
  }
  return result;
}

export interface FunnelProgressionRow {
  identity: IdentityKey;
  /** One entry per step, same length/order as `steps`. `stepTimestamps[0]` is always set (it's what put this identity in the progression at all); a later `null` means the funnel broke at that step and every entry after it is also `null` - drop-off is terminal, matching task brief section 5's ordering requirement. */
  stepTimestamps: (number | null)[];
}

/**
 * Sequence-matches each candidate identity through `steps` in order.
 * A step N timestamp must be strictly after step N-1's timestamp and
 * within `windowMinutes` of the *first* step's timestamp (task brief
 * section 9: the window is "relative to the funnel journey", i.e.
 * anchored to when the user entered the funnel, not re-armed at every
 * step) - this is a documented V1 semantic, consistent with how most
 * funnel tools define a single conversion window per funnel.
 */
export async function computeFunnelProgression(
  db: Db,
  siteId: string,
  steps: FunnelStep[],
  range: DateRangeRequired,
  windowMinutes: number,
  allowedIdentities?: Set<IdentityKey>
): Promise<FunnelProgressionRow[]> {
  if (steps.length === 0) return [];
  const windowMs = windowMinutes * 60 * 1000;

  const firstStepMap = await fetchStepTimestamps(db, siteId, steps[0], range.since, range.until);
  // Later steps may complete after `until` if they're still inside the
  // conversion window - so their query range is widened accordingly.
  const laterStepMaps = await Promise.all(
    steps.slice(1).map((s) => fetchStepTimestamps(db, siteId, s, range.since, new Date(range.until.getTime() + windowMs)))
  );

  const results: FunnelProgressionRow[] = [];
  for (const [identity, timestamps] of firstStepMap) {
    if (allowedIdentities && !allowedIdentities.has(identity)) continue;

    const anchor = timestamps[0]; // earliest step-1 occurrence in range
    const stepTimestamps: (number | null)[] = [anchor];
    let cursor = anchor;
    let broken = false;

    for (const stepMap of laterStepMaps) {
      if (broken) {
        stepTimestamps.push(null);
        continue;
      }
      const candidates = stepMap.get(identity);
      const next = candidates?.find((ts) => ts > cursor && ts <= anchor + windowMs);
      if (next === undefined) {
        broken = true;
        stepTimestamps.push(null);
      } else {
        stepTimestamps.push(next);
        cursor = next;
      }
    }

    results.push({ identity, stepTimestamps });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Summary (task brief sections 6, 10, 16)

export interface FunnelStepResult {
  index: number;
  type: "event" | "page";
  label: string;
  eventName?: string;
  pageId?: string;
  users: number;
  /** Percent of step 1's users who reached this step. 100 for step 1 itself. */
  conversionFromStart: number;
  /** Percent of the *previous* step's users who reached this step. 100 for step 1 itself. */
  conversionFromPrevious: number;
  droppedBeforeNext: number;
}

export interface FunnelSummary {
  steps: FunnelStepResult[];
  totalUsers: number;
  convertedUsers: number;
  overallConversion: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function summarizeFunnel(steps: FunnelStep[], stepLabels: string[], progression: FunnelProgressionRow[]): FunnelSummary {
  const counts = steps.map((_, i) => progression.reduce((n, row) => n + (row.stepTimestamps[i] !== null ? 1 : 0), 0));
  const totalUsers = counts[0] ?? 0;

  const stepResults: FunnelStepResult[] = steps.map((step, i) => {
    const users = counts[i];
    const previousUsers = i === 0 ? users : counts[i - 1];
    return {
      index: i,
      type: step.type,
      label: stepLabels[i],
      eventName: step.type === "event" ? step.eventName : undefined,
      pageId: step.type === "page" ? step.pageId : undefined,
      users,
      conversionFromStart: totalUsers === 0 ? 0 : round1((users / totalUsers) * 100),
      conversionFromPrevious: i === 0 ? 100 : previousUsers === 0 ? 0 : round1((users / previousUsers) * 100),
      droppedBeforeNext: i < steps.length - 1 ? Math.max(0, users - counts[i + 1]) : 0,
    };
  });

  const convertedUsers = counts[counts.length - 1] ?? 0;
  return {
    steps: stepResults,
    totalUsers,
    convertedUsers,
    overallConversion: totalUsers === 0 ? 0 : round1((convertedUsers / totalUsers) * 100),
  };
}

// ---------------------------------------------------------------------------
// Trend (task brief section 15) - derived from the same progression pass,
// bucketed by the UTC day each identity entered the funnel (step 1's
// timestamp), rather than re-running the whole evaluation once per day.

export interface FunnelTrendPoint {
  date: string; // YYYY-MM-DD, UTC
  startedUsers: number;
  convertedUsers: number;
  conversion: number;
}

const MAX_TREND_DAYS = 120; // same defensive-cap spirit as eventQueries.ts's MAX_TIMESERIES_DAYS

function toUtcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function computeFunnelTrend(progression: FunnelProgressionRow[], range: DateRangeRequired, stepCount: number): FunnelTrendPoint[] {
  const byDay = new Map<string, { started: number; converted: number }>();
  for (const row of progression) {
    const day = toUtcDay(row.stepTimestamps[0]!);
    const bucket = byDay.get(day) ?? { started: 0, converted: 0 };
    bucket.started += 1;
    if (stepCount > 0 && row.stepTimestamps[stepCount - 1] !== null) bucket.converted += 1;
    byDay.set(day, bucket);
  }

  const points: FunnelTrendPoint[] = [];
  const cursor = new Date(Date.UTC(range.since.getUTCFullYear(), range.since.getUTCMonth(), range.since.getUTCDate()));
  const end = new Date(Date.UTC(range.until.getUTCFullYear(), range.until.getUTCMonth(), range.until.getUTCDate()));
  for (let i = 0; cursor.getTime() <= end.getTime() && i < MAX_TREND_DAYS; i++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.toISOString().slice(0, 10);
    const bucket = byDay.get(day);
    const started = bucket?.started ?? 0;
    const converted = bucket?.converted ?? 0;
    points.push({ date: day, startedUsers: started, convertedUsers: converted, conversion: started === 0 ? 0 : round1((converted / started) * 100) });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Entry points

export interface FunnelEvaluationOptions {
  /** Restricts step-1 candidates to a saved Segment's current membership (task brief section 17). Evaluated via the existing, unmodified Segment evaluator. */
  segmentId?: string;
}

export interface FunnelResult extends FunnelSummary {
  trend: FunnelTrendPoint[];
}

async function resolveStepLabels(db: Db, siteId: string, steps: FunnelStep[]): Promise<string[]> {
  const pageIds = steps.filter((s): s is Extract<FunnelStep, { type: "page" }> => s.type === "page" && !s.label).map((s) => s.pageId);
  const pageNames = new Map<string, string>();
  if (pageIds.length > 0) {
    const rows = await db
      .select({ id: pageDefinitions.id, name: pageDefinitions.name })
      .from(pageDefinitions)
      .where(and(eq(pageDefinitions.siteId, siteId), inArray(pageDefinitions.id, pageIds)));
    for (const r of rows) pageNames.set(r.id, r.name);
  }
  return steps.map((step) => {
    if (step.label) return step.label;
    if (step.type === "page") return pageNames.get(step.pageId) ?? funnelStepLabel(step);
    return funnelStepLabel(step);
  });
}

async function resolveAllowedIdentities(db: Db, siteId: string, segmentId?: string): Promise<Set<IdentityKey> | undefined> {
  if (!segmentId) return undefined;
  const [row] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, segmentId)).limit(1);
  if (!row || row.siteId !== siteId) return new Set(); // dangling/cross-site segment reference - matches nobody rather than silently ignoring the filter
  return evaluateSegment(db, siteId, row.definition as SegmentDefinition);
}

/** The single entry point for computing a funnel's conversion result over a date range - what routes/funnels.ts's analyze endpoint wraps. */
export async function evaluateFunnel(
  db: Db,
  siteId: string,
  steps: FunnelStep[],
  range: DateRangeRequired,
  windowMinutes: number,
  opts: FunnelEvaluationOptions = {}
): Promise<FunnelResult> {
  if (steps.length === 0) {
    return { steps: [], totalUsers: 0, convertedUsers: 0, overallConversion: 0, trend: [] };
  }
  const [allowedIdentities, stepLabels] = await Promise.all([
    resolveAllowedIdentities(db, siteId, opts.segmentId),
    resolveStepLabels(db, siteId, steps),
  ]);
  const progression = await computeFunnelProgression(db, siteId, steps, range, windowMinutes, allowedIdentities);
  const summary = summarizeFunnel(steps, stepLabels, progression);
  const trend = computeFunnelTrend(progression, range, steps.length);
  return { ...summary, trend };
}

/** Paginated, hydrated user list for a single funnel step (task brief section 18) - links back to the existing User Profile / Anonymous Visitor pages via the same hydrateIdentities helper Segments uses. */
export async function getFunnelStepUsers(
  db: Db,
  siteId: string,
  steps: FunnelStep[],
  range: DateRangeRequired,
  windowMinutes: number,
  stepIndex: number,
  opts: FunnelEvaluationOptions & { limit: number; offset: number }
): Promise<{ users: IdentitySummary[]; total: number }> {
  if (stepIndex < 0 || stepIndex >= steps.length) return { users: [], total: 0 };
  const allowedIdentities = await resolveAllowedIdentities(db, siteId, opts.segmentId);
  const progression = await computeFunnelProgression(db, siteId, steps, range, windowMinutes, allowedIdentities);
  const ids = progression.filter((row) => row.stepTimestamps[stepIndex] !== null).map((row) => row.identity);
  const total = ids.length;
  const page = ids.slice(opts.offset, opts.offset + opts.limit);
  const users = await hydrateIdentities(db, siteId, page);
  return { users, total };
}
