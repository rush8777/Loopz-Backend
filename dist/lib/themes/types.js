export const THEME_COMPONENTS = ["modal", "anchored_card", "survey", "checklist", "banner", "slideout", "toast", "hotspot", "cursor_follow", "guide"];
export function componentTheme(tokens, component) {
    const { components, ...base } = tokens;
    const defaults = components?.[component];
    if (!defaults)
        return base;
    return {
        ...base,
        spacing: defaults.spacing ?? base.spacing,
        radii: { ...base.radii, lg: defaults.radius ?? base.radii.lg, md: defaults.buttonRadius ?? base.radii.md },
    };
}
//# sourceMappingURL=types.js.map