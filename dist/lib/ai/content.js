import { z } from "zod";
const valueFormatSchema = z.enum(["number", "percent", "duration_ms"]);
export const aiMetricCardSchema = z.object({
    label: z.string().min(1).max(120), value: z.number().finite(), format: valueFormatSchema.default("number"),
    previousValue: z.number().finite().nullable().optional(), deltaPercent: z.number().finite().nullable().optional(),
});
const chartPointSchema = z.object({ label: z.string().min(1).max(120), values: z.record(z.string().min(1).max(100), z.number().finite()) });
export const validatedChartSpecSchema = z.object({
    type: z.enum(["line", "area", "bar", "stacked_bar", "funnel", "donut"]),
    title: z.string().min(1).max(160), subtitle: z.string().max(240).optional(),
    format: valueFormatSchema.default("number"),
    series: z.array(z.object({ key: z.string().min(1).max(100), label: z.string().min(1).max(120) })).min(1).max(10),
    data: z.array(chartPointSchema).max(400),
});
export const validatedTableSpecSchema = z.object({
    title: z.string().min(1).max(160),
    columns: z.array(z.object({ key: z.string().min(1).max(100), label: z.string().min(1).max(120), format: valueFormatSchema.optional() })).min(1).max(12),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(100),
});
export const aiContentBlockSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), markdown: z.string().min(1).max(30_000) }),
    z.object({ type: z.literal("metrics"), metrics: z.array(aiMetricCardSchema).min(1).max(12) }),
    // chartId is optional so historical persisted chart arrays remain readable.
    z.object({ type: z.literal("chart"), chartId: z.string().min(1).max(80).optional(), chart: validatedChartSpecSchema }),
    z.object({ type: z.literal("table"), table: validatedTableSpecSchema }),
]);
export const aiContentBlocksSchema = z.array(aiContentBlockSchema).max(12);
/** The model can choose where a trusted chart is mentioned, never its values. */
export const aiModelContentBlockSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), markdown: z.string().trim().min(1).max(30_000) }),
    z.object({ type: z.literal("chart"), chartId: z.string().trim().min(1).max(80) }),
]);
export const aiModelContentBlocksSchema = z.array(aiModelContentBlockSchema).min(1).max(12);
export function withChartIds(blocks) {
    let chartNumber = 0;
    return blocks.map(block => block.type === "chart" ? { ...block, chartId: block.chartId ?? `chart-${++chartNumber}` } : block);
}
export function orderAiContentBlocks(markdown, requested, trusted) {
    const trustedBlocks = withChartIds(trusted);
    if (!requested?.length)
        return [{ type: "text", markdown }, ...trustedBlocks];
    const charts = new Map(trustedBlocks.filter((block) => block.type === "chart").map(block => [block.chartId, block]));
    const used = new Set();
    const ordered = [];
    for (const block of requested) {
        if (block.type === "text")
            ordered.push(block);
        else if (!used.has(block.chartId) && charts.has(block.chartId)) {
            ordered.push(charts.get(block.chartId));
            used.add(block.chartId);
        }
    }
    // Retain non-chart analytical blocks without forcing unrequested charts to the end.
    return [...ordered, ...trustedBlocks.filter(block => block.type !== "chart")];
}
//# sourceMappingURL=content.js.map