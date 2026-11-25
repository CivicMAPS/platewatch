import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getAllHotEvents, getKv, putKv } from '../src/lib/db';
import { ackLocation, hitPayload, hotLogRows, responseEvent } from '../src/lib/hotlist';
import { cancelCode1, checkDeadline, flushDeliveries, openHotAlert, raiseCode1, resetSafety, respond, safetyState, setAckSeconds, startSafety } from '../src/lib/safety';
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
    const done = openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, openedAt: 1000, location: { lat: -37.81, lng: 144.96, accuracyM: 4 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(safetyState().pending).toMatchObject({ deadline: 61_000, hits: [{ hit: { plate: 'ZAF402' } }] });
    expect(await getKv('safety')).toMatchObject({ pending: { deadline: 61_000 } }); // survives a reload
    await respond('safe_clear', 'Driver stayed in the car');
    const events = await done;
    expect(events[0]).toMatchObject({ kind: 'acknowledged', response: 'safe_clear', note: 'Driver stayed in the car', officerNumber: '4471' });
    expect(safetyState().pending).toBeNull();
    expect((await getAllHotEvents()).map((e) => e.kind).sort()).toEqual(['acknowledged', 'hit']);
  });

  it('the answer window starts when the pop-up opens, not at capture (slow plate checks never shorten it)', async () => {
    setWindow();
    void openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, openedAt: 500_000, location: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(safetyState().pending).toMatchObject({ openedAt: 500_000, deadline: 560_000, hits: [{ hit: { at: 1000, ackDeadline: 560_000 } }] });
    await checkDeadline(61_000); // where a capture-based deadline would already have passed
    expect(safetyState().pending?.softCode1).toBeUndefined();
    await respond('safe_clear', '');
  });

  it('no answer by the deadline: the handset raises the soft Code 1 (once), the pop-up stays', async () => {
    const calls: unknown[] = [];
    setWindow({ raiseSoftCode1: async (a: unknown) => (calls.push(a), { id: 'sc1-x' }) });
    void openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, openedAt: 1000, location: null });
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
    void openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, openedAt: 1000, location: null });
    await new Promise((r) => setTimeout(r, 0));
    await checkDeadline(61_000);
    expect(safetyState().pending?.softCode1?.status).toBe('unavailable');
  });

  it('CODE 1 from the pop-up raises a Code 1 with the hit; failures are kept for a retry', async () => {
    let fail = true;
    const raised: { cause: string; hit?: { plate: string } }[] = [];
    setWindow({ raiseCode1: async (a: { cause: string; hit?: { plate: string } }) => { if (fail) throw new Error('offline'); raised.push(a); return { id: 'c1' }; } });
    void openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, openedAt: 1000, location: null });
    await new Promise((r) => setTimeout(r, 0));
    await respond('code1', '');
    expect(safetyState().code1).toMatchObject({ status: 'failed', cause: 'hot_list_code1' });
    fail = false;
    await raiseCode1({ cause: 'officer_duress' });
    expect(safetyState().code1).toMatchObject({ status: 'sent' });
    expect(raised.at(-1)).toMatchObject({ cause: 'officer_duress' });
  });

  it('uses the EnforcementMAPS sign-in officer number when Settings has none', async () => {
    resetSafety();
    await startSafety(() => ({ officerNumber: '', vibrate: false, sound: false }));
    setWindow({ officerNumber: '9001' });
    const done = openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, openedAt: 1000, location: null });
    expect(safetyState().pending?.hits[0]?.hit.officerNumber).toBe('9001');
    const [ev] = await (respond('safe_clear', ''), done);
    expect(ev).toMatchObject({ officerNumber: '9001', response: 'safe_clear' });
  });

  it('CODE 1 with a number typed on the pop-up (none in Settings) carries that officer to the raise and the cancel', async () => {
    resetSafety();
    await startSafety(() => ({ officerNumber: '', vibrate: false, sound: false }));
    const raised: { officerNumber?: string; hit?: { officerNumber: string } }[] = [];
    const cancels: (string | undefined)[] = [];
    setWindow({
      raiseCode1: async (a: { officerNumber?: string; hit?: { officerNumber: string } }) => (raised.push(a), { id: 'c1' }),
      cancelCode1: async (_id: string, _reason: string, officer?: string) => void cancels.push(officer),
    });
    void openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, openedAt: 1000, location: null });
    await new Promise((r) => setTimeout(r, 0));
    await respond('code1', '', '4471');
    expect(raised[0]).toMatchObject({ officerNumber: '4471', hit: { officerNumber: '4471' } });
    expect(safetyState().code1).toMatchObject({ status: 'sent', officerNumber: '4471' });
    await cancelCode1('raised in error');
    expect(cancels).toEqual(['4471']);
  });

  it('keeps the id the host returns (a CODE 1 merged into one already raised for the hit) for cancel', async () => {
    const cancels: string[] = [];
    let land!: () => void;
    setWindow({
      raiseCode1: (a: { id: string }) => new Promise((res) => { land = () => res({ id: `host-${a.id === 'x' ? 'x' : 'merged'}` }); }),
      cancelCode1: async (id: string) => void cancels.push(id),
    });
    const raising = raiseCode1({ cause: 'officer_duress' });
    await new Promise((r) => setTimeout(r, 0));
    land();
    await raising;
    expect(safetyState().code1).toMatchObject({ id: 'host-merged', status: 'sent' });
    await cancelCode1('raised in error');
    expect(cancels).toEqual(['host-merged']);
    // Cancelled while the raise is in flight: the cancel goes to the id the host then returns.
    const again = raiseCode1({ cause: 'officer_duress' });
    await new Promise((r) => setTimeout(r, 0));
    const cancelling = cancelCode1('raised in error');
    land();
    await again;
    await cancelling;
    expect(cancels).toEqual(['host-merged', 'host-merged']);
    expect(safetyState().code1).toBeNull();
  });

  it('cancelling while the raise is in flight cancels at the host once the raise lands', async () => {
    let land!: () => void;
    const calls: string[] = [];
    setWindow({
      raiseCode1: (a: { id: string }) => new Promise((r) => { land = () => { calls.push(`raise:${a.id}`); r({ id: a.id }); }; }),
      cancelCode1: async (id: string) => { calls.push(`cancel:${id}`); },
    });
    const raising = raiseCode1({ cause: 'officer_duress' });
    const id = safetyState().code1!.id;
    await cancelCode1('pressed in error');
    expect(safetyState().code1).toMatchObject({ cancelRequested: 'pressed in error' }); // not dropped yet
    expect(calls).toEqual([]);
    land();
    await raising;
    expect(calls).toEqual([`raise:${id}`, `cancel:${id}`]);
    expect(safetyState().code1).toBeNull();
  });

  it('cancelling after a failed (timed-out) raise asks the host; "not found" means it never arrived', async () => {
    const notFound = Object.assign(new Error('No such Code 1.'), { status: 404 });
    let cancelResult: 'ok' | '404' | 'offline' = 'offline';
    const cancels: string[] = [];
    setWindow({
      raiseCode1: async () => { throw new Error('timeout'); },
      cancelCode1: async (id: string) => { cancels.push(id); if (cancelResult === '404') throw notFound; if (cancelResult === 'offline') throw new Error('offline'); },
    });
    await raiseCode1({ cause: 'officer_duress' });
    expect(safetyState().code1?.status).toBe('failed');
    await cancelCode1('mistake');
    expect(safetyState().code1).toMatchObject({ cancelRequested: 'mistake' }); // offline: kept for a retry
    cancelResult = '404';
    await cancelCode1('mistake');
    expect(safetyState().code1).toBeNull();
    expect(cancels).toHaveLength(2);
  });

  it('delivers the hit and the answer to the host, retrying a failed delivery', async () => {
    const sent: string[] = [];
    let fail = true;
    setWindow({
      reportHotHit: async (h: { id: string }) => { sent.push(`hit:${h.id}`); },
      reportHotHitResponse: async (h: { id: string }, a: { response: string; note?: string }) => { if (fail) throw new Error('offline'); sent.push(`answer:${h.id}:${a.response}:${a.note}`); },
    });
    const done = openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, openedAt: 1000, location: null });
    const hitId = safetyState().pending!.hits[0]!.hit.id;
    await respond('safe_clear', 'left the segment');
    await done;
    await flushDeliveries(Date.now());
    expect(sent).toEqual([`hit:${hitId}`]);
    expect(safetyState().deliveries).toMatchObject([{ kind: 'response', attempts: 1 }]);
    fail = false;
    await flushDeliveries(Date.now() + 11_000);
    expect(sent).toEqual([`hit:${hitId}`, `answer:${hitId}:safe_clear:left the segment`]);
    expect(safetyState().deliveries).toEqual([]);
  });

  it('a soft Code 1 that was mid-send when the app closed is retried after a restart', async () => {
    const pendingHit = { hit: { id: 'hx', plate: 'ZAF402', hotListEntryId: entry.id, scanId: 's1', at: 1000, ackDeadline: 61_000, officerNumber: '4471', location: null, entry: { make: '', type: '', colour: '', riskLevel: 'high', risks: [] } }, hotListId: list.id, key: entry.key, listName: 'x', notes: '' };
    await putKv('safety', { pending: { hits: [pendingHit], openedAt: 1000, deadline: 61_000, softCode1: { status: 'sending', at: 61_000 } }, code1: null, deliveries: [] });
    resetSafety();
    const calls: unknown[] = [];
    setWindow({ raiseSoftCode1: async (a: unknown) => (calls.push(a), { id: 'sc1-hx' }) });
    await startSafety(() => ({ officerNumber: '4471', vibrate: false, sound: false })); // the restart
    expect(safetyState().pending?.softCode1?.status).toBe('failed');
    await checkDeadline(80_000);
    expect(calls).toHaveLength(1);
    expect(safetyState().pending?.softCode1).toMatchObject({ status: 'sent', id: 'sc1-hx' });
  });

  it('CODE 1 is raised even when the local log cannot be written (storage full)', async () => {
    const raised: string[] = [];
    setWindow({ raiseCode1: async (a: { cause: string }) => (raised.push(a.cause), { id: 'c1' }) });
    void openHotAlert({ hits: [{ list, entry, scanId: 's1' }], at: 1000, openedAt: 1000, location: null });
    await new Promise((r) => setTimeout(r, 0));
    await closeDb();
    const real = globalThis.indexedDB;
    (globalThis as { indexedDB: unknown }).indexedDB = { open: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); } };
    try {
      const events = await respond('code1', '');
      expect(raised).toEqual(['hot_list_code1']);
      expect(events[0]).toMatchObject({ response: 'code1' }); // answer still recorded in memory and delivered
      expect(safetyState().code1).toMatchObject({ status: 'sent' });
    } finally {
      (globalThis as { indexedDB: unknown }).indexedDB = real;
      await closeDb();
    }
  });
});

