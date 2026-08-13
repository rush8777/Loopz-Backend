import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sites, sessionReplayEvents } from "../db/schema.js";
import { trackReplayBodySchema } from "../lib/patterns/validation.js";

/**
 * Public, unauthenticated (same trust model as /public/config and
 * /public/sites/:siteId/events - see the comment on the former) sink for
 * raw rrweb events. Purely a durable log: this endpoint never inspects
 * or interprets rrweb's event payloads, it just stores them in arrival
 * order under the given `sessionId` for later playback/snapshot use by
 * the dashboard.
 *
 * Deliberately a separate endpoint from /public/sites/:siteId/events
 * rather than folded into the same batch - rrweb payloads (especially
 * FullSnapshot events, which serialize an entire DOM tree) are much
 * larger than a handful of interaction events, and a site may want to
 * flush replay data on a different cadence than analytics events.
 */
export function registerPublicReplayRoutes(app: FastifyInstance, db: Db) {
  app.post("/public/sites/:siteId/replay", async (request, reply) => {
    const { siteId } = request.params as { siteId: string };

    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
    if (!site) {
      return reply.code(404).send({ error: "site_not_found" });
    }

    const parsed = trackReplayBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { sessionId, events } = parsed.data;

    // seq is assigned server-side by arrival order, offset by how many
    // replay events this session already has. Correct as long as
    // batches from one session arrive in order, which holds for a
    // single browser tab's sequential fetches.
    const existing = await db
      .select({ id: sessionReplayEvents.id })
      .from(sessionReplayEvents)
      .where(eq(sessionReplayEvents.sessionId, sessionId));
    const seqOffset = existing.length;

    await db.insert(sessionReplayEvents).values(
      events.map((e, i) => ({
        siteId: site.id,
        sessionId,
        seq: seqOffset + i,
        rrwebType: e.type,
        timestamp: new Date(e.timestamp),
        data: e.data,
      }))
    );

    return reply.code(204).send();
  });
}
