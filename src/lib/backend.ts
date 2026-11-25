/**
 * PlateWatch backend client (development and field testing, docs/BACKEND.md).
 *
 * - Sync: every scan, timing and hot-list event is queued in the outbox in the same transaction as
 *   the change; this sends them (images stay on the device except evidence for infringements and
 *   acknowledged hot-list sightings, which is uploaded with its SHA-256 checked by the server).
 * - Updates: pulls infringement status (void decisions, payment) and CommandMAPS acknowledgements
 *   of soft Code 1 alerts, and applies them to the device's records.
 * - Development host: when a backend is configured and no EnforcementMAPS host is present, installs
 *   `window.EnforcementMAPS` so hot-list alerts reach the console and Issue infringement works
 *   end to end (the wizard runs on the device; the I-N is allocated and signed here, offline-safe).
 */
import { countOutbox, getHotEvent, getOutbox, getScan, markOutboxFailed, removeOutbox, saveScan, enqueue, getKv, putKv, getObservation } from './db';
import type { EnforcementMapsHost, HotProfile, LiveAlert } from './host';
import { setAckSeconds } from './safety';
import type { InfringementHandoff, InfringementResult } from './infringement';
import { buildIssuedRecord, type WizardValues } from './issuance';
import { allocateNumber, closeNumber, deviceKey, getBundle, isWizardOpen, markWizardOpen, raisePoolFloors } from './signer';
import { toLocalIso } from './time';
import type { HotHitPayload, InfringementRecord, ScanRecord, Settings, VoidReason } from './types';

export interface BackendState {
  configured: boolean;
  device?: { keyId: string; status: 'pending' | 'approved' | 'revoked' | 'unregistered'; council?: string; hotAckSeconds?: number };
  lastSyncAt?: number;
  lastError?: string;
  pending: number;
  syncing: boolean;
}

/**
 * Registration, update cursor and last-sync time belong to one server: keyed by the backend URL, so
 * pointing the handset at another server registers afresh and pulls that server's updates from 0
 * (and switching back resumes where it left off).
 */
const serverKey = (name: string) => () => `${name}:${(settingsRef().backendUrl ?? '').trim().replace(/\/+$/, '').toLowerCase()}`;
const DEVICE_KEY = serverKey('backendDevice');
const CURSOR_KEY = serverKey('backendCursor');
const LAST_KEY = serverKey('backendLast');

let settingsRef: () => Settings = () => ({}) as Settings;
let state: BackendState = { configured: false, pending: 0, syncing: false };
const listeners = new Set<() => void>();

export function backendState(): BackendState {
  return state;
}
export function onBackendChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setState(patch: Partial<BackendState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function isConfigured(s: Settings = settingsRef()): boolean {
  return !!s.backendUrl?.trim() && !!s.backendToken?.trim();
}

export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  /** Worth retrying later (network, server busy, device not yet approved). */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429 || this.code === 'device_not_approved' || this.code === 'unknown_device';
  }
}

async function request<T>(method: string, path: string, opts: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  const s = settingsRef();
  const base = s.backendUrl.trim().replace(/\/+$/, '');
  const keyId = (await getKv<{ keyId: string }>(DEVICE_KEY()))?.keyId;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${s.backendToken.trim()}`,
    ...(keyId ? { 'X-Device-Key': keyId } : {}),
    ...(s.officerNumber?.trim() ? { 'X-Officer-Number': s.officerNumber.trim() } : {}),
    ...(opts.headers ?? {}),
  };
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body, signal: ctrl.signal });
  } catch (e) {
    throw new BackendError(0, 'network', ctrl.signal.aborted ? 'The backend did not answer in time.' : `Cannot reach the backend (${(e as Error).message}).`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string };
    throw new BackendError(res.status, d.error ?? 'http', d.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

/** The officer a Code 1 call is about, when known (overrides the Settings number in `request`). */
const officerHeader = (officer?: string): Record<string, string> => (officer?.trim() ? { 'X-Officer-Number': officer.trim() } : {});

/** Register this device's signing key (idempotent). */
export async function registerDevice(): Promise<NonNullable<BackendState['device']>> {
  const k = await deviceKey();
  const key = DEVICE_KEY(); // the server this registration is with, even if Settings change meanwhile
  const out = await request<{ keyId: string; status: 'pending' | 'approved' | 'revoked'; council: string; hotAckSeconds?: number }>('POST', '/api/devices/register', {
    json: { publicJwk: k.publicJwk, label: typeof navigator === 'undefined' ? 'device' : navigator.userAgent.slice(0, 120), officerNumber: settingsRef().officerNumber },
    headers: { 'X-Device-Key': k.keyId },
  });
  const device = { keyId: out.keyId, status: out.status, council: out.council, hotAckSeconds: out.hotAckSeconds };
  if (out.hotAckSeconds) setAckSeconds(out.hotAckSeconds);
  // Stored only if the backend did not change while registering (the next sync registers again).
  if (DEVICE_KEY() !== key) return device;
  await putKv(key, device);
  setState({ device });
  return device;
}

export async function testConnection(): Promise<{ council: string; version: string }> {
  return request('GET', '/api/health', { timeoutMs: 8000 });
}

async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function scanJson(s: ScanRecord): Promise<Record<string, unknown>> {
  const { image: _image, thumb, ...rest } = s;
  return { ...rest, officerNumber: settingsRef().officerNumber, thumbJpegBase64: thumb && thumb.size < 200_000 ? await blobToBase64(thumb) : undefined };
}

/** Send what is queued, oldest first. Infringement statements go in chain order. */
async function pushOutbox(): Promise<void> {
  const items = await getOutbox();
  const batch: { scans: unknown[]; observations: unknown[]; hotEvents: unknown[] } = { scans: [], observations: [], hotEvents: [] };
  const batched: typeof items = [];
  for (const it of items) {
    if (it.kind === 'scan') {
      const s = await getScan(it.id);
      if (s) batch.scans.push(await scanJson(s));
      batched.push(it);
    } else if (it.kind === 'observation') {
      const o = await getObservation(it.id);
      if (o) batch.observations.push(o);
      batched.push(it);
    } else if (it.kind === 'hotEvent') {
      const e = await getHotEvent(it.id);
      if (e) batch.hotEvents.push(e);
      batched.push(it);
    }
    if (batched.length >= 50) await flushBatch();
  }
  await flushBatch();

  async function flushBatch() {
    if (!batched.length) return;
    try {
      await request('POST', '/api/sync', { json: batch });
      for (const it of batched) await removeOutbox(it.key, it.queuedAt);
    } catch (e) {
      for (const it of batched) await markOutboxFailed(it.key, it.queuedAt, (e as Error).message);
      throw e;
    } finally {
      batched.length = 0;
      batch.scans = [];
      batch.observations = [];
      batch.hotEvents = [];
    }
  }

  // Infringements, void requests and evidence after the records they refer to.
  for (const it of items) {
    if (it.kind === 'scan' || it.kind === 'observation' || it.kind === 'hotEvent') continue;
    try {
      let done = true;
      if (it.kind === 'infringement') done = await pushInfringement(it.id);
      else if (it.kind === 'voidRequest') await pushVoidRequest(it.id);
      else if (it.kind === 'evidence') await pushEvidence(it.id);
      if (done) await removeOutbox(it.key, it.queuedAt);
    } catch (e) {
      const err = e as BackendError;
      // A statement the server refuses outright (signature, chain, key) is not in its chain, so every
      // later statement chained onto it would be refused too: keep it queued and stop here, visibly,
      // instead of dropping it and the numbers after it (a supervisor must re-key the device).
      if (err instanceof BackendError && !err.retryable && it.kind === 'infringement') {
        await markInfringementRejected(it.id, err.message);
        await markOutboxFailed(it.key, it.queuedAt, err.message);
        throw new BackendError(err.status, err.code, `Infringement sync stopped at ${it.id}: ${err.message} Later numbers are kept on the handset.`);
      }
      await markOutboxFailed(it.key, it.queuedAt, err.message);
      // Keep chain order: never send a later statement past a failed one.
      if (it.kind === 'infringement') throw e;
    }
  }
}

/**
 * Send one number's statements. Returns false while the number is still open (keep it queued).
 * A number left open when the app closed mid-wizard is consumed with a signed cancel — signed now,
 * so it chains after anything allocated since, and re-queued so it is sent in that order.
 */
async function pushInfringement(number: string): Promise<boolean> {
  const b = await getBundle(number);
  if (!b) return true;
  const out = await request<{ status: string; rejection?: { code: string; message: string } }>('POST', '/api/infringements/statements', { json: { keyId: b.keyId, scanId: b.scanId, allocation: b.allocation, closing: b.closing, record: b.record } });
  // Refused on a business rule (e.g. reissued offline after the original was paid): the server kept
  // the statements in this key's chain, so later numbers still follow; this one is not valid.
  if (out?.status === 'rejected') await markInfringementRejected(number, out.rejection?.message ?? 'Refused by the backend.');
  if (b.closing) {
    if (out?.status !== 'rejected') await updateScanInfringement(b.scanId, number, (r) => ({ ...r, sync: 'synced' }));
    return true;
  }
  if (!isWizardOpen(number) && Date.now() - b.createdAt > 60_000) await closeNumber(number, null);
  return false;
}

async function pushVoidRequest(number: string): Promise<void> {
  const b = await getBundle(number);
  const scan = b ? await getScan(b.scanId) : undefined;
  const v = scan?.infringement?.number === number ? scan.infringement.voidRequest : undefined;
  if (!v) return;
  await request('POST', `/api/infringements/${encodeURIComponent(number)}/void-request`, { json: { reason: v.reason, note: v.note, requestedAt: v.requestedAt, officerNumber: settingsRef().officerNumber } });
}

async function pushEvidence(scanId: string): Promise<void> {
  const s = await getScan(scanId);
  if (!s) return;
  await request('PUT', `/api/evidence/${encodeURIComponent(scanId)}`, { body: s.image, headers: { 'Content-Type': s.image.type || 'image/jpeg', 'X-Content-SHA256': s.sha256 }, timeoutMs: 60_000 });
}

async function updateScanInfringement(scanId: string, number: string, fn: (r: InfringementRecord) => InfringementRecord): Promise<void> {
  const s = await getScan(scanId);
  if (!s) return;
  if (s.infringement?.number === number) return saveScan({ ...s, infringement: fn(s.infringement) });
  const i = s.infringementHistory?.findIndex((r) => r.number === number) ?? -1;
  if (i >= 0) {
    const history = [...s.infringementHistory!];
    history[i] = fn(history[i]!);
    await saveScan({ ...s, infringementHistory: history });
  }
}

async function markInfringementRejected(number: string, message: string): Promise<void> {
  const b = await getBundle(number);
  if (b) await updateScanInfringement(b.scanId, number, (r) => ({ ...r, sync: 'rejected', syncError: message }));
}

/** Apply the server's changes since our cursor. */
async function pullUpdates(): Promise<void> {
  const key = CURSOR_KEY();
  const since = (await getKv<number>(key)) ?? 0;
  const u = await request<{
    cursor: number;
    infringements: { number: string; scanId: string; status: InfringementRecord['status'] | 'paid' | 'allocated' | 'rejected'; voidRequest: InfringementRecord['voidRequest'] & { decision?: 'approved' | 'rejected'; decidedBy?: string; decidedAt?: number }; paidAt: number | null; rejection?: { message?: string } }[];
  }>('GET', `/api/updates?since=${since}`);
  // The backend changed while this was in flight: these updates and this cursor are not for it.
  if (CURSOR_KEY() !== key) return;
  for (const x of u.infringements) {
    if (x.status === 'allocated') continue;
    if (x.status === 'rejected') {
      await markInfringementRejected(x.number, x.rejection?.message ?? 'Refused by the backend.');
      continue;
    }
    const status = x.status === 'paid' ? 'issued' : x.status;
    await updateScanInfringement(x.scanId, x.number, (r) => ({
      ...r,
      status,
      sync: 'synced',
      ...(x.paidAt ? { paidAt: x.paidAt } : {}),
      ...(x.voidRequest && r.voidRequest
        ? { voidRequest: { ...r.voidRequest, ...(x.voidRequest.decision ? { decision: x.voidRequest.decision, decidedBy: x.voidRequest.decidedBy, decidedAt: x.voidRequest.decidedAt } : {}) } }
        : {}),
    }));
  }
  await putKv(key, u.cursor);
}

let running: Promise<void> | null = null;
let again = false;

/** Send the outbox and pull updates. Concurrent calls coalesce. */
export function syncNow(): Promise<void> {
  if (!isConfigured()) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    setState({ syncing: true });
    try {
      const dev = (await getKv<BackendState['device']>(DEVICE_KEY())) ?? undefined;
      if (!dev || dev.status !== 'approved') await registerDevice();
      // Continue the officer's daily I-N sequence from what the backend already accepted (another handset).
      const officer = settingsRef().officerNumber?.trim();
      if (officer) {
        const me = await request<{ pools?: { day: string; lastSequence: number }[] }>('GET', '/api/devices/me').catch(() => null);
        if (me?.pools?.length) await raisePoolFloors(officer, me.pools);
      }
      await pushOutbox();
      await pullUpdates();
      const lastSyncAt = Date.now();
      await putKv(LAST_KEY(), lastSyncAt);
      setState({ lastSyncAt, lastError: undefined });
    } catch (e) {
      setState({ lastError: (e as Error).message });
    } finally {
      setState({ syncing: false, pending: await countOutbox() });
      running = null;
      if (again) {
        again = false;
        void syncNow();
      }
    }
  })();
  return running;
}

let debounce: ReturnType<typeof setTimeout> | undefined;
/** Ask for a sync soon (after a save). */
export function requestSync(delayMs = 1500): void {
  if (!isConfigured()) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void syncNow(), delayMs);
}

/* ─────────────────────────── Development host ─────────────────────────── */

export type WizardOutcome = { action: 'issue'; values: WizardValues } | { action: 'cancel' };
export type WizardFn = (args: { handoff: InfringementHandoff; number: string; initial?: Partial<WizardValues>; reissueOf?: string }) => Promise<WizardOutcome>;

let wizard: WizardFn | null = null;
/** The UI registers the four-step wizard (src/ui/infringementWizard.ts). */
export function setInfringementWizard(fn: WizardFn): void {
  wizard = fn;
}

let installed = false;

/** Council the device's numbers are for (from the backend registration). */
async function council(): Promise<string> {
  return (await getKv<{ council?: string }>(DEVICE_KEY()))?.council ?? 'com';
}

async function runWizard(args: { handoff: InfringementHandoff; scanId: string; initial?: Partial<WizardValues>; reissueOf?: string; reissueReason?: VoidReason }): Promise<{ result: InfringementResult; record?: ReturnType<typeof buildIssuedRecord> }> {
  if (!wizard) throw new Error('The issue wizard is not available.');
  const officer = args.handoff.officerNumber;
  const b = await allocateNumber({ officer, council: await council(), scanId: args.scanId });
  markWizardOpen(b.number);
  try {
    const outcome = await wizard({ handoff: args.handoff, number: b.number, initial: args.initial, reissueOf: args.reissueOf });
    if (outcome.action === 'cancel') {
      await closeNumber(b.number, null);
      requestSync(100);
      return { result: { status: 'cancelled', number: b.number } };
    }
    const issuedAt = Date.now();
    const record = buildIssuedRecord({ number: b.number, handoff: args.handoff, values: outcome.values, issuedAt: toLocalIso(issuedAt), toIso: toLocalIso, ...(args.reissueOf ? { reissueOf: args.reissueOf, reissueReason: args.reissueReason } : {}) });
    await closeNumber(b.number, record, issuedAt);
    for (const e of (args.handoff.evidence as { scanId: string }[] | undefined) ?? []) await enqueue('evidence', e.scanId);
    requestSync(100);
    return {
      record,
      result: { status: 'issued', number: b.number, offenceCode: record.offenceCode, timeFrom: Date.parse(record.timeFrom), timeTo: Date.parse(record.timeTo), issuedAt, sync: 'pending' },
    };
  } finally {
    markWizardOpen(null);
  }
}

/**
 * Reissue (void + reissue, no approval — owner 23/11/2026): a new number for the same sighting,
 * pre-filled from the original; the original is voided when the backend accepts the reissue.
 * Cancelling the reissue consumes the new number and leaves the original in force.
 */
export async function reissue(scan: ScanRecord, reason: VoidReason): Promise<ScanRecord> {
  const cur = scan.infringement;
  if (!cur || cur.status !== 'issued') throw new Error('Only an issued infringement can be reissued.');
  const orig = await getBundle(cur.number);
  if (!orig?.record) throw new Error('The original issue record is not on this device.');
  const handoff = { ...(orig.record.handoff as InfringementHandoff), handoffId: crypto.randomUUID() };
  const { result } = await runWizard({
    handoff,
    scanId: scan.id,
    initial: { offenceCode: orig.record.offenceCode, notes: orig.record.notes, vehicle: orig.record.vehicle, evidenceOverride: orig.record.evidenceOverride?.reason, timeTo: Date.parse(orig.record.timeTo) },
    reissueOf: cur.number,
    reissueReason: reason,
  });
  const latest = (await getScan(scan.id)) ?? scan;
  const fresh: InfringementRecord = {
    status: result.status === 'issued' ? 'issued' : 'cancelled', sync: 'pending', pinSource: 'device', handoffId: handoff.handoffId, number: result.number!,
    offenceCode: result.offenceCode ?? orig.record.offenceCode, offenceOverridden: (result.offenceCode ?? orig.record.offenceCode) !== handoff.offence.suggestedCode,
    timeFrom: result.timeFrom ?? Date.parse(orig.record.timeFrom), timeTo: result.timeTo ?? Date.parse(orig.record.timeTo), ...(result.issuedAt ? { issuedAt: result.issuedAt } : {}),
    officerNumber: handoff.officerNumber, reissueOf: cur.number,
  };
  const next: ScanRecord =
    result.status === 'issued'
      ? { ...latest, infringement: fresh, infringementHistory: [...(latest.infringementHistory ?? []), { ...cur, status: 'voided' }] }
      : { ...latest, infringementHistory: [...(latest.infringementHistory ?? []), fresh] };
  await saveScan(next);
  requestSync(100);
  return next;
}

/** Void without a reissue: request it; a supervisor decides in CommandMAPS. */
export async function requestVoid(scan: ScanRecord, reason: VoidReason, note: string): Promise<ScanRecord> {
  const cur = scan.infringement;
  if (!cur || cur.status !== 'issued') throw new Error('Only an issued infringement can be voided.');
  const next: ScanRecord = { ...scan, infringement: { ...cur, status: 'void_requested', voidRequest: { reason, ...(note.trim() ? { note: note.trim() } : {}), requestedAt: Date.now() } } };
  await saveScan(next);
  await enqueue('voidRequest', cur.number);
  requestSync(100);
  return next;
}

export async function paymentLookup(plate: string, at: number, ref?: string): Promise<{ source: string; sourceRef: string; paidFrom: number; paidTo: number } | null> {
  const q = new URLSearchParams({ plate, at: String(at), ...(ref ? { ref } : {}) });
  return (await request<{ session: { source: string; sourceRef: string; paidFrom: number; paidTo: number } | null }>('GET', `/api/payments/lookup?${q}`, { timeoutMs: 6000 })).session;
}

/** Install the development host when a backend is configured and EnforcementMAPS is absent. */
export function installBackend(getSettings: () => Settings): void {
  settingsRef = getSettings;
  if (typeof window === 'undefined') return;
  const configured = isConfigured();
  setState({ configured });
  void getKv<number>(LAST_KEY()).then((lastSyncAt) => lastSyncAt && setState({ lastSyncAt }));
  void getKv<BackendState['device']>(DEVICE_KEY()).then((device) => {
    if (!device) return;
    setState({ device });
    if (device.hotAckSeconds) setAckSeconds(device.hotAckSeconds);
  });
  void countOutbox().then((pending) => setState({ pending }));
  if (installed || window.EnforcementMAPS) return;
  installed = true;
  const devHost: EnforcementMapsHost = {
    get officerNumber() {
      return isConfigured() ? settingsRef().officerNumber : undefined;
    },
    async reportHotHit(hit: HotHitPayload) {
      if (!isConfigured()) throw new Error('No backend configured.');
      await request('POST', '/api/hot-hits', { json: { hit }, timeoutMs: 8000 });
      if (hit.scanId) await enqueue('evidence', hit.scanId);
    },
    async reportHotHitResponse(hit, answer) {
      if (!isConfigured()) throw new Error('No backend configured.');
      await request('POST', `/api/hot-hits/${encodeURIComponent(hit.id)}/response`, { json: { ...answer, hit }, timeoutMs: 8000 });
    },
    async raiseSoftCode1(args) {
      if (!isConfigured()) throw new Error('No backend configured.');
      return request<{ id: string | null }>('POST', '/api/alerts/soft-code1', { json: args, timeoutMs: 10_000 });
    },
    async raiseCode1(args) {
      if (!isConfigured()) throw new Error('No backend configured.');
      return request<{ id: string }>('POST', '/api/code1', { json: args, headers: officerHeader(args.officerNumber), timeoutMs: 10_000 });
    },
    async code1Location(id, location, officer) {
      await request('POST', `/api/code1/${encodeURIComponent(id)}/location`, { json: location, headers: officerHeader(officer), timeoutMs: 8000 });
    },
    async cancelCode1(id, reason, officer) {
      await request('POST', `/api/code1/${encodeURIComponent(id)}/cancel`, { json: { reason }, headers: officerHeader(officer), timeoutMs: 8000 });
    },
    async liveAlerts() {
      return request<{ own: LiveAlert[]; branch_code1: LiveAlert[] }>('GET', '/api/alerts/live', { timeoutMs: 6000 });
    },
    async receiveCode1(id) {
      await request('POST', `/api/alerts/${encodeURIComponent(id)}/receipt`, { json: {}, timeoutMs: 6000 });
    },
    async hotProfile(plate, entryId) {
      return request<HotProfile>('GET', `/api/hot-profile?${new URLSearchParams({ plate, entryId })}`, { timeoutMs: 8000 });
    },
    async startInfringement(handoff: InfringementHandoff) {
      if (!isConfigured()) throw new Error('No backend configured.');
      const scanId = String((handoff.sighting as { scanId?: string } | undefined)?.scanId ?? '');
      return (await runWizard({ handoff, scanId })).result;
    },
  };
  // Only expose the capabilities while a backend is configured (IR-3 otherwise).
  // A real host assigned later replaces the development host.
  Object.defineProperty(window, 'EnforcementMAPS', {
    configurable: true,
    get: () => (isConfigured() ? devHost : undefined),
    set: (real: EnforcementMapsHost | undefined) => Object.defineProperty(window, 'EnforcementMAPS', { configurable: true, writable: true, value: real }),
  });
}

export function backendSettingsChanged(): void {
  setState({ configured: isConfigured(), device: undefined, lastSyncAt: undefined, lastError: undefined });
  // Show this server's registration (none yet for a new server: the next sync registers).
  void getKv<BackendState['device']>(DEVICE_KEY()).then((device) => device && setState({ device }));
  void getKv<number>(LAST_KEY()).then((lastSyncAt) => lastSyncAt && setState({ lastSyncAt }));
  if (isConfigured()) void syncNow();
}

/** Start the background loop (every 30 s, when back online, and when the app is shown). */
export function startSyncLoop(): void {
  if (typeof window === 'undefined') return;
  setState({ configured: isConfigured() });
  setInterval(() => void syncNow(), 30_000);
  window.addEventListener('online', () => void syncNow());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void syncNow());
  void syncNow();
}
