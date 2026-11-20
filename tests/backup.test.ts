import { describe, expect, it } from 'vitest';
import { BACKUP_SCHEMA, parseBackup, sanitisePayment } from '../src/lib/backup';
import { GeoTracker } from '../src/lib/geo';
import type { GeoFix } from '../src/lib/types';
import { timed } from './fixtures';

const file = (lists: unknown[]) => JSON.stringify({ schema: BACKUP_SCHEMA, version: 1, lists, observations: [], scans: [] });

describe('backup import', () => {
  it('drops malformed paid-parking data instead of crashing the views', () => {
    const bad = { ...timed(), payment: { easyPark: 'x', payStay: [{ zone: 42 }, null, { zone: '00042', meter: 7 }] } };
    const [list] = parseBackup(file([bad])).lists;
    expect(list?.type === 'timed' && list.payment).toEqual({ easyPark: [], payStay: [{ zone: '00042', meter: '' }] });
  });

  it('keeps valid paid-parking data', () => {
    const payment = { easyPark: ['010'], payStay: [{ zone: '020', meter: '03' }] };
    const [list] = parseBackup(file([{ ...timed(), payment }])).lists;
    expect(list?.type === 'timed' && list.payment).toEqual(payment);
  });

  it('treats a missing payment as none and a non-array allowListIds as empty', () => {
    expect(sanitisePayment(undefined)).toBeUndefined();
    const [list] = parseBackup(file([{ ...timed(), allowListIds: 'allow-1' }])).lists;
    expect(list?.type === 'timed' && list.allowListIds).toEqual([]);
  });
});

describe('geo fix selection', () => {
  const fix = (timestamp: number, accuracy: number): GeoFix => ({
    latitude: 0, longitude: 0, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null, timestamp,
  });

  it('ignores fixes produced after the frame when a cutoff is given', () => {
    const g = new GeoTracker();
    (g as unknown as { recent: GeoFix[] }).recent = [fix(1_000, 12), fix(2_500, 3)];
    expect(g.bestRecent(2_000)?.accuracy).toBe(3);
    expect(g.bestRecent(2_000, 2_000)?.accuracy).toBe(12);
  });
});
