import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  deleteList,
  getActiveObservations,
  getList,
  getScansForList,
  purgeScansOlderThan,
  putList,
  saveScan,
} from '../src/lib/db';
import { newObservation } from '../src/lib/engine';
import type { ScanRecord } from '../src/lib/types';
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
