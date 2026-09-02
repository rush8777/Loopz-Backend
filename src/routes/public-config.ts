import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sites, pageDefinitions, pageHeatmapStates } from "../db/schema.js";

/**
 * The one endpoint in this service with NO authentication at all -
 * called directly by the SDK from anonymous visitors' browsers on
 * potentially every page load. Security here rests entirely on:
 *
 *   1. Scoping strictly to the single `siteId` in the URL - never a
 *      list, never a join that could leak a sibling site or the parent
 *      org's identity.
 *   2. Returning ONLY the `publicConfig` allowlist (see the PATCH route
 *      in orgs.ts) - never orgId, internal id, domain, or anything else
 *      from the row.
 *   3. Rate limiting (applied where this route is registered in app.ts)
 *      since it's an easy target for scraping/abuse precisely because
 *      it requires no credentials.
 *
 * A 404 for an unknown siteId looks identical to a 404 for a
 * deliberately malformed one - nothing here should help someone
 * enumerate valid site IDs.
 */
export function registerPublicConfigRoutes(app: FastifyInstance, db: Db) {
  app.get("/public/config/:siteId", async (request, reply) => {
    const { siteId } = request.params as { siteId: string };

    const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
    if (!site) {
      return reply.code(404).send({ error: "site_not_found" });
    }

    reply.header("Cache-Control", "public, max-age=60");
    const heatmapStates = await db
      .select({ id: pageHeatmapStates.id, selector: pageHeatmapStates.selector })
      .from(pageHeatmapStates)
      .innerJoin(pageDefinitions, eq(pageHeatmapStates.pageDefinitionId, pageDefinitions.id))
      .where(and(eq(pageHeatmapStates.siteId, site.id), eq(pageDefinitions.heatmapEnabled, true)));
    return reply.send({
      siteId: site.publicId,
      config: site.publicConfig,
      heatmapStates,
    });
  });
}
