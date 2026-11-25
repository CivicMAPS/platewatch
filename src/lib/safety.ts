/**
 * Officer-safety state machine on the handset (owner direction 25/11/2026; see hotlist.ts).
 *
 * pending hit ──(officer)──▶ SAFE & CLEAR │ CODE 1
 *     └─ deadline passes ──▶ soft Code 1 raised by the handset (retried); the pop-up stays until answered
 * own Code 1 ──▶ sent (retried) ──▶ location shared every 10 s ──▶ cleared / cancelled (from the live feed)
 * branch Code 1 (another officer) ──▶ alarm (sound + vibration) until RECEIVED, banner until cleared
 *
 * The pending hit and an own Code 1 are kept in IndexedDB, so a reload or a restart shows the
 * pop-up again: the officer cannot get past it without answering.
 */
import { getKv, putHotEvent, putKv, uid } from './db';
import { feedback } from './feedback';
import { geo } from './geo';
import { hitEvent, hitPayload, responseEvent } from './hotlist';
import { host, officerNumber, type HotProfile, type LiveAlert } from './host';
import type { GeoFix, HotEntry, HotHitPayload, HotHitResponse, HotList, HotListEvent, Settings } from './types';

export interface PendingHit {
  hit: HotHitPayload;
  hotListId: string;
  key: string;
  listName: string;
  notes: string;
}

type SendState = { status: 'sending' | 'sent' | 'failed' | 'unavailable'; at: number; id?: string | null; error?: string };

export interface SafetyState {
  pending: { hits: PendingHit[]; openedAt: number; deadline: number; softCode1?: SendState } | null;
  /** `cancelRequested`: the officer cancelled before the raise was confirmed; reconciled with the host. */
  code1: ({ id: string; cause: string; hit?: HotHitPayload; raisedAt: number; cancelRequested?: string } & SendState) | null;
  own: LiveAlert[];
  branch: LiveAlert[];
  lastLiveAt?: number;
}

const KV = 'safety';
/** Seconds the officer has to answer the pop-up (owner: "a set time frame"; backend can override). */
export const DEFAULT_ACK_SECONDS = 60;

let state: SafetyState = { pending: null, code1: null, own: [], branch: [] };
let ackSeconds = DEFAULT_ACK_SECONDS;
let settingsRef: () => Pick<Settings, 'officerNumber' | 'vibrate' | 'sound'> = () => ({ officerNumber: '', vibrate: true, sound: true });
let resolveAck: ((events: HotListEvent[]) => void) | null = null;
const listeners = new Set<() => void>();
let started = false;

export function safetyState(): SafetyState {
  return state;
}
export function onSafetyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function set(patch: Partial<SafetyState>, persist = true): void {
  state = { ...state, ...patch };
  if (persist) void putKv(KV, { pending: state.pending, code1: state.code1 }).catch(() => undefined);
  for (const fn of listeners) fn();
}

/** The officer: the EnforcementMAPS sign-in first, else the development build's Settings number. */
export function currentOfficer(): string {
  return officerNumber(settingsRef().officerNumber ?? '');
}

export function setAckSeconds(s: number): void {
  if (Number.isFinite(s) && s >= 10) ackSeconds = Math.round(s);
}
export function ackSecondsNow(): number {
  return ackSeconds;
}

const fixToLoc = (f: GeoFix | null): HotHitPayload['location'] => (f ? { lat: f.latitude, lng: f.longitude, accuracyM: f.accuracy } : null);
const freshLocation = (fallback: HotHitPayload['location']) => fixToLoc(geo.bestRecent(Date.now())) ?? fallback;

/** Load what was open before a reload and start the timers. */
export async function startSafety(getSettings: typeof settingsRef): Promise<void> {
  settingsRef = getSettings;
  if (started) return;
  started = true;
  const saved = await getKv<Pick<SafetyState, 'pending' | 'code1'>>(KV).catch(() => undefined);
  if (saved) set({ pending: saved.pending ?? null, code1: saved.code1 ?? null }, false);
  if (typeof window === 'undefined') return;
  setInterval(tick, 1000);
  setInterval(() => void pollLive(), 5000);
  setInterval(() => void shareCode1Location(), 10_000);
  void pollLive();
}

/**
 * Open the pop-up for the exact hot-list hits of one scan. Resolves with the acknowledgement events
 * once the officer answers (not if the app is reloaded first: the pop-up is restored, unresolved).
 */
export async function openHotAlert(args: {
  hits: { list: HotList; entry: HotEntry; scanId: string | null }[];
  at: number;
  location: HotHitPayload['location'];
  where?: HotHitPayload['where'];
}): Promise<HotListEvent[]> {
  const officer = currentOfficer();
  const pending: PendingHit[] = args.hits.map((h) => ({
    hit: hitPayload({ id: uid(), list: h.list, entry: h.entry, scanId: h.scanId, at: args.at, ackSeconds, officerNumber: officer, location: args.location, where: args.where }),
    hotListId: h.list.id, key: h.entry.key, listName: h.list.name, notes: h.entry.notes,
  }));
  // The pop-up first (synchronously), then the log and the report.
  const answered = new Promise<HotListEvent[]>((resolve) => (resolveAck = resolve));
  set({ pending: { hits: pending, openedAt: args.at, deadline: args.at + ackSeconds * 1000 } });
  args.hits.forEach((h, i) => {
    const hit = pending[i]!.hit;
    void putHotEvent(hitEvent({ id: uid(), list: h.list, entry: h.entry, hit, device: navigator.userAgent })).catch(() => undefined);
    void host()?.reportHotHit?.(hit).catch(() => undefined);
  });
  return answered;
}

/** The officer answered the pop-up. */
export async function respond(response: HotHitResponse, note: string, officerOverride?: string): Promise<HotListEvent[]> {
  const p = state.pending;
  if (!p) return [];
  const at = Date.now();
  const officer = officerOverride?.trim() || currentOfficer() || 'unknown';
  const location = freshLocation(p.hits[0]?.hit.location ?? null);
  const events: HotListEvent[] = [];
  for (const h of p.hits) {
    const e = responseEvent({ id: uid(), hit: { ...h.hit, officerNumber: officer || h.hit.officerNumber }, hotListId: h.hotListId, key: h.key, response, note, at, officerNumber: officer, location, device: navigator.userAgent });
    await putHotEvent(e);
    events.push(e);
  }
  set({ pending: null });
  const first = p.hits[0]?.hit;
  if (response === 'code1') await raiseCode1({ cause: 'hot_list_code1', ...(first ? { hit: { ...first, officerNumber: officer } } : {}) });
  resolveAck?.(events);
  resolveAck = null;
  return events;
}

function tick(now = Date.now()): void {
  const p = state.pending;
  if (!p) return;
  if (now < p.deadline) return;
  const s = p.softCode1;
  if (!s || (s.status === 'failed' && now - s.at >= 10_000)) void pushSoftCode1();
}

async function pushSoftCode1(): Promise<void> {
  const p = state.pending;
  const first = p?.hits[0];
  if (!p || !first) return;
  const raise = host()?.raiseSoftCode1;
  if (!raise) return set({ pending: { ...p, softCode1: { status: 'unavailable', at: Date.now() } } });
  set({ pending: { ...p, softCode1: { status: 'sending', at: Date.now() } } });
  feedback('alarm', settingsRef());
  try {
    const out = await raise({ hit: first.hit, at: Date.now(), location: freshLocation(first.hit.location) });
    if (state.pending) set({ pending: { ...state.pending, softCode1: { status: 'sent', at: Date.now(), id: out.id } } });
  } catch (e) {
    if (state.pending) set({ pending: { ...state.pending, softCode1: { status: 'failed', at: Date.now(), error: (e as Error).message } } });
  }
}

/** Code 1 (duress). Kept and retried until the host accepts it. */
export async function raiseCode1(args: { cause: string; hit?: HotHitPayload }): Promise<void> {
  const raisedAt = Date.now();
  set({ code1: { id: uid(), cause: args.cause, ...(args.hit ? { hit: args.hit } : {}), raisedAt, status: 'sending', at: raisedAt } });
  geo.start();
  await sendCode1();
}

/** Raise requests still waiting for the host's answer (never two at once for one Code 1). */
const inFlight = new Set<string>();

async function sendCode1(): Promise<void> {
  const c = state.code1;
  if (!c || c.status === 'sent' || inFlight.has(c.id)) return;
  if (c.cancelRequested) return reconcileCancel();
  const raise = host()?.raiseCode1;
  if (!raise) return set({ code1: { ...c, status: 'unavailable', at: Date.now() } });
  inFlight.add(c.id);
  try {
    await raise({ id: c.id, ...(c.hit ? { hit: c.hit } : {}), cause: c.cause, at: c.raisedAt, location: freshLocation(c.hit?.location ?? null) });
    if (state.code1?.id === c.id) set({ code1: { ...state.code1, status: 'sent', at: Date.now() } });
  } catch (e) {
    if (state.code1?.id === c.id) set({ code1: { ...state.code1, status: 'failed', at: Date.now(), error: (e as Error).message } });
  } finally {
    inFlight.delete(c.id);
  }
  // Cancelled while the raise was in flight: the host may now hold it, so cancel it there.
  if (state.code1?.id === c.id && state.code1.cancelRequested) await reconcileCancel();
}

/**
 * The officer cancelled a Code 1 raised in error. When the raise was confirmed, cancel at the host.
 * When it was not (sending, or failed after a timeout the host may still have accepted), keep the
 * Code 1 with `cancelRequested`, stop raising it, and cancel at the host once no raise is in flight;
 * "not found" there means it never arrived. Without a host there is nothing to cancel remotely.
 */
export async function cancelCode1(reason: string): Promise<void> {
  const c = state.code1;
  if (!c) return;
  if (c.status === 'unavailable' || !host()?.cancelCode1) return set({ code1: null });
  set({ code1: { ...c, cancelRequested: reason || 'raised in error' } });
  await reconcileCancel();
}

async function reconcileCancel(): Promise<void> {
  const c = state.code1;
  if (!c?.cancelRequested || inFlight.has(c.id)) return;
  const cancel = host()?.cancelCode1;
  if (!cancel) return set({ code1: null });
  try {
    await cancel(c.id, c.cancelRequested);
  } catch (e) {
    if ((e as { status?: number }).status !== 404) return; // keep it and retry with the 10 s loop
  }
  if (state.code1?.id === c.id) set({ code1: null });
}

/** Open Code 1s about this officer that the handset did not raise (dispatch escalated a soft Code 1). */
export function escalatedCode1(): LiveAlert[] {
  return state.own.filter((a) => a.kind === 'code1' && OPEN.has(a.status) && a.id !== state.code1?.id);
}

async function shareCode1Location(): Promise<void> {
  const c = state.code1;
  if (c?.cancelRequested) void reconcileCancel();
  else if (c && (c.status === 'failed' || c.status === 'sending')) void sendCode1();
  const ids = [...(c?.status === 'sent' && !c.cancelRequested ? [c.id] : []), ...escalatedCode1().map((a) => a.id)];
  if (!ids.length) return;
  geo.start();
  const loc = fixToLoc(geo.bestRecent(Date.now()));
  if (!loc) return;
  for (const id of ids) await host()?.code1Location?.(id, { ...loc, at: Date.now() }).catch(() => undefined);
}

const OPEN = new Set(['active', 'radio_requested', 'acknowledged']);
let alarmTimer: ReturnType<typeof setInterval> | null = null;

async function pollLive(): Promise<void> {
  const live = host()?.liveAlerts;
  if (!live) return;
  try {
    const out = await live();
    const patch: Partial<SafetyState> = { own: out.own, branch: out.branch_code1, lastLiveAt: Date.now() };
    const mine = state.code1 && out.own.find((a) => a.id === state.code1!.id);
    if (mine && !OPEN.has(mine.status)) patch.code1 = null;
    set(patch, !!('code1' in patch));
    syncAlarm();
  } catch {
    /* offline: keep the last state */
  }
}

/** Branch Code 1 not yet received: repeat the alarm until the officer presses RECEIVED. */
function syncAlarm(): void {
  const ringing = state.branch.some((a) => OPEN.has(a.status) && !a.received);
  if (ringing && !alarmTimer) {
    feedback('alarm', { vibrate: true, sound: true });
    alarmTimer = setInterval(() => feedback('alarm', { vibrate: true, sound: true }), 2500);
  } else if (!ringing && alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
  }
}

export async function receiveCode1(id: string): Promise<void> {
  set({ branch: state.branch.map((a) => (a.id === id ? { ...a, received: true } : a)) }, false);
  syncAlarm();
  await host()?.receiveCode1?.(id).catch(() => undefined);
}

export async function hotProfile(plate: string, entryId: string): Promise<HotProfile | null> {
  const get = host()?.hotProfile;
  if (!get) return null;
  try {
    return await get(plate, entryId);
  } catch {
    return null;
  }
}

/** Test hooks. */
export async function checkDeadline(now: number): Promise<void> {
  tick(now);
  await new Promise((r) => setTimeout(r, 0));
}
export function resetSafety(): void {
  state = { pending: null, code1: null, own: [], branch: [] };
  resolveAck = null;
}
