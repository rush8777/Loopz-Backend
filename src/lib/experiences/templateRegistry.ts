import type { WidgetType } from "./types.js";

export type ExperienceTemplateCategory = "widget" | "guide" | "survey" | "checklist";
export type VisualPresetId = "minimal" | "modern" | "soft" | "dark";

export interface ExperienceTemplateSummary {
  id: string;
  version: 1;
  category: ExperienceTemplateCategory;
  widgetType?: WidgetType;
  name: string;
  description: string;
  accent: string;
  surface: string;
  preset: VisualPresetId;
}

/** Bundled and deliberately data-only. Definitions are instantiated by the
 * authoritative experience factory so templates cannot bypass validation. */
export const EXPERIENCE_TEMPLATES: readonly ExperienceTemplateSummary[] = [
  { id: "widget-welcome-modal", version: 1, category: "widget", widgetType: "modal", name: "Welcome modal", description: "A warm welcome with a clear first action.", accent: "#4f46e5", surface: "#ffffff", preset: "modern" },
  { id: "widget-feature-announcement", version: 1, category: "widget", widgetType: "modal", name: "Feature announcement", description: "A polished launch card for an important update.", accent: "#7c3aed", surface: "#faf5ff", preset: "soft" },
  { id: "widget-upgrade-slideout", version: 1, category: "widget", widgetType: "slideout", name: "Upgrade or promotion", description: "A focused slideout for plans, trials, and offers.", accent: "#0f766e", surface: "#f0fdfa", preset: "modern" },
  { id: "widget-feature-tooltip", version: 1, category: "widget", widgetType: "anchored_card", name: "Contextual feature tooltip", description: "A compact explanation placed beside a product control.", accent: "#2563eb", surface: "#eff6ff", preset: "minimal" },
  { id: "widget-notification-toast", version: 1, category: "widget", widgetType: "toast", name: "Compact notification", description: "A concise confirmation or status message.", accent: "#15803d", surface: "#f0fdf4", preset: "minimal" },
  { id: "guide-new-user-onboarding", version: 1, category: "guide", name: "New-user onboarding", description: "A welcoming three-step path to the first success.", accent: "#4f46e5", surface: "#ffffff", preset: "modern" },
  { id: "guide-feature-discovery", version: 1, category: "guide", name: "Feature discovery", description: "Introduce a useful feature in context.", accent: "#0284c7", surface: "#f0f9ff", preset: "soft" },
  { id: "guide-product-tour", version: 1, category: "guide", name: "Multi-step product tour", description: "A structured tour across key product areas.", accent: "#7c3aed", surface: "#faf5ff", preset: "modern" },
  { id: "survey-csat", version: 1, category: "survey", widgetType: "survey", name: "Customer satisfaction", description: "Measure satisfaction and collect an optional explanation.", accent: "#2563eb", surface: "#ffffff", preset: "minimal" },
  { id: "survey-nps", version: 1, category: "survey", widgetType: "survey", name: "NPS feedback", description: "Capture recommendation score and the reason behind it.", accent: "#7c3aed", surface: "#faf5ff", preset: "modern" },
  { id: "survey-feature-feedback", version: 1, category: "survey", widgetType: "survey", name: "Feature feedback", description: "Learn usefulness, preference, and improvement ideas.", accent: "#0f766e", surface: "#f0fdfa", preset: "soft" },
  { id: "checklist-getting-started", version: 1, category: "checklist", name: "Getting started", description: "Guide new users through their first meaningful actions.", accent: "#4f46e5", surface: "#ffffff", preset: "modern" },
  { id: "checklist-account-setup", version: 1, category: "checklist", name: "Account setup", description: "Help teams finish profile, security, and collaboration setup.", accent: "#0284c7", surface: "#f0f9ff", preset: "soft" },
  { id: "checklist-product-activation", version: 1, category: "checklist", name: "Product activation", description: "Move users from setup to a completed core workflow.", accent: "#15803d", surface: "#f0fdf4", preset: "minimal" },
] as const;

export function templatesFor(kind: "guide" | "widget" | "checklist", widgetType?: WidgetType | null): ExperienceTemplateSummary[] {
  const category: ExperienceTemplateCategory = kind === "widget" && widgetType === "survey" ? "survey" : kind;
  return EXPERIENCE_TEMPLATES.filter(template => template.category === category && (category !== "widget" || template.widgetType === widgetType));
}

export function resolveTemplate(id: string, kind: "guide" | "widget" | "checklist", widgetType?: WidgetType | null): ExperienceTemplateSummary | null {
  return templatesFor(kind, widgetType).find(template => template.id === id) ?? null;
}
