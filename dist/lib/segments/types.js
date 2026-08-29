/**
 * Segment definition shapes (task brief sections 2-3). This is the
 * "source of truth" schema for `segments.definition` - a nested tree
 * of AND/OR groups over a small set of V1 condition types, deliberately
 * NOT flattened into database columns (task brief section 2) so groups
 * can nest arbitrarily deep and new condition types can be added later
 * (task brief section 4) without a schema migration.
 *
 * Reused as-is by the evaluator (evaluator.ts) and by validation.ts's
 * zod schema - this file is the single source of truth for the shape,
 * `validation.ts` is what actually enforces it at the API boundary.
 */
export function isGroup(node) {
    return "logic" in node && "conditions" in node;
}
//# sourceMappingURL=types.js.map