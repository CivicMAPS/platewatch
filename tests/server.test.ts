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

  const call = async (method: string, path: string, opts: { body?: unknown; token?: string; staff?: [string, string]; device?: boolean; raw?: Buffer; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token ?? (opts.staff ? CONSOLE : DEVICE)}`, ...(opts.headers ?? {}) };
    if (opts.staff) Object.assign(headers, { 'X-Staff-Role': opts.staff[0], 'X-Staff-User': opts.staff[1] });
    if (opts.device !== false && !opts.staff && key) headers['X-Device-Key'] = key.keyId;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: opts.raw ? new Uint8Array(opts.raw) : opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any> };
  };
  const sup = ['supervisor', 'Sgt Lee'] as [string, string];

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
    const handler = createApp(db, { council: 'com', deviceToken: DEVICE, consoleToken: CONSOLE, corsOrigins: ['*'], consoleDir: 'server/console', version: 'test', now: () => t(9) });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    key = await generateSigningKey();
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await db?.end();
  });

  it('rejects wrong tokens and staff without a role', async () => {
    expect((await call('GET', '/api/devices/me', { token: 'nope' })).status).toBe(401);
    expect((await call('GET', '/api/console/summary', { token: DEVICE, device: false, headers: { 'X-Staff-Role': 'supervisor', 'X-Staff-User': 'x' } })).status).toBe(401);
    expect((await call('GET', '/api/console/summary', { token: CONSOLE, device: false })).status).toBe(400);
    expect((await call('GET', '/api/console/summary', { staff: ['janitor', 'x'] })).status).toBe(400);
    expect((await call('GET', '/api/health', { device: false })).json).toMatchObject({ ok: true, council: 'com' });
  });

  it('a device key is pending until a supervisor approves it; numbers are refused meanwhile', async () => {
    const reg = await call('POST', '/api/devices/register', { body: { publicJwk: key.publicJwk, label: 'Galaxy S26 test', officerNumber: '4471' } });
    expect(reg.json).toMatchObject({ keyId: key.keyId, status: 'pending', council: 'com' });
    const { allocation } = await nextAllocation(t(8, 24));
    const refused = await call('POST', '/api/infringements/statements', { body: { keyId: key.keyId, scanId: 's1', allocation } });
    expect(refused).toMatchObject({ status: 403, json: { error: 'device_not_approved' } });
    expect((await call('POST', `/api/console/devices/${key.keyId}/decision`, { staff: ['dispatch', 'D1'], body: { approve: true } })).status).toBe(403);
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
    expect((await call('POST', `/api/console/infringements/${number}/void-decision`, { staff: ['dispatch', 'D1'], body: { approve: true } })).status).toBe(403);
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
    expect((await call('POST', `/api/console/infringements/${number}/payment`, { staff: ['compliance_coordinator', 'CC1'] })).json).toEqual({ status: 'paid' });
    expect((await call('POST', `/api/console/infringements/${number}/payment`, { staff: sup })).status).toBe(409);
  });

  it('soft Code 1: each recipient acknowledges; the alert closes after both; the device sees who acknowledged', async () => {
    const event = { id: 'ack-1', kind: 'acknowledged', plate: 'ZAF402', key: 'ZAF402', hotListId: 'h1', hotListEntryId: 'e1', scanId: 's-hot', at: t(10, 41, 7), atLocal: '2026-11-21T10:41:07.000+11:00', officerNumber: '4471', location: { lat: -37.81277, lng: 144.96443, accuracyM: 4 }, device: 't', notification: { severity: 'soft_code1', recipients: ['dispatch', 'compliance_coordinator'], status: 'queued', attempts: 1 } };
    const sent = await call('POST', '/api/hot-alerts', { body: { event, entry: { riskLevel: 'high', risks: ['aggressive'], make: 'Toyota', colour: 'Silver' } } });
    expect(sent.status).toBe(200);
    expect(typeof sent.json.sentAt).toBe('number');
    const active = await call('GET', '/api/console/alerts', { staff: ['dispatch', 'D1'] });
    expect(active.json.alerts).toEqual([expect.objectContaining({ id: 'ack-1', plate: 'ZAF402', riskLevel: 'high', status: 'active', officerNumber: '4471' })]);
    expect((await call('POST', '/api/console/alerts/ack-1/ack', { staff: sup })).status).toBe(403);
    expect((await call('POST', '/api/console/alerts/ack-1/ack', { staff: ['dispatch', 'D1'] })).json).toMatchObject({ status: 'active' });
    expect((await call('POST', '/api/console/alerts/ack-1/ack', { staff: ['compliance_coordinator', 'CC1'] })).json).toMatchObject({ status: 'closed' });
    expect((await call('GET', '/api/console/alerts', { staff: ['dispatch', 'D1'] })).json.alerts).toEqual([]);
    const u = await call('GET', '/api/updates?since=0');
    expect(u.json.alerts[0]).toMatchObject({ id: 'ack-1', status: 'closed' });
    expect(u.json.alerts[0].acknowledgedBy.map((k: { recipient: string }) => k.recipient).sort()).toEqual(['compliance_coordinator', 'dispatch']);
    const detail = await call('GET', '/api/console/alerts/ack-1', { staff: ['dispatch', 'D1'] });
    expect(detail.json.log[0]).toMatchObject({ kind: 'acknowledged', officerNumber: '4471' });
  });

  it('sync stores scans and timings; evidence must match the SHA-256 recorded at capture', async () => {
    const bytes = Buffer.from('jpeg-bytes-for-test');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const { image: _i, thumb: _t, ...s } = scan('s9', t(9, 5), { sha256: sha, outcome: 'hot_sighting', plate: 'ZAF402', key: 'ZAF402' });
    const res = await call('POST', '/api/sync', { body: { scans: [{ ...s, thumbJpegBase64: bytes.toString('base64') }], observations: [obs702], hotEvents: [] } });
    expect(res.json).toMatchObject({ accepted: { scans: ['s9'], observations: ['o1'] }, rejected: [] });
    expect((await call('PUT', '/api/evidence/s9', { raw: Buffer.from('other'), headers: { 'X-Content-SHA256': sha, 'Content-Type': 'image/jpeg' } })).json).toMatchObject({ error: 'sha256' });
    expect((await call('PUT', '/api/evidence/s9', { raw: bytes, headers: { 'X-Content-SHA256': sha, 'Content-Type': 'image/jpeg' } })).json).toMatchObject({ verifiedAgainstCapture: true });
    const feed = await call('GET', '/api/console/scans', { staff: ['dispatch', 'D1'] });
    expect(feed.json.scans[0]).toMatchObject({ id: 's9', plate: 'ZAF402', hasThumb: true, hasEvidence: true });
  });

  it('payment lookup finds a paid session testers created', async () => {
    expect((await call('POST', '/api/console/paid-sessions', { staff: ['dispatch', 'D1'], body: { plate: '1ur6yf', source: 'easypark', sourceRef: '7514', paidFrom: t(8, 0), paidTo: t(10, 15) } })).status).toBe(200);
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
    const handler = createApp(db, { council: 'com', deviceToken: DEVICE, consoleToken: CONSOLE, corsOrigins: ['*'], consoleDir: 'server/console', version: 'test' });
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
    const staff = { Authorization: `Bearer ${CONSOLE}`, 'X-Staff-Role': 'supervisor', 'X-Staff-User': 'Sgt Lee', 'Content-Type': 'application/json' };
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
