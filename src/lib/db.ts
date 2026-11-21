import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  DEFAULT_SETTINGS,
  type AllowList,
  type DismissedCapture,
  type HotList,
  type Observation,
  type PlateList,
  type ScanRecord,
  type Settings,
  type TimedList,
} from './types';

const DB_NAME = 'platewatch';
const DB_VERSION = 2;

interface PlateWatchDB extends DBSchema {
  lists: { key: string; value: PlateList; indexes: { 'by-type': string } };
  scans: {
    key: string;
    value: ScanRecord;
    indexes: { 'by-list': string; 'by-observation': string; 'by-created': number };
  };
  observations: {
    key: string;
    value: Observation;
    indexes: { 'by-list': string; 'by-list-status': [string, string] };
  };
  kv: { key: string; value: unknown };
  /** Version 2: patrol captures dismissed at review (one global list). */
  dismissed: { key: string; value: DismissedCapture; indexes: { 'by-created': number } };
}

let dbPromise: Promise<IDBPDatabase<PlateWatchDB>> | null = null;

export function db(): Promise<IDBPDatabase<PlateWatchDB>> {
  dbPromise ??= openDB<PlateWatchDB>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const lists = database.createObjectStore('lists', { keyPath: 'id' });
        lists.createIndex('by-type', 'type');
        const scans = database.createObjectStore('scans', { keyPath: 'id' });
        scans.createIndex('by-list', 'listId');
        scans.createIndex('by-observation', 'observationId');
        scans.createIndex('by-created', 'createdAt');
        const obs = database.createObjectStore('observations', { keyPath: 'id' });
        obs.createIndex('by-list', 'listId');
        obs.createIndex('by-list-status', ['listId', 'status']);
        database.createObjectStore('kv');
      }
      if (oldVersion < 2) {
        database.createObjectStore('dismissed', { keyPath: 'id' }).createIndex('by-created', 'createdAt');
      }
    },
    blocked() {
      console.warn('[db] upgrade blocked by another open tab');
    },
  });
  return dbPromise;
}

/** Test hook: drop the cached connection. */
export async function closeDb(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}

export function uid(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ───────────────────────────── Lists ───────────────────────────── */

export async function getLists(): Promise<PlateList[]> {
  const all = await (await db()).getAll('lists');
  return all.sort((a, b) => a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' }));
}

export async function getList(id: string): Promise<PlateList | undefined> {
  return (await db()).get('lists', id);
}

export async function getListsByType<T extends PlateList['type']>(
  type: T,
): Promise<Extract<PlateList, { type: T }>[]> {
  const rows = await (await db()).getAllFromIndex('lists', 'by-type', type);
  return rows as Extract<PlateList, { type: T }>[];
}

export const getHotLists = () => getListsByType('hot') as Promise<HotList[]>;
export const getAllowLists = () => getListsByType('allow') as Promise<AllowList[]>;
export const getTimedLists = () => getListsByType('timed') as Promise<TimedList[]>;

export async function putList(list: PlateList): Promise<void> {
  await (await db()).put('lists', { ...list, updatedAt: Date.now() });
}

/** Delete a list and everything recorded against it; unlink deleted allow lists. */
export async function deleteList(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['lists', 'scans', 'observations'], 'readwrite');
  const lists = tx.objectStore('lists');
  const target = await lists.get(id);
  if (target?.type === 'allow') {
    for (const l of await lists.getAll()) {
      if (l.type === 'timed' && l.allowListIds.includes(id)) {
        await lists.put({ ...l, allowListIds: l.allowListIds.filter((x) => x !== id), updatedAt: Date.now() });
      }
    }
  }
  for (const key of await tx.objectStore('scans').index('by-list').getAllKeys(id)) {
    await tx.objectStore('scans').delete(key);
  }
  for (const key of await tx.objectStore('observations').index('by-list').getAllKeys(id)) {
    await tx.objectStore('observations').delete(key);
  }
  await lists.delete(id);
  await tx.done;
}

/* ─────────────────────────── Observations ─────────────────────────── */

export async function getObservations(listId: string): Promise<Observation[]> {
  return (await db()).getAllFromIndex('observations', 'by-list', listId);
}

export async function getActiveObservations(listId: string): Promise<Observation[]> {
  return (await db()).getAllFromIndex('observations', 'by-list-status', [listId, 'active']);
}

export async function getObservation(id: string): Promise<Observation | undefined> {
  return (await db()).get('observations', id);
}

export async function putObservation(o: Observation): Promise<void> {
  await (await db()).put('observations', o);
}

export async function expireObservations(ids: readonly string[], at: number): Promise<void> {
  if (!ids.length) return;
  const d = await db();
  const tx = d.transaction('observations', 'readwrite');
  for (const id of ids) {
    const o = await tx.store.get(id);
    if (o && o.status === 'active') await tx.store.put({ ...o, status: 'expired', closedAt: at });
  }
  await tx.done;
}

/* ────────────────────────────── Scans ────────────────────────────── */

/** Atomically persist a scan and (optionally) the observation it creates/updates. */
export async function saveScan(scan: ScanRecord, observation?: Observation): Promise<void> {
  const d = await db();
  const tx = d.transaction(['scans', 'observations'], 'readwrite');
  await tx.objectStore('scans').put(scan);
  if (observation) await tx.objectStore('observations').put(observation);
  await tx.done;
}

export async function getScan(id: string): Promise<ScanRecord | undefined> {
  return (await db()).get('scans', id);
}

export async function getScansForList(listId: string, limit = 100): Promise<ScanRecord[]> {
  const rows = await (await db()).getAllFromIndex('scans', 'by-list', listId);
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function getScansForObservation(observationId: string): Promise<ScanRecord[]> {
  const rows = await (await db()).getAllFromIndex('scans', 'by-observation', observationId);
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getAllScans(): Promise<ScanRecord[]> {
  return (await db()).getAll('scans');
}

export async function getAllObservations(): Promise<Observation[]> {
  return (await db()).getAll('observations');
}

export async function deleteScan(id: string): Promise<void> {
  await (await db()).delete('scans', id);
}

/**
 * Delete scans (and their closed observations) and dismissed captures created before
 * now − days. Returns the number of scans and dismissed captures deleted.
 */
export async function purgeScansOlderThan(days: number, now = Date.now()): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = now - days * 86_400_000;
  const d = await db();
  const tx = d.transaction(['scans', 'observations', 'dismissed'], 'readwrite');
  let n = 0;
  for (const store of ['scans', 'dismissed'] as const) {
    let cursor = await tx.objectStore(store).index('by-created').openCursor(IDBKeyRange.upperBound(cutoff, true));
    while (cursor) {
      await cursor.delete();
      n++;
      cursor = await cursor.continue();
    }
  }
  const obsStore = tx.objectStore('observations');
  for (const o of await obsStore.getAll()) {
    if (o.status !== 'active' && (o.closedAt ?? o.startedAt) < cutoff) await obsStore.delete(o.id);
  }
  await tx.done;
  return n;
}

/* ─────────────────────── Dismissed captures ─────────────────────── */

export async function saveDismissed(d: DismissedCapture): Promise<void> {
  await (await db()).put('dismissed', d);
}

/** Newest first. */
export async function getDismissed(): Promise<DismissedCapture[]> {
  return (await (await db()).getAll('dismissed')).sort((a, b) => b.createdAt - a.createdAt);
}

export async function countDismissed(): Promise<number> {
  return (await db()).count('dismissed');
}

export async function deleteDismissed(id: string): Promise<void> {
  await (await db()).delete('dismissed', id);
}

export async function clearDismissed(): Promise<void> {
  await (await db()).clear('dismissed');
}

/* ──────────────────────────── Settings ──────────────────────────── */

export async function getSettings(): Promise<Settings> {
  const stored = (await (await db()).get('kv', 'settings')) as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await (await db()).put('kv', s, 'settings');
}

/* ───────────────────────────── Backup ───────────────────────────── */

export async function replaceAll(data: {
  lists: PlateList[];
  observations: Observation[];
  scans: ScanRecord[];
  merge: boolean;
}): Promise<void> {
  const d = await db();
  const tx = d.transaction(['lists', 'scans', 'observations'], 'readwrite');
  if (!data.merge) {
    await tx.objectStore('lists').clear();
    await tx.objectStore('scans').clear();
    await tx.objectStore('observations').clear();
  }
  for (const l of data.lists) await tx.objectStore('lists').put(l);
  for (const o of data.observations) await tx.objectStore('observations').put(o);
  for (const s of data.scans) await tx.objectStore('scans').put(s);
  await tx.done;
}
