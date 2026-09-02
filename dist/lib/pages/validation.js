import { z } from "zod";
import { PAGE_TYPES } from "./types.js";
export const pageRuleSchema = z.object({
    id: z.string().min(1).max(64),
    kind: z.enum(["include", "exclude"]),
    operator: z.enum(["equals", "starts_with", "ends_with", "contains", "matches_pattern"]),
    value: z.string().min(1).max(500),
});
/** A Page's rules must be able to match *something* - at least one include rule, exclude-only rule sets are rejected rather than silently matching nothing. */
const rulesArraySchema = z
    .array(pageRuleSchema)
    .min(1)
    .max(30)
    .refine((rules) => rules.some((r) => r.kind === "include"), {
    message: "at least one include rule is required",
});
export const createPageSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    area: z.string().min(1).max(120).optional(),
    pageType: z.enum(PAGE_TYPES).optional(),
    rules: rulesArraySchema,
    heatmapEnabled: z.boolean().optional(),
});
export const updatePageSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    area: z.string().min(1).max(120).optional(),
    pageType: z.enum(PAGE_TYPES).optional(),
    rules: rulesArraySchema.optional(),
    heatmapEnabled: z.boolean().optional(),
});
export const previewRulesSchema = z.object({
    rules: rulesArraySchema,
});
//# sourceMappingURL=validation.js.map