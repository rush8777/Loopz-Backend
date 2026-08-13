import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, sql, asc, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sites, sessionEvents, sessionReplayEvents } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";

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
        })
        .from(sessionEvents)
        .where(eq(sessionEvents.siteId, site.id))
        .groupBy(sessionEvents.sessionId)
        .orderBy(desc(sql`max(${sessionEvents.timestamp})`))
        .limit(limit)
        .offset(offset);

      const replaySessionIds = new Set(
        (
          await db
            .selectDistinct({ sessionId: sessionReplayEvents.sessionId })
            .from(sessionReplayEvents)
            .where(eq(sessionReplayEvents.siteId, site.id))
        ).map((r) => r.sessionId)
      );

      return reply.send({
        sessions: rows.map((r) => ({
          sessionId: r.sessionId,
          eventCount: r.eventCount,
          firstSeen: new Date(r.firstSeen).toISOString(),
          lastSeen: new Date(r.lastSeen).toISOString(),
          durationMs: r.lastSeen - r.firstSeen,
          hasReplay: replaySessionIds.has(r.sessionId),
        })),
        limit,
        offset,
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
          type: r.type,
          timestamp: r.timestamp.toISOString(),
          selector: r.selector,
          durationMs: r.durationMs,
          scrollPercent: r.scrollPercent,
          x: r.x,
          y: r.y,
          viewportWidth: r.viewportWidth,
          viewportHeight: r.viewportHeight,
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
