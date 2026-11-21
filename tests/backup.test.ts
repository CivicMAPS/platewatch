import { beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_SCHEMA, createBackup, parseBackup, restoreBackup, sanitisePayment } from '../src/lib/backup';
import { clearDismissed, closeDb, getDismissed, saveDismissed } from '../src/lib/db';
import { GeoTracker } from '../src/lib/geo';
import type { DismissedCapture, GeoFix } from '../src/lib/types';
import { timed } from './fixtures';

const file = (lists: unknown[]) => JSON.stringify({ schema: BACKUP_SCHEMA, version: 1, lists, observations: [], scans: [] });

describe('backup import', () => {
  it('drops malformed paid-parking data instead of crashing the views', () => {
    const bad = { ...timed(), payment: { easyPark: 'x', payStay: [{ zone: 42 }, null, { zone: '00042', meter: 7 }] } };
    const [list] = parseBackup(file([bad])).lists;
    expect(list?.type === 'timed' && list.payment).toEqual({ easyPark: [], payStay: [{ zone: '00042', meter: '' }] });
  });

  it('keeps a parking area number and drops a malformed one', () => {
    const [ok] = parseBackup(file([{ ...timed(), payment: { parkingArea: '637', easyPark: [], payStay: [] } }])).lists;
    expect(ok?.type === 'timed' && ok.payment?.parkingArea).toBe('637');
    const [bad] = parseBackup(file([{ ...timed(), payment: { parkingArea: 637, easyPark: [], payStay: [] } }])).lists;
    expect(bad?.type === 'timed' && bad.payment).toEqual({ easyPark: [], payStay: [] });
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

describe('backup: patrol zone, RPA and dismissed captures', () => {
  const dismissed = (id: string): DismissedCapture => ({
    id,
    plate: 'LAWS',
    ocrText: 'LAWS',
    ocrEngine: 'patrol',
    intendedListId: 'L1',
    intendedListName: 'york_784',
    meta: { capturedAt: 1_795_211_529_148, capturedAtLocal: '2026-11-21T08:52:09.148+11:00', timeZone: 'Australia/Melbourne', location: null, locationAgeMs: null, userAgent: 'test' },
    image: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }),
    thumb: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }),
    sha256: 'abc',
    createdAt: 1_795_211_600_000,
  });

  beforeEach(async () => {
    await closeDb();
    await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('platewatch'); r.onsuccess = () => res(); r.onerror = () => res(); });
  });

  it('keeps patrol zone and RPA text, drops anything else', () => {
    const [ok] = parseBackup(file([{ ...timed(), patrolZone: '14', patrolZoneName: 'Flagstaff', rpa: '12' }])).lists;
    expect(ok?.type === 'timed' && [ok.patrolZone, ok.patrolZoneName, ok.rpa]).toEqual(['14', 'Flagstaff', '12']);
    const [bad] = parseBackup(file([{ ...timed(), patrolZone: 7, rpa: { x: 1 } }])).lists;
    expect(bad?.type === 'timed' && [bad.patrolZone, bad.rpa]).toEqual([undefined, undefined]);
  });

  it('leaves dismissed captures out unless asked, and round-trips them when included', async () => {
    await saveDismissed(dismissed('d1'));
    const without = JSON.parse(await (await createBackup(false, 'test')).text());
    expect(without.includesDismissed).toBe(false);
    expect(without.dismissed).toEqual([]);

    const withText = await (await createBackup(false, 'test', { includeDismissed: true })).text();
    const parsed = JSON.parse(withText);
    expect(parsed.includesDismissed).toBe(true);
    expect(parsed.dismissed[0].image).toMatch(/^data:image\/jpeg;base64,/);

    await clearDismissed();
    const r = await restoreBackup(withText, true);
    expect(r.dismissed).toBe(1);
    const [back] = await getDismissed();
    expect(back?.plate).toBe('LAWS');
    expect(new Uint8Array(await back!.image.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  });

  it('drops malformed dismissed entries', () => {
    const text = JSON.stringify({ schema: BACKUP_SCHEMA, version: 1, lists: [], observations: [], scans: [],
      includesDismissed: true, dismissed: [{ id: 'x', image: 'nope', thumb: 'nope', meta: {} }, null] });
    expect(parseBackup(text).dismissed).toEqual([]);
  });

  it('replacing from a backup without dismissed captures keeps the ones on the device', async () => {
    await saveDismissed(dismissed('d1'));
    await restoreBackup(await (await createBackup(false, 'test')).text(), false);
    expect(await getDismissed()).toHaveLength(1);
  });
});
