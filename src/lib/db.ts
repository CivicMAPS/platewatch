import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { registrationTypeCode, vehicleTypeCode } from './vehicle';
import {
  DEFAULT_SETTINGS,
  type AllowList,
  type DismissedCapture,
  type HotList,
  type HotListEvent,
  type Observation,
  type PlateFlag,
  type PlateList,
  type ScanRecord,
  type Settings,
  type TimedList,
} from './types';

const DB_NAME = 'platewatch';
const DB_VERSION = 7;

/** What the backend sync sends (DB v7). The payload is read at send time, so one row per record. */
export type OutboxKind = 'scan' | 'observation' | 'hotEvent' | 'infringement' | 'voidRequest' | 'evidence';
export interface OutboxItem {
  /** `${kind}:${id}` — a newer change to the same record replaces the row. */
  key: string;
  kind: OutboxKind;
  id: string;
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

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
  /** Version 3: plate record tags (known disability / emergency vehicles), keyed by plate key. */
  flags: { key: string; value: PlateFlag };
  /** Version 4: hot-list entry log events (acknowledgements, look-alike decisions), WF-S29. */
  hotEvents: { key: string; value: HotListEvent; indexes: { 'by-entry': string; 'by-at': number } };
  /** Version 7: records waiting for the PlateWatch backend (docs/BACKEND.md). */
  outbox: { key: string; value: OutboxItem; indexes: { 'by-queued': number } };
}

/** Vehicle details in the infringement structure (DB v5, backups): no model, no free-text vehicle. */
export function migrateVehicleDetails(l: PlateList): PlateList {
  /** Registration type / type as codes where the value is on the list (kept as entered otherwise). */
  const codes = <T extends { registrationType?: string; bodyType?: string }>(e: T): T => {
    const rt = e.registrationType ? registrationTypeCode(e.registrationType) : e.registrationType;
    const bt = e.bodyType ? vehicleTypeCode(e.bodyType) : e.bodyType;
    return { ...e, ...(rt ? { registrationType: rt } : {}), ...(bt ? { bodyType: bt } : {}) };
  };
  if (l.type === 'hot') {
    return {
      ...l,
      entries: l.entries.map((e) => {
        const { model, ...rest } = e;
        const notes = model?.trim() && !rest.notes.includes(`Model: ${model.trim()}`) ? [rest.notes, `Model: ${model.trim()}`].filter(Boolean).join(' · ') : rest.notes;
        return codes({ ...rest, registrationType: rest.registrationType ?? '', notes });
      }),
    };
  }
  if (l.type === 'allow') {
    return {
      ...l,
      entries: l.entries.map((e) => {
        const { vehicle, ...rest } = e as typeof e & { vehicle?: unknown };
        return codes(typeof vehicle === 'string' && vehicle.trim() && !rest.make ? { ...rest, make: vehicle.trim() } : rest);
      }),
    };
  }
  return l;
}

let dbPromise: Promise<IDBPDatabase<PlateWatchDB>> | null = null;

export function db(): Promise<IDBPDatabase<PlateWatchDB>> {
  dbPromise ??= openDB<PlateWatchDB>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion, _newVersion, tx) {
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
      if (oldVersion < 3) {
        database.createObjectStore('flags', { keyPath: 'key' });
      }
      if (oldVersion < 4) {
        const ev = database.createObjectStore('hotEvents', { keyPath: 'id' });
        ev.createIndex('by-entry', 'hotListEntryId');
        ev.createIndex('by-at', 'at');
      }
      if (oldVersion < 7) {
        database.createObjectStore('outbox', { keyPath: 'key' }).createIndex('by-queued', 'queuedAt');
      }
      if (oldVersion >= 1 && oldVersion < 6) {
        // Versions 5–6: vehicle details in the infringement structure (registration type, make,
        // type, colour). Hot-list model → notes; a permit's free-text vehicle → make; registration
        // type and type values → the fixed lists' codes.
        void tx.objectStore('lists').getAll().then(async (lists) => {
          for (const l of lists) {
            if (l.type !== 'timed') await tx.objectStore('lists').put(migrateVehicleDetails(l));
          }
        });
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

/** Save many lists in one transaction (bulk import); keeps each list's own updatedAt. */
export async function putLists(lists: readonly PlateList[]): Promise<void> {
  const tx = (await db()).transaction('lists', 'readwrite');
  for (const l of lists) await tx.store.put(l);
  await tx.done;
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
  const tx = (await db()).transaction(['observations', 'outbox'], 'readwrite');
  await tx.objectStore('observations').put(o);
  await queue(tx.objectStore('outbox'), 'observation', o.id);
  await tx.done;
  queued();
}

export async function expireObservations(ids: readonly string[], at: number): Promise<void> {
  if (!ids.length) return;
  const d = await db();
  const tx = d.transaction(['observations', 'outbox'], 'readwrite');
  for (const id of ids) {
    const o = await tx.objectStore('observations').get(id);
    if (o && o.status === 'active') {
      await tx.objectStore('observations').put({ ...o, status: 'expired', closedAt: at });
      await queue(tx.objectStore('outbox'), 'observation', id);
    }
  }
  await tx.done;
  queued();
}

/* ────────────────────────────── Scans ────────────────────────────── */

/** Atomically persist a scan and (optionally) the observation it creates/updates. */
export async function saveScan(scan: ScanRecord, observation?: Observation): Promise<void> {
  const d = await db();
  const tx = d.transaction(['scans', 'observations', 'outbox'], 'readwrite');
  await tx.objectStore('scans').put(scan);
  await queue(tx.objectStore('outbox'), 'scan', scan.id);
  if (observation) {
    await tx.objectStore('observations').put(observation);
    await queue(tx.objectStore('outbox'), 'observation', observation.id);
  }
  await tx.done;
  queued();
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
      // An infringement's evidence is kept until the PIN's own retention allows (WF-S31 IR-23).
      const v = cursor.value as ScanRecord | DismissedCapture;
      if (!('infringement' in v && v.infringement && v.infringement.status !== 'cancelled')) {
        await cursor.delete();
        n++;
      }
      cursor = await cursor.continue();
    }
  }
  const obsStore = tx.objectStore('observations');
  for (const o of await obsStore.getAll()) {
    if (o.status !== 'active' && o.status !== 'issued' && (o.closedAt ?? o.startedAt) < cutoff) await obsStore.delete(o.id);
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

/* ───────────────────────────── Plate flags ───────────────────────────── */

export async function getFlags(): Promise<PlateFlag[]> {
  return (await db()).getAll('flags');
}

export async function getFlag(key: string): Promise<PlateFlag | undefined> {
  return (await db()).get('flags', key);
}

export async function putFlag(f: PlateFlag): Promise<void> {
  await (await db()).put('flags', f);
}

export async function deleteFlag(key: string): Promise<void> {
  await (await db()).delete('flags', key);
}

/**
 * Overstay alert dismissed after a vehicle check: the scan keeps the reason, the timing closes as
 * dismissed, and a disability / emergency dismissal tags the plate — all in one transaction.
 */
export async function dismissOverstay(args: { scan: ScanRecord; observation: Observation; flag?: PlateFlag }): Promise<void> {
  const tx = (await db()).transaction(['scans', 'observations', 'flags', 'outbox'], 'readwrite');
  await tx.objectStore('scans').put(args.scan);
  await tx.objectStore('observations').put(args.observation);
  await queue(tx.objectStore('outbox'), 'scan', args.scan.id);
  await queue(tx.objectStore('outbox'), 'observation', args.observation.id);
  if (args.flag) await tx.objectStore('flags').put(args.flag);
  await tx.done;
  queued();
}

/* ───────────────────────────── Hot-list entry log ───────────────────────────── */

export async function putHotEvent(e: HotListEvent): Promise<void> {
  const tx = (await db()).transaction(['hotEvents', 'outbox'], 'readwrite');
  await tx.objectStore('hotEvents').put(e);
  await queue(tx.objectStore('outbox'), 'hotEvent', e.id);
  await tx.done;
  queued();
}

export async function getHotEvent(id: string): Promise<HotListEvent | undefined> {
  return (await db()).get('hotEvents', id);
}

/* ───────────────────────────── Backend outbox (v7) ───────────────────────────── */

let outboxHook: (() => void) | null = null;
/** Called after a change is queued (the backend client requests a sync). */
export function setOutboxHook(fn: (() => void) | null): void {
  outboxHook = fn;
}
const queued = () => outboxHook?.();

type OutboxStore = { put(value: OutboxItem): Promise<unknown>; get(key: string): Promise<OutboxItem | undefined> };

async function queue(store: OutboxStore, kind: OutboxKind, id: string, now = Date.now()): Promise<void> {
  const key = `${kind}:${id}`;
  const prev = await store.get(key);
  // Strictly increasing, so a change made while a send is in flight is never dropped by removeOutbox.
  await store.put({ key, kind, id, queuedAt: Math.max(now, (prev?.queuedAt ?? 0) + 1), attempts: 0 });
}

export async function enqueue(kind: OutboxKind, id: string): Promise<void> {
  const tx = (await db()).transaction('outbox', 'readwrite');
  await queue(tx.store, kind, id);
  await tx.done;
  queued();
}

export async function getOutbox(): Promise<OutboxItem[]> {
  return (await db()).getAllFromIndex('outbox', 'by-queued');
}

export async function countOutbox(): Promise<number> {
  return (await db()).count('outbox');
}

/** Remove a sent row, unless the record changed again after `queuedAt` was read. */
export async function removeOutbox(key: string, queuedAt: number): Promise<void> {
  const tx = (await db()).transaction('outbox', 'readwrite');
  const cur = await tx.store.get(key);
  if (cur && cur.queuedAt === queuedAt) await tx.store.delete(key);
  await tx.done;
}

export async function markOutboxFailed(key: string, queuedAt: number, error: string): Promise<void> {
  const tx = (await db()).transaction('outbox', 'readwrite');
  const cur = await tx.store.get(key);
  if (cur && cur.queuedAt === queuedAt) await tx.store.put({ ...cur, attempts: cur.attempts + 1, lastError: error });
  await tx.done;
}

/** Queue every scan, timing and hot-list event on the device (Settings → Send everything). */
export async function enqueueAll(): Promise<number> {
  const d = await db();
  const [scans, obs, events] = await Promise.all([d.getAllKeys('scans'), d.getAllKeys('observations'), d.getAllKeys('hotEvents')]);
  const tx = d.transaction('outbox', 'readwrite');
  for (const id of scans) await queue(tx.store, 'scan', id);
  for (const id of obs) await queue(tx.store, 'observation', id);
  for (const id of events) await queue(tx.store, 'hotEvent', id);
  await tx.done;
  return scans.length + obs.length + events.length;
}

/**
 * Several kv entries and one outbox row in a single transaction: all or nothing. The I-N signer
 * uses it so the chain head never advances past a statement that is not saved and queued.
 */
export async function putKvsAndQueue(entries: readonly [string, unknown][], queueItem?: { kind: OutboxKind; id: string }): Promise<void> {
  const tx = (await db()).transaction(['kv', 'outbox'], 'readwrite');
  for (const [key, value] of entries) await tx.objectStore('kv').put(value, key);
  if (queueItem) await queue(tx.objectStore('outbox'), queueItem.kind, queueItem.id);
  await tx.done;
  if (queueItem) queued();
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined;
}

/** Every kv value whose key starts with `prefix`. */
export async function getKvsByPrefix<T>(prefix: string): Promise<T[]> {
  return (await (await db()).getAll('kv', IDBKeyRange.bound(prefix, `${prefix}\uffff`))) as T[];
}

export async function putKv(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key);
}

export async function getHotEventsForEntry(entryId: string): Promise<HotListEvent[]> {
  return (await (await db()).getAllFromIndex('hotEvents', 'by-entry', entryId)).sort((a, b) => b.at - a.at);
}

export async function getAllHotEvents(): Promise<HotListEvent[]> {
  return (await db()).getAll('hotEvents');
}

/* ───────────────────────────── Backup ───────────────────────────── */

export async function replaceAll(data: {
  lists: PlateList[];
  observations: Observation[];
  scans: ScanRecord[];
  /** Only when the backup includes the Dismissed list; otherwise dismissed captures are untouched. */
  dismissed?: DismissedCapture[];
  /** Only when the backup includes plate tags; otherwise tags on the device are untouched. */
  flags?: PlateFlag[];
  /** Only when the backup includes hot-list events; otherwise the device's log is untouched. */
  hotEvents?: HotListEvent[];
  merge: boolean;
}): Promise<void> {
  const d = await db();
  const tx = d.transaction(['lists', 'scans', 'observations', 'dismissed', 'flags', 'hotEvents'], 'readwrite');
  if (data.hotEvents) {
    if (!data.merge) await tx.objectStore('hotEvents').clear();
    for (const e of data.hotEvents) await tx.objectStore('hotEvents').put(e);
  }
  if (data.flags) {
    if (!data.merge) await tx.objectStore('flags').clear();
    for (const f of data.flags) await tx.objectStore('flags').put(f);
  }
  if (!data.merge) {
    await tx.objectStore('lists').clear();
    await tx.objectStore('scans').clear();
    await tx.objectStore('observations').clear();
    if (data.dismissed) await tx.objectStore('dismissed').clear();
  }
  for (const x of data.dismissed ?? []) await tx.objectStore('dismissed').put(x);
  for (const l of data.lists) await tx.objectStore('lists').put(l);
  for (const o of data.observations) await tx.objectStore('observations').put(o);
  for (const s of data.scans) await tx.objectStore('scans').put(s);
  await tx.done;
}
