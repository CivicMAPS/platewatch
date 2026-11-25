/**
 * Backend integration test against a real PostgreSQL database (docs/BACKEND.md §Testing).
 * Set PLATEWATCH_TEST_DATABASE_URL to a database this test may wipe, e.g.
 *   PLATEWATCH_TEST_DATABASE_URL=postgres://platewatch:platewatch@localhost/platewatch_test npm test
 * `npm run test:server` fails if it is not set, so CI cannot pass it silently.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { runWatchdog, type SafetyConfig } from '../server/safety';
import { createPool, migrate, type Db } from '../server/db';
import { newObservation } from '../src/lib/engine';
import { allocate, canonical, generateSigningKey, GENESIS_HASH, sha256Hex, signStatement, type IssueStatement, type Signed, type AllocationStatement } from '../src/lib/inNumber';
import { buildHandoff, type InfringementHandoff } from '../src/lib/infringement';
import { buildIssuedRecord, type WizardValues } from '../src/lib/issuance';
import { offenceFor } from '../src/lib/offence';
import { toLocalIso } from '../src/lib/time';
import type { Observation, ScanRecord } from '../src/lib/types';
import { at, r2P, timed } from './fixtures';

const URL_ = process.env.PLATEWATCH_TEST_DATABASE_URL;
const DEVICE = 'device-token-for-tests-0123456789';
const CONSOLE = 'console-token-for-tests-0123456789';
const t = (h: number, m = 0, s = 0) => at(2026, 11, 21, h, m, s);
const SAFETY: SafetyConfig = { timeZone: 'Australia/Melbourne', defaultBranch: 'parking', hotAckSeconds: 60, watchdogGraceSeconds: 20, radioEscalateSeconds: 0 };

const list = timed({
  displayId: 'com-20055',
  patrolZone: '9',
  segment: { street: 'Little Bourke Street', fromStreet: 'Swanston Street', toStreet: 'Elizabeth Street', side: 'south', suburb: 'Melbourne' },
  restrictions: [r2P({ description: 'Meter' })],
});
const loc = { latitude: -37.81277, longitude: 144.96443, accuracy: 4, altitude: null, altitudeAccuracy: null, heading: null, speed: null, timestamp: 0 };
const scan = (id: string, capturedAt: number, patch: Partial<ScanRecord> = {}): ScanRecord =>
  ({
    id, listId: list.id, observationId: 'o1', plate: 'DTS512', key: 'DTS512', ocrText: 'DTS512', ocrConfidence: 90, corrected: false, outcome: 'recorded',
    meta: { capturedAt, capturedAtLocal: '', timeZone: 'Australia/Melbourne', location: loc, locationAgeMs: 0, userAgent: 't', payment: { parkingArea: '645', easyPark: ['7514'], payStay: [] } },
    image: new Blob(), thumb: new Blob(), sha256: 'a'.repeat(64), createdAt: capturedAt, ...patch,
  }) as ScanRecord;
const VEH = { registrationType: 'Standard', make: 'Holden', bodyType: 'Hatchback', colour: 'White' };

describe.runIf(!!URL_)('PlateWatch backend (PostgreSQL)', () => {
  let db: Db;
  let server: Server;
  let base = '';
  let key: Awaited<ReturnType<typeof generateSigningKey>>;
  let prevHash = GENESIS_HASH;
  let seq = 0;

  const call = async (method: string, path: string, opts: { body?: unknown; token?: string; staff?: string; device?: boolean; raw?: Buffer; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token ?? (opts.staff ? CONSOLE : DEVICE)}`, ...(opts.headers ?? {}) };
    if (opts.staff) headers['X-Staff-Id'] = opts.staff;
    if (opts.device !== false && !opts.staff && key) headers['X-Device-Key'] = key.keyId;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: opts.raw ? new Uint8Array(opts.raw) : opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any> };
  };
  const sup = 'S1'; // team supervisor, team A

  const nextAllocation = async (now: number, opts: { prev?: string; sequence?: number } = {}) => {
    const sequence = opts.sequence ?? seq + 1;
    const out = await allocate({ privateKey: key.privateKey, keyId: key.keyId, council: 'com', officer: '4471', sequence, prevHash: opts.prev ?? prevHash, now, timestamp: toLocalIso(now) });
    return out;
  };
  const commit = (a: Signed) => {
    prevHash = a.hash;
    if (a.statement.type === 'allocation') seq = (a.statement as AllocationStatement).sequence;
  };
  const close = async (number: string, allocationHash: string, record: unknown | null, now: number) => {
    const st: IssueStatement = { v: 1, type: record ? 'issue' : 'cancel', number, keyId: key.keyId, allocationHash, ...(record ? { recordHash: await sha256Hex(canonical(record)) } : {}), timestamp: toLocalIso(now), prevHash };
    return signStatement(key.privateKey, st);
  };

  const first = scan('s1', t(8, 20, 5), { payment: { status: 'not_found', source: 'easypark', sourceRef: '7514', checkedAt: t(8, 21), checkedBy: '4471' } });
  const obs702: Observation = { ...newObservation({ id: 'o1', list, plate: 'DTS512', scanId: 's1', at: t(8, 20, 5), instance: { restriction: list.restrictions[0]!, start: t(7), end: t(22) } }), payment: { status: 'not_found' } };
  const handoff702 = (): InfringementHandoff =>
    buildHandoff({ handoffId: crypto.randomUUID(), list, observation: obs702, scan: first, offer: offenceFor(obs702, t(8, 20, 5))!, officerNumber: '4471', device: 'test', vehicle: VEH, plateSecondEntry: { plate: 'DTS512', at: t(8, 22) } });
  const values = (code: '701' | '702', timeTo = t(8, 25)): WizardValues => ({ offenceCode: code, timeTo, notes: 'n', vehicle: { make: 'Holden', type: 'Hatchback', colour: 'White', registrationType: 'Standard' }, evidenceOverride: 'Vehicle drove off after one photo' });

  /** Allocate + issue one 702 and return its number. */
  const issue702 = async (opts: { reissueOf?: string } = {}) => {
    const now = t(8, 24);
    const { number, allocation } = await nextAllocation(now);
    commit(allocation);
    const record = buildIssuedRecord({ number, handoff: handoff702(), values: values('702'), issuedAt: toLocalIso(t(8, 26)), toIso: toLocalIso, ...(opts.reissueOf ? { reissueOf: opts.reissueOf, reissueReason: 'incorrect_vehicle_details' as const } : {}) });
    const closing = await close(number, allocation.hash, record, t(8, 26));
    const res = await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation, closing, record } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    commit(closing);
    return number;
  };

  beforeAll(async () => {
    db = createPool(URL_!);
    await db.query('drop schema public cascade; create schema public;');
    await migrate(db);
    const handler = createApp(db, { council: 'com', deviceToken: DEVICE, consoleToken: CONSOLE, corsOrigins: ['*'], consoleDir: 'server/console', version: 'test', now: () => t(9), safety: SAFETY });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    key = await generateSigningKey();
    // Roster: the first entry bootstraps with the console token alone; the rest need a manager.
    const roster = [
      { id: 'S1', name: 'Sgt Lee', role: 'team_supervisor', team: 'A' },
      { id: 'S2', name: 'Sgt Ng', role: 'team_supervisor', team: 'B' },
      { id: 'D1', name: 'Dispatcher Kim', role: 'dispatch' },
      { id: 'CL1', name: 'Compliance Lead Rao', role: 'compliance_lead' },
      { id: 'O4471', name: 'Officer 4471', role: 'officer', officerNumber: '4471', team: 'A' },
      { id: 'O5123', name: 'Officer 5123', role: 'officer', officerNumber: '5123', team: 'B' },
      { id: 'O6001', name: 'Officer 6001', role: 'officer', officerNumber: '6001', team: 'A' },
    ];
    for (const [i, st] of roster.entries()) expect((await call('POST', '/api/console/staff', { body: st, token: CONSOLE, device: false, ...(i ? { staff: 'S1' } : {}) })).status).toBe(200);
    for (const id of ['S1', 'S2', 'D1']) await call('POST', `/api/console/staff/${id}/shift`, { staff: 'S1', body: { day: '2026-11-21', on: true } });
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await db?.end();
  });

  it('rejects wrong tokens and staff without a role', async () => {
    expect((await call('GET', '/api/devices/me', { token: 'nope' })).status).toBe(401);
    expect((await call('GET', '/api/console/summary', { token: DEVICE, device: false, headers: { 'X-Staff-Id': 'S1' } })).status).toBe(401);
    expect((await call('GET', '/api/console/summary', { token: CONSOLE, device: false })).status).toBe(400);
    expect((await call('GET', '/api/console/summary', { staff: 'nobody' })).status).toBe(401);
    expect((await call('GET', '/api/console/summary', { staff: 'O4471' })).status).toBe(403);
    expect((await call('POST', '/api/console/staff', { token: CONSOLE, device: false, body: { id: 'X', name: 'X', role: 'dispatch' } })).status).toBe(400);
    const dir = await call('GET', '/api/console/directory', { token: CONSOLE, device: false });
    expect(dir.json).toMatchObject({ bootstrap: false });
    expect(dir.json.staff.map((x: { id: string }) => x.id).sort()).toEqual(['CL1', 'D1', 'S1', 'S2']);
    expect((await call('GET', '/api/health', { device: false })).json).toMatchObject({ ok: true, council: 'com' });
  });

  it('a device key is pending until a supervisor approves it; numbers are refused meanwhile', async () => {
    const reg = await call('POST', '/api/devices/register', { body: { publicJwk: key.publicJwk, label: 'Galaxy S26 test', officerNumber: '4471' } });
    expect(reg.json).toMatchObject({ keyId: key.keyId, status: 'pending', council: 'com' });
    const { allocation } = await nextAllocation(t(8, 24));
    const refused = await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation } });
    expect(refused).toMatchObject({ status: 403, json: { error: 'device_not_approved' } });
    expect((await call('POST', `/api/console/devices/${key.keyId}/decision`, { staff: 'D1', body: { approve: true } })).status).toBe(403);
    expect((await call('POST', `/api/console/devices/${key.keyId}/decision`, { staff: sup, body: { approve: true } })).json).toEqual({ status: 'approved' });
  });

  it('accepts an allocation, then the issue: 702 with the internal classification derived server-side', async () => {
    const { number, allocation } = await nextAllocation(t(8, 24));
    const a = await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation } });
    expect(a.json).toEqual({ number, status: 'allocated' });
    commit(allocation);
    // Idempotent re-send.
    expect((await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation } })).json).toEqual({ number, status: 'allocated' });
    const record = buildIssuedRecord({ number, handoff: handoff702(), values: values('702'), issuedAt: toLocalIso(t(8, 26)), toIso: toLocalIso });
    expect(record.internalVariant).toBe('no_payment');
    const closing = await close(number, allocation.hash, record, t(8, 26));
    const res = await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation, closing, record } });
    expect(res.json).toEqual({ number, status: 'issued' });
    commit(closing);
    const detail = await call('GET', `/api/console/infringements/${number}`, { staff: sup });
    expect(detail.json.infringement).toMatchObject({ status: 'issued', offenceCode: '702', internalVariant: 'no_payment', variantSource: 'derived', plate: 'DTS512' });
    expect(detail.json.statements.map((s: { type: string }) => s.type)).toEqual(['allocation', 'issue']);
  });

  it('refuses a chain break, a skipped sequence, a tampered record and a chosen 702 variant', async () => {
    const forked = await nextAllocation(t(8, 30), { prev: GENESIS_HASH });
    expect((await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation: forked.allocation } })).json).toMatchObject({ error: 'chain_break' });
    const skipped = await nextAllocation(t(8, 30), { sequence: seq + 2 });
    expect((await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation: skipped.allocation } })).json).toMatchObject({ error: 'sequence' });

    const { number, allocation } = await nextAllocation(t(8, 30));
    expect((await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation } })).status).toBe(200);
    commit(allocation);
    const record = buildIssuedRecord({ number, handoff: handoff702(), values: values('702'), issuedAt: toLocalIso(t(8, 31)), toIso: toLocalIso });
    const closing = await close(number, allocation.hash, record, t(8, 31));
    const tampered = { ...record, notes: 'changed after signing' };
    expect((await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation, closing, record: tampered } })).json).toMatchObject({ error: 'record_hash' });
    // A client that "chooses" 702e: re-signed honestly, but the server re-derives and refuses.
    const chosen = { ...record, internalVariant: 'expired_session' as const };
    const closing2 = await close(number, allocation.hash, chosen, t(8, 31));
    expect((await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation, closing: closing2, record: chosen } })).json).toMatchObject({ error: 'variant' });
    // The honest closing is still accepted.
    expect((await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation, closing, record } })).json).toEqual({ number, status: 'issued' });
    commit(closing);
  });

  it('a cancelled number is consumed', async () => {
    const { number, allocation } = await nextAllocation(t(8, 40));
    commit(allocation);
    const closing = await close(number, allocation.hash, null, t(8, 41));
    expect((await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation, closing } })).json).toEqual({ number, status: 'cancelled' });
    commit(closing);
  });

  it('void without reissue: requested on the device, rejected then approved by a supervisor; device sees each change', async () => {
    const number = await issue702();
    const before = (await call('GET', '/api/updates?since=0')).json.cursor as number;
    expect((await call('POST', `/api/infringements/${number}/void-request`, { body: { reason: 'permit_displayed', note: 'RPA 7 permit on dash', officerNumber: '4471' } })).json).toEqual({ status: 'void_requested' });
    expect((await call('POST', `/api/console/infringements/${number}/void-decision`, { staff: 'D1', body: { approve: true } })).status).toBe(403);
    expect((await call('POST', `/api/console/infringements/${number}/void-decision`, { staff: sup, body: { approve: false, note: 'No permit in photos' } })).json).toEqual({ status: 'issued' });
    await call('POST', `/api/infringements/${number}/void-request`, { body: { reason: 'permit_displayed', officerNumber: '4471' } });
    expect((await call('POST', `/api/console/infringements/${number}/void-decision`, { staff: sup, body: { approve: true } })).json).toEqual({ status: 'voided' });
    const u = await call('GET', `/api/updates?since=${before}`);
    expect(u.json.infringements.find((x: { number: string }) => x.number === number)).toMatchObject({ status: 'voided', scanId: 's1', voidRequest: { decision: 'approved', decidedBy: 'Sgt Lee' } });
  });

  it('void with reissue needs no approval: the original is voided when the reissue is accepted', async () => {
    const original = await issue702();
    const replacement = await issue702({ reissueOf: original });
    const o = await call('GET', `/api/console/infringements/${original}`, { staff: sup });
    expect(o.json.infringement).toMatchObject({ status: 'voided', reissuedBy: replacement });
    expect(o.json.events.map((e: { action: string }) => e.action)).toContain('voided_by_reissue');
    expect((await call('GET', `/api/console/infringements/${replacement}`, { staff: sup })).json.infringement).toMatchObject({ status: 'issued', reissueOf: original });
  });

  it('simulated customer payment closes the life cycle', async () => {
    const number = await issue702();
    expect((await call('POST', `/api/console/infringements/${number}/payment`, { staff: 'CL1' })).json).toEqual({ status: 'paid' });
    expect((await call('POST', `/api/console/infringements/${number}/payment`, { staff: sup })).status).toBe(409);
  });

  const hit = (id: string, at: number, officer = '4471', patch: Record<string, unknown> = {}) => ({
    id, plate: 'ZAF402', hotListEntryId: 'e1', scanId: `scan-${id}`, at, officerNumber: officer, location: { lat: -37.81277, lng: 144.96443, accuracyM: 4 },
    entry: { make: 'Toyota', type: 'sedan', colour: 'Silver', riskLevel: 'extreme', risks: ['aggressive'], alertMessage: 'Do not approach — prior aggressive male driver', ownerDescription: 'Male, 40s' },
    where: { listName: 'Little Bourke St S', listId: 'l1', displayId: 'com-20055' }, ...patch,
  });
  const asOfficer = (n: string) => ({ headers: { 'X-Officer-Number': n } });

  it('hit synced, then SAFE & CLEAR with a note: logged to the plate history with officer and location', async () => {
    const ev = (kind: string, extra: Record<string, unknown>) => ({ id: `${kind}-h1`, kind, plate: 'ZAF402', key: 'ZAF402', hotListId: 'hl', hotListEntryId: 'e1', scanId: 'scan-h1', at: t(8, 30), atLocal: '', officerNumber: '4471', location: { lat: -37.81277, lng: 144.96443, accuracyM: 4 }, device: 't', ...extra });
    expect((await call('POST', '/api/sync', { body: { hotEvents: [ev('hit', { hit: hit('h1', t(8, 30)) })] } })).json.rejected).toEqual([]);
    expect((await call('GET', '/api/console/hits', { staff: 'D1' })).json.hits[0]).toMatchObject({ id: 'h1', response: null, officerNumber: '4471' });
    await call('POST', '/api/sync', { body: { hotEvents: [ev('acknowledged', { hitId: 'h1', response: 'safe_clear', note: 'Driver in car, did not approach', at: t(8, 30, 40) })] } });
    const p = await call('GET', '/api/hot-profile?plate=ZAF402');
    expect(p.json.history[0]).toMatchObject({ officerNumber: '4471', response: 'safe_clear', note: 'Driver in car, did not approach', where: 'Little Bourke St S' });
    expect(p.json.interactions).toEqual([expect.objectContaining({ note: 'Driver in car, did not approach' })]);
    expect(p.json.knownLocations[0]).toMatchObject({ label: 'Little Bourke St S (com-20055)', count: 1 });
    expect(p.json.entry).toMatchObject({ alertMessage: 'Do not approach — prior aggressive male driver', ownerDescription: 'Male, 40s' });
    expect((await runWatchdog(db, SAFETY, t(9))).softCode1).toEqual([]);
  });

  it("no acknowledgement: soft Code 1 to dispatch and the officer's own supervisor on shift; radio requested; no response → branch Code 1 with its life cycle", async () => {
    const out = await call('POST', '/api/alerts/soft-code1', { body: { hit: hit('h2', t(8, 40)), at: t(8, 41), location: { lat: -37.8128, lng: 144.9644, accuracyM: 5 } } });
    expect(out.json).toEqual({ id: 'sc1-h2', status: 'raised' });
    expect((await call('POST', '/api/alerts/soft-code1', { body: { hit: hit('h2', t(8, 40)) } })).json.id).toBe('sc1-h2'); // idempotent
    const list = (staff: string) => call('GET', '/api/console/alerts', { staff }).then((r) => r.json.alerts.find((a: { id: string }) => a.id === 'sc1-h2'));
    expect(await list('S1')).toMatchObject({ kind: 'soft_code1', status: 'active', forMe: true, recipients: { staffIds: ['S1'], fallback: false } });
    expect(await list('D1')).toMatchObject({ forMe: true });
    expect(await list('S2')).toMatchObject({ forMe: false });
    expect((await call('POST', '/api/console/alerts/sc1-h2/acknowledge', { staff: 'S2' })).status).toBe(403);
    expect((await call('POST', '/api/console/alerts/sc1-h2/acknowledge', { staff: 'D1' })).json).toEqual({ status: 'radio_requested' });
    const esc = await call('POST', '/api/console/alerts/sc1-h2/escalate', { staff: 'S1', body: { note: 'No answer on channel 2' } });
    expect(esc.json).toEqual({ status: 'escalated', code1: 'c1-sc1-h2' });
    // Every handset in branch "parking" sees it (not only team A); the raising officer sees it as own.
    const other = await call('GET', '/api/alerts/live', asOfficer('5123'));
    expect(other.json.branch_code1[0]).toMatchObject({ id: 'c1-sc1-h2', kind: 'code1', status: 'active', officerNumber: '4471', received: false, location: { lat: -37.8128 } });
    expect((await call('GET', '/api/alerts/live', asOfficer('4471'))).json.own.map((a: { id: string }) => a.id)).toContain('c1-sc1-h2');
    await call('POST', '/api/alerts/c1-sc1-h2/receipt', asOfficer('5123'));
    expect((await call('GET', '/api/alerts/live', asOfficer('5123'))).json.branch_code1[0].received).toBe(true);
    await call('POST', '/api/code1/c1-sc1-h2/location', { body: { lat: -37.8131, lng: 144.9650, accuracyM: 6, at: t(8, 44) } });
    expect((await call('POST', '/api/console/alerts/c1-sc1-h2/acknowledge', { staff: 'D1' })).json).toEqual({ status: 'acknowledged' });
    expect((await call('POST', '/api/console/alerts/c1-sc1-h2/clear', { staff: 'S1', body: {} })).status).toBe(422);
    expect((await call('POST', '/api/console/alerts/c1-sc1-h2/clear', { staff: 'S1', body: { outcome: 'Units attended, officer safe' } })).json).toEqual({ status: 'cleared' });
    const d = await call('GET', '/api/console/alerts/c1-sc1-h2', { staff: 'CL1' });
    expect(d.json.alert).toMatchObject({ status: 'cleared', outcome: 'Units attended, officer safe', escalatedFrom: 'sc1-h2', location: { lat: -37.8131 } });
    expect(d.json.receipts).toEqual([expect.objectContaining({ officerNumber: '5123' })]);
    expect(d.json.events.map((e: { action: string }) => e.action)).toEqual(['code1_raised', 'alarm_received', 'code1_acknowledged', 'code1_cleared']);
  });

  it("own supervisor not on shift: every team supervisor on shift and the compliance lead; radio OK resolves", async () => {
    await call('POST', '/api/console/staff/S1/shift', { staff: 'S2', body: { day: '2026-11-21', on: false } });
    await call('POST', '/api/alerts/soft-code1', { body: { hit: hit('h3', t(8, 50)) } });
    const a = (await call('GET', '/api/console/alerts', { staff: 'CL1' })).json.alerts.find((x: { id: string }) => x.id === 'sc1-h3');
    expect(a).toMatchObject({ forMe: true, recipients: { fallback: true, staffIds: ['S2', 'CL1'] } });
    expect((await call('POST', '/api/console/alerts/sc1-h3/radio-ok', { staff: 'S2', body: { note: 'Officer answered, safe' } })).json).toEqual({ status: 'resolved' });
    await call('POST', '/api/console/staff/S1/shift', { staff: 'S2', body: { day: '2026-11-21', on: true } });
  });

  it('watchdog raises the soft Code 1 when the handset could not, once, after the grace period', async () => {
    await call('POST', '/api/hot-hits', { body: { hit: hit('h4', t(8, 55)) } });
    expect((await runWatchdog(db, SAFETY, t(8, 56, 10))).softCode1).toEqual([]); // within deadline + grace
    expect((await runWatchdog(db, SAFETY, t(8, 56, 30))).softCode1).toEqual(['sc1-h4']);
    expect((await runWatchdog(db, SAFETY, t(8, 57))).softCode1).toEqual([]);
    const a = (await call('GET', '/api/console/alerts', { staff: 'D1' })).json.alerts.find((x: { id: string }) => x.id === 'sc1-h4');
    expect(a).toMatchObject({ raisedBy: 'server_watchdog', status: 'active' });
    // A late SAFE & CLEAR shows on the open soft Code 1; dispatch still confirms by radio.
    await call('POST', '/api/hot-hits/h4/response', { body: { response: 'safe_clear', at: t(8, 57, 30) } });
    expect((await call('GET', '/api/console/alerts', { staff: 'D1' })).json.alerts.find((x: { id: string }) => x.id === 'sc1-h4')).toMatchObject({ officerResponse: 'safe_clear', status: 'active' });
    await call('POST', '/api/console/alerts/sc1-h4/radio-ok', { staff: 'D1' });
  });

  it('CODE 1 from the pop-up: hit answered code1, Code 1 raised; the officer can cancel it as raised in error', async () => {
    const r = await call('POST', '/api/code1', { body: { id: 'c1-pop', hit: hit('h5', t(9, 0)), at: t(9, 0, 5), location: { lat: -37.81, lng: 144.96 } }, ...asOfficer('4471') });
    expect(r.json).toEqual({ id: 'c1-pop', status: 'raised' });
    expect((await call('GET', '/api/hot-profile?plate=ZAF402')).json.history[0]).toMatchObject({ response: 'code1', alerts: [{ kind: 'code1', status: 'active' }] });
    expect((await call('POST', '/api/code1/c1-pop/cancel', { body: { reason: 'pressed by mistake' }, ...asOfficer('5123') })).status).toBe(403);
    expect((await call('POST', '/api/code1/c1-pop/cancel', { body: { reason: 'pressed by mistake' }, ...asOfficer('4471') })).json).toEqual({ status: 'cancelled' });
  });

  it('sync stores scans and timings; evidence must match the SHA-256 recorded at capture', async () => {
    const bytes = Buffer.from('jpeg-bytes-for-test');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const { image: _i, thumb: _t, ...s } = scan('s9', t(9, 5), { sha256: sha, outcome: 'hot_sighting', plate: 'ZAF402', key: 'ZAF402' });
    const res = await call('POST', '/api/sync', { body: { scans: [{ ...s, thumbJpegBase64: bytes.toString('base64') }], observations: [obs702], hotEvents: [] } });
    expect(res.json).toMatchObject({ accepted: { scans: ['s9'], observations: ['o1'] }, rejected: [] });
    expect((await call('PUT', '/api/evidence/s9', { raw: Buffer.from('other'), headers: { 'X-Content-SHA256': sha, 'Content-Type': 'image/jpeg' } })).json).toMatchObject({ error: 'sha256' });
    expect((await call('PUT', '/api/evidence/s9', { raw: bytes, headers: { 'X-Content-SHA256': sha, 'Content-Type': 'image/jpeg' } })).json).toMatchObject({ verifiedAgainstCapture: true });
    const feed = await call('GET', '/api/console/scans', { staff: 'D1' });
    expect(feed.json.scans[0]).toMatchObject({ id: 's9', plate: 'ZAF402', hasThumb: true, hasEvidence: true });
  });

  it('payment lookup finds a paid session testers created', async () => {
    expect((await call('POST', '/api/console/paid-sessions', { staff: 'D1', body: { plate: '1ur6yf', source: 'easypark', sourceRef: '7514', paidFrom: t(8, 0), paidTo: t(10, 15) } })).status).toBe(200);
    expect((await call('GET', `/api/payments/lookup?plate=1UR6YF&at=${t(9)}&ref=7514`)).json.session).toMatchObject({ source: 'easypark', sourceRef: '7514', paidTo: t(10, 15) });
    expect((await call('GET', `/api/payments/lookup?plate=DA8899&at=${t(9)}`)).json.session).toBeNull();
  });

  it('analytics split 702 by the derived internal classification; the console never shows "702e" as a code', async () => {
    const a = await call('GET', '/api/console/analytics/offences', { staff: sup });
    const codes = a.json.byCode as { offence_code: string; variant: string; n: number }[];
    expect(codes.every((x) => x.offence_code === '701' || x.offence_code === '702')).toBe(true);
    expect(codes.find((x) => x.offence_code === '702' && x.variant === 'no_payment')?.n).toBeGreaterThan(0);
  });
});

/**
 * The device's own sync code (outbox, signer, backend client) against the real server: the
 * crash-recovery path, where a number left open mid-wizard must be consumed with a cancel that
 * chains after numbers allocated since.
 */
describe.runIf(!!URL_)('device sync against the backend (PostgreSQL)', () => {
  let db: Db;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    db = createPool(URL_!);
    const handler = createApp(db, { council: 'com', deviceToken: DEVICE, consoleToken: CONSOLE, corsOrigins: ['*'], consoleDir: 'server/console', version: 'test', safety: SAFETY });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await db?.end();
  });

  it('an allocation left open is sent first, then cancelled in chain order after later numbers', async () => {
    const { closeDb } = await import('../src/lib/db');
    await closeDb();
    await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('platewatch'); r.onsuccess = () => res(); r.onerror = () => res(); });
    const backend = await import('../src/lib/backend');
    const signer = await import('../src/lib/signer');
    const settings = { backendUrl: base, backendToken: DEVICE, officerNumber: '5123' } as never;
    backend.installBackend(() => settings);
    const dev = await backend.registerDevice();
    const staff = { Authorization: `Bearer ${CONSOLE}`, 'X-Staff-Id': 'S1', 'Content-Type': 'application/json' };
    await fetch(`${base}/api/console/devices/${dev.keyId}/decision`, { method: 'POST', headers: staff, body: JSON.stringify({ approve: true }) });
    const detail = async (n: string) => (await (await fetch(`${base}/api/console/infringements/${n}`, { headers: staff })).json()).infringement;

    // A: allocated two minutes ago, the app closed before Issue or Cancel.
    const a = await signer.allocateNumber({ officer: '5123', council: 'com', scanId: 'sA', now: Date.now() - 120_000 });
    // B: allocated and issued afterwards (its allocation chains on A's).
    const b = await signer.allocateNumber({ officer: '5123', council: 'com', scanId: 'sB' });
    const record = buildIssuedRecord({ number: b.number, handoff: handoff(), values: { offenceCode: '702', timeTo: t(8, 25), notes: 'n', vehicle: { make: 'Holden', type: 'Hatchback', colour: 'White', registrationType: 'Standard' }, evidenceOverride: 'x' }, issuedAt: toLocalIso(t(8, 26)), toIso: toLocalIso });
    await signer.closeNumber(b.number, record);

    await backend.syncNow();
    expect(backend.backendState().lastError).toBeUndefined();
    expect((await detail(a.number)).status).toBe('allocated');
    expect((await detail(b.number)).status).toBe('issued');
    // The recovery cancel was signed after B and re-queued; the next sync sends it.
    await backend.syncNow();
    expect(backend.backendState().lastError).toBeUndefined();
    expect((await detail(a.number)).status).toBe('cancelled');
    expect(backend.backendState().pending).toBe(0);
  });
});

function handoff(): InfringementHandoff {
  const list2 = list;
  const f = scan('sB', t(8, 20, 5), { payment: { status: 'not_found', source: 'easypark', sourceRef: '7514', checkedAt: t(8, 21), checkedBy: '5123' } });
  const o: Observation = { ...newObservation({ id: 'oB', list: list2, plate: 'DTS512', scanId: 'sB', at: t(8, 20, 5), instance: { restriction: list2.restrictions[0]!, start: t(7), end: t(22) } }), payment: { status: 'not_found' } };
  return buildHandoff({ handoffId: crypto.randomUUID(), list: list2, observation: o, scan: f, offer: offenceFor(o, t(8, 20, 5))!, officerNumber: '5123', device: 'test', vehicle: VEH, plateSecondEntry: { plate: 'DTS512', at: t(8, 22) } });
}
