import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getAllHotEvents, getKv } from '../src/lib/db';
import { ackLocation, hitPayload, hotLogRows, responseEvent } from '../src/lib/hotlist';
import { checkDeadline, openHotAlert, raiseCode1, resetSafety, respond, safetyState, setAckSeconds, startSafety } from '../src/lib/safety';
import type { GeoFix, HotEntry } from '../src/lib/types';
import { hot } from './fixtures';

const fix = (lat: number, ts: number, acc = 4): GeoFix => ({ latitude: lat, longitude: 144.96443, accuracy: acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null, timestamp: ts });
const list = hot(['ZAF402']);
const entry: HotEntry = { ...list.entries[0]!, make: 'Toyota', bodyType: 'sedan', colour: 'Silver', alertMessage: 'Do not approach — prior aggressive male driver interaction', ownerDescription: 'Male, 40s' };
const hit = (at: number) => hitPayload({ id: `h${at}`, list, entry, scanId: 's1', at, ackSeconds: 60, officerNumber: '4471', location: { lat: -37.81, lng: 144.96, accuracyM: 4 } });
const ack = (at: number) => responseEvent({ id: `e${at}`, hit: hit(at), hotListId: list.id, key: entry.key, response: 'safe_clear', note: '', at, officerNumber: '4471', location: null, device: 'test' });
const setWindow = (host?: unknown) => ((globalThis as { window?: unknown }).window = host ? { EnforcementMAPS: host } : {});

describe('hot-list officer safety: payloads and log (owner 25/11/2026)', () => {
  it('uses a fix no older than 10 s, else the scan fix', () => {
    expect(ackLocation(fix(-37.81277, 1000), fix(-37.8, 0), 9000)).toEqual({ lat: -37.81277, lng: 144.96443, accuracyM: 4 });
    expect(ackLocation(fix(-37.81277, 1000), fix(-37.8, 0), 20_000)?.lat).toBe(-37.8);
    expect(ackLocation(null, null, 0)).toBeNull();
  });

  it('the hit carries what the pop-up shows and the deadline for the soft Code 1', () => {
    expect(hit(1000)).toMatchObject({
      plate: 'ZAF402', hotListEntryId: entry.id, ackDeadline: 61_000, officerNumber: '4471',
      entry: { make: 'Toyota', type: 'Sedan', colour: 'Silver', alertMessage: 'Do not approach — prior aggressive male driver interaction', ownerDescription: 'Male, 40s' },
    });
  });

  it('an answer after the deadline is marked late; a blank note is not stored', () => {
    expect(ack(1000)).toMatchObject({ kind: 'acknowledged', response: 'safe_clear', hitId: 'h1000' });
    expect(ack(1000)).not.toHaveProperty('note');
    const late = responseEvent({ id: 'x', hit: hit(0), hotListId: list.id, key: entry.key, response: 'code1', note: ' Driver came at me ', at: 90_000, officerNumber: '4471', location: null, device: 't' });
    expect(late).toMatchObject({ late: true, note: 'Driver came at me', response: 'code1' });
  });

  it('merges sightings and events into the entry log, newest first (hit events are not rows)', () => {
    const sightings = [
      { id: 's1', key: 'ZAF402', outcome: 'hot_sighting', plate: 'ZAF402', meta: { capturedAt: 100 } },
      { id: 's2', key: '2AF402', outcome: 'hot_sighting', plate: '2AF402', meta: { capturedAt: 300 }, lookalikes: [{ candidateId: entry.id, choice: 'hot_confirmed' }] },
      { id: 's3', key: 'OTHER1', outcome: 'hot_sighting', plate: 'OTHER1', meta: { capturedAt: 400 } },
    ];
    const notMatched = { ...ack(250), id: 'n1', kind: 'lookalike_not_matched' as const, readAs: '2AF4O2' };
    const hitEv = { ...ack(260), id: 'h', kind: 'hit' as const };
    const rows = hotLogRows(entry, sightings, [ack(200), notMatched, hitEv]);
    expect(rows.map((r) => r.kind)).toEqual(['sighting', 'not_matched', 'acknowledged', 'sighting']);
  });
});

describe('hot-list officer safety: handset state machine', () => {
  beforeEach(async () => {
    await closeDb();
    await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('platewatch'); r.onsuccess = () => res(); r.onerror = () => res(); });
    resetSafety();
    setAckSeconds(60);
    await startSafety(() => ({ officerNumber: '4471', vibrate: false, sound: false }));
  });
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it('blocks until answered; SAFE & CLEAR logs the hit and the answer with the note', async () => {
    setWindow();
    const done = openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, location: { lat: -37.81, lng: 144.96, accuracyM: 4 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(safetyState().pending).toMatchObject({ deadline: 61_000, hits: [{ hit: { plate: 'ZAF402' } }] });
    expect(await getKv('safety')).toMatchObject({ pending: { deadline: 61_000 } }); // survives a reload
    await respond('safe_clear', 'Driver stayed in the car');
    const events = await done;
    expect(events[0]).toMatchObject({ kind: 'acknowledged', response: 'safe_clear', note: 'Driver stayed in the car', officerNumber: '4471' });
    expect(safetyState().pending).toBeNull();
    expect((await getAllHotEvents()).map((e) => e.kind).sort()).toEqual(['acknowledged', 'hit']);
  });

  it('no answer by the deadline: the handset raises the soft Code 1 (once), the pop-up stays', async () => {
    const calls: unknown[] = [];
    setWindow({ raiseSoftCode1: async (a: unknown) => (calls.push(a), { id: 'sc1-x' }) });
    void openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, location: null });
    await new Promise((r) => setTimeout(r, 0));
    await checkDeadline(60_999);
    expect(calls).toHaveLength(0);
    await checkDeadline(61_000);
    await checkDeadline(62_000);
    expect(calls).toHaveLength(1);
    expect(safetyState().pending?.softCode1).toMatchObject({ status: 'sent', id: 'sc1-x' });
    await respond('safe_clear', '');
    expect(safetyState().pending).toBeNull();
  });

  it('without a host: the soft Code 1 cannot be sent and the officer is told to use the radio', async () => {
    setWindow();
    void openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, location: null });
    await new Promise((r) => setTimeout(r, 0));
    await checkDeadline(61_000);
    expect(safetyState().pending?.softCode1?.status).toBe('unavailable');
  });

  it('CODE 1 from the pop-up raises a Code 1 with the hit; failures are kept for a retry', async () => {
    let fail = true;
    const raised: { cause: string; hit?: { plate: string } }[] = [];
    setWindow({ raiseCode1: async (a: { cause: string; hit?: { plate: string } }) => { if (fail) throw new Error('offline'); raised.push(a); return { id: 'c1' }; } });
    void openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, location: null });
    await new Promise((r) => setTimeout(r, 0));
    await respond('code1', '');
    expect(safetyState().code1).toMatchObject({ status: 'failed', cause: 'hot_list_code1' });
    fail = false;
    await raiseCode1({ cause: 'officer_duress' });
    expect(safetyState().code1).toMatchObject({ status: 'sent' });
    expect(raised.at(-1)).toMatchObject({ cause: 'officer_duress' });
  });
});
