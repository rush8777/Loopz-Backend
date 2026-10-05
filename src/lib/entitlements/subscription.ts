import { eq } from "drizzle-orm";
import type { DbExecutor } from "../../db/client.js";
import { organizationSubscriptions } from "../../db/schema.js";
import type { PlanId } from "./plans.js";

export const TRIAL_DAYS = 14;
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";

export async function createGrowthTrial(db: DbExecutor, orgId: string, now = new Date()) {
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 86_400_000);
  const [row] = await db.insert(organizationSubscriptions).values({
    orgId, planId: "growth", status: "trialing", trialEndsAt,
  }).onConflictDoNothing().returning();
  if (row) return row;
  const [existing] = await db.select().from(organizationSubscriptions).where(eq(organizationSubscriptions.orgId, orgId)).limit(1);
  return existing;
}

export async function getOrganizationSubscription(db: DbExecutor, orgId: string, now = new Date()) {
  let [row] = await db.select().from(organizationSubscriptions).where(eq(organizationSubscriptions.orgId, orgId)).limit(1);
  if (!row) row = await createGrowthTrial(db, orgId, now);
  if (!row) throw new Error("subscription_not_created");
  if (row.status === "trialing" && row.trialEndsAt && row.trialEndsAt <= now) {
    const [expired] = await db.update(organizationSubscriptions)
      .set({ status: "expired", updatedAt: now })
      .where(eq(organizationSubscriptions.id, row.id)).returning();
    return expired;
  }
  return row;
}

export function subscriptionIsActive(row: { status: string }): boolean {
  return row.status === "trialing" || row.status === "active" || row.status === "past_due";
}

export function subscriptionPlanId(row: { planId: string }): PlanId {
  return row.planId === "growth" || row.planId === "scale" ? row.planId : "starter";
}
