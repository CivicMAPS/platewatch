import { describe, expect, it } from 'vitest';
import { clampZoom, nextPreset, presetsFor, sliderRange, ZOOM_PRESETS } from '../src/lib/zoom';

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

describe('single zoom button', () => {
  const range = { min: 0.6, max: 100, step: 0.1 };

  it('steps through 1×, 1.75×, 3.5×, 5× and wraps back to 1×', () => {
    expect(nextPreset(1, range)).toBe(1.75);
    expect(nextPreset(1.75, range)).toBe(3.5);
    expect(nextPreset(3.5, range)).toBe(5);
    expect(nextPreset(5, range)).toBe(1);
  });

  it('steps from a custom slider zoom to the next preset above it', () => {
    expect(nextPreset(2.4, range)).toBe(3.5);
    expect(nextPreset(8, range)).toBe(1);
  });

  it('skips presets the lens cannot reach', () => {
    expect(nextPreset(1.75, { min: 1, max: 3, step: 0.1 })).toBe(1);
  });
});
