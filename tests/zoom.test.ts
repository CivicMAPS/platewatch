import { describe, expect, it } from 'vitest';
import { clampZoom, presetsFor, sliderRange, ZOOM_PRESETS } from '../src/lib/zoom';

describe('camera zoom', () => {
  it('offers 1×, 1.75×, 3.5× and 5× quick zoom', () => {
    expect([...ZOOM_PRESETS]).toEqual([1, 1.75, 3.5, 5]);
  });

  it('only offers presets the lens can reach', () => {
    expect(presetsFor({ min: 1, max: 4, step: 0.1 })).toEqual([1, 1.75, 3.5]);
    expect(presetsFor({ min: 0.6, max: 100, step: 0.1 })).toEqual([1, 1.75, 3.5, 5]);
  });

  it('caps the slider at 10× even when the lens reports more', () => {
    expect(sliderRange({ min: 0.6, max: 100, step: 0 })).toEqual({ min: 0.6, max: 10, step: 0.05 });
    expect(sliderRange({ min: 1, max: 8, step: 0.1 })).toEqual({ min: 1, max: 8, step: 0.1 });
  });

  it('clamps a stored zoom into the current lens range', () => {
    const range = { min: 1, max: 8, step: 0.1 };
    expect(clampZoom(12, range)).toBe(8);
    expect(clampZoom(0.5, range)).toBe(1);
    expect(clampZoom(Number.NaN, range)).toBe(1);
    expect(clampZoom(3.5, range)).toBe(3.5);
  });
});
