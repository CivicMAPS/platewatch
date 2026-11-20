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

  /** Most accurate fix produced within the freshness window, or null. */
  bestRecent(now = Date.now()): GeoFix | null {
    const fresh = this.recent.filter((f) => now - f.timestamp <= FRESH_MS);
    if (!fresh.length) return null;
    return fresh.reduce((best, f) => (f.accuracy < best.accuracy ? f : best));
  }

  /**
   * Fix for a capture taken at `capturedAt`. Uses the best recent fix, otherwise
   * waits (bounded) for a fresh high-accuracy fix.
   */
  async fixForCapture(capturedAt: number, timeoutMs = 8_000): Promise<GeoFix | null> {
    const best = this.bestRecent(capturedAt);
    if (best) return best;
    if (!this.supported || this.state.status === 'denied') return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(toFix(p)),
        () => resolve(null),
        { enableHighAccuracy: true, maximumAge: FRESH_MS, timeout: timeoutMs },
      );
    });
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
