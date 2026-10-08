import { isChecklistDefinition } from "../experiences/types.js";
export function requiredExperienceFeatures(definition) {
    const features = new Set();
    if (definition.targeting.audience.type === "segment_rules")
        features.add("advanced_audience_targeting");
    if (!isChecklistDefinition(definition)) {
        const targeting = definition.targeting;
        if (targeting.trigger.type === "custom_event")
            features.add("custom_event_trigger");
        if (targeting.trigger.type === "manual")
            features.add("manual_guide_launch");
        if (targeting.frequency.cooldownHours !== undefined || targeting.frequency.maxImpressions !== undefined)
            features.add("advanced_frequency");
        if (targeting.interruptPolicy !== undefined || targeting.priority !== 0)
            features.add("experience_orchestration");
    }
    else if (definition.targeting.priority !== 0)
        features.add("experience_orchestration");
    if (definition.targeting.schedule?.startsAt || definition.targeting.schedule?.endsAt)
        features.add("experience_scheduling");
    if ("steps" in definition && definition.steps.some(step => step.advance && step.advance.type !== "button"))
        features.add("advanced_guide_progression");
    return features;
}
//# sourceMappingURL=experienceFeatures.js.map