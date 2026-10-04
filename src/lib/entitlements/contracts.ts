/**
 * The only contract future pricing code needs to implement. Route handlers
 * should eventually depend on this boundary, never on plan names or provider
 * details. It deliberately contains no products, limits, or payment state.
 */
export type BillableResource = "site" | "member" | "dashboard" | "segment" | "funnel" | "published_experience";
export type EntitlementFeature = string;

export interface EntitlementSubject {
  orgId: string;
}

export interface EntitlementDecision {
  allowed: boolean;
  reason?: "resource_limit" | "feature_unavailable" | "subscription_inactive";
}

export interface EntitlementService {
  canCreate(subject: EntitlementSubject, resource: BillableResource): Promise<EntitlementDecision>;
  canPublishExperience(subject: EntitlementSubject): Promise<EntitlementDecision>;
  hasFeature(subject: EntitlementSubject, feature: EntitlementFeature): Promise<EntitlementDecision>;
  assertCanCreate(subject: EntitlementSubject, resource: BillableResource): Promise<void>;
  assertCanPublishExperience(subject: EntitlementSubject): Promise<void>;
  assertFeature(subject: EntitlementSubject, feature: EntitlementFeature): Promise<void>;
}
