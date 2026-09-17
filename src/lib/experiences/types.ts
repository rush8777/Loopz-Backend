import type { PageRule } from "../pages/types.js";

export type ExperienceKind = "guide" | "widget";
export type WidgetType = "anchored_card" | "toast" | "cursor_follow" | "modal" | "slideout" | "hotspot" | "banner" | "survey";
export type ExperienceStatus = "draft" | "published" | "paused" | "archived";

export interface ExperienceAction {
  label: string;
  type: "dismiss" | "next_step" | "open_url" | "track_event";
  url?: string;
  eventName?: string;
}

export interface ExperienceContent {
  heading: string;
  body: string;
  primaryAction?: ExperienceAction;
  secondaryAction?: { label: string; type: "dismiss" };
}

export interface ExperienceTarget {
  primarySelector: string;
  fallbackSelectors: string[];
  label?: string;
  role?: string;
  tagName?: string;
  reliability: "reliable" | "moderate" | "fragile";
  targetContext?: { pagePath: string };
}

export type LegacyExperienceWidth = "sm" | "md" | "lg";

export interface ExperienceSize {
  width: { mode: "auto" | "fixed" | "full"; value?: number };
  height: { mode: "auto" | "fixed" | "viewport"; value?: number };
}

export interface ExperienceDesign {
  width: LegacyExperienceWidth;
  size?: ExperienceSize;
  theme: {
    background: string;
    foreground: string;
    primary: string;
    borderRadius: "sm" | "md" | "lg";
  };
}

export interface WidgetBuilderState {
  version: 1;
  projectData: Record<string, unknown>;
  html: string;
  css: string;
}

export type ExperienceLayer =
  | { mode: "auto" }
  | { mode: "relative"; relation: "above" | "below"; target: ExperienceTarget }
  | { mode: "always_on_top" }
  | { mode: "custom"; zIndex: number };

export interface ExperienceBehavior {
  dismissible: boolean;
  layer?: ExperienceLayer;
  zIndex?: number;
  placement?: "auto" | "top" | "right" | "bottom" | "left";
  alignment?: "start" | "center" | "end";
  offset?: number;
  toastPosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  autoDismissMs?: number | null;
  cursorOffset?: { x: number; y: number };
  modalLayout?: "center" | "fullscreen";
  backdrop?: boolean;
  backdropOpacity?: number;
  closeOnBackdrop?: boolean;
  slideoutPosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center-left" | "center-right";
  bannerPosition?: "top" | "bottom";
  hotspotStyle?: "pulse" | "dot" | "question";
  hotspotColor?: string;
}

export interface ExperienceTargeting {
  pageRules: PageRule[];
  audience: { type: "all" } | { type: "segment"; segmentId: string } | { type: "segment_rules"; logic: "all" | "any"; conditions: Array<{ id: string; segmentId: string; operator: "matches" | "not_matches" }> };
  trigger: { type: "page_load" } | { type: "custom_event"; eventName: string };
  frequency: {
    mode: "once" | "once_per_session" | "every_time";
    cooldownHours?: number;
    maxImpressions?: number;
  };
  priority: number;
  interruptPolicy?: "queue" | "interrupt";
  schedule?: { startsAt?: string; endsAt?: string };
  allowedOrigins?: string[];
}

export interface GuideStep {
  id: string;
  pattern?: GuideStepPattern;
  content: ExperienceContent;
  builder?: WidgetBuilderState;
  size?: ExperienceSize;
  advance?: { type: "button" } | { type: "element_click" } | { type: "element_hover"; durationMs?: number } | { type: "custom_event"; eventName: string } | { type: "route"; pageRules: PageRule[] };
  target?: ExperienceTarget;
  behavior: Pick<ExperienceBehavior, "placement" | "alignment" | "offset" | "dismissible">;
}

export type GuideStepPattern = "anchored_card" | "modal";
export function getGuideStepPattern(step: Pick<GuideStep, "pattern">): GuideStepPattern { return step.pattern ?? "anchored_card"; }
export function guideStepRequiresTarget(step: Pick<GuideStep, "pattern">): boolean { return getGuideStepPattern(step) === "anchored_card"; }

export interface SurveyOption { id: string; label: string }
export type SurveyQuestion =
  | { id: string; type: "single_choice"; label: string; required?: boolean; options: SurveyOption[] }
  | { id: string; type: "multiple_choice"; label: string; required?: boolean; options: SurveyOption[] }
  | { id: string; type: "short_text"; label: string; required?: boolean; placeholder?: string; maxLength?: number }
  | { id: string; type: "long_text"; label: string; required?: boolean; placeholder?: string; maxLength?: number }
  | { id: string; type: "rating"; label: string; required?: boolean; min: number; max: number }
  | { id: string; type: "nps"; label: string; required?: boolean };
export interface SurveyStep { id: string; content: { heading: string; body: string }; questions: SurveyQuestion[]; builder?: WidgetBuilderState; size?: ExperienceSize }
export interface SurveyConfig { steps: SurveyStep[]; showProgress: boolean; allowBack: boolean; submitLabel: string }
export type SurveyAnswers = Record<string, string | string[] | number>;

export interface WidgetExperienceDefinition {
  content: ExperienceContent;
  design: ExperienceDesign;
  behavior: ExperienceBehavior;
  builder?: WidgetBuilderState;
  target?: ExperienceTarget;
  targeting: ExperienceTargeting;
  survey?: SurveyConfig;
}

export interface GuideExperienceDefinition {
  steps: GuideStep[];
  design: ExperienceDesign;
  behavior?: { layer?: ExperienceLayer };
  targeting: ExperienceTargeting;
}

export type ExperienceDefinition = WidgetExperienceDefinition | GuideExperienceDefinition;

export function isGuideDefinition(definition: ExperienceDefinition): definition is GuideExperienceDefinition {
  return "steps" in definition;
}
