export function getGuideStepPattern(step) { return step.pattern ?? "anchored_card"; }
export function guideStepRequiresTarget(step) { return getGuideStepPattern(step) === "anchored_card"; }
export function isGuideDefinition(definition) {
    return "steps" in definition;
}
//# sourceMappingURL=types.js.map