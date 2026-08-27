import { eq, and } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { trackedUsers, trackedUserAliases, trackedUserProperties } from "../../db/schema.js";

export interface IdentifyInput {
  siteId: string; // internal site.id, already resolved from the public siteId
  anonymousId?: string;
  externalUserId: string;
  traits?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Resolves one identify() call into the tracked-user identity layer:
 *
 *   1. find-or-create the tracked_users row for (siteId, externalUserId)
 *   2. point anonymousId's alias at it (so prior/future anonymous
 *      activity under that anonymousId shows up on this profile)
 *   3. upsert any supplied trait attributes as user properties
 *
 * Called from the public events ingestion route, once per identify
 * event in a batch - see public-events.ts. Never touches
 * session_events/behavioral_events; this is purely the identity/
 * properties side of the profile layer (task brief sections 3-6).
 */
export async function resolveIdentity(db: Db, input: IdentifyInput): Promise<{ trackedUserId: string }> {
  const { siteId, anonymousId, externalUserId, traits, timestamp } = input;
  const now = new Date(timestamp);

  const [existingUser] = await db
    .select()
    .from(trackedUsers)
    .where(and(eq(trackedUsers.siteId, siteId), eq(trackedUsers.externalUserId, externalUserId)))
    .limit(1);

  let trackedUserId: string;
  if (!existingUser) {
    const [created] = await db
      .insert(trackedUsers)
      .values({
        siteId,
        externalUserId,
        firstSeenAt: now,
        lastSeenAt: now,
        firstIdentifiedAt: now,
        lastIdentifiedAt: now,
      })
      .returning();
    trackedUserId = created.id;
  } else {
    trackedUserId = existingUser.id;
    await db
      .update(trackedUsers)
      .set({
        // Never move lastSeenAt/lastIdentifiedAt backwards - batches
        // can arrive slightly out of order, and this row's "current"
        // state should reflect the most recent thing we've seen, not
        // whichever request happened to land last.
        lastSeenAt: now > existingUser.lastSeenAt ? now : existingUser.lastSeenAt,
        lastIdentifiedAt: now > existingUser.lastIdentifiedAt ? now : existingUser.lastIdentifiedAt,
        updatedAt: new Date(),
      })
      .where(eq(trackedUsers.id, trackedUserId));
  }

  if (anonymousId) {
    const [existingAlias] = await db
      .select()
      .from(trackedUserAliases)
      .where(and(eq(trackedUserAliases.siteId, siteId), eq(trackedUserAliases.anonymousId, anonymousId)))
      .limit(1);

    if (!existingAlias) {
      await db.insert(trackedUserAliases).values({
        siteId,
        trackedUserId,
        anonymousId,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    } else {
      // Re-point rather than duplicate, even if this anonymousId was
      // previously aliased to a different tracked user (shared device,
      // or someone logging in as a different account) - the alias
      // table's job is "who does this anonymousId currently resolve
      // to", not a full history of every identity it's ever touched.
      await db
        .update(trackedUserAliases)
        .set({
          trackedUserId,
          lastSeenAt: now > existingAlias.lastSeenAt ? now : existingAlias.lastSeenAt,
        })
        .where(eq(trackedUserAliases.id, existingAlias.id));
    }
  }

  if (traits) {
    for (const [name, rawValue] of Object.entries(traits)) {
      if (rawValue === undefined) continue;
      const { value, valueType } = serializeTraitValue(rawValue);

      const [existingProp] = await db
        .select()
        .from(trackedUserProperties)
        .where(and(eq(trackedUserProperties.trackedUserId, trackedUserId), eq(trackedUserProperties.name, name)))
        .limit(1);

      if (!existingProp) {
        await db.insert(trackedUserProperties).values({
          trackedUserId,
          siteId,
          name,
          value,
          valueType,
          source: "identify",
          firstSeenAt: now,
          lastSeenAt: now,
        });
      } else {
        await db
          .update(trackedUserProperties)
          .set({
            value,
            valueType,
            lastSeenAt: now > existingProp.lastSeenAt ? now : existingProp.lastSeenAt,
            updatedAt: new Date(),
          })
          .where(eq(trackedUserProperties.id, existingProp.id));
      }
    }
  }

  return { trackedUserId };
}

function serializeTraitValue(raw: unknown): { value: string; valueType: string } {
  if (raw === null) return { value: "", valueType: "null" };
  if (typeof raw === "string") return { value: raw, valueType: "string" };
  if (typeof raw === "number") return { value: String(raw), valueType: "number" };
  if (typeof raw === "boolean") return { value: String(raw), valueType: "boolean" };
  // Arrays/nested objects - stored as JSON text, flagged so the API/UI
  // can render them distinctly rather than as a plain string.
  return { value: JSON.stringify(raw), valueType: "object" };
}
