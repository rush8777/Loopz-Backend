import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sites, pageDefinitions, elementCatalog, elementPageSightings } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { createPageSchema, updatePageSchema, previewRulesSchema } from "../lib/pages/validation.js";
import { filterMatchingPaths, matchesRules } from "../lib/pages/pageMatcher.js";
import { loadPagePathStats, computeMatchedMetrics, type PageMetrics } from "../lib/pages/pageAggregation.js";
import type { PageRule } from "../lib/pages/types.js";

/** Loads a site and verifies it belongs to the authenticated org - the same 404-not-403 principle as everywhere else. */
async function loadSiteInOrg(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site || site.orgId !== orgId) return null;
  return site;
}

function hasDuplicateRuleIds(rules: PageRule[]): boolean {
  const ids = rules.map((r) => r.id);
  return new Set(ids).size !== ids.length;
}

function serializePage(row: typeof pageDefinitions.$inferSelect, metrics: PageMetrics) {
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    description: row.description,
    area: row.area,
    pageType: row.pageType,
    rules: row.rules as PageRule[],
    heatmapEnabled: row.heatmapEnabled,
    views: metrics.views,
    uniqueVisitors: metrics.uniqueVisitors,
    uniqueSessions: metrics.uniqueSessions,
    lastSeenAt: metrics.lastSeenAt ? metrics.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function registerPageRoutes(app: FastifyInstance, db: Db) {
  app.post(
    "/orgs/:orgId/sites/:siteId/pages",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const parsed = createPageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      if (hasDuplicateRuleIds(parsed.data.rules)) {
        return reply.code(400).send({ error: "duplicate_rule_id" });
      }

      const [page] = await db
        .insert(pageDefinitions)
        .values({
          siteId: site.id,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          area: parsed.data.area ?? null,
          pageType: parsed.data.pageType ?? null,
          rules: parsed.data.rules,
          heatmapEnabled: parsed.data.heatmapEnabled ?? false,
        })
        .returning();

      const pathStats = await loadPagePathStats(db, site.id);
      const matchedPaths = filterMatchingPaths(
        pathStats.map((p) => p.pagePath),
        parsed.data.rules
      );
      const metrics = await computeMatchedMetrics(db, site.id, matchedPaths);

      return reply.code(201).send(serializePage(page, metrics));
    }
  );

  app.get(
    "/orgs/:orgId/sites/:siteId/pages/:pageId/elements",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, pageId } = request.params as { siteId: string; pageId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const [page] = await db.select().from(pageDefinitions).where(eq(pageDefinitions.id, pageId)).limit(1);
      if (!page || page.siteId !== site.id) return reply.code(404).send({ error: "page_not_found" });

      const rows = await db
        .select({ element: elementCatalog, sighting: elementPageSightings })
        .from(elementPageSightings)
        .innerJoin(elementCatalog, eq(elementPageSightings.elementId, elementCatalog.id))
        .where(eq(elementPageSightings.siteId, site.id));

      const rules = page.rules as PageRule[];
      const aggregated = new Map<
        string,
        {
          element: typeof elementCatalog.$inferSelect;
          seenCount: number;
          firstSeenAt: Date;
          lastSeenAt: Date;
          matchedPaths: Set<string>;
        }
      >();

      for (const row of rows) {
        if (!matchesRules(row.sighting.pagePath, rules)) continue;
        const current = aggregated.get(row.element.id);
        if (current) {
          current.seenCount += row.sighting.seenCount;
          if (row.sighting.firstSeenAt < current.firstSeenAt) current.firstSeenAt = row.sighting.firstSeenAt;
          if (row.sighting.lastSeenAt > current.lastSeenAt) current.lastSeenAt = row.sighting.lastSeenAt;
          current.matchedPaths.add(row.sighting.pagePath);
        } else {
          aggregated.set(row.element.id, {
            element: row.element,
            seenCount: row.sighting.seenCount,
            firstSeenAt: row.sighting.firstSeenAt,
            lastSeenAt: row.sighting.lastSeenAt,
            matchedPaths: new Set([row.sighting.pagePath]),
          });
        }
      }

      const elements = [...aggregated.values()]
        .map(({ element, seenCount, firstSeenAt, lastSeenAt, matchedPaths }) => ({
          id: element.id,
          selector: element.selector,
          tagName: element.tagName,
          label: element.label,
          role: element.role,
          source: element.source,
          isIgnored: element.isIgnored,
          seenCount,
          firstSeenAt: firstSeenAt.toISOString(),
          lastSeenAt: lastSeenAt.toISOString(),
          matchedPaths: [...matchedPaths].sort(),
        }))
        .sort((a, b) => b.seenCount - a.seenCount);

      return reply.send({ elements });
    }
  );

  app.get(
    "/orgs/:orgId/sites/:siteId/pages",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const rows = await db.select().from(pageDefinitions).where(eq(pageDefinitions.siteId, site.id));
      const pathStats = await loadPagePathStats(db, site.id);
      const allPaths = pathStats.map((p) => p.pagePath);

      const pages = await Promise.all(
        rows.map(async (row) => {
          const matchedPaths = filterMatchingPaths(allPaths, row.rules as PageRule[]);
          const metrics = await computeMatchedMetrics(db, site.id, matchedPaths);
          return serializePage(row, metrics);
        })
      );

      return reply.send({ pages });
    }
  );

  /**
   * Distinct pagePaths with `page_view` traffic that don't match any
   * currently-tagged Page's rules - the discovery workflow ("what
   * pages exist in this app that we haven't organized yet?"). Sorted
   * by view count so the highest-traffic gaps surface first; capped at
   * 200 rows, same rationale as other unbounded-list endpoints in this
   * codebase.
   */
  app.get(
    "/orgs/:orgId/sites/:siteId/pages/untagged",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const [pageRows, pathStats] = await Promise.all([
        db.select().from(pageDefinitions).where(eq(pageDefinitions.siteId, site.id)),
        loadPagePathStats(db, site.id),
      ]);
      const ruleSets = pageRows.map((row) => row.rules as PageRule[]);

      const untagged = pathStats
        .filter((p) => !ruleSets.some((rules) => matchesRules(p.pagePath, rules)))
        .sort((a, b) => b.views - a.views)
        .slice(0, 200)
        .map((p) => ({ pagePath: p.pagePath, views: p.views, lastSeenAt: p.lastSeenAt.toISOString() }));

      return reply.send({ untagged });
    }
  );

  /**
   * Live rule-testing, used by the Page editor's preview panel before
   * anything is saved. Runs the candidate rules (not yet persisted, and
   * never validated against other Pages' rules - overlap is allowed,
   * same as Pendo) against this site's actual traffic and returns which
   * real pagePaths would match.
   */
  app.post(
    "/orgs/:orgId/sites/:siteId/pages/preview",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const parsed = previewRulesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      if (hasDuplicateRuleIds(parsed.data.rules)) {
        return reply.code(400).send({ error: "duplicate_rule_id" });
      }

      const pathStats = await loadPagePathStats(db, site.id);
      const matched: typeof pathStats = [];
      const unmatched: typeof pathStats = [];
      for (const p of pathStats) {
        (matchesRules(p.pagePath, parsed.data.rules) ? matched : unmatched).push(p);
      }
      matched.sort((a, b) => b.views - a.views);
      unmatched.sort((a, b) => b.views - a.views);

      const metrics = await computeMatchedMetrics(
        db,
        site.id,
        matched.map((p) => p.pagePath)
      );

      return reply.send({
        matched: matched.slice(0, 50).map((p) => ({ pagePath: p.pagePath, views: p.views })),
        unmatchedSample: unmatched.slice(0, 10).map((p) => ({ pagePath: p.pagePath, views: p.views })),
        metrics: {
          views: metrics.views,
          uniqueVisitors: metrics.uniqueVisitors,
          uniqueSessions: metrics.uniqueSessions,
        },
      });
    }
  );

  app.get(
    "/orgs/:orgId/sites/:siteId/pages/:pageId",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, pageId } = request.params as { siteId: string; pageId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const [page] = await db.select().from(pageDefinitions).where(eq(pageDefinitions.id, pageId)).limit(1);
      if (!page || page.siteId !== site.id) return reply.code(404).send({ error: "page_not_found" });

      const pathStats = await loadPagePathStats(db, site.id);
      const rules = page.rules as PageRule[];
      const matchedPaths = pathStats.filter((p) => matchesRules(p.pagePath, rules));
      const metrics = await computeMatchedMetrics(
        db,
        site.id,
        matchedPaths.map((p) => p.pagePath)
      );

      return reply.send({
        ...serializePage(page, metrics),
        // Per-URL breakdown within this Page - which raw paths are actually contributing to it, and how much.
        matchedPaths: matchedPaths
          .sort((a, b) => b.views - a.views)
          .slice(0, 20)
          .map((p) => ({ pagePath: p.pagePath, views: p.views, lastSeenAt: p.lastSeenAt.toISOString() })),
      });
    }
  );

  app.patch(
    "/orgs/:orgId/sites/:siteId/pages/:pageId",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const { siteId, pageId } = request.params as { siteId: string; pageId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const [existing] = await db.select().from(pageDefinitions).where(eq(pageDefinitions.id, pageId)).limit(1);
      if (!existing || existing.siteId !== site.id) return reply.code(404).send({ error: "page_not_found" });

      const parsed = updatePageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      if (parsed.data.rules && hasDuplicateRuleIds(parsed.data.rules)) {
        return reply.code(400).send({ error: "duplicate_rule_id" });
      }

      const [updated] = await db
        .update(pageDefinitions)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(pageDefinitions.id, pageId))
        .returning();

      const pathStats = await loadPagePathStats(db, site.id);
      const matchedPaths = filterMatchingPaths(
        pathStats.map((p) => p.pagePath),
        updated.rules as PageRule[]
      );
      const metrics = await computeMatchedMetrics(db, site.id, matchedPaths);

      return reply.send(serializePage(updated, metrics));
    }
  );

  app.delete(
    "/orgs/:orgId/sites/:siteId/pages/:pageId",
    { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] },
    async (request, reply) => {
      const { siteId, pageId } = request.params as { siteId: string; pageId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const [existing] = await db.select().from(pageDefinitions).where(eq(pageDefinitions.id, pageId)).limit(1);
      if (!existing || existing.siteId !== site.id) return reply.code(404).send({ error: "page_not_found" });

      await db.delete(pageDefinitions).where(eq(pageDefinitions.id, pageId));
      return reply.code(204).send();
    }
  );
}
