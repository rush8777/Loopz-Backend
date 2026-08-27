import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sites, patternCandidates, patternEpisodes, episodes, behavioralEvents } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
import { runSiteObservation } from "../lib/analysis/runObservation.js";
import { describeElementIdentity, hasStableIdentity, type ElementIdentity } from "../lib/behavior/elementIdentity.js";

async function loadSiteInOrg(db: Db, siteId: string, orgId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site || site.orgId !== orgId) return null;
  return site;
}

const observeRequestSchema = z.object({
  similarityThreshold: z.number().min(0).max(1).optional(),
  minimumOccurrences: z.number().int().min(1).optional(),
  maximumEpisodes: z.number().int().min(1).max(20000).optional(),
  maximumPatternLength: z.number().int().min(1).max(100).optional(),
  minimumPatternLength: z.number().int().min(1).max(100).optional(),
});

function serializeCandidateRow(row: typeof patternCandidates.$inferSelect) {
  return {
    id: row.id,
    siteId: row.siteId,
    representativeSequence: row.representativeSequence as string[],
    occurrenceCount: row.occurrenceCount,
    uniqueSessionCount: row.uniqueSessionCount,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    similarity: row.similarity as { average: number; minimum: number; maximum: number },
    quality: row.quality as {
      frequencyScore: number;
      coverageScore: number;
      consistencyScore: number;
      recencyScore: number;
      overallScore: number;
    },
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Reconstructs the same "<kind>" / "<kind>:<element>" token format
 * `tokenForBehavioralEvent` (behavioralSequence.ts) produces, from a
 * persisted `behavioral_events` row rather than an in-memory
 * `BehavioralEvent`. Kept as a small local function instead of forcing
 * the DB row's loosely-typed JSON columns through that function's
 * strict discriminated-union parameter - the two representations carry
 * the same information (kind + element), just typed differently.
 */
function tokenForBehavioralEventRow(row: typeof behavioralEvents.$inferSelect): string {
  const element = (row.element as ElementIdentity | null) ?? undefined;
  if (element && hasStableIdentity(element)) {
    return `${row.kind}:${describeElementIdentity(element)}`;
  }
  return row.kind;
}

/** The SDK-computed display label for a behavioral_events row's element, when one was captured - display only, never part of token/grouping identity (see elementIdentity.ts). */
function labelForBehavioralEventRow(row: typeof behavioralEvents.$inferSelect): string | undefined {
  const element = (row.element as ElementIdentity | null) ?? undefined;
  return element?.label;
}

export function registerPatternObserverRoutes(app: FastifyInstance, db: Db) {
  /**
   * Runs the Pattern Observer pipeline (telemetry aggregation -> behavior
   * compilation -> episode segmentation -> pattern observation) over this
   * site's current session_events and persists the result, replacing
   * whatever was previously derived (see runObservation.ts's module doc -
   * these tables are documented as rebuildable, so this is a safe,
   * idempotent resync rather than an incremental append).
   *
   * This is a batch/manual trigger for MVP - there is no background
   * scheduler running this automatically yet.
   */
  app.post(
    "/orgs/:orgId/sites/:siteId/analysis/patterns/observe",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const parsed = observeRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      }

      const result = await runSiteObservation(db, site.id, parsed.data);

      return reply.send({
        sessionCount: result.sessionCount,
        episodeCount: result.episodeCount,
        candidateCount: result.candidates.length,
        candidates: result.candidates.map((c) => ({
          id: c.id,
          representativeSequence: c.representativeSequence,
          occurrenceCount: c.occurrenceCount,
          uniqueSessionCount: c.uniqueSessionCount,
          firstSeenAt: new Date(c.firstSeenAt).toISOString(),
          lastSeenAt: new Date(c.lastSeenAt).toISOString(),
          similarity: c.similarity,
          quality: c.quality,
        })),
      });
    }
  );

  /** Lists the pattern candidates from the most recent observation run, ranked by quality (same ordering observePatterns already produces). */
  app.get(
    "/orgs/:orgId/sites/:siteId/analysis/patterns/candidates",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const rows = await db.select().from(patternCandidates).where(eq(patternCandidates.siteId, site.id));
      const candidates = rows.map(serializeCandidateRow).sort((a, b) => b.quality.overallScore - a.quality.overallScore);

      return reply.send({ candidates });
    }
  );

  /**
   * One candidate's evidence: the underlying episodes (session, time
   * range, and that episode's own behavioral token sequence), so the
   * dashboard can show *why* an episode was grouped into the candidate,
   * not just that it was.
   */
  app.get(
    "/orgs/:orgId/sites/:siteId/analysis/patterns/candidates/:candidateId",
    { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] },
    async (request, reply) => {
      const { siteId, candidateId } = request.params as { siteId: string; candidateId: string };
      const site = await loadSiteInOrg(db, siteId, request.membership!.orgId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });

      const [candidateRow] = await db.select().from(patternCandidates).where(eq(patternCandidates.id, candidateId)).limit(1);
      if (!candidateRow || candidateRow.siteId !== site.id) {
        return reply.code(404).send({ error: "pattern_candidate_not_found" });
      }

      const links = await db.select().from(patternEpisodes).where(eq(patternEpisodes.patternCandidateId, candidateId));

      const episodeRows = links.length > 0 ? await db.select().from(episodes).where(eq(episodes.siteId, site.id)) : [];
      const episodeById = new Map(episodeRows.map((e) => [e.id, e]));

      const evidence: {
        episodeId: string;
        sessionId: string;
        startedAt: string;
        endedAt: string;
        startReason: string;
        endReason: string;
        /** `token` is the canonical grouping/identity string (selector-based, unchanged format) - `label` is the SDK-computed display name for the same step, when captured, purely for a friendlier UI (see elementIdentity.ts's identity-vs-display note). */
        steps: { token: string; label?: string }[];
      }[] = [];

      for (const link of links) {
        const episode = episodeById.get(link.episodeId);
        if (!episode) continue; // defensive - a dangling link shouldn't 500 the request

        const behavioralRows = await db
          .select()
          .from(behavioralEvents)
          .where(eq(behavioralEvents.episodeId, episode.id))
          .orderBy(asc(behavioralEvents.timestamp));

        evidence.push({
          episodeId: episode.id,
          sessionId: episode.sessionId,
          startedAt: episode.startedAt.toISOString(),
          endedAt: episode.endedAt.toISOString(),
          startReason: episode.startReason,
          endReason: episode.endReason,
          steps: behavioralRows.map((row) => ({
            token: tokenForBehavioralEventRow(row),
            ...(labelForBehavioralEventRow(row) && { label: labelForBehavioralEventRow(row) }),
          })),
        });
      }

      evidence.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

      return reply.send({ candidate: serializeCandidateRow(candidateRow), evidence });
    }
  );
}
