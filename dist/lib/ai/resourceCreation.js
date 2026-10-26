import { and, eq, inArray } from "drizzle-orm";
import { cuid, dashboardCards, dashboards, funnels, pageDefinitions, segments } from "../../db/schema.js";
import { createEntitlementService } from "../entitlements/service.js";
import { eventExistsForSite } from "../events/eventQueries.js";
import { getSegmentAudienceCount } from "../segments/evaluator.js";
export async function validateProposalReferences(db, siteId, proposal) {
    if (proposal.type === "funnel") {
        for (const step of proposal.data.steps) {
            if (step.type === "event" && !(await eventExistsForSite(db, siteId, step.eventName)))
                return `Unknown event: ${step.eventName}`;
            if (step.type === "page") {
                const [page] = await db.select({ id: pageDefinitions.id }).from(pageDefinitions).where(and(eq(pageDefinitions.siteId, siteId), eq(pageDefinitions.id, step.pageId))).limit(1);
                if (!page)
                    return `Unknown page: ${step.pageId}`;
            }
        }
    }
    if (proposal.type === "dashboard") {
        const funnelIds = proposal.data.cards.flatMap(card => card.configuration.kind === "funnel" ? [card.configuration.funnelId] : []);
        const segmentIds = proposal.data.cards.flatMap(card => card.configuration.kind === "metric" && card.configuration.breakdown?.dimension === "segment" ? card.configuration.breakdown.segmentIds : card.configuration.kind === "retention" && card.configuration.cohort.type === "segments" ? card.configuration.cohort.segmentIds : []);
        if (funnelIds.length) {
            const rows = await db.select({ id: funnels.id }).from(funnels).where(and(eq(funnels.siteId, siteId), inArray(funnels.id, funnelIds)));
            if (new Set(rows.map(row => row.id)).size !== new Set(funnelIds).size)
                return "Dashboard references an unavailable Funnel.";
        }
        if (segmentIds.length) {
            const rows = await db.select({ id: segments.id }).from(segments).where(and(eq(segments.siteId, siteId), inArray(segments.id, segmentIds)));
            if (new Set(rows.map(row => row.id)).size !== new Set(segmentIds).size)
                return "Dashboard references an unavailable Segment.";
        }
    }
    return null;
}
export async function previewProposal(db, siteId, proposal) {
    const referenceError = await validateProposalReferences(db, siteId, proposal);
    if (referenceError)
        throw new Error(referenceError);
    if (proposal.type === "segment")
        return { audienceCount: await getSegmentAudienceCount(db, siteId, proposal.data.definition) };
    if (proposal.type === "dashboard")
        return { cardCount: proposal.data.cards.length };
    return { stepCount: proposal.data.steps.length, conversionWindow: proposal.data.conversionWindow ?? { value: 1, unit: "days" } };
}
export async function saveApprovedProposal(db, input) {
    const { proposal, siteId, userId, orgId } = input;
    const now = new Date();
    if (proposal.type === "dashboard") {
        const id = cuid("dsh");
        await createEntitlementService(db).assertCanCreate({ orgId, siteId }, "dashboard");
        await db.insert(dashboards).values({ id, siteId, name: proposal.data.name, description: proposal.data.description ?? null, createdBy: userId, createdAt: now, updatedAt: now });
        if (proposal.data.cards.length)
            await db.insert(dashboardCards).values(proposal.data.cards.map((card, position) => ({ id: cuid("dsc"), dashboardId: id, title: card.title, cardType: card.cardType, position, width: card.width, configuration: card.configuration, createdAt: now, updatedAt: now })));
        return { id, path: `/dashboard/${id}` };
    }
    if (proposal.type === "segment") {
        const id = cuid("seg");
        await createEntitlementService(db).assertCanCreate({ orgId, siteId }, "segment");
        await db.insert(segments).values({ id, siteId, name: proposal.data.name, description: proposal.data.description ?? null, definition: proposal.data.definition, createdAt: now, updatedAt: now });
        return { id, path: `/segments/${id}` };
    }
    const id = cuid("fun");
    const window = proposal.data.conversionWindow;
    await createEntitlementService(db).assertCanCreate({ orgId, siteId }, "funnel");
    await db.insert(funnels).values({ id, siteId, name: proposal.data.name, description: proposal.data.description ?? null, steps: proposal.data.steps, conversionWindowMinutes: window ? window.value * (window.unit === "days" ? 1440 : 60) : 1440, createdAt: now, updatedAt: now });
    return { id, path: `/observe/funnels/${id}` };
}
//# sourceMappingURL=resourceCreation.js.map