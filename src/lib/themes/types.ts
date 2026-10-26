export interface ThemeShadow { x: number; y: number; blur: number; spread: number; color: string }

export interface SiteThemeTokens {
  version: 1;
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
