import type { BillableResource, EntitlementFeature } from "./contracts.js";

export type PlanId = "starter" | "growth" | "scale";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  monthlyActiveUsers: number;
  limits: Record<BillableResource, number>;
  features: ReadonlySet<EntitlementFeature>;
}

const GROWTH_FEATURES = new Set<EntitlementFeature>([
  "advanced_audience_targeting",
  "custom_event_trigger",
  "manual_guide_launch",
  "experience_scheduling",
  "advanced_frequency",
  "advanced_guide_progression",
  "experience_orchestration",
]);

export const PLAN_CATALOG: Record<PlanId, PlanDefinition> = {
  starter: {
    id: "starter", name: "Starter", monthlyActiveUsers: 5_000,
    limits: { site: 1, member: 3, dashboard: 3, segment: 10, funnel: 3, published_experience: 5 },
    features: new Set(),
  },
  growth: {
    id: "growth", name: "Growth", monthlyActiveUsers: 15_000,
    limits: { site: 3, member: 10, dashboard: 10, segment: 50, funnel: 15, published_experience: 25 },
    features: GROWTH_FEATURES,
  },
  scale: {
    id: "scale", name: "Scale", monthlyActiveUsers: 50_000,
    limits: { site: 10, member: 30, dashboard: 30, segment: 200, funnel: 50, published_experience: 100 },
    features: GROWTH_FEATURES,
  },
};

export function isPlanId(value: string): value is PlanId { return value in PLAN_CATALOG; }
export function planDefinition(value: string): PlanDefinition { return PLAN_CATALOG[isPlanId(value) ? value : "starter"]; }
