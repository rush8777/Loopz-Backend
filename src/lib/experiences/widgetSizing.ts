import type { ExperienceDefinition, ExperienceSize, WidgetType } from "./types.js";

interface WidgetSizeConstraint {
  width: { default: number | "full"; min?: number; max?: number; allowFull?: boolean };
  height: { allowFixed?: boolean; allowViewport?: boolean; min?: number; max?: number };
}

export const WIDGET_SIZE_CONSTRAINTS: Record<WidgetType, WidgetSizeConstraint> = {
  anchored_card: { width: { default: 320, min: 240, max: 480 }, height: { allowFixed: true, min: 120, max: 700 } },
  toast: { width: { default: 380, min: 280, max: 520 }, height: {} },
  cursor_follow: { width: { default: 280, min: 200, max: 360 }, height: {} },
  modal: { width: { default: 600, min: 320, max: 960, allowFull: true }, height: { allowFixed: true, allowViewport: true, min: 200, max: 900 } },
  slideout: { width: { default: 400, min: 320, max: 640 }, height: { allowFixed: true, allowViewport: true, min: 240, max: 900 } },
  hotspot: { width: { default: 300, min: 220, max: 420 }, height: {} },
  banner: { width: { default: "full" }, height: {} },
  survey: { width: { default: 700, min: 320, max: 960, allowFull: true }, height: { allowFixed: true, allowViewport: true, min: 200, max: 900 } },
};

export function defaultWidgetSize(widgetType: WidgetType): ExperienceSize {
  const width = WIDGET_SIZE_CONSTRAINTS[widgetType].width.default;
  return { width: width === "full" ? { mode: "full" } : { mode: "fixed", value: width }, height: { mode: "auto" } };
}

function sizeIsValid(widgetType: WidgetType, size: ExperienceSize): boolean {
  const { width, height } = size; const constraint = WIDGET_SIZE_CONSTRAINTS[widgetType];
  if (widgetType === "banner") return width.mode === "full" && height.mode === "auto";
  if (width.mode !== "fixed" && !(width.mode === "full" && constraint.width.allowFull)) return false;
  if (width.mode === "fixed" && (width.value === undefined || width.value < constraint.width.min! || width.value > constraint.width.max!)) return false;
  if (height.mode === "fixed" && (!constraint.height.allowFixed || height.value === undefined || height.value < constraint.height.min! || height.value > constraint.height.max!)) return false;
  if (height.mode === "viewport" && !constraint.height.allowViewport) return false;
  return true;
}

export function widgetSizeIsValid(widgetType: WidgetType, definition: ExperienceDefinition): boolean {
  if ("steps" in definition) return true;
  const sizes = [definition.design.size, ...(widgetType === "survey" ? definition.survey?.steps.map(step => step.size) ?? [] : [])].filter((size): size is ExperienceSize => Boolean(size));
  return sizes.every(size => sizeIsValid(widgetType, size));
}
