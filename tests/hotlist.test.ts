import { afterEach, describe, expect, it } from 'vitest';
import { ackLocation, acknowledgementEvent, hotLogRows, trySendAlert } from '../src/lib/hotlist';
import type { GeoFix } from '../src/lib/types';
import { hot } from './fixtures';

const fix = (lat: number, ts: number, acc = 4): GeoFix => ({ latitude: lat, longitude: 144.96443, accuracy: acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null, timestamp: ts });
const list = hot(['ZAF402']);
const entry = list.entries[0]!;
const ev = (at: number) => acknowledgementEvent({ id: `e${at}`, list, entry, scanId: 's1', at, officerNumber: '4471', location: null, device: 'test' });

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe('hot-list acknowledge (WF-S29)', () => {
  it('uses a fix no older than 10 s, else the scan fix', () => {
    expect(ackLocation(fix(-37.81277, 1000), fix(-37.8, 0), 9000)).toEqual({ lat: -37.81277, lng: 144.96443, accuracyM: 4 });
    expect(ackLocation(fix(-37.81277, 1000), fix(-37.8, 0), 20_000)?.lat).toBe(-37.8);
    expect(ackLocation(null, null, 0)).toBeNull();
  });

  it('records time, officer number and a queued soft Code 1 to dispatch and the compliance coordinator', () => {
    const e = ev(1_800_000_000_000);
    expect(e).toMatchObject({ kind: 'acknowledged', plate: 'ZAF402', hotListEntryId: entry.id, scanId: 's1', officerNumber: '4471' });
    expect(e.atLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(e.notification).toEqual({ severity: 'soft_code1', recipients: ['dispatch', 'compliance_coordinator'], status: 'queued', attempts: 0 });
  });

  it('stays queued without an EnforcementMAPS host, counting the attempt', async () => {
    const e = await trySendAlert(ev(1), 5);
    expect(e.notification).toMatchObject({ status: 'queued', attempts: 1, lastAttemptAt: 5 });
  });

  it('is sent through the host when one is present, and retried after a failure', async () => {
    (globalThis as { window?: unknown }).window = { EnforcementMAPS: { sendHotListAlert: async () => ({ sentAt: 42 }) } };
    expect((await trySendAlert(ev(1), 5)).notification).toMatchObject({ status: 'sent', sentAt: 42, attempts: 1 });
    (globalThis as { window?: unknown }).window = { EnforcementMAPS: { sendHotListAlert: async () => { throw new Error('offline'); } } };
    expect((await trySendAlert(ev(1), 5)).notification).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('merges sightings and events into the entry log, newest first', () => {
    const sightings = [
      { id: 's1', key: 'ZAF402', outcome: 'hot_sighting', plate: 'ZAF402', meta: { capturedAt: 100 } },
      { id: 's2', key: '2AF402', outcome: 'hot_sighting', plate: '2AF402', meta: { capturedAt: 300 }, lookalikes: [{ candidateId: entry.id, choice: 'hot_confirmed' }] },
      { id: 's3', key: 'OTHER1', outcome: 'hot_sighting', plate: 'OTHER1', meta: { capturedAt: 400 } },
    ];
    const notMatched = { ...ev(250), id: 'n1', kind: 'lookalike_not_matched' as const, readAs: '2AF4O2', notification: undefined };
    const rows = hotLogRows(entry, sightings, [ev(200), notMatched]);
    expect(rows.map((r) => r.kind)).toEqual(['sighting', 'not_matched', 'acknowledged', 'sighting']);
    expect(rows.filter((r) => r.kind === 'sighting').map((r) => (r as { plate: string }).plate)).toEqual(['2AF402', 'ZAF402']);
  });
});
