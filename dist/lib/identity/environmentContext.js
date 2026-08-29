import { eq, and, inArray, desc } from "drizzle-orm";
import { sessionContexts } from "../../db/schema.js";
/**
 * Upserts the one-row-per-session environment snapshot. Keyed on
 * (siteId, sessionId) - a session's environment doesn't change, so a
 * repeat session_start for the same session (e.g. a retried batch)
 * just overwrites with the same values rather than creating a
 * duplicate row.
 */
export async function recordSessionStart(db, input) {
    const { siteId, sessionId, anonymousId, ...environment } = input;
    const [existing] = await db
        .select({ id: sessionContexts.id })
        .from(sessionContexts)
        .where(and(eq(sessionContexts.siteId, siteId), eq(sessionContexts.sessionId, sessionId)))
        .limit(1);
    if (existing) {
        await db
            .update(sessionContexts)
            .set({
            anonymousId,
            browserName: environment.browserName ?? null,
            browserVersion: environment.browserVersion ?? null,
            osName: environment.osName ?? null,
            osVersion: environment.osVersion ?? null,
            deviceType: environment.deviceType ?? null,
            language: environment.language ?? null,
            timezone: environment.timezone ?? null,
            screenWidth: environment.screenWidth ?? null,
            screenHeight: environment.screenHeight ?? null,
            referrer: environment.referrer ?? null,
        })
            .where(eq(sessionContexts.id, existing.id));
        return;
    }
    await db.insert(sessionContexts).values({
        siteId,
        sessionId,
        anonymousId,
        browserName: environment.browserName ?? null,
        browserVersion: environment.browserVersion ?? null,
        osName: environment.osName ?? null,
        osVersion: environment.osVersion ?? null,
        deviceType: environment.deviceType ?? null,
        language: environment.language ?? null,
        timezone: environment.timezone ?? null,
        screenWidth: environment.screenWidth ?? null,
        screenHeight: environment.screenHeight ?? null,
        referrer: environment.referrer ?? null,
    });
}
function toView(row) {
    return {
        sessionId: row.sessionId,
        browserName: row.browserName,
        browserVersion: row.browserVersion,
        osName: row.osName,
        osVersion: row.osVersion,
        deviceType: row.deviceType,
        language: row.language,
        timezone: row.timezone,
        screenWidth: row.screenWidth,
        screenHeight: row.screenHeight,
        referrer: row.referrer,
    };
}
/**
 * The environment context of whichever of these anonymousIds' sessions
 * was most recently seen - "current" device/browser/OS for a profile's
 * Overview tab. A visitor/user can genuinely change devices between
 * sessions (phone one day, laptop the next), so this is a snapshot of
 * their latest session, not an aggregate.
 */
export async function getLatestEnvironmentContext(db, siteId, anonymousIds) {
    if (anonymousIds.length === 0)
        return null;
    const [row] = await db
        .select()
        .from(sessionContexts)
        .where(and(eq(sessionContexts.siteId, siteId), inArray(sessionContexts.anonymousId, anonymousIds)))
        .orderBy(desc(sessionContexts.createdAt))
        .limit(1);
    return row ? toView(row) : null;
}
/** Per-session environment context, for the Sessions tab (one row per sessionId, to show a device badge alongside each session). */
export async function getEnvironmentContextsForSessions(db, siteId, sessionIds) {
    if (sessionIds.length === 0)
        return new Map();
    const rows = await db
        .select()
        .from(sessionContexts)
        .where(and(eq(sessionContexts.siteId, siteId), inArray(sessionContexts.sessionId, sessionIds)));
    return new Map(rows.map((r) => [r.sessionId, toView(r)]));
}
//# sourceMappingURL=environmentContext.js.map