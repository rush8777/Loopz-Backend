import { eq, and } from "drizzle-orm";
import { sites, elementCatalog, elementPageSightings } from "../db/schema.js";
import { trackElementsBodySchema } from "../lib/patterns/validation.js";
/**
 * Public, unauthenticated (same trust model as /public/events and
 * /public/config) endpoint the SDK's ElementCrawler calls after each
 * DOM scan. Upserts into `element_catalog` keyed by (siteId, selector):
 *
 *   - new selector  -> insert, source "crawl"
 *   - known selector, source "crawl"  -> refresh tagName/label/role,
 *     bump seenCount/lastSeenAt (later crawls improve/correct the
 *     heuristic label as page content settles)
 *   - known selector, source "manual" -> refresh seenCount/lastSeenAt
 *     only; a human-set label is never silently overwritten by a crawl
 *
 * `isIgnored` is never touched here - it's a standing decision only the
 * authenticated PATCH route (routes/elements.ts) can change.
 */
export function registerPublicElementsRoutes(app, db) {
    app.post("/public/sites/:siteId/elements", async (request, reply) => {
        const { siteId } = request.params;
        const [site] = await db.select().from(sites).where(eq(sites.publicId, siteId)).limit(1);
        if (!site) {
            return reply.code(404).send({ error: "site_not_found" });
        }
        const parsed = trackElementsBodySchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        }
        const now = new Date();
        let created = 0;
        let updated = 0;
        for (const el of parsed.data.elements) {
            const [existing] = await db
                .select()
                .from(elementCatalog)
                .where(and(eq(elementCatalog.siteId, site.id), eq(elementCatalog.selector, el.selector)))
                .limit(1);
            let elementId;
            if (existing) {
                elementId = existing.id;
                const preserveManualLabel = existing.source === "manual";
                await db
                    .update(elementCatalog)
                    .set({
                    tagName: el.tagName,
                    ...(preserveManualLabel ? {} : { label: el.label ?? existing.label, role: el.role ?? existing.role }),
                    seenCount: existing.seenCount + 1,
                    lastSeenAt: now,
                })
                    .where(eq(elementCatalog.id, existing.id));
                updated += 1;
            }
            else {
                const [inserted] = await db.insert(elementCatalog).values({
                    siteId: site.id,
                    selector: el.selector,
                    tagName: el.tagName,
                    label: el.label ?? null,
                    role: el.role ?? null,
                    source: "crawl",
                    seenCount: 1,
                    firstSeenAt: now,
                    lastSeenAt: now,
                }).returning({ id: elementCatalog.id });
                elementId = inserted.id;
                created += 1;
            }
            // Older SDK payloads did not include pagePath. Continue refreshing the
            // global catalog for them, but only current payloads can create a Page sighting.
            if (!parsed.data.pagePath)
                continue;
            const [existingSighting] = await db
                .select()
                .from(elementPageSightings)
                .where(and(eq(elementPageSightings.siteId, site.id), eq(elementPageSightings.elementId, elementId), eq(elementPageSightings.pagePath, parsed.data.pagePath)))
                .limit(1);
            if (existingSighting) {
                await db
                    .update(elementPageSightings)
                    .set({ seenCount: existingSighting.seenCount + 1, lastSeenAt: now })
                    .where(eq(elementPageSightings.id, existingSighting.id));
            }
            else {
                await db.insert(elementPageSightings).values({
                    siteId: site.id,
                    elementId,
                    pagePath: parsed.data.pagePath,
                    firstSeenAt: now,
                    lastSeenAt: now,
                    seenCount: 1,
                });
            }
        }
        return reply.send({ created, updated });
    });
}
//# sourceMappingURL=public-elements.js.map