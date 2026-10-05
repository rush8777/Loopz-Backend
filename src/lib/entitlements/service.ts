import type { DbExecutor } from "../../db/client.js";
import type { BillableResource, EntitlementDecision, EntitlementFeature, EntitlementService, EntitlementSubject } from "./contracts.js";
import { planDefinition } from "./plans.js";
import { getOrganizationSubscription, subscriptionIsActive, subscriptionPlanId } from "./subscription.js";
import {
  getMemberUsage,
  getOrganizationDashboardUsage,
  getOrganizationFunnelUsage,
  getOrganizationPublishedExperienceUsage,
  getOrganizationSegmentUsage,
  getSiteUsage,
} from "../usage/usage.js";

export class EntitlementDeniedError extends Error {
  constructor(readonly decision: EntitlementDecision) { super(decision.reason ?? "entitlement_denied"); }
}

export async function assertSubscriptionActive(db: DbExecutor, orgId: string, now = new Date()): Promise<void> {
  const subscription = await getOrganizationSubscription(db, orgId, now);
  if (subscriptionIsActive(subscription)) return;
  const plan = planDefinition(subscriptionPlanId(subscription));
  throw new EntitlementDeniedError({
    allowed: false, reason: "subscription_inactive", planId: plan.id,
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null, upgradeRequired: true,
  });
}

async function resourceUsage(db: DbExecutor, subject: EntitlementSubject, resource: BillableResource): Promise<number> {
  if (resource === "site") return getSiteUsage(db, subject.orgId);
  if (resource === "member") return getMemberUsage(db, subject.orgId);
  if (resource === "dashboard") return getOrganizationDashboardUsage(db, subject.orgId);
  if (resource === "segment") return getOrganizationSegmentUsage(db, subject.orgId);
  if (resource === "funnel") return getOrganizationFunnelUsage(db, subject.orgId);
  return getOrganizationPublishedExperienceUsage(db, subject.orgId);
}

export function createEntitlementService(db: DbExecutor, now: () => Date = () => new Date()): EntitlementService {
  async function context(subject: EntitlementSubject) {
    const subscription = await getOrganizationSubscription(db, subject.orgId, now());
    const plan = planDefinition(subscriptionPlanId(subscription));
    return { subscription, plan };
  }
  async function canCreate(subject: EntitlementSubject, resource: BillableResource): Promise<EntitlementDecision> {
    const { subscription, plan } = await context(subject);
    const common = { planId: plan.id, resource, trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null };
    if (!subscriptionIsActive(subscription)) return { allowed: false, reason: "subscription_inactive", upgradeRequired: true, ...common };
    const current = await resourceUsage(db, subject, resource); const limit = plan.limits[resource];
    return current < limit ? { allowed: true, current, limit, ...common } : { allowed: false, reason: "resource_limit", current, limit, upgradeRequired: true, ...common };
  }
  async function hasFeature(subject: EntitlementSubject, feature: EntitlementFeature): Promise<EntitlementDecision> {
    const { subscription, plan } = await context(subject);
    const common = { planId: plan.id, feature, trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null };
    if (!subscriptionIsActive(subscription)) return { allowed: false, reason: "subscription_inactive", upgradeRequired: true, ...common };
    return plan.features.has(feature) ? { allowed: true, ...common } : { allowed: false, reason: "feature_unavailable", upgradeRequired: true, ...common };
  }
  const assert = async (decision: Promise<EntitlementDecision>) => { const result = await decision; if (!result.allowed) throw new EntitlementDeniedError(result); };
  return {
    canCreate,
    canPublishExperience: (subject) => canCreate(subject, "published_experience"),
    hasFeature,
    assertCanCreate: (subject, resource) => assert(canCreate(subject, resource)),
    assertCanPublishExperience: (subject) => assert(canCreate(subject, "published_experience")),
    assertFeature: (subject, feature) => assert(hasFeature(subject, feature)),
  };
}
