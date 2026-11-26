import { z } from "zod";
const bounded = (length) => z.string().trim().min(1).max(length)
    .refine(text => !/[\u0000-\u001f\u007f<>]/.test(text), "Use plain text");
export const skillMetadata = z.object({
    name: bounded(100),
    description: bounded(500),
    intentExamples: z.array(bounded(140)).min(1).max(8),
    keywords: z.array(bounded(45)).max(15).default([]),
    preconditions: z.array(bounded(160)).max(8).default([]),
    completionEvidence: bounded(160).optional(),
}).strict();
export const skillRegistration = z.object({ enabled: z.boolean(), metadata: skillMetadata.optional() }).strict()
    .refine(value => !value.enabled || !!value.metadata, "Review metadata before enabling the skill");
export const skillRecommendation = z.discriminatedUnion("decision", [
    z.object({ schemaVersion: z.literal(1), decision: z.literal("recommend_skill"), skillId: z.string(), skillVersionId: z.string(), reason: z.string().max(160) }).strict(),
    z.object({ schemaVersion: z.literal(1), decision: z.enum(["answer_only", "clarify", "insufficient_evidence"]) }).strict(),
]);
export const skillSelection = z.array(z.string().min(1).max(64)).max(500).default([]).transform(ids => [...new Set(ids)]);
//# sourceMappingURL=contracts.js.map