import { beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_SCHEMA, createBackup, parseBackup, restoreBackup, sanitisePayment } from '../src/lib/backup';
import { clearDismissed, closeDb, getDismissed, saveDismissed } from '../src/lib/db';
import { GeoTracker } from '../src/lib/geo';
import type { DismissedCapture, GeoFix } from '../src/lib/types';
import { timed } from './fixtures';

const file = (lists: unknown[]) => JSON.stringify({ schema: BACKUP_SCHEMA, version: 1, lists, observations: [], scans: [] });

describe('backup import', () => {
  it('keeps a well-formed list source and drops a malformed one', () => {
    const src = { origin: 'system', importedFrom: 'zone-3.csv', importedAt: 1_800_000_000_000, junk: 1 };
    const [ok] = parseBackup(file([{ ...timed(), source: src }])).lists;
    expect(ok!.source).toEqual({ origin: 'system', importedFrom: 'zone-3.csv', importedAt: 1_800_000_000_000 });
    const [officer] = parseBackup(file([{ ...timed(), source: { origin: 'officer', serviceDay: '2026-11-22', importedAt: 'x' } }])).lists;
    expect(officer!.source).toEqual({ origin: 'officer', serviceDay: '2026-11-22' });
    const [bad] = parseBackup(file([{ ...timed(), source: { origin: 'admin' } }])).lists;
    expect(bad!.source).toBeUndefined();
  });

  it('drops malformed paid-parking data instead of crashing the views', () => {
    const bad = { ...timed(), payment: { easyPark: 'x', payStay: [{ zone: 42 }, null, { zone: '00042', meter: 7 }] } };
    const [list] = parseBackup(file([bad])).lists;
    expect(list?.type === 'timed' && list.payment).toEqual({ easyPark: [], payStay: [{ zone: '00042' }] });
  });

  it('keeps sub-segment bounds, road segment ID and bays, and drops malformed ones', () => {
    const seg = { street: 'Little Bourke Street', fromStreet: 'Swanston Street', toStreet: 'Elizabeth Street', side: 'south', suburb: '', subFrom: 'Bay 58', subTo: 'Bay 72' };
    const [ok] = parseBackup(file([{ ...timed(), segment: seg, roadSegmentId: '20055', bays: [58, 59] }])).lists;
    expect(ok?.type === 'timed' && [ok.segment.subFrom, ok.segment.subTo, ok.roadSegmentId, ok.bays]).toEqual(['Bay 58', 'Bay 72', '20055', [58, 59]]);
    const [bad] = parseBackup(file([{ ...timed(), segment: { ...seg, subFrom: 5, subTo: null }, roadSegmentId: 20055, bays: ['x', 3] }])).lists;
    expect(bad?.type === 'timed' && [bad.segment.subFrom, bad.segment.subTo, bad.roadSegmentId, bad.bays]).toEqual([undefined, undefined, undefined, [3]]);
  });

  it('keeps a parking area number and drops a malformed one', () => {
    const [ok] = parseBackup(file([{ ...timed(), payment: { parkingArea: '637', easyPark: [], payStay: [] } }])).lists;
    expect(ok?.type === 'timed' && ok.payment?.parkingArea).toBe('637');
    const [bad] = parseBackup(file([{ ...timed(), payment: { parkingArea: 637, easyPark: [], payStay: [] } }])).lists;
    expect(bad?.type === 'timed' && bad.payment).toEqual({ easyPark: [], payStay: [] });
  });

  it('keeps valid paid-parking data, moving a meter stored with its zone (older backups) into meters', () => {
    const payment = { easyPark: ['010'], payStay: [{ zone: '020', meter: '03' }, { zone: '020', meter: '04' }] };
    const [list] = parseBackup(file([{ ...timed(), payment }])).lists;
    expect(list?.type === 'timed' && list.payment).toEqual({
      easyPark: ['010'],
      payStay: [{ zone: '020' }],
      meters: [{ id: '03', easyPark: [], payStay: ['020'] }, { id: '04', easyPark: [], payStay: ['020'] }],
    });
  });

  it('keeps meters and restriction payment links, dropping links to numbers the list does not have', () => {
    const payment = { easyPark: [], payStay: [{ zone: '33883296' }, { zone: '33883294' }], meters: [{ id: 'GLP1', easyPark: [], payStay: ['33883296'] }, { id: 'SEG', easyPark: 5, payStay: null }, { id: 3 }] };
    const restrictions = [
      { ...timed().restrictions[0]!, id: 'a', paidBy: { easyPark: ['999'], payStay: ['33883296', 7] } },
      { ...timed().restrictions[0]!, id: 'b', paidBy: { easyPark: ['999'], payStay: [] } },
    ];
    const [list] = parseBackup(file([{ ...timed(), payment, restrictions }])).lists;
    if (list?.type !== 'timed') throw new Error('timed list expected');
    expect(list.payment?.meters).toEqual([{ id: 'GLP1', easyPark: [], payStay: ['33883296'] }, { id: 'SEG', easyPark: [], payStay: [] }]);
    expect(list.restrictions.map((r) => r.paidBy)).toEqual([{ easyPark: [], payStay: ['33883296'] }, undefined]);
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

describe('vehicle details from older backups', () => {
  it('moves a hot-list model into notes and a permit free-text vehicle into make', () => {
    const hotList = { id: 'h', type: 'hot', name: 'H', notes: '', createdAt: 0, updatedAt: 0, entries: [{ id: 'x', plate: 'ABC123', risks: [], riskLevel: 'high', make: 'Toyota', model: 'Hilux', bodyType: 'Ute', colour: 'White', notes: 'Seen', addedAt: 0 }] };
    const allowList = { id: 'a', type: 'allow', name: 'A', notes: '', createdAt: 0, updatedAt: 0, entries: [{ id: 'y', plate: 'RES1', vehicle: 'White Corolla' }] };
    const [h, a] = parseBackup(file([hotList, allowList])).lists as unknown as [{ entries: Record<string, unknown>[] }, { entries: Record<string, unknown>[] }];
    expect(h.entries[0]).toMatchObject({ registrationType: '', make: 'Toyota', notes: 'Seen · Model: Hilux' });
    expect(h.entries[0]).not.toHaveProperty('model');
    expect(a.entries[0]).toMatchObject({ make: 'White Corolla' });
    expect(a.entries[0]).not.toHaveProperty('vehicle');
  });
});

describe('plate tags in backups', () => {
  it('restores well-formed tags and drops malformed ones', () => {
    const raw = JSON.parse(file([]));
    raw.flags = [
      { key: 'x', plate: 'abc 123', kind: 'disability', createdAt: 5, sourceScanId: 's1', confirmedDay: '2026-11-16' },
      { plate: 'BAD1', kind: 'vip' },
      { plate: 'EMR1', kind: 'emergency', confirmedDay: 'yesterday' },
    ];
    const { flags } = parseBackup(JSON.stringify(raw));
    expect(flags).toEqual([
      { key: 'ABC123', plate: 'abc 123', kind: 'disability', createdAt: 5, sourceScanId: 's1', confirmedDay: '2026-11-16' },
      { key: 'EMR1', plate: 'EMR1', kind: 'emergency', createdAt: 0, sourceScanId: '', confirmedDay: '' },
    ]);
  });

  it('leaves tags alone when the backup has none', () => {
    expect(parseBackup(file([])).flags).toBeUndefined();
  });

  it('keeps permit vehicle details, area and streets on allow entries and drops malformed ones', () => {
    const entries = [
      { id: 'e1', plate: 'RES1', registrationType: 'private', registrationState: 'NSW', make: 'Toyota', bodyType: 'sedan', colour: 'White', rpa: '7', streets: ['Smith St', 3, ''], permitTypes: ['RSP', 'XX'], council: { code: 'copp' }, address: { streetNumber: '12', street: 'Smith Street' } },
      { id: 'e2', plate: 'RES2', make: 9, rpa: '', streets: 'Smith St' },
    ];
    const [l] = parseBackup(file([{ id: 'a', type: 'allow', name: 'P', notes: '', createdAt: 0, updatedAt: 0, entries }])).lists;
    const [a, b] = (l as unknown as { entries: Record<string, unknown>[] }).entries;
    expect(a).toMatchObject({ registrationType: 'private', registrationState: 'NSW', make: 'Toyota', bodyType: 'sedan', colour: 'White', rpa: '7', streets: ['Smith St'], permitTypes: ['RSP'], council: { code: 'copp' }, address: { streetNumber: '12', street: 'Smith Street' } });
    expect(b).not.toHaveProperty('make');
    expect(b).not.toHaveProperty('rpa');
    expect(b).not.toHaveProperty('streets');
  });
});
