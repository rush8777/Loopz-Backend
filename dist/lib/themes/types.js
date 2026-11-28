export const THEME_COMPONENTS = ["modal", "anchored_card", "survey", "checklist", "banner", "slideout", "toast", "hotspot", "cursor_follow", "guide", "geo_agent"];
export const THEME_CONTROLS = ["primaryButton", "secondaryButton", "input", "selection", "progress", "closeButton", "checklistItem", "navigation"];
export function componentTheme(tokens, component) {
    const { components, ...base } = structuredClone(tokens);
    const defaults = components?.[component];
    if (!defaults)
        return base;
    base.spacing = defaults.spacing ?? base.spacing;
    base.width = defaults.width ?? base.width;
    base.radii.lg = defaults.radius ?? base.radii.lg;
    if (defaults.buttonRadius !== undefined) {
        base.radii.md = defaults.buttonRadius;
        if (base.shared?.primaryButton)
            base.shared.primaryButton.radius = defaults.buttonRadius;
        if (base.shared?.secondaryButton)
            base.shared.secondaryButton.radius = defaults.buttonRadius;
    }
    if (defaults.bodyFontSize !== undefined)
        base.typography.bodyFontSize = defaults.bodyFontSize;
    if (defaults.headingFontSize !== undefined)
        base.typography.headingFontSize = defaults.headingFontSize;
    if (defaults.bodyLineHeight !== undefined)
        base.typography.bodyLineHeight = defaults.bodyLineHeight;
    if (defaults.headingLineHeight !== undefined)
        base.typography.headingLineHeight = defaults.headingLineHeight;
    if (defaults.background !== undefined)
        base.colors.background = defaults.background;
    if (defaults.surface !== undefined)
        base.colors.surface = defaults.surface;
    if (defaults.text !== undefined)
        base.colors.text = defaults.text;
    if (defaults.shadow !== undefined)
        base.shadows.md = defaults.shadow;
    return base;
}
export function authoringThemeSnapshot(tokens, component) {
    if (tokens.version !== 2 || component !== "guide")
        return componentTheme(tokens, component);
    return structuredClone({ ...tokens, components: { guide: tokens.components?.guide, modal: tokens.components?.modal } });
}
//# sourceMappingURL=types.js.map