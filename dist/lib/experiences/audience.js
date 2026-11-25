import { and, eq } from "drizzle-orm";
import { segments } from "../../db/schema.js";
import { evaluateSegment } from "../segments/evaluator.js";
export async function matchesExperienceAudience(db, siteId, identityKey, audience) {
    if (audience.type === "all")
        return true;
    const conditions = audience.type === "segment" ? [{ segmentId: audience.segmentId, operator: "matches" }] : audience.conditions;
    const results = await Promise.all(conditions.map(async (condition) => {
        const [segment] = await db.select().from(segments).where(and(eq(segments.id, condition.segmentId), eq(segments.siteId, siteId))).limit(1);
        if (!segment)
            return false;
        const member = (await evaluateSegment(db, siteId, segment.definition)).has(identityKey);
        return condition.operator === "matches" ? member : !member;
    }));
    return audience.type === "segment_rules" && audience.logic === "any" ? results.some(Boolean) : results.every(Boolean);
}
//# sourceMappingURL=audience.js.map