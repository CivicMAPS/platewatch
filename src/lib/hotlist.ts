/**
 * Hot-list acknowledge (WF-S29). The officer must acknowledge a hot-list alert at the time.
 * Acknowledging captures the date, time, location and officer number, adds an entry to the plate's
 * hot-list entry log, and raises a soft Code 1 with dispatch and the compliance coordinator
 * (OQ29-2, OQ29-6). The acknowledgement is saved on the device first, so it never depends on the
 * network; the alert is queued and sent by the EnforcementMAPS host when one is present.
 */
import { host } from './host';
import { toLocalIso } from './time';
import type { GeoFix, HotEntry, HotList, HotListEvent } from './types';

export const SOFT_CODE1_RECIPIENTS = ['dispatch', 'compliance_coordinator'] as const;

/** A fresh fix (≤ 10 s old) if there is one, else the scan's own fix (29a.4). */
export function ackLocation(fresh: GeoFix | null, scanFix: GeoFix | null, now: number): HotListEvent['location'] {
  const f = fresh && now - fresh.timestamp <= 10_000 ? fresh : scanFix;
  return f ? { lat: f.latitude, lng: f.longitude, accuracyM: f.accuracy } : null;
}

export function acknowledgementEvent(args: {
  id: string;
  list: HotList;
  entry: HotEntry;
  scanId: string | null;
  at: number;
  officerNumber: string;
  location: HotListEvent['location'];
  device: string;
}): HotListEvent {
  return {
    id: args.id,
    kind: 'acknowledged',
    plate: args.entry.plate,
    key: args.entry.key,
    hotListId: args.list.id,
    hotListEntryId: args.entry.id,
    scanId: args.scanId,
    at: args.at,
    atLocal: toLocalIso(args.at),
    officerNumber: args.officerNumber,
    location: args.location,
    device: args.device,
    notification: { severity: 'soft_code1', recipients: [...SOFT_CODE1_RECIPIENTS], status: 'queued', attempts: 0 },
  };
}

/**
 * Try to send a queued soft Code 1. Without an EnforcementMAPS host (development build) it stays
 * queued; a failure counts the attempt and stays queued for a retry.
 */
export async function trySendAlert(e: HotListEvent, now = Date.now()): Promise<HotListEvent> {
  if (!e.notification || e.notification.status === 'sent') return e;
  const send = host()?.sendHotListAlert;
  const attempted = { ...e.notification, attempts: e.notification.attempts + 1, lastAttemptAt: now };
  if (!send) return { ...e, notification: attempted };
  try {
    const { sentAt } = await send(e);
    return { ...e, notification: { ...attempted, status: 'sent', sentAt } };
  } catch {
    return { ...e, notification: attempted };
  }
}

/** True when the device can send alerts to CommandMAPS (EnforcementMAPS build). */
export function canSendAlerts(): boolean {
  return !!host()?.sendHotListAlert;
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
      .filter((e) => e.hotListEntryId === entry.id)
      .map((e) => (e.kind === 'acknowledged' ? { kind: 'acknowledged' as const, at: e.at, event: e } : { kind: 'not_matched' as const, at: e.at, event: e })),
  ];
  return rows.sort((a, b) => b.at - a.at);
}
