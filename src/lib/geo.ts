import type { GeoFix } from './types';

export type GeoState =
  | { status: 'idle' }
  | { status: 'unsupported' }
  | { status: 'denied'; message: string }
  | { status: 'searching' }
  | { status: 'error'; message: string }
  | { status: 'fix'; fix: GeoFix };

const toFix = (p: GeolocationPosition): GeoFix => ({
  latitude: p.coords.latitude,
  longitude: p.coords.longitude,
  accuracy: p.coords.accuracy,
  altitude: p.coords.altitude,
  altitudeAccuracy: p.coords.altitudeAccuracy,
  heading: p.coords.heading !== null && Number.isFinite(p.coords.heading) ? p.coords.heading : null,
  speed: p.coords.speed !== null && Number.isFinite(p.coords.speed) ? p.coords.speed : null,
  timestamp: p.timestamp,
});

/** How long a fix stays usable for evidence. */
const FRESH_MS = 15_000;

/** Assumed motion (m/s) when the receiver reports no speed: brisk walking. */
const WALKING_MPS = 1.5;

/**
 * Keeps the GNSS receiver warm while the camera is open (high-accuracy watch)
 * and hands out the best recent fix at the moment of capture.
 */
export class GeoTracker {
  private watchId: number | null = null;
  private recent: GeoFix[] = [];
  private listeners = new Set<(s: GeoState) => void>();
  state: GeoState = { status: 'idle' };

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  }

  subscribe(fn: (s: GeoState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(s: GeoState) {
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  start(): void {
    if (!this.supported) {
      this.set({ status: 'unsupported' });
      return;
    }
    if (this.watchId !== null) return;
    this.set({ status: 'searching' });
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        const fix = toFix(p);
        const cutoff = Date.now() - FRESH_MS;
        this.recent = [...this.recent.filter((f) => f.timestamp >= cutoff), fix].slice(-20);
        this.set({ status: 'fix', fix });
      },
      (err) => this.handleError(err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
  }

  stop(): void {
    if (this.watchId !== null && this.supported) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  private handleError(err: GeolocationPositionError) {
    if (err.code === err.PERMISSION_DENIED) {
      this.set({ status: 'denied', message: 'Location permission denied.' });
      this.stop();
    } else if (err.code === err.TIMEOUT) {
      // Keep watching; just report that no fix has arrived yet.
      if (this.state.status !== 'fix') this.set({ status: 'searching' });
    } else {
      this.set({ status: 'error', message: err.message || 'Location unavailable.' });
    }
  }

  /**
   * Fix closest to the true position at `now`, from fixes within the freshness
   * window, or null.
   *
   * Ranks by reported accuracy plus the distance the officer could have moved
   * since the fix. Accuracy alone is wrong once moving: at 20 km/h a ±3 m fix
   * from 12 s earlier is ~67 m behind the vehicle. The newest fix's speed stands
   * for current motion; when the receiver reports none, walking pace is assumed
   * so an old fix is never treated as free.
   */
  bestRecent(now = Date.now(), notAfter = Number.POSITIVE_INFINITY): GeoFix | null {
    const fresh = this.recent.filter((f) => now - f.timestamp <= FRESH_MS && f.timestamp <= notAfter);
    if (!fresh.length) return null;
    const newest = fresh.reduce((a, f) => (f.timestamp > a.timestamp ? f : a));
    const speed = newest.speed !== null && newest.speed >= 0 ? newest.speed : WALKING_MPS;
    const error = (f: GeoFix) => f.accuracy + (speed * Math.max(0, now - f.timestamp)) / 1000;
    return fresh.reduce((best, f) => (error(f) < error(best) ? f : best));
  }

  /**
   * Fix for a capture taken at `capturedAt`: the best fix produced at or before
   * the shutter and no older than the freshness window, otherwise null.
   *
   * Never waits for a new fix. A fix obtained after the shutter describes where
   * the officer moved to, not where the vehicle was photographed, so it is not
   * evidence of the capture location. Falls back only to the platform's cached
   * position (`timeout: 0` answers from cache or fails at once).
   */
  async fixForCapture(capturedAt: number): Promise<GeoFix | null> {
    const best = this.bestRecent(capturedAt, capturedAt);
    if (best) return best;
    if (!this.supported || this.state.status === 'denied') return null;
    const cached = await new Promise<GeoFix | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(toFix(p)),
        () => resolve(null),
        { enableHighAccuracy: true, maximumAge: FRESH_MS, timeout: 0 },
      );
    });
    if (!cached) return null;
    const age = capturedAt - cached.timestamp;
    return age >= 0 && age <= FRESH_MS ? cached : null;
  }
}

export const geo = new GeoTracker();

export function formatLatLng(fix: GeoFix): string {
  return `${fix.latitude.toFixed(6)}, ${fix.longitude.toFixed(6)}`;
}

export function accuracyTone(accuracy: number | undefined, warnAt: number): 'good' | 'fair' | 'poor' {
  if (accuracy === undefined) return 'poor';
  if (accuracy <= Math.min(10, warnAt)) return 'good';
  if (accuracy <= warnAt) return 'fair';
  return 'poor';
}

/** Map link for officers to verify the location (opened in the external maps app). */
export function mapUrl(fix: GeoFix): string {
  return `https://www.google.com/maps/search/?api=1&query=${fix.latitude.toFixed(7)},${fix.longitude.toFixed(7)}`;
}
