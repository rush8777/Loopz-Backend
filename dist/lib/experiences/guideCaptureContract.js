export const GUIDE_CAPTURE_PLACEHOLDER = "movcues_guided_capture_pending";
export function isPendingGuideCapture(definition) {
    if (!definition || typeof definition !== "object" || !("steps" in definition))
        return false;
    const { steps } = definition;
    return Array.isArray(steps) && steps.some(step => step?.id === GUIDE_CAPTURE_PLACEHOLDER);
}
//# sourceMappingURL=guideCaptureContract.js.map