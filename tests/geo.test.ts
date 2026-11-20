import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeoTracker } from '../src/lib/geo';
import type { GeoFix } from '../src/lib/types';

const fix = (timestamp: number, accuracy: number): GeoFix => ({
  latitude: 0, longitude: 0, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null, timestamp,
});

const position = (timestamp: number, accuracy = 5) => ({
  timestamp,
  coords: { latitude: -37.8, longitude: 144.9, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
});

/** Stub navigator.geolocation so getCurrentPosition answers with `answer`. */
function stubGeolocation(answer: { timestamp: number } | null) {
  const getCurrentPosition = vi.fn((ok: (p: unknown) => void, fail: (e: unknown) => void, _options?: PositionOptions) => {
    if (answer) ok(answer);
    else fail({ code: 3, message: 'Timeout expired' });
  });
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition, watchPosition: vi.fn(), clearWatch: vi.fn() } });
  return getCurrentPosition;
}

afterEach(() => vi.unstubAllGlobals());

describe('fix ranking accounts for movement since the fix', () => {
  const moving = (timestamp: number, accuracy: number, speed: number | null): GeoFix => ({ ...fix(timestamp, accuracy), speed });
  const tracker = (fixes: GeoFix[]) => {
    const g = new GeoTracker();
    (g as unknown as { recent: GeoFix[] }).recent = fixes;
    return g;
  };

  it('prefers a recent fix over an older, tighter one when driving at 20 km/h', () => {
    // 11.5 s at 5.6 m/s is ~64 m of travel: the ±3 m fix is far from where the frame was taken.
    const g = tracker([moving(0, 3, 5.6), moving(11_500, 8, 5.6)]);
    expect(g.bestRecent(12_000, 12_000)?.timestamp).toBe(11_500);
  });

  it('still prefers the tighter fix when stationary', () => {
    const g = tracker([moving(0, 3, 0), moving(11_500, 8, 0)]);
    expect(g.bestRecent(12_000, 12_000)?.timestamp).toBe(0);
  });

  it('assumes walking pace when the receiver reports no speed', () => {
    const g = tracker([moving(0, 4, null), moving(10_000, 9, null)]);
    expect(g.bestRecent(12_000, 12_000)?.timestamp).toBe(10_000);
  });
});

describe('fix for a manual capture', () => {
  it('never attaches a fix produced after the shutter', async () => {
    const shutter = 10_000;
    stubGeolocation(position(shutter + 3_000));
    const located = await new GeoTracker().fixForCapture(shutter);
    expect(located).toBeNull();
  });

  it('ignores a watched fix that arrived after the shutter', async () => {
    const shutter = 10_000;
    stubGeolocation(null);
    const g = new GeoTracker();
    (g as unknown as { recent: GeoFix[] }).recent = [fix(9_000, 15), fix(10_500, 3)];
    expect((await g.fixForCapture(shutter))?.timestamp).toBe(9_000);
  });

  it('accepts a cached fix from before the shutter without waiting for a new one', async () => {
    const shutter = 10_000;
    const getCurrentPosition = stubGeolocation(position(shutter - 2_000));
    const located = await new GeoTracker().fixForCapture(shutter);
    expect(located?.timestamp).toBe(shutter - 2_000);
    expect(getCurrentPosition.mock.calls[0]?.[2]).toMatchObject({ timeout: 0 });
  });

  it('rejects a cached fix older than the freshness window', async () => {
    const shutter = 100_000;
    stubGeolocation(position(shutter - 60_000));
    expect(await new GeoTracker().fixForCapture(shutter)).toBeNull();
  });
});
