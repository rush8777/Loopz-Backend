import { z } from "zod";
import { dashboardCreateSchema } from "../../analytics/validation.js";
import { createFunnelSchema } from "../../funnels/validation.js";
import { createSegmentSchema } from "../../segments/validation.js";

export const aiResourceTypeSchema = z.enum(["dashboard", "segment", "funnel"]);
export type AiResourceType = z.infer<typeof aiResourceTypeSchema>;

export const aiProposalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dashboard"), data: dashboardCreateSchema }),
  z.object({ type: z.literal("segment"), data: createSegmentSchema }),
  z.object({ type: z.literal("funnel"), data: createFunnelSchema }),
]);
export type AiProposal = z.infer<typeof aiProposalSchema>;

export const modelEnvelopeSchema = z.object({
  markdown: z.string().trim().min(1).max(30_000),
  proposal: aiProposalSchema.nullable().optional(),
});

export const SKILL_CATALOG = [
  "Analyze dashboards and period-over-period product performance",
  "Analyze real event frequency, users, sessions, and page activity",
  "Summarize recent sessions and chronological activity",
  "Analyze Guide, Widget, Survey, and Checklist performance",
  "Draft validated dashboards, segments, and funnels for approval",
] as const;
