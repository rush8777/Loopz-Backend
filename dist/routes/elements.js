import { z } from "zod";
import { eq } from "drizzle-orm";
import { sites, elementCatalog } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOrgRole } from "../middleware/requireOrgRole.js";
async function loadSiteInOrg(db, siteId, orgId) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site || site.orgId !== orgId)
        return null;
    return site;
}
function serializeElementRow(row) {
    return {
        id: row.id,
        selector: row.selector,
        tagName: row.tagName,
        label: row.label,
        role: row.role,
        source: row.source,
        isIgnored: row.isIgnored,
        seenCount: row.seenCount,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
    };
}
const updateElementSchema = z
    .object({
    label: z.string().min(1).max(200).optional(),
    isIgnored: z.boolean().optional(),
})
    .refine((v) => v.label !== undefined || v.isIgnored !== undefined, {
    message: "at least one of label or isIgnored must be provided",
});
/**
 * The human-facing side of the element catalog populated by
 * `POST /public/sites/:siteId/elements` (see public-elements.ts) - what
 * powers the Observe > Elements page: browse discovered elements, rename
 * one (which also switches it to `source: "manual"` so later crawls stop
 * overwriting the label), or mark one as noise via `isIgnored`.
 */
export function registerElementRoutes(app, db) {
    app.get("/orgs/:orgId/sites/:siteId/elements", { preHandler: [authenticate, requireOrgRole(db, "VIEWER")] }, async (request, reply) => {
        const { siteId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const rows = await db.select().from(elementCatalog).where(eq(elementCatalog.siteId, site.id));
        const elements = rows.map(serializeElementRow).sort((a, b) => b.seenCount - a.seenCount);
        return reply.send({ elements });
    });
    app.patch("/orgs/:orgId/sites/:siteId/elements/:elementId", { preHandler: [authenticate, requireOrgRole(db, "ADMIN")] }, async (request, reply) => {
        const { siteId, elementId } = request.params;
        const site = await loadSiteInOrg(db, siteId, request.membership.orgId);
        if (!site)
            return reply.code(404).send({ error: "site_not_found" });
        const [existing] = await db.select().from(elementCatalog).where(eq(elementCatalog.id, elementId)).limit(1);
        if (!existing || existing.siteId !== site.id) {
            return reply.code(404).send({ error: "element_not_found" });
        }
        const parsed = updateElementSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        }
        const updates = {};
        if (parsed.data.label !== undefined) {
            updates.label = parsed.data.label;
            // A human-set label is a standing decision - later crawls must not clobber it (see public-elements.ts).
            updates.source = "manual";
        }
        if (parsed.data.isIgnored !== undefined) {
            updates.isIgnored = parsed.data.isIgnored;
        }
        const [updated] = await db.update(elementCatalog).set(updates).where(eq(elementCatalog.id, elementId)).returning();
        return reply.send(serializeElementRow(updated));
    });
}
//# sourceMappingURL=elements.js.map