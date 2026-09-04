import type { PageRule } from "../pages/types.js";

export type ExperienceKind = "guide" | "widget";
export type WidgetType = "anchored_card" | "toast" | "cursor_follow" | "modal" | "slideout" | "hotspot" | "banner";
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
}

export interface ExperienceDesign {
  width: "sm" | "md" | "lg";
  theme: {
    background: string;
    foreground: string;
    primary: string;
    borderRadius: "sm" | "md" | "lg";
  };
}

export interface ExperienceBehavior {
  dismissible: boolean;
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
  schedule?: { startsAt?: string; endsAt?: string };
  allowedOrigins?: string[];
}

export interface GuideStep {
  id: string;
  content: ExperienceContent;
  target?: ExperienceTarget;
  behavior: Pick<ExperienceBehavior, "placement" | "alignment" | "offset" | "dismissible">;
}

export interface WidgetExperienceDefinition {
  content: ExperienceContent;
  design: ExperienceDesign;
  behavior: ExperienceBehavior;
  target?: ExperienceTarget;
  targeting: ExperienceTargeting;
}

export interface GuideExperienceDefinition {
  steps: GuideStep[];
  design: ExperienceDesign;
  targeting: ExperienceTargeting;
}

export type ExperienceDefinition = WidgetExperienceDefinition | GuideExperienceDefinition;

export function isGuideDefinition(definition: ExperienceDefinition): definition is GuideExperienceDefinition {
  return "steps" in definition;
}
