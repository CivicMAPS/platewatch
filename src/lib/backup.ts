/** JSON backup / restore. Images are embedded as base64 data URLs when included. */
import { getAllObservations, getAllScans, getLists, replaceAll } from './db';
import { dataUrlToBlob } from './exif';
import { plateKey } from './plate';
import type { Observation, PaymentAreas, PlateList, ScanRecord } from './types';

export const BACKUP_SCHEMA = 'platewatch.backup';
export const BACKUP_VERSION = 1;

type SerialScan = Omit<ScanRecord, 'image' | 'thumb'> & { image: string | null; thumb: string | null };

export interface BackupFile {
  schema: typeof BACKUP_SCHEMA;
  version: number;
  exportedAt: string;
  appVersion: string;
  includesScans: boolean;
  lists: PlateList[];
  observations: Observation[];
  scans: SerialScan[];
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

export async function createBackup(includeScans: boolean, appVersion: string): Promise<Blob> {
  const lists = await getLists();
  const observations = includeScans ? await getAllObservations() : [];
  const scans: SerialScan[] = [];
  if (includeScans) {
    for (const s of await getAllScans()) {
      scans.push({ ...s, image: await blobToDataUrl(s.image), thumb: await blobToDataUrl(s.thumb) });
    }
  }
  const file: BackupFile = {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion,
    includesScans: includeScans,
    lists,
    observations,
    scans,
  };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/** Keep only well-formed paid-parking entries; anything else would crash rendering. */
export function sanitisePayment(v: unknown): PaymentAreas | undefined {
  if (!isObj(v)) return undefined;
  const easyPark = (Array.isArray(v.easyPark) ? v.easyPark : []).filter(
    (a): a is string => typeof a === 'string' && a.trim() !== '',
  );
  const payStay = (Array.isArray(v.payStay) ? v.payStay : [])
    .filter((p): p is Record<string, unknown> => isObj(p) && typeof p.zone === 'string' && p.zone.trim() !== '')
    .map((p) => ({ zone: str(p.zone), meter: str(p.meter) }));
  return { easyPark, payStay };
}

/** Validate and sanitise lists from an untrusted file. Throws with a readable message. */
export function parseBackup(text: string): { lists: PlateList[]; observations: Observation[]; scans: ScanRecord[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  if (!isObj(raw) || raw.schema !== BACKUP_SCHEMA) throw new Error('Not a PlateWatch backup file.');
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION)
    throw new Error('Backup was created by a newer version of PlateWatch.');
  if (!Array.isArray(raw.lists)) throw new Error('Backup has no lists.');

  const lists: PlateList[] = [];
  for (const l of raw.lists) {
    if (!isObj(l) || typeof l.id !== 'string' || typeof l.name !== 'string') continue;
    if (l.type !== 'allow' && l.type !== 'timed' && l.type !== 'hot') continue;
    // Re-derive keys so tampered/old keys cannot cause false matches.
    if ((l.type === 'allow' || l.type === 'hot') && Array.isArray(l.entries)) {
      l.entries = (l.entries as Record<string, unknown>[])
        .filter((e) => isObj(e) && typeof e.plate === 'string')
        .map((e) => ({ ...e, key: plateKey(str(e.plate)) }));
    }
    if (l.type === 'timed' && (!isObj(l.segment) || !Array.isArray(l.restrictions))) continue;
    if (l.type === 'timed') {
      if (!Array.isArray(l.allowListIds)) l.allowListIds = [];
      l.allowListIds = (l.allowListIds as unknown[]).filter((x): x is string => typeof x === 'string');
      l.payment = sanitisePayment(l.payment);
    }
    lists.push(l as unknown as PlateList);
  }

  const observations = (Array.isArray(raw.observations) ? raw.observations : []).filter(
    (o): o is Observation => isObj(o) && typeof o.id === 'string' && typeof o.listId === 'string',
  );

  const scans: ScanRecord[] = [];
  for (const s of Array.isArray(raw.scans) ? raw.scans : []) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.image !== 'string' || typeof s.thumb !== 'string') continue;
    if (!s.image.startsWith('data:image/') || !s.thumb.startsWith('data:image/')) continue;
    if (!isObj(s.meta) || typeof s.meta.capturedAt !== 'number') continue;
    const meta = { ...s.meta, payment: sanitisePayment(s.meta.payment) };
    scans.push({ ...(s as unknown as ScanRecord), meta: meta as unknown as ScanRecord['meta'], image: dataUrlToBlob(s.image), thumb: dataUrlToBlob(s.thumb) });
  }
  return { lists, observations, scans };
}

export async function restoreBackup(text: string, merge: boolean): Promise<{ lists: number; scans: number }> {
  const data = parseBackup(text);
  await replaceAll({ ...data, merge });
  return { lists: data.lists.length, scans: data.scans.length };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
