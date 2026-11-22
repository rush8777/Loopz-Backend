import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { sites } from "../db/schema.js";

const referenceQuery = z.object({
  path: z.string().min(1).max(2000),
  device: z.enum(["desktop", "tablet", "mobile"]),
});

/** Cached SDKs can finish delivery without retrying or storing retired telemetry. */
export function registerRetiredCaptureRoutes(app: FastifyInstance, db: Db) {
  async function siteExists(request: FastifyRequest) {
    const { siteId } = request.params as { siteId: string };
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.publicId, siteId)).limit(1);
    return Boolean(site);
  }

  const uploadOptions = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  app.post("/public/sites/:siteId/replay", uploadOptions, async (request, reply) => {
    if (!(await siteExists(request))) return reply.code(404).send({ error: "site_not_found" });
    return reply.code(204).send();
  });
  app.post("/public/sites/:siteId/elements", uploadOptions, async (request, reply) => {
    if (!(await siteExists(request))) return reply.code(404).send({ error: "site_not_found" });
    return reply.send({ created: 0, updated: 0 });
  });

  app.get("/public/sites/:siteId/heatmap-reference", async (request, reply) => {
    if (!referenceQuery.safeParse(request.query).success) return reply.code(400).send({ error: "invalid_query" });
    if (!(await siteExists(request))) return reply.code(404).send({ error: "site_not_found" });
    return reply.send({ capture: null });
  });
  app.get("/public/sites/:siteId/heatmap-captures/:token", async (_request, reply) =>
    reply.code(404).send({ error: "capture_not_found" }),
  );
  app.post("/public/sites/:siteId/heatmap-snapshots/:token", { bodyLimit: 8_500_000 }, async (request, reply) => {
    if (!(await siteExists(request))) return reply.code(404).send({ error: "site_not_found" });
    return reply.code(204).send();
  });
}
