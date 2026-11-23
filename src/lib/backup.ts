/** JSON backup / restore. Images are embedded as base64 data URLs when included. */
import { getAllHotEvents, getAllObservations, getAllScans, getDismissed, getFlags, getLists, migrateVehicleDetails, replaceAll } from './db';
import { dataUrlToBlob } from './exif';
import { plateKey } from './plate';
import { normalisePayment, prunePaidBy } from './payment';
import type { DismissedCapture, HotListEvent, Observation, PaidBy, PaymentAreas, PlateFlag, PlateList, ScanRecord } from './types';

export const BACKUP_SCHEMA = 'platewatch.backup';
export const BACKUP_VERSION = 1;

type SerialScan = Omit<ScanRecord, 'image' | 'thumb'> & { image: string | null; thumb: string | null };
type SerialDismissed = Omit<DismissedCapture, 'image' | 'thumb'> & { image: string; thumb: string };

export interface BackupFile {
  schema: typeof BACKUP_SCHEMA;
  version: number;
  exportedAt: string;
  appVersion: string;
  includesScans: boolean;
  lists: PlateList[];
  observations: Observation[];
  scans: SerialScan[];
  /** Optional: patrol captures dismissed at review (absent in backups made before 21 Nov 2026). */
  includesDismissed?: boolean;
  dismissed?: SerialDismissed[];
  /** Plate record tags (known disability / emergency vehicles); exported with scan records. */
  flags?: PlateFlag[];
  /** Hot-list entry log events (acknowledgements, look-alike decisions); exported with scan records. */
  hotEvents?: HotListEvent[];
}

export interface BackupOptions {
  /** Add the global Dismissed list, with its evidence images. Off by default. */
  includeDismissed?: boolean;
}

async function blobToDataUrl(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${b.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

export async function createBackup(includeScans: boolean, appVersion: string, options: BackupOptions = {}): Promise<Blob> {
  const lists = await getLists();
  const observations = includeScans ? await getAllObservations() : [];
  const scans: SerialScan[] = [];
  if (includeScans) {
    for (const s of await getAllScans()) {
      scans.push({ ...s, image: await blobToDataUrl(s.image), thumb: await blobToDataUrl(s.thumb) });
    }
  }
  const dismissed: SerialDismissed[] = [];
  if (options.includeDismissed) {
    for (const d of await getDismissed()) {
      dismissed.push({ ...d, image: await blobToDataUrl(d.image), thumb: await blobToDataUrl(d.thumb) });
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
    includesDismissed: !!options.includeDismissed,
    dismissed,
    ...(includeScans ? { flags: await getFlags(), hotEvents: await getAllHotEvents() } : {}),
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
  const parkingArea = typeof v.parkingArea === 'string' && v.parkingArea.trim() ? v.parkingArea.trim() : undefined;
  const meters = (Array.isArray(v.meters) ? v.meters : [])
    .filter((m): m is Record<string, unknown> => isObj(m) && typeof m.id === 'string' && m.id.trim() !== '')
    .map((m) => ({ id: str(m.id), ...sanitisePaidBy(m) }));
  return normalisePayment({ ...(parkingArea ? { parkingArea } : {}), easyPark, payStay, ...(meters.length ? { meters } : {}) });
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/** EasyPark areas and PayStay zones a restriction or meter is tied to. */
export function sanitisePaidBy(v: unknown): PaidBy {
  return isObj(v) ? { easyPark: strings(v.easyPark), payStay: strings(v.payStay) } : { easyPark: [], payStay: [] };
}

/** Validate and sanitise lists from an untrusted file. Throws with a readable message. */
export function parseBackup(text: string): {
  lists: PlateList[];
  observations: Observation[];
  scans: ScanRecord[];
  /** Undefined when the backup does not include the Dismissed list. */
  dismissed?: DismissedCapture[];
  flags?: PlateFlag[];
  hotEvents?: HotListEvent[];
} {
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
        .map((e) => {
          const out: Record<string, unknown> = { ...e, key: plateKey(str(e.plate)) };
          // Permit details: strings only; streets a list of strings.
          for (const k of ['vehicle', 'rpa', 'registrationType', 'make', 'bodyType', 'colour', 'registrationState'] as const) if (typeof out[k] !== 'string' || !out[k]) delete out[k];
          // Permit details (schemas/civicmaps-parking-permit.v1.schema.json).
          if (Array.isArray(out.permitTypes)) out.permitTypes = (out.permitTypes as unknown[]).filter((t) => t === 'RPA' || t === 'RSP' || t === 'RP' || t === 'FS');
          if (!Array.isArray(out.permitTypes) || !(out.permitTypes as unknown[]).length) delete out.permitTypes;
          const c = out.council as Record<string, unknown> | undefined;
          if (isObj(c) && typeof c.code === 'string' && c.code) out.council = { code: c.code, ...(typeof c.linkingId === 'string' && c.linkingId ? { linkingId: c.linkingId } : {}) };
          else delete out.council;
          const ad = out.address as Record<string, unknown> | undefined;
          if (isObj(ad) && typeof ad.street === 'string' && ad.street) out.address = { streetNumber: typeof ad.streetNumber === 'string' ? ad.streetNumber : '', street: ad.street };
          else delete out.address;
          if (Array.isArray(out.streets)) out.streets = (out.streets as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim());
          if (!Array.isArray(out.streets) || !(out.streets as string[]).length) delete out.streets;
          return out;
        });
    }
    if (l.type === 'timed' && (!isObj(l.segment) || !Array.isArray(l.restrictions))) continue;
    if (l.type === 'timed') {
      if (!Array.isArray(l.allowListIds)) l.allowListIds = [];
      l.allowListIds = (l.allowListIds as unknown[]).filter((x): x is string => typeof x === 'string');
      l.payment = sanitisePayment(l.payment);
      // A restriction may only be tied to payment numbers the list has.
      for (const r of l.restrictions as Record<string, unknown>[]) {
        if (!isObj(r)) continue;
        const paidBy = 'paidBy' in r ? prunePaidBy(sanitisePaidBy(r.paidBy), l.payment as PaymentAreas | undefined) : undefined;
        if (paidBy) r.paidBy = paidBy;
        else delete r.paidBy;
      }
      for (const k of ['patrolZone', 'patrolZoneName', 'rpa', 'roadSegmentId', 'displayId'] as const) if (typeof l[k] !== 'string') delete l[k];
      const seg = l.segment as Record<string, unknown>;
      for (const k of ['subFrom', 'subTo'] as const) if (typeof seg[k] !== 'string') delete seg[k];
      if (Array.isArray(l.bays)) l.bays = (l.bays as unknown[]).filter((b): b is number => typeof b === 'number' && Number.isInteger(b) && b >= 0);
      else delete l.bays;
      if (typeof l.externalId !== 'string') delete l.externalId;
      if (Array.isArray(l.bayPoints))
        l.bayPoints = (l.bayPoints as unknown[]).filter(
          (p) => isObj(p) && Number.isInteger(p.bay) && typeof p.lat === 'number' && typeof p.lng === 'number' && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180,
        );
      else delete l.bayPoints;
      if (Array.isArray(l.untimedControls))
        l.untimedControls = (l.untimedControls as unknown[]).filter(
          (u) => isObj(u) && typeof u.control === 'string' && typeof u.label === 'string' && Array.isArray(u.days) && typeof u.allDay === 'boolean',
        );
      else delete l.untimedControls;
    }
    // Provenance (OQ26-5): keep only a well-formed source; anything else counts as an officer list.
    if (isObj(l.source) && (l.source.origin === 'system' || l.source.origin === 'officer')) {
      const src = l.source;
      l.source = {
        origin: src.origin,
        ...(typeof src.importedFrom === 'string' ? { importedFrom: src.importedFrom } : {}),
        ...(typeof src.importedAt === 'number' && Number.isFinite(src.importedAt) ? { importedAt: src.importedAt } : {}),
        ...(typeof src.serviceDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(src.serviceDay) ? { serviceDay: src.serviceDay } : {}),
      };
    } else delete l.source;
    lists.push(migrateVehicleDetails(l as unknown as PlateList));
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
  let dismissed: DismissedCapture[] | undefined;
  if (raw.includesDismissed === true) {
    dismissed = [];
    for (const d of Array.isArray(raw.dismissed) ? raw.dismissed : []) {
      if (!isObj(d) || typeof d.id !== 'string' || typeof d.image !== 'string' || typeof d.thumb !== 'string') continue;
      if (!d.image.startsWith('data:image/') || !d.thumb.startsWith('data:image/')) continue;
      if (!isObj(d.meta) || typeof d.meta.capturedAt !== 'number') continue;
      dismissed.push({
        ...(d as unknown as DismissedCapture),
        plate: str(d.plate),
        ocrText: str(d.ocrText),
        intendedListId: str(d.intendedListId),
        intendedListName: str(d.intendedListName),
        createdAt: typeof d.createdAt === 'number' ? d.createdAt : d.meta.capturedAt,
        image: dataUrlToBlob(d.image),
        thumb: dataUrlToBlob(d.thumb),
      });
    }
  }
  const flags = Array.isArray(raw.flags)
    ? (raw.flags as unknown[])
        .filter((f): f is Record<string, unknown> => isObj(f) && typeof f.plate === 'string' && (f.kind === 'disability' || f.kind === 'emergency'))
        .map((f): PlateFlag => ({
          key: plateKey(str(f.plate)),
          plate: str(f.plate),
          kind: f.kind as PlateFlag['kind'],
          createdAt: typeof f.createdAt === 'number' ? f.createdAt : 0,
          sourceScanId: str(f.sourceScanId),
          confirmedDay: typeof f.confirmedDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.confirmedDay) ? f.confirmedDay : '',
        }))
    : undefined;
  const hotEvents = Array.isArray(raw.hotEvents)
    ? (raw.hotEvents as unknown[]).filter(
        (e): e is HotListEvent =>
          isObj(e) && typeof e.id === 'string' && (e.kind === 'acknowledged' || e.kind === 'lookalike_not_matched') && typeof e.hotListEntryId === 'string' && typeof e.at === 'number',
      )
    : undefined;
  return { lists, observations, scans, dismissed, ...(flags ? { flags } : {}), ...(hotEvents ? { hotEvents } : {}) };
}

export async function restoreBackup(text: string, merge: boolean): Promise<{ lists: number; scans: number; dismissed: number }> {
  const data = parseBackup(text);
  await replaceAll({ ...data, merge });
  return { lists: data.lists.length, scans: data.scans.length, dismissed: data.dismissed?.length ?? 0 };
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
