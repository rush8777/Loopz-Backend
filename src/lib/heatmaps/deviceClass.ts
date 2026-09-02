export const MOBILE_MAX_WIDTH = 767;
export const TABLET_MAX_WIDTH = 1023;

export type HeatmapDeviceClass = "desktop" | "tablet" | "mobile";

export function classifyHeatmapDevice(viewportWidth: number): HeatmapDeviceClass {
  if (viewportWidth <= MOBILE_MAX_WIDTH) return "mobile";
  if (viewportWidth <= TABLET_MAX_WIDTH) return "tablet";
  return "desktop";
}
