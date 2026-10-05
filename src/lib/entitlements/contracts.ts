/**
 * The only contract future pricing code needs to implement. Route handlers
 * should eventually depend on this boundary, never on plan names or provider
 * details. It deliberately contains no products, limits, or payment state.
 */
export type BillableResource = "site" | "member" | "dashboard" | "segment" | "funnel" | "published_experience";
export type EntitlementFeature =
  | "advanced_audience_targeting"
  | "custom_event_trigger"
  | "manual_guide_launch"
  | "experience_scheduling"
  | "advanced_frequency"
  | "advanced_guide_progression"
  | "experience_orchestration";

export interface EntitlementSubject {
  orgId: string;
  siteId?: string;
  resourceId?: string;
}

export interface EntitlementDecision {
  allowed: boolean;
  reason?: "resource_limit" | "feature_unavailable" | "subscription_inactive";
  planId?: string;
  resource?: BillableResource;
  feature?: EntitlementFeature;
  current?: number;
  limit?: number;
  trialEndsAt?: string | null;
  upgradeRequired?: boolean;
}

export interface EntitlementService {
  canCreate(subject: EntitlementSubject, resource: BillableResource): Promise<EntitlementDecision>;
  canPublishExperience(subject: EntitlementSubject): Promise<EntitlementDecision>;
  hasFeature(subject: EntitlementSubject, feature: EntitlementFeature): Promise<EntitlementDecision>;
  assertCanCreate(subject: EntitlementSubject, resource: BillableResource): Promise<void>;
  assertCanPublishExperience(subject: EntitlementSubject): Promise<void>;
  assertFeature(subject: EntitlementSubject, feature: EntitlementFeature): Promise<void>;
}
