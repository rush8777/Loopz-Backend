import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, sql, asc, desc, inArray, gte, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  sites,
  sessionEvents,
  sessionReplayEvents,
  sessionContexts,
  trackedUserAliases,
  trackedUsers,
  pageDefinitions,
  segments,
} from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { buildSessionActivityGroups } from "../lib/behavior/sessionActivity.js";
import { matchesRules } from "../lib/pages/pageMatcher.js";
import type { PageRule } from "../lib/pages/types.js";
import { evaluateSegment, resolveMatchedPagePaths } from "../lib/segments/evaluator.js";
import type { SegmentDefinition } from "../lib/segments/types.js";

async function loadSiteInOrg(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site || site.orgId !== orgId) return null;
  return site;
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().min(1).max(200).optional(),
  since: z.coerce.date().optional(), until: z.coerce.date().optional(), segmentId: z.string().min(1).max(100).optional(),
  visitorType: z.enum(["identified", "anonymous"]).optional(), pageId: z.string().min(1).max(100).optional(), eventName: z.string().min(1).max(200).optional(),
  hasReplay: z.enum(["true", "false"]).optional(), deviceType: z.enum(["desktop", "mobile", "tablet"]).optional(),
  minDurationMs: z.coerce.number().int().min(0).optional(), maxDurationMs: z.coerce.number().int().min(0).optional(),
  sort: z.enum(["newest", "oldest", "longest", "shortest", "activity", "clicks"]).default("newest"),
}).refine((query) => query.minDurationMs === undefined || query.maxDurationMs === undefined || query.minDurationMs <= query.maxDurationMs, { message: "minDurationMs must be less than maxDurationMs" });

export function registerSessionRoutes(app: FastifyInstance, db: Db) {
  /**
   * Session list for the Observe > Sessions page. Aggregated directly
   * off session_events (there's no separate "sessions" table - a
   * session is just the set of events sharing a sessionId), sorted by
   * most recent activity. FullSnapshot availability is included per row
   * so the dashboard can show a "replay available" indicator without a
   * second round trip per session.
   */
  app.get(
    "/orgs/:orgId/sites/:siteId/sessions",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      }
      const { limit, offset, search, since, until, segmentId, visitorType, pageId, eventName, hasReplay, deviceType, minDurationMs, maxDurationMs, sort } = parsed.data;
      const conditions = [eq(sessionEvents.siteId, site.id)];
      if (since) conditions.push(gte(sessionEvents.timestamp, since));
      if (until) conditions.push(lte(sessionEvents.timestamp, until));
      // The list intentionally groups all matching raw events before applying any
      // filter, sort, or slice. This is what makes server-side search and totals
      // accurate beyond the first 25 rows.
      const rawEvents = await db.select({ sessionId: sessionEvents.sessionId, timestamp: sessionEvents.timestamp, type: sessionEvents.type, anonymousId: sessionEvents.anonymousId, pagePath: sessionEvents.pagePath, eventName: sessionEvents.eventName }).from(sessionEvents).where(and(...conditions));
      const grouped = new Map<string, { sessionId: string; firstSeen: Date; lastSeen: Date; eventCount: number; pageVisitCount: number; clickCount: number; customEventCount: number; anonymousIds: Set<string>; paths: Set<string>; eventNames: Set<string> }>();
      for (const event of rawEvents) {
        const row = grouped.get(event.sessionId) ?? { sessionId: event.sessionId, firstSeen: event.timestamp, lastSeen: event.timestamp, eventCount: 0, pageVisitCount: 0, clickCount: 0, customEventCount: 0, anonymousIds: new Set(), paths: new Set(), eventNames: new Set() };
        row.eventCount++; if (event.timestamp < row.firstSeen) row.firstSeen = event.timestamp; if (event.timestamp > row.lastSeen) row.lastSeen = event.timestamp;
        if (event.type === "page_view") row.pageVisitCount++; if (event.type === "click") row.clickCount++; if (event.type === "custom") row.customEventCount++;
        if (event.anonymousId) row.anonymousIds.add(event.anonymousId); if (event.pagePath) row.paths.add(event.pagePath); if (event.eventName) row.eventNames.add(event.eventName);
        grouped.set(event.sessionId, row);
      }
      const rows = [...grouped.values()];
      const sessionIds = rows.map((row) => row.sessionId);
      const anonymousIds = [...new Set(rows.flatMap((row) => [...row.anonymousIds]))];
      const [replayRows, contextRows, identityRows] = await Promise.all([
        sessionIds.length
          ? db
              .selectDistinct({ sessionId: sessionReplayEvents.sessionId })
              .from(sessionReplayEvents)
              .where(and(eq(sessionReplayEvents.siteId, site.id), inArray(sessionReplayEvents.sessionId, sessionIds)))
          : [],
        sessionIds.length
          ? db
              .select()
              .from(sessionContexts)
              .where(and(eq(sessionContexts.siteId, site.id), inArray(sessionContexts.sessionId, sessionIds)))
          : [],
        anonymousIds.length
          ? db
              .select({
                anonymousId: trackedUserAliases.anonymousId,
                trackedUserId: trackedUsers.id,
                externalUserId: trackedUsers.externalUserId,
              })
              .from(trackedUserAliases)
              .innerJoin(trackedUsers, eq(trackedUsers.id, trackedUserAliases.trackedUserId))
              .where(and(eq(trackedUserAliases.siteId, site.id), inArray(trackedUserAliases.anonymousId, anonymousIds)))
          : [],
      ]);
      const replaySessionIds = new Set(replayRows.map((row) => row.sessionId));
      const contextsBySession = new Map(contextRows.map((row) => [row.sessionId, row]));
      const identitiesByAnonymousId = new Map(identityRows.map((row) => [row.anonymousId, row]));

      let members: Set<string> | undefined;
      if (segmentId) {
        const [segment] = await db.select().from(segments).where(eq(segments.id, segmentId)).limit(1);
        if (!segment || segment.siteId !== site.id) return reply.code(400).send({ error: "invalid_segment" });
        members = await evaluateSegment(db, site.id, segment.definition as SegmentDefinition);
      }
      let pagePaths: string[] | undefined;
      if (pageId) {
        const resolved = await resolveMatchedPagePaths(db, site.id, pageId);
        if (resolved === null) return reply.code(400).send({ error: "invalid_page" });
        pagePaths = resolved;
      }
      if (eventName) {
        const [event] = await db.select({ id: sessionEvents.id }).from(sessionEvents).where(and(eq(sessionEvents.siteId, site.id), eq(sessionEvents.type, "custom"), eq(sessionEvents.eventName, eventName))).limit(1);
        if (!event) return reply.code(400).send({ error: "invalid_event" });
      }
      const filtered = rows.filter((row) => {
        const unambiguous = row.anonymousIds.size === 1 ? [...row.anonymousIds][0] : undefined;
        const identity = unambiguous ? identitiesByAnonymousId.get(unambiguous) : undefined;
        const identities = [...row.anonymousIds].map((id) => identitiesByAnonymousId.get(id)?.trackedUserId ?? id);
        const duration = row.lastSeen.getTime() - row.firstSeen.getTime();
        const haystack = [row.sessionId, ...row.anonymousIds, ...[...row.anonymousIds].map((id) => identitiesByAnonymousId.get(id)?.externalUserId ?? "")].join(" ").toLowerCase();
        return (!search || haystack.includes(search.toLowerCase()))
          && (!members || identities.some((id) => members!.has(id)))
          && (!visitorType || (visitorType === "identified" ? Boolean(identity) : !identity))
          && (!pagePaths || [...row.paths].some((path) => pagePaths!.includes(path)))
          && (!eventName || row.eventNames.has(eventName))
          && (!hasReplay || replaySessionIds.has(row.sessionId) === (hasReplay === "true"))
          && (!deviceType || contextsBySession.get(row.sessionId)?.deviceType === deviceType)
          && (minDurationMs === undefined || duration >= minDurationMs)
          && (maxDurationMs === undefined || duration <= maxDurationMs);
      });
      filtered.sort((a, b) => { const ad = a.lastSeen.getTime() - a.firstSeen.getTime(); const bd = b.lastSeen.getTime() - b.firstSeen.getTime(); switch (sort) { case "oldest": return a.lastSeen.getTime() - b.lastSeen.getTime(); case "longest": return bd - ad; case "shortest": return ad - bd; case "activity": return b.eventCount - a.eventCount; case "clicks": return b.clickCount - a.clickCount; default: return b.lastSeen.getTime() - a.lastSeen.getTime(); } });
      const total = filtered.length;
      const pageRows = filtered.slice(offset, offset + limit);

      return reply.send({
        sessions: pageRows.map((r) => {
          const context = contextsBySession.get(r.sessionId);
          const unambiguousAnonymousId = r.anonymousIds.size === 1 ? [...r.anonymousIds][0] : null;
          const identity = unambiguousAnonymousId ? identitiesByAnonymousId.get(unambiguousAnonymousId) : undefined;
          return {
            sessionId: r.sessionId,
            eventCount: r.eventCount,
            firstSeen: r.firstSeen.toISOString(),
            lastSeen: r.lastSeen.toISOString(),
            durationMs: r.lastSeen.getTime() - r.firstSeen.getTime(),
            pageVisitCount: r.pageVisitCount,
            clickCount: r.clickCount,
            customEventCount: r.customEventCount,
            visitor: identity
              ? { type: "identified" as const, id: identity.trackedUserId, label: identity.externalUserId }
              : unambiguousAnonymousId
                ? { type: "anonymous" as const, id: unambiguousAnonymousId, label: unambiguousAnonymousId }
                : null,
            deviceType: context?.deviceType ?? null,
            browserName: context?.browserName ?? null,
            osName: context?.osName ?? null,
            hasReplay: replaySessionIds.has(r.sessionId),
          };
        }),
        limit,
        offset,
        total,
      });
    }
  );

  /** Compact, page-grouped session presentation. The existing raw-detail endpoint above remains unchanged. */
  app.get(
    "/orgs/:orgId/sites/:siteId/sessions/:sessionId/activity",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, sessionId } = request.params as { siteId: string; sessionId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const rows = await db
        .select()
        .from(sessionEvents)
        .where(and(eq(sessionEvents.siteId, site.id), eq(sessionEvents.sessionId, sessionId)))
        .orderBy(asc(sessionEvents.timestamp), asc(sessionEvents.id));
      if (rows.length === 0) return reply.code(404).send({ error: "session_not_found" });

      const definitions = await db.select().from(pageDefinitions).where(eq(pageDefinitions.siteId, site.id));
      const resolvePageName = (path: string) => {
        const matches = definitions.filter((definition) => matchesRules(path, definition.rules as PageRule[]));
        return matches.length === 1 ? matches[0].name : null;
      };
      const groups = buildSessionActivityGroups(rows, resolvePageName);
      const anonymousIds = [...new Set(rows.map((row) => row.anonymousId).filter((id): id is string => Boolean(id)))];
      const [contextRows, identityRows, replayRows] = await Promise.all([
        db
          .select()
          .from(sessionContexts)
          .where(and(eq(sessionContexts.siteId, site.id), eq(sessionContexts.sessionId, sessionId)))
          .limit(1),
        anonymousIds.length === 1
          ? db
              .select({
                anonymousId: trackedUserAliases.anonymousId,
                trackedUserId: trackedUsers.id,
                externalUserId: trackedUsers.externalUserId,
              })
              .from(trackedUserAliases)
              .innerJoin(trackedUsers, eq(trackedUsers.id, trackedUserAliases.trackedUserId))
              .where(and(eq(trackedUserAliases.siteId, site.id), inArray(trackedUserAliases.anonymousId, anonymousIds)))
              .limit(1)
          : [],
        db
          .select({ id: sessionReplayEvents.id })
          .from(sessionReplayEvents)
          .where(and(eq(sessionReplayEvents.siteId, site.id), eq(sessionReplayEvents.sessionId, sessionId)))
          .limit(1),
      ]);
      const first = rows[0].timestamp;
      const last = rows[rows.length - 1].timestamp;
      const identity = identityRows[0];
      const anonymousId = anonymousIds.length === 1 ? anonymousIds[0] : undefined;
      const context = contextRows[0];

      return reply.send({
        sessionId,
        hasReplay: replayRows.length > 0,
        visitor: identity
          ? { type: "identified", id: identity.trackedUserId, label: identity.externalUserId }
          : anonymousId
            ? { type: "anonymous", id: anonymousId, label: anonymousId }
            : null,
        firstObserved: first.toISOString(),
        lastObserved: last.toISOString(),
        observedDurationMs: last.getTime() - first.getTime(),
        counts: {
          pageVisits: rows.filter((row) => row.type === "page_view").length,
          clicks: rows.filter((row) => row.type === "click").length,
          customEvents: rows.filter((row) => row.type === "custom").length,
        },
        environment: context
          ? {
              browserName: context.browserName,
              browserVersion: context.browserVersion,
              osName: context.osName,
              osVersion: context.osVersion,
              deviceType: context.deviceType,
              language: context.language,
              timezone: context.timezone,
              screenWidth: context.screenWidth,
              screenHeight: context.screenHeight,
              referrer: context.referrer,
            }
          : null,
        pages: groups,
        coverage: {
          complete: true,
          rawEventCount: rows.length,
          cursorSampleCount: rows.filter((row) => row.type === "cursor").length,
        },
        limitations: {
          observedDuration: "Elapsed time between the first and last recorded event; it is not active time.",
          hover: "Hover duration is reported after pointer leave and was not visibility-verified; its start is estimated when it stays within the page boundary.",
          pointer: "Pointer proximity uses recorded interaction coordinates as a proxy, not verified historical element bounds. No cursor trace is reconstructed.",
        },
      });
    }
  );

  /** Full ordered event timeline for one session - the Observe > Sessions detail view. */
  app.get(
    "/orgs/:orgId/sites/:siteId/sessions/:sessionId",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, sessionId } = request.params as { siteId: string; sessionId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const rows = await db
        .select()
        .from(sessionEvents)
        .where(and(eq(sessionEvents.siteId, site.id), eq(sessionEvents.sessionId, sessionId)))
        .orderBy(asc(sessionEvents.timestamp));

      if (rows.length === 0) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const [hasReplayRow] = await db
        .select({ id: sessionReplayEvents.id })
        .from(sessionReplayEvents)
        .where(and(eq(sessionReplayEvents.siteId, site.id), eq(sessionReplayEvents.sessionId, sessionId)))
        .limit(1);

      return reply.send({
        sessionId,
        hasReplay: Boolean(hasReplayRow),
        events: rows.map((r) => ({
          id: r.id,
          type: r.type,
          timestamp: r.timestamp.toISOString(),
          eventId: r.eventId,
          pageViewId: r.pageViewId,
          pagePath: r.pagePath,
          selector: r.selector,
          elementLabel: r.elementLabel,
          elementRole: r.elementRole,
          durationMs: r.durationMs,
          scrollPercent: r.scrollPercent,
          x: r.x,
          y: r.y,
          viewportWidth: r.viewportWidth,
          viewportHeight: r.viewportHeight,
          // custom events only (type === "custom") - the developer-defined
          // event's name and JSON-serializable properties, carried
          // through from session_events.eventName/eventProperties
          // unchanged. null for every other event type.
          name: r.eventName,
          properties: r.eventProperties,
        })),
      });
    }
  );

  /**
   * The first FullSnapshot (rrweb event type 2) for a session - exactly
   * what the Heatmaps page needs to render a static screenshot via
   * rrweb-snapshot's rebuild(), without shipping the full replay stream.
   */
  app.get(
    "/orgs/:orgId/sites/:siteId/sessions/:sessionId/snapshot",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, sessionId } = request.params as { siteId: string; sessionId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const [snapshot] = await db
        .select()
        .from(sessionReplayEvents)
        .where(
          and(
            eq(sessionReplayEvents.siteId, site.id),
            eq(sessionReplayEvents.sessionId, sessionId),
            eq(sessionReplayEvents.rrwebType, 2)
          )
        )
        .orderBy(asc(sessionReplayEvents.seq))
        .limit(1);

      if (!snapshot) {
        return reply.code(404).send({ error: "snapshot_not_found" });
      }

      return reply.send({ sessionId, timestamp: snapshot.timestamp.toISOString(), data: snapshot.data });
    }
  );

  /** Full ordered rrweb event stream for a session - for playback (rrweb-player), not just the initial snapshot. */
  app.get(
    "/orgs/:orgId/sites/:siteId/sessions/:sessionId/replay",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, sessionId } = request.params as { siteId: string; sessionId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const rows = await db
        .select()
        .from(sessionReplayEvents)
        .where(and(eq(sessionReplayEvents.siteId, site.id), eq(sessionReplayEvents.sessionId, sessionId)))
        .orderBy(asc(sessionReplayEvents.seq));

      if (rows.length === 0) {
        return reply.code(404).send({ error: "replay_not_found" });
      }

      return reply.send({
        sessionId,
        events: rows.map((r) => ({ type: r.rrwebType, timestamp: r.timestamp.getTime(), data: r.data })),
      });
    }
  );
}
