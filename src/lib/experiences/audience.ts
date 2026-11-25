import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { segments } from "../../db/schema.js";
import { evaluateSegment } from "../segments/evaluator.js";
import type { SegmentDefinition } from "../segments/types.js";
import type { ExperienceTargeting } from "./types.js";

export async function matchesExperienceAudience(db: Db, siteId: string, identityKey: string, audience: ExperienceTargeting["audience"]): Promise<boolean> {
  if (audience.type === "all") return true;
  const conditions = audience.type === "segment" ? [{ segmentId: audience.segmentId, operator: "matches" as const }] : audience.conditions;
  const results = await Promise.all(conditions.map(async condition => {
    const [segment] = await db.select().from(segments).where(and(eq(segments.id, condition.segmentId), eq(segments.siteId, siteId))).limit(1);
    if (!segment) return false;
    const member = (await evaluateSegment(db, siteId, segment.definition as SegmentDefinition)).has(identityKey);
    return condition.operator === "matches" ? member : !member;
  }));
  return audience.type === "segment_rules" && audience.logic === "any" ? results.some(Boolean) : results.every(Boolean);
}
