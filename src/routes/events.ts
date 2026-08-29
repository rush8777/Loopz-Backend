import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sites } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import {
  listEventDefinitions,
  getEventSummary,
  getEventTimeseries,
  getEventPropertySummary,
  listEventOccurrences,
  getEventOccurrence,
  getEventUsers,
  getEventSessions,
  getEventPages,
  getEventPatternReferences,
  eventExistsForSite,
} from "../lib/events/eventQueries.js";

async function loadSiteInOrg(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site || site.orgId !== orgId) return null;
  return site;
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().min(1).max(200).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

const rangeQuerySchema = z.object({
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

// Default window for endpoints that need a bounded range even when the
// caller doesn't supply one (the timeseries chart in particular can't
// zero-fill an unbounded range) - 30 days, matching the task brief's
// suggested default range option.
const DEFAULT_RANGE_DAYS = 30;
function resolveRange(since?: Date, until?: Date): { since: Date; until: Date } {
  const resolvedUntil = until ?? new Date();
  const resolvedSince = since ?? new Date(resolvedUntil.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { since: resolvedSince, until: resolvedUntil };
}

/**
 * The Event Explorer (task brief) - a first-class catalog of
 * developer-defined `type === "custom"` events, built entirely on top
 * of the existing `session_events` log and the lib/events/eventQueries.ts
 * service layer. Every route here is a thin HTTP wrapper: parse/
 * validate query params, resolve+authorize the site, call one service
 * function, serialize the result. No aggregation logic lives in this
 * file - see eventQueries.ts's module doc comment for why, and for the
 * identity-resolution/page-attribution notes that apply to every route
 * below.
 */
export function registerEventRoutes(app: FastifyInstance, db: Db) {
  /** Distinct custom event names, most-frequent first - the catalog list (task brief section 3). */
  app.get(
    "/orgs/:orgId/sites/:siteId/events",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      }
      const { limit, offset, search, since, until } = parsed.data;

      const { events, total } = await listEventDefinitions(db, site.id, { limit, offset, search, since, until });
      return reply.send({ events, total, limit, offset });
    }
  );

  /** Overview: summary stats + existing "used in" references (task brief sections 6, 11). */
  app.get(
    "/orgs/:orgId/sites/:siteId/events/:eventName",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, eventName } = request.params as { siteId: string; eventName: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      if (!(await eventExistsForSite(db, site.id, eventName))) {
        return reply.code(404).send({ error: "event_not_found" });
      }

      const parsed = rangeQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      }

      const summary = await getEventSummary(db, site.id, eventName, parsed.data);
      // "Used in" never fakes a reference (task constraint) - patterns
      // is the only existing system that can reference a custom event
      // today (see matcher.ts's "custom" verb); funnels/experiences
      // don't exist yet, so they're simply omitted rather than shown
      // empty or invented - see the frontend's rendering of this field.
      const patternReferences = await getEventPatternReferences(db, site.id, eventName);

      return reply.send({ ...summary, usedIn: { patterns: patternReferences } });
    }
  );

  /** Daily occurrence counts across a range, zero-filled (task brief section 6's "Occurrences over time" chart). */
  app.get(
    "/orgs/:orgId/sites/:siteId/events/:eventName/timeseries",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, eventName } = request.params as { siteId: string; eventName: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      if (!(await eventExistsForSite(db, site.id, eventName))) {
        return reply.code(404).send({ error: "event_not_found" });
      }

      const parsed = rangeQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      }
      const range = resolveRange(parsed.data.since, parsed.data.until);

      const points = await getEventTimeseries(db, site.id, eventName, range);
      return reply.send({ points, since: range.since.toISOString(), until: range.until.toISOString() });
    }
  );

  /** Dynamically-discovered property breakdown (task brief section 7). */
  app.get(
    "/orgs/:orgId/sites/:siteId/events/:eventName/properties",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, eventName } = request.params as { siteId: string; eventName: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      if (!(await eventExistsForSite(db, site.id, eventName))) {
        return reply.code(404).send({ error: "event_not_found" });
      }

      const parsed = rangeQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      }

      const result = await getEventPropertySummary(db, site.id, eventName, parsed.data);
      return reply.send(result);
    }
  );

  /** Recent occurrences, paginated (task brief section 8). */
  app.get(
    "/orgs/:orgId/sites/:siteId/events/:eventName/occurrences",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, eventName } = request.params as { siteId: string; eventName: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      if (!(await eventExistsForSite(db, site.id, eventName))) {
        return reply.code(404).send({ error: "event_not_found" });
      }

      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      }
      const { limit, offset, since, until } = parsed.data;

      const { occurrences, total } = await listEventOccurrences(db, site.id, eventName, { limit, offset, since, until });
      return reply.send({ occurrences, total, limit, offset });
    }
  );

  /** One occurrence's full payload (task brief section 9's drawer). */
  app.get(
    "/orgs/:orgId/sites/:siteId/events/:eventName/occurrences/:occurrenceId",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, eventName, occurrenceId } = request.params as { siteId: string; eventName: string; occurrenceId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const occurrence = await getEventOccurrence(db, site.id, eventName, occurrenceId);
      if (!occurrence) return reply.code(404).send({ error: "occurrence_not_found" });

      return reply.send(occurrence);
    }
  );

  /** Users who performed this event, identity-resolved (task brief section 10). */
  app.get(
    "/orgs/:orgId/sites/:siteId/events/:eventName/users",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, eventName } = request.params as { siteId: string; eventName: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      if (!(await eventExistsForSite(db, site.id, eventName))) {
        return reply.code(404).send({ error: "event_not_found" });
      }

      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      }
      const { limit, offset, since, until } = parsed.data;

      const { users, total } = await getEventUsers(db, site.id, eventName, { limit, offset, since, until });
      return reply.send({ users, total, limit, offset });
    }
  );

  /** Sessions containing this event (task brief section 10). */
  app.get(
    "/orgs/:orgId/sites/:siteId/events/:eventName/sessions",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, eventName } = request.params as { siteId: string; eventName: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      if (!(await eventExistsForSite(db, site.id, eventName))) {
        return reply.code(404).send({ error: "event_not_found" });
      }

      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      }
      const { limit, offset, since, until } = parsed.data;

      const { sessions, total } = await getEventSessions(db, site.id, eventName, { limit, offset, since, until });
      return reply.send({ sessions, total, limit, offset });
    }
  );

  /** Which pages generated this event (task brief section 10) - small breakdown, not paginated. */
  app.get(
    "/orgs/:orgId/sites/:siteId/events/:eventName/pages",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, eventName } = request.params as { siteId: string; eventName: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      if (!(await eventExistsForSite(db, site.id, eventName))) {
        return reply.code(404).send({ error: "event_not_found" });
      }

      const parsed = rangeQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
      }

      const pages = await getEventPages(db, site.id, eventName, parsed.data);
      return reply.send({ pages });
    }
  );
}
