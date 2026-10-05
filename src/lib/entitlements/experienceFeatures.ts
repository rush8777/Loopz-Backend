import { isChecklistDefinition, type ExperienceDefinition } from "../experiences/types.js";
import type { EntitlementFeature } from "./contracts.js";

export function requiredExperienceFeatures(definition: ExperienceDefinition): Set<EntitlementFeature> {
  const features = new Set<EntitlementFeature>();
  if (definition.targeting.audience.type === "segment_rules") features.add("advanced_audience_targeting");
  if (!isChecklistDefinition(definition)) {
    const targeting = definition.targeting;
    if (targeting.trigger.type === "custom_event") features.add("custom_event_trigger");
    if (targeting.trigger.type === "manual") features.add("manual_guide_launch");
    if (targeting.frequency.cooldownHours !== undefined || targeting.frequency.maxImpressions !== undefined) features.add("advanced_frequency");
    if (targeting.interruptPolicy !== undefined || targeting.priority !== 0) features.add("experience_orchestration");
  } else if (definition.targeting.priority !== 0) features.add("experience_orchestration");
  if (definition.targeting.schedule?.startsAt || definition.targeting.schedule?.endsAt) features.add("experience_scheduling");
  if ("steps" in definition && definition.steps.some(step => step.advance && step.advance.type !== "button")) features.add("advanced_guide_progression");
  return features;
}
