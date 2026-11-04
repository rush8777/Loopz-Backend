export const ORDINARY_BUTTON_ACTIONS = [
    { type: "dismiss", label: "Dismiss", contexts: ["widget", "guide"], requiredConfiguration: [], runtimeRequirement: "dismiss" },
    { type: "next_step", label: "Next step", contexts: ["guide"], requiredConfiguration: [], runtimeRequirement: "guide_advance" },
    { type: "previous_step", label: "Previous step", contexts: ["guide"], requiredConfiguration: [], runtimeRequirement: "guide_back" },
    { type: "open_url", label: "Open URL", contexts: ["widget", "guide"], requiredConfiguration: ["url"], runtimeRequirement: "navigation" },
    { type: "track_event", label: "Track event", contexts: ["widget", "guide"], requiredConfiguration: ["eventName"], runtimeRequirement: "analytics" },
];
export const ORDINARY_ACTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
export function ordinaryButtonActionErrors(value, context) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return ["Action configuration is missing."];
    const action = value;
    const definition = ORDINARY_BUTTON_ACTIONS.find(candidate => candidate.type === action.type);
    if (!definition)
        return ["Action type is unsupported."];
    if (!definition.contexts.includes(context))
        return [`${definition.label} is only supported by Guides.`];
    if (definition.type === "open_url" && (typeof action.url !== "string" || action.url.length > 2_000 || !/^https?:\/\//i.test(action.url)))
        return ["Open URL actions must use a complete HTTP(S) URL."];
    if (definition.type === "track_event" && (typeof action.eventName !== "string" || !action.eventName.trim() || action.eventName.length > 200 || /[\u0000-\u001f\u007f]/.test(action.eventName)))
        return ["Track event actions require an event name of 1-200 characters."];
    return [];
}
//# sourceMappingURL=ordinaryButtonAction.js.map