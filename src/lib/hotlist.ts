/**
 * Hot-list officer safety on the handset (owner direction 25/11/2026, superseding WF-S29's
 * acknowledge-then-notify flow).
 *
 * A hot-list match (scanned or typed plate) opens a pop-up that blocks every other action until
 * the officer answers it: CODE 1 (duress) or SAFE & CLEAR (safe, and has left the road segment
 * where the vehicle is). The hit — time, location, officer — and the answer with an optional note
 * are logged on the plate's history. If the officer has not answered by the deadline, the handset
 * raises a soft Code 1 (amber) with dispatch and the officer's team supervisor, who ask for a radio
 * response; with none, it becomes a Code 1 for the whole branch (the backend also raises the soft
 * Code 1 if the handset cannot).
 *
 * Pure helpers here; the state machine is `src/lib/safety.ts`.
 */
import { toLocalIso } from './time';
import { vehicleTypeLabel } from './vehicle';
import type { GeoFix, HotEntry, HotHitPayload, HotHitResponse, HotList, HotListEvent } from './types';

/** A fresh fix (≤ 10 s old) if there is one, else the scan's own fix (29a.4). */
export function ackLocation(fresh: GeoFix | null, scanFix: GeoFix | null, now: number): HotListEvent['location'] {
  const f = fresh && now - fresh.timestamp <= 10_000 ? fresh : scanFix;
  return f ? { lat: f.latitude, lng: f.longitude, accuracyM: f.accuracy } : null;
}

/** The label officers see for the safe answer (OWNER VALIDATION REQUIRED: name / acronym). */
export const SAFE_CLEAR_LABEL = 'SAFE & CLEAR';
export const SAFE_CLEAR_HELP = 'I am safe and have left the road segment where the vehicle is parked.';

export function hitPayload(args: {
  id: string;
  list: HotList;
  entry: HotEntry;
  scanId: string | null;
  at: number;
  ackSeconds: number;
  officerNumber: string;
  location: HotHitPayload['location'];
  where?: HotHitPayload['where'];
}): HotHitPayload {
  const e = args.entry;
  return {
    id: args.id,
    plate: e.plate,
    hotListEntryId: e.id,
    scanId: args.scanId,
    at: args.at,
    ackDeadline: args.at + args.ackSeconds * 1000,
    officerNumber: args.officerNumber,
    location: args.location,
    entry: { make: e.make, type: e.bodyType ? vehicleTypeLabel(e.bodyType) : '', colour: e.colour, riskLevel: e.riskLevel, risks: [...e.risks], ...(e.alertMessage ? { alertMessage: e.alertMessage } : {}), ...(e.ownerDescription ? { ownerDescription: e.ownerDescription } : {}) },
    ...(args.where ? { where: args.where } : {}),
  };
}

export function hitEvent(args: { id: string; list: HotList; entry: HotEntry; hit: HotHitPayload; device: string }): HotListEvent {
  const { hit } = args;
  return {
    id: args.id, kind: 'hit', plate: args.entry.plate, key: args.entry.key, hotListId: args.list.id, hotListEntryId: args.entry.id, scanId: hit.scanId,
    at: hit.at, atLocal: toLocalIso(hit.at), officerNumber: hit.officerNumber, location: hit.location, device: args.device, hitId: hit.id, hit,
  };
}

export function responseEvent(args: {
  id: string;
  hit: HotHitPayload;
  hotListId: string;
  key: string;
  response: HotHitResponse;
  note: string;
  at: number;
  officerNumber: string;
  location: HotListEvent['location'];
  device: string;
}): HotListEvent {
  return {
    id: args.id, kind: 'acknowledged', plate: args.hit.plate, key: args.key, hotListId: args.hotListId, hotListEntryId: args.hit.hotListEntryId, scanId: args.hit.scanId,
    at: args.at, atLocal: toLocalIso(args.at), officerNumber: args.officerNumber, location: args.location, device: args.device,
    hitId: args.hit.id, response: args.response, ...(args.note.trim() ? { note: args.note.trim().slice(0, 1000) } : {}), ...(args.at > args.hit.ackDeadline ? { late: true } : {}),
  };
}

/** One row of a hot-list entry log (29d), newest first. */
export type HotLogRow =
  | { kind: 'sighting'; at: number; scanId: string; plate: string }
  | { kind: 'acknowledged'; at: number; event: HotListEvent }
  | { kind: 'not_matched'; at: number; event: HotListEvent };

/**
 * The entry log: sightings (the `hot_sighting` scans of this plate on its hot list) and the
 * device's events for the entry (acknowledgements, look-alike "not the hot-list vehicle").
 */
export function hotLogRows(
  entry: Pick<HotEntry, 'id' | 'key'>,
  sightings: readonly { id: string; key: string; outcome: string; plate: string; meta: { capturedAt: number }; lookalikes?: { candidateId: string; choice: string }[] }[],
  events: readonly HotListEvent[],
): HotLogRow[] {
  const rows: HotLogRow[] = [
    ...sightings
      .filter((s) => s.outcome === 'hot_sighting' && (s.key === entry.key || s.lookalikes?.some((l) => l.candidateId === entry.id && l.choice === 'hot_confirmed')))
      .map((s) => ({ kind: 'sighting' as const, at: s.meta.capturedAt, scanId: s.id, plate: s.plate })),
    ...events
      .filter((e) => e.hotListEntryId === entry.id && e.kind !== 'hit')
      .map((e) => (e.kind === 'acknowledged' ? { kind: 'acknowledged' as const, at: e.at, event: e } : { kind: 'not_matched' as const, at: e.at, event: e })),
  ];
  return rows.sort((a, b) => b.at - a.at);
}
