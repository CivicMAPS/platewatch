/**
 * Camera zoom shared by the web scan camera and the native patrol camera.
 *
 * Zoom lets an officer read a plate from the footpath or the vehicle instead of
 * stepping in front of the car. Tapping a preset jumps straight to it; a long
 * press opens a slider for an exact zoom.
 */

export interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

/** Quick zoom points. 1× is the way back to the wide view. */
export const ZOOM_PRESETS = [1, 1.75, 3.5, 5] as const;

/** Beyond 10× the image softens and hand shake dominates, so the slider stops there. */
export const MAX_SLIDER_ZOOM = 10;

/** Long-press duration that opens the slider instead of choosing a preset. */
export const LONG_PRESS_MS = 450;

export function sliderRange(range: ZoomRange): ZoomRange {
  return { min: range.min, max: Math.min(range.max, MAX_SLIDER_ZOOM), step: range.step > 0 ? range.step : 0.05 };
}

export function presetsFor(range: ZoomRange): number[] {
  const { min, max } = sliderRange(range);
  return ZOOM_PRESETS.filter((z) => z >= min - 1e-6 && z <= max + 1e-6);
}

/**
 * Single zoom button: each tap moves to the next preset above the current zoom, wrapping to
 * the lowest reachable preset. Mirrored in PatrolCamera.java `nextPreset`.
 */
export function nextPreset(current: number, range: ZoomRange): number {
  const reachable = presetsFor(range);
  if (!reachable.length) return sliderRange(range).min;
  return reachable.find((z) => z > current + 0.01) ?? reachable[0]!;
}

export function clampZoom(zoom: number, range: ZoomRange): number {
  const { min, max } = sliderRange(range);
  if (!Number.isFinite(zoom)) return min;
  return Math.min(max, Math.max(min, zoom));
}

export function formatZoom(zoom: number): string {
  return `${Number(zoom.toFixed(2))}×`;
}
