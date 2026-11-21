import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDismissed,
  closeDb,
  deleteDismissed,
  deleteList,
  getDismissed,
  getActiveObservations,
  getList,
  getScansForList,
  purgeScansOlderThan,
  putList,
  putLists,
  getLists,
  saveDismissed,
  saveScan,
} from '../src/lib/db';
import { newObservation } from '../src/lib/engine';
import type { DismissedCapture, ScanRecord } from '../src/lib/types';
import { allow, at, r2P, timed } from './fixtures';

const scan = (id: string, listId: string, createdAt: number, observationId: string | null = null): ScanRecord => ({
  id,
  listId,
  observationId,
  plate: 'ABC123',
  key: 'ABC123',
  ocrText: 'ABC123',
  ocrConfidence: 90,
  corrected: false,
  outcome: 'recorded',
  meta: { capturedAt: createdAt, capturedAtLocal: '', timeZone: 'Australia/Melbourne', location: null, locationAgeMs: null, userAgent: 'test' },
  image: new Blob(['jpeg'], { type: 'image/jpeg' }),
  thumb: new Blob(['jpeg'], { type: 'image/jpeg' }),
  sha256: 'x',
  createdAt,
});

beforeEach(async () => {
  await closeDb();
  await new Promise<void>((res, rej) => {
    const req = indexedDB.deleteDatabase('platewatch');
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
});

describe('db', () => {
  it('persists a scan and its observation atomically', async () => {
    const list = timed();
    await putList(list);
    const t = at(2026, 11, 16, 9);
    const obs = newObservation({ id: 'o1', list, plate: 'ABC123', scanId: 's1', at: t, instance: { restriction: r2P(), start: t, end: t + 3600_000 } });
    await saveScan(scan('s1', list.id, t, 'o1'), obs);
    expect(await getActiveObservations(list.id)).toHaveLength(1);
    expect(await getScansForList(list.id)).toHaveLength(1);
  });

  it('deleting an allow list unlinks it from timed lists', async () => {
    await putList(allow(['RES001']));
    await putList(timed());
    await deleteList('allow-1');
    const t = await getList('timed-1');
    expect(t?.type === 'timed' && t.allowListIds).toEqual([]);
  });

  it('deleting a timed list cascades to scans and observations', async () => {
    const list = timed();
    await putList(list);
    const t = at(2026, 11, 16, 9);
    const obs = newObservation({ id: 'o1', list, plate: 'ABC123', scanId: 's1', at: t, instance: { restriction: r2P(), start: t, end: t + 3600_000 } });
    await saveScan(scan('s1', list.id, t, 'o1'), obs);
    await deleteList(list.id);
    expect(await getScansForList(list.id)).toHaveLength(0);
    expect(await getActiveObservations(list.id)).toHaveLength(0);
  });

  it('purges records older than the retention period', async () => {
    const now = at(2026, 11, 20, 12);
    await saveScan(scan('old', 'l', now - 40 * 86_400_000));
    await saveScan(scan('new', 'l', now - 1 * 86_400_000));
    expect(await purgeScansOlderThan(30, now)).toBe(1);
    expect((await getScansForList('l')).map((s) => s.id)).toEqual(['new']);
  });
});

it('rechecks a corrected first sighting and preserves capture time, original image and payment snapshot', async () => {
  const { correctRecord } = await import('../src/lib/corrections');
  const payment = {easyPark:['010'],payStay:[{zone:'020',meter:'03'}]};
  const list = timed({payment});
  await putList(list);
  const t = at(2026,11,16,10);
  const obs = newObservation({id:'o',list,plate:'ABC123',scanId:'s',at:t,instance:{restriction:r2P(),start:t,end:t+3600000}});
  const original = scan('s',list.id,t,'o');
  original.meta.payment = payment;
  await saveScan(original,obs);
  await putList({...list,payment:{easyPark:[],payStay:[]}});
  await putList(allow(['ABQ123']));
  await correctRecord('s','ABQ123','ABC123');
  const [edited] = await getScansForList(list.id);
  expect(edited).toMatchObject({plate:'ABQ123',sha256:original.sha256,meta:{payment,capturedAt:t},
    observationId:null,amendmentResult:'timed_exempt',revisions:[{plate:'ABC123'}]});
  expect(await getActiveObservations(list.id)).toHaveLength(0);
});

describe('dismissed patrol captures (global list)', () => {
  const dismissed = (id: string, createdAt: number, intendedListId = 'L1'): DismissedCapture => ({
    id,
    plate: 'CITYOFP',
    ocrText: 'CITYOFP',
    ocrEngine: 'patrol',
    intendedListId,
    intendedListName: 'york_784',
    meta: { capturedAt: createdAt, capturedAtLocal: '', timeZone: 'Australia/Melbourne', location: null, locationAgeMs: null, userAgent: 'test' },
    image: new Blob(['jpeg'], { type: 'image/jpeg' }),
    thumb: new Blob(['jpeg'], { type: 'image/jpeg' }),
    sha256: 'x',
    createdAt,
  });

  it('keeps dismissed captures out of the intended list and its timing', async () => {
    const list = timed();
    await putList(list);
    await saveDismissed(dismissed('d1', at(2026, 11, 20, 9), list.id));
    expect(await getScansForList(list.id)).toEqual([]);
    expect(await getActiveObservations(list.id)).toEqual([]);
    expect((await getDismissed()).map((d) => d.id)).toEqual(['d1']);
  });

  it('lists newest first, survives deleting the intended list, and deletes one or all', async () => {
    const list = timed();
    await putList(list);
    await saveDismissed(dismissed('old', at(2026, 11, 20, 9), list.id));
    await saveDismissed(dismissed('new', at(2026, 11, 20, 10), list.id));
    await deleteList(list.id);
    expect((await getDismissed()).map((d) => d.id)).toEqual(['new', 'old']);
    await deleteDismissed('new');
    expect((await getDismissed()).map((d) => d.id)).toEqual(['old']);
    await clearDismissed();
    expect(await getDismissed()).toEqual([]);
  });

  it('applies the retention period to dismissed captures too', async () => {
    const now = at(2026, 11, 30, 9);
    await saveDismissed(dismissed('stale', now - 10 * 86_400_000));
    await saveDismissed(dismissed('fresh', now - 86_400_000));
    expect(await purgeScansOlderThan(7, now)).toBe(1);
    expect((await getDismissed()).map((d) => d.id)).toEqual(['fresh']);
  });

  it('upgrades a version 1 database without losing lists or scans', async () => {
    const v1 = await openDB('platewatch', 1, {
      upgrade(d) {
        d.createObjectStore('lists', { keyPath: 'id' }).createIndex('by-type', 'type');
        const s = d.createObjectStore('scans', { keyPath: 'id' });
        s.createIndex('by-list', 'listId');
        s.createIndex('by-observation', 'observationId');
        s.createIndex('by-created', 'createdAt');
        const o = d.createObjectStore('observations', { keyPath: 'id' });
        o.createIndex('by-list', 'listId');
        o.createIndex('by-list-status', ['listId', 'status']);
        d.createObjectStore('kv');
      },
    });
    const list = timed();
    await v1.put('lists', list);
    await v1.put('scans', scan('s1', list.id, at(2026, 11, 20, 9)));
    v1.close();
    expect((await getList(list.id))?.id).toBe(list.id);
    expect((await getScansForList(list.id)).map((s) => s.id)).toEqual(['s1']);
    await saveDismissed(dismissed('d1', at(2026, 11, 20, 9)));
    expect(await getDismissed()).toHaveLength(1);
  });
});

describe('putLists (bulk import)', () => {
  it('saves many lists in one go', async () => {
    const many = Array.from({ length: 500 }, (_, i) => timed({ id: `t${i}`, name: `Segment ${i}` }));
    await putLists(many);
    expect(await getLists()).toHaveLength(500);
  });
});
