import { eq } from "drizzle-orm";
import { pageDefinitions } from "../../db/schema.js";
import { matchesRules } from "./pageMatcher.js";
import { loadPagePathStats } from "./pageAggregation.js";
/** Resolves a saved Page definition to the paths it currently covers.
 *
 * This intentionally lives outside the Segment evaluator: Pages are shared
 * primitives used by both Segment conditions and ordered Funnel steps.
 */
export async function resolveMatchedPagePaths(db, siteId, pageId) {
    const [page] = await db.select().from(pageDefinitions).where(eq(pageDefinitions.id, pageId)).limit(1);
    if (!page || page.siteId !== siteId)
        return null;
    const pathStats = await loadPagePathStats(db, siteId);
    return pathStats.map((p) => p.pagePath).filter((p) => matchesRules(p, page.rules));
}
//# sourceMappingURL=resolveMatchedPagePaths.js.map