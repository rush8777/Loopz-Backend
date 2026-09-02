import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, sql, asc, desc, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  sites,
  sessionEvents,
  sessionReplayEvents,
  sessionContexts,
  trackedUserAliases,
  trackedUsers,
  pageDefinitions,
} from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { buildSessionActivityGroups } from "../lib/behavior/sessionActivity.js";
import { matchesRules } from "../lib/pages/pageMatcher.js";
import type { PageRule } from "../lib/pages/types.js";

async function loadSiteInOrg(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site || site.orgId !== orgId) return null;
  return site;
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

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
      const { limit, offset } = parsed.data;

      const rows = await db
        .select({
          sessionId: sessionEvents.sessionId,
          eventCount: sql<number>`count(*)`,
          firstSeen: sql<number>`min(${sessionEvents.timestamp})`,
          lastSeen: sql<number>`max(${sessionEvents.timestamp})`,
          pageVisitCount: sql<number>`sum(case when ${sessionEvents.type} = 'page_view' then 1 else 0 end)`,
          clickCount: sql<number>`sum(case when ${sessionEvents.type} = 'click' then 1 else 0 end)`,
          customEventCount: sql<number>`sum(case when ${sessionEvents.type} = 'custom' then 1 else 0 end)`,
          anonymousId: sql<string | null>`min(${sessionEvents.anonymousId})`,
          anonymousIdCount: sql<number>`count(distinct ${sessionEvents.anonymousId})`,
        })
        .from(sessionEvents)
        .where(eq(sessionEvents.siteId, site.id))
        .groupBy(sessionEvents.sessionId)
        .orderBy(desc(sql`max(${sessionEvents.timestamp})`))
        .limit(limit)
        .offset(offset);

      const sessionIds = rows.map((row) => row.sessionId);
      const anonymousIds = rows.map((row) => row.anonymousId).filter((id): id is string => Boolean(id));
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

      return reply.send({
        sessions: rows.map((r) => {
          const context = contextsBySession.get(r.sessionId);
          const unambiguousAnonymousId = r.anonymousIdCount === 1 ? r.anonymousId : null;
          const identity = unambiguousAnonymousId ? identitiesByAnonymousId.get(unambiguousAnonymousId) : undefined;
          return {
            sessionId: r.sessionId,
            eventCount: r.eventCount,
            firstSeen: new Date(r.firstSeen).toISOString(),
            lastSeen: new Date(r.lastSeen).toISOString(),
            durationMs: r.lastSeen - r.firstSeen,
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
