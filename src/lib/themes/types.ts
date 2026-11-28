export interface ThemeShadow { x: number; y: number; blur: number; spread: number; color: string }

export type ThemeControl = "primaryButton" | "secondaryButton" | "input" | "selection" | "progress" | "closeButton" | "checklistItem" | "navigation";
export interface ThemeControlStyle { radius?: number; minHeight?: number; background?: string; foreground?: string }
export interface ThemeComponentStyle {
  spacing?: number; radius?: number; buttonRadius?: number; width?: number;
  bodyFontSize?: number; headingFontSize?: number; bodyLineHeight?: number; headingLineHeight?: number;
  background?: string; surface?: string; text?: string; shadow?: ThemeShadow;
}

export interface SiteThemeTokens {
  version: 1 | 2;
  colors: {
    background: string; surface: string; text: string; mutedText: string;
    primary: string; primaryForeground: string; border: string;
  };
  typography: {
    bodyFontFamily: string; headingFontFamily: string;
    bodyFontSize: number; headingFontSize: number;
    bodyFontWeight: number; headingFontWeight: number;
    bodyLineHeight: number; headingLineHeight: number;
  };
  radii: { sm: number; md: number; lg: number };
  shadows: { sm: ThemeShadow; md: ThemeShadow };
  spacing?: number;
  width?: number;
  motion?: "system" | "off";
  focusColor?: string;
  shared?: Partial<Record<ThemeControl, ThemeControlStyle>>;
  components?: Partial<Record<ThemeComponent, ThemeComponentStyle>>;
}

export const THEME_COMPONENTS = ["modal", "anchored_card", "survey", "checklist", "banner", "slideout", "toast", "hotspot", "cursor_follow", "guide"] as const;
export type ThemeComponent = typeof THEME_COMPONENTS[number];
export const THEME_CONTROLS = ["primaryButton", "secondaryButton", "input", "selection", "progress", "closeButton", "checklistItem", "navigation"] as const;

export function componentTheme(tokens: SiteThemeTokens, component: ThemeComponent): SiteThemeTokens {
  const { components, ...base } = structuredClone(tokens);
  const defaults = components?.[component];
  if (!defaults) return base;
  base.spacing = defaults.spacing ?? base.spacing;
  base.width = defaults.width ?? base.width;
  base.radii.lg = defaults.radius ?? base.radii.lg;
  if (defaults.buttonRadius !== undefined) {
    base.radii.md = defaults.buttonRadius;
    if (base.shared?.primaryButton) base.shared.primaryButton.radius = defaults.buttonRadius;
    if (base.shared?.secondaryButton) base.shared.secondaryButton.radius = defaults.buttonRadius;
  }
  if (defaults.bodyFontSize !== undefined) base.typography.bodyFontSize = defaults.bodyFontSize;
  if (defaults.headingFontSize !== undefined) base.typography.headingFontSize = defaults.headingFontSize;
  if (defaults.bodyLineHeight !== undefined) base.typography.bodyLineHeight = defaults.bodyLineHeight;
  if (defaults.headingLineHeight !== undefined) base.typography.headingLineHeight = defaults.headingLineHeight;
  if (defaults.background !== undefined) base.colors.background = defaults.background;
  if (defaults.surface !== undefined) base.colors.surface = defaults.surface;
  if (defaults.text !== undefined) base.colors.text = defaults.text;
  if (defaults.shadow !== undefined) base.shadows.md = defaults.shadow;
  return base;
}

export function authoringThemeSnapshot(tokens: SiteThemeTokens, component: ThemeComponent): SiteThemeTokens {
  if (tokens.version !== 2 || component !== "guide") return componentTheme(tokens, component);
  return structuredClone({ ...tokens, components: { guide: tokens.components?.guide, modal: tokens.components?.modal } });
}

export interface ThemeCaptureEvidence {
  confidence: Record<string, number>;
  cssVariables: Record<string, string>;
  sdkVersion: string;
}

export type VisualThemeSource = "template" | "site" | "preset";
export type VisualPresetId = "minimal" | "modern" | "soft" | "dark";
export interface VisualThemeState {
  source: VisualThemeSource;
  preset?: VisualPresetId;
  savedStyleId?: string;
  templateId?: string;
  templateTokens: SiteThemeTokens;
  baseTokens: SiteThemeTokens;
  overrides: {
    primary?: string; secondary?: string; background?: string; text?: string;
    bodyFontFamily?: string; headingFontFamily?: string;
    bodyFontSize?: number; headingFontSize?: number;
    buttonRadius?: number; radius?: number; shadow?: ThemeShadow; spacing?: number;
  };
}
