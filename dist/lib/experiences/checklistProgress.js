import { and, eq, isNull } from "drizzle-orm";
import { checklistItemCompletions, checklistStates, experienceEvents, experienceVersions, experiences, segments } from "../../db/schema.js";
import { evaluateSegment } from "../segments/evaluator.js";
export async function getOrCreateChecklistState(db, siteId, experienceId, identity, initialCollapsed) {
    const condition = identity.trackedUserId
        ? and(eq(checklistStates.siteId, siteId), eq(checklistStates.experienceId, experienceId), eq(checklistStates.trackedUserId, identity.trackedUserId))
        : and(eq(checklistStates.siteId, siteId), eq(checklistStates.experienceId, experienceId), eq(checklistStates.anonymousId, identity.anonymousId), isNull(checklistStates.trackedUserId));
    const [existing] = await db.select().from(checklistStates).where(condition).limit(1);
    if (existing)
        return existing;
    const [created] = await db.insert(checklistStates).values({ siteId, experienceId, anonymousId: identity.anonymousId, trackedUserId: identity.trackedUserId, isCollapsed: initialCollapsed }).returning();
    return created;
}
export async function checklistProgress(db, state, definition) {
    const completions = await db.select().from(checklistItemCompletions).where(eq(checklistItemCompletions.checklistStateId, state.id));
    const completedIds = new Set(completions.map(row => row.itemId));
    const itemStates = definition.items.map((item, index) => ({ id: item.id, state: completedIds.has(item.id) ? "completed" : definition.behavior.order === "sequential" && definition.items.slice(0, index).some(previous => !completedIds.has(previous.id)) ? "locked" : "available" }));
    const complete = definition.items.every(item => completedIds.has(item.id));
    return { stateId: state.id, collapsed: state.isCollapsed, dismissed: Boolean(state.dismissedAt), complete, completionAcknowledged: Boolean(state.completionAcknowledgedAt), completedItemIds: definition.items.filter(item => completedIds.has(item.id)).map(item => item.id), items: itemStates };
}
async function conditionMatches(db, siteId, identity, item) {
    if (item.completion.type === "item_clicked")
        return null;
    const identityKey = identity.trackedUserId ?? identity.anonymousId;
    if (item.completion.type === "segment") {
        const [segment] = await db.select().from(segments).where(eq(segments.id, item.completion.segmentId)).limit(1);
        if (!segment || segment.siteId !== siteId)
            return null;
        try {
            return (await evaluateSegment(db, siteId, segment.definition)).has(identityKey) ? "segment" : null;
        }
        catch {
            return null;
        }
    }
    const rows = await db.select().from(experienceEvents).where(and(eq(experienceEvents.siteId, siteId), eq(experienceEvents.experienceId, item.completion.experienceId), eq(experienceEvents.eventType, "guide_completed")));
    return rows.some(row => identity.trackedUserId ? row.trackedUserId === identity.trackedUserId : !row.trackedUserId && row.anonymousId === identity.anonymousId) ? "guide_completed" : null;
}
async function insertCompletion(db, stateId, versionId, item, itemIndex, source, context) {
    const now = new Date();
    const inserted = await db.insert(checklistItemCompletions).values({ checklistStateId: stateId, itemId: item.id, completedAt: now, completionSource: source, completedVersionId: versionId }).onConflictDoNothing().returning();
    if (!inserted.length)
        return false;
    await db.insert(experienceEvents).values({ siteId: context.siteId, experienceId: context.experienceId, versionId, eventType: "checklist_item_completed", itemId: item.id, itemIndex, completionSource: source, anonymousId: context.identity.anonymousId, trackedUserId: context.identity.trackedUserId, sessionId: context.sessionId ?? null, pageViewId: context.pageViewId ?? null, timestamp: now });
    return true;
}
export async function refreshChecklist(db, input) {
    const state = await getOrCreateChecklistState(db, input.siteId, input.experienceId, input.identity, input.definition.behavior.initialState === "collapsed");
    let progress = await checklistProgress(db, state, input.definition);
    if (progress.dismissed || (progress.completionAcknowledged && progress.complete))
        return { ...progress, newlyCompletedIds: [] };
    const candidates = input.definition.behavior.order === "sequential"
        ? input.definition.items.filter(item => !progress.completedItemIds.includes(item.id)).slice(0, 1)
        : input.definition.items.filter(item => !progress.completedItemIds.includes(item.id));
    const distinct = new Map();
    for (const item of candidates) {
        if (item.completion.type === "item_clicked")
            continue;
        const key = `${item.completion.type}:${item.completion.type === "segment" ? item.completion.segmentId : item.completion.experienceId}`;
        if (!distinct.has(key))
            distinct.set(key, conditionMatches(db, input.siteId, input.identity, item));
    }
    const newlyCompletedIds = [];
    for (const item of candidates) {
        if (item.completion.type === "item_clicked")
            continue;
        const key = `${item.completion.type}:${item.completion.type === "segment" ? item.completion.segmentId : item.completion.experienceId}`;
        const source = await distinct.get(key);
        if (source && await insertCompletion(db, state.id, input.versionId, item, input.definition.items.indexOf(item), source, input))
            newlyCompletedIds.push(item.id);
    }
    progress = await checklistProgress(db, state, input.definition);
    const now = new Date();
    if (progress.complete && !state.completedAt) {
        await db.update(checklistStates).set({ completedAt: now, updatedAt: now }).where(eq(checklistStates.id, state.id));
        await db.insert(experienceEvents).values({ siteId: input.siteId, experienceId: input.experienceId, versionId: input.versionId, eventType: "checklist_completed", anonymousId: input.identity.anonymousId, trackedUserId: input.identity.trackedUserId, sessionId: input.sessionId ?? null, pageViewId: input.pageViewId ?? null, timestamp: now });
    }
    else if (!progress.complete && state.completedAt) {
        await db.update(checklistStates).set({ completedAt: null, completionAcknowledgedAt: null, updatedAt: now }).where(eq(checklistStates.id, state.id));
        progress = { ...progress, completionAcknowledged: false };
    }
    return { ...progress, newlyCompletedIds };
}
export async function completeChecklistItemFromClick(db, input) {
    const state = await getOrCreateChecklistState(db, input.siteId, input.experienceId, input.identity, input.definition.behavior.initialState === "collapsed");
    const progress = await checklistProgress(db, state, input.definition);
    const itemIndex = input.definition.items.findIndex(item => item.id === input.itemId);
    if (itemIndex < 0)
        return { error: "item_not_found" };
    if (progress.items[itemIndex].state === "locked")
        return { error: "item_locked" };
    const item = input.definition.items[itemIndex];
    const now = new Date();
    if (!state.startedAt)
        await db.update(checklistStates).set({ startedAt: now, isCollapsed: true, updatedAt: now }).where(eq(checklistStates.id, state.id));
    await db.insert(experienceEvents).values({ siteId: input.siteId, experienceId: input.experienceId, versionId: input.versionId, eventType: "checklist_item_clicked", itemId: item.id, itemIndex, anonymousId: input.identity.anonymousId, trackedUserId: input.identity.trackedUserId, sessionId: input.sessionId ?? null, pageViewId: input.pageViewId ?? null, timestamp: now });
    const clickedCompletion = item.completion.type === "item_clicked" && await insertCompletion(db, state.id, input.versionId, item, itemIndex, "item_clicked", input);
    const refreshed = await refreshChecklist(db, input);
    return { item, progress: { ...refreshed, newlyCompletedIds: clickedCompletion ? [item.id, ...refreshed.newlyCompletedIds.filter(id => id !== item.id)] : refreshed.newlyCompletedIds } };
}
export async function claimChecklistProgress(db, siteId, anonymousId, trackedUserId) {
    const anonymousStates = await db.select().from(checklistStates).where(and(eq(checklistStates.siteId, siteId), eq(checklistStates.anonymousId, anonymousId), isNull(checklistStates.trackedUserId)));
    for (const anonymousState of anonymousStates) {
        const [identified] = await db.select().from(checklistStates).where(and(eq(checklistStates.siteId, siteId), eq(checklistStates.experienceId, anonymousState.experienceId), eq(checklistStates.trackedUserId, trackedUserId))).limit(1);
        if (!identified) {
            await db.update(checklistStates).set({ trackedUserId, updatedAt: new Date() }).where(eq(checklistStates.id, anonymousState.id));
            await recomputeClaimedChecklistCompletion(db, siteId, anonymousState.experienceId, anonymousState.id);
            continue;
        }
        const completions = await db.select().from(checklistItemCompletions).where(eq(checklistItemCompletions.checklistStateId, anonymousState.id));
        for (const completion of completions)
            await db.insert(checklistItemCompletions).values({ checklistStateId: identified.id, itemId: completion.itemId, completedAt: completion.completedAt, completionSource: completion.completionSource, completedVersionId: completion.completedVersionId }).onConflictDoNothing();
        await db.update(checklistStates).set({ anonymousId, isCollapsed: anonymousState.isCollapsed, startedAt: earliest(identified.startedAt, anonymousState.startedAt), lastShownAt: latest(identified.lastShownAt, anonymousState.lastShownAt), lastOpenedAt: latest(identified.lastOpenedAt, anonymousState.lastOpenedAt), dismissedAt: identified.dismissedAt ?? anonymousState.dismissedAt, completedAt: earliest(identified.completedAt, anonymousState.completedAt), completionAcknowledgedAt: latest(identified.completionAcknowledgedAt, anonymousState.completionAcknowledgedAt), updatedAt: new Date() }).where(eq(checklistStates.id, identified.id));
        await db.delete(checklistStates).where(eq(checklistStates.id, anonymousState.id));
        await recomputeClaimedChecklistCompletion(db, siteId, identified.experienceId, identified.id);
    }
}
function latest(a, b) { return a && b ? new Date(Math.max(a.getTime(), b.getTime())) : a ?? b; }
function earliest(a, b) { return a && b ? new Date(Math.min(a.getTime(), b.getTime())) : a ?? b; }
async function recomputeClaimedChecklistCompletion(db, siteId, experienceId, stateId) {
    const current = await currentChecklistDefinition(db, siteId, experienceId);
    if (!current || !current.definition || !Array.isArray(current.definition.items))
        return;
    const completions = await db.select().from(checklistItemCompletions).where(eq(checklistItemCompletions.checklistStateId, stateId));
    const completedIds = new Set(completions.map(row => row.itemId));
    const complete = current.definition.items.length > 0 && current.definition.items.every(item => completedIds.has(item.id));
    const [state] = await db.select().from(checklistStates).where(eq(checklistStates.id, stateId)).limit(1);
    if (!state)
        return;
    await db.update(checklistStates).set({ completedAt: complete ? state.completedAt ?? new Date() : null, completionAcknowledgedAt: complete ? state.completionAcknowledgedAt : null, updatedAt: new Date() }).where(eq(checklistStates.id, stateId));
}
export async function currentChecklistDefinition(db, siteId, experienceId) {
    const [experience] = await db.select().from(experiences).where(and(eq(experiences.id, experienceId), eq(experiences.siteId, siteId), eq(experiences.kind, "checklist"), eq(experiences.status, "published"))).limit(1);
    if (!experience?.publishedVersionId)
        return null;
    const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, experience.publishedVersionId)).limit(1);
    if (!version || version.state !== "published")
        return null;
    return { experience, version, definition: version.definition };
}
//# sourceMappingURL=checklistProgress.js.map