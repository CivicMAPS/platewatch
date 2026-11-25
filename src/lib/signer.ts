/**
 * The handset's I-N signer (development host): one non-exportable ECDSA P-256 key per device,
 * kept in IndexedDB, a hash chain over every statement it signs, and the per-officer daily pools.
 * Allocation works offline; the backend verifies when the statements arrive (`docs/BACKEND.md`).
 */
import { getKv, putKv, putKvsAndQueue } from './db';
import { allocate, generateSigningKey, GENESIS_HASH, type AllocationStatement, type IssueStatement, signStatement, sha256Hex, canonical } from './inNumber';
import { toLocalIso } from './time';
import type { IssueBundle, IssuedRecord } from './types';

interface StoredKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  keyId: string;
  createdAt: number;
}

interface ChainState {
  keyId: string;
  prevHash: string;
  /** `${officer}|${YYMMDD}` → last sequence used. */
  pools: Record<string, number>;
}

/** A bundle as kept on the device until the backend accepts it. */
export interface StoredBundle extends IssueBundle {
  number: string;
  scanId: string;
  createdAt: number;
}

/**
 * Signing key and chain belong to the backend that accepts the chain: a fresh backend never saw
 * this key's earlier statements, so continuing the chain there would be refused as a chain break.
 * The scope is set by the backend module (the backend URL); '' (no backend) keeps the plain names.
 */
let scope: () => string = () => '';
export function setSigningScope(fn: () => string): void {
  scope = fn;
}
const scoped = (name: string) => (scope() ? `${name}:${scope()}` : name);
const KEY = () => scoped('signingKey');
const CHAIN = () => scoped('inChain');
const bundleKey = (n: string) => `inBundle:${n}`;

interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive'; ifAvailable?: boolean }, fn: (lock: unknown) => Promise<T>): Promise<T>;
}

const lockManager = (): LockManagerLike | undefined => (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;

/**
 * Run `fn` holding a lock shared by every tab and the installed PWA of this origin (Web Locks).
 * They share the IndexedDB key and chain, so two contexts must never read the same chain head and
 * sign two statements onto it. Where Web Locks are unavailable, the in-page lock is all there is.
 */
function crossContext<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  return locks ? locks.request(name, { mode: 'exclusive' }, () => fn()) : fn();
}

let lock: Promise<unknown> = Promise.resolve();
/** Serialise everything that reads and advances the chain (in this page and across contexts). */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const guarded = () => crossContext('platewatch-signer', fn);
  const run = lock.then(guarded, guarded);
  lock = run.catch(() => undefined);
  return run;
}

/** First use of a scope: one key, however many callers ask at once (else two keys race). */
const creating = new Map<string, Promise<StoredKey>>();

export function deviceKey(): Promise<StoredKey> {
  const key = KEY();
  const pending = creating.get(key);
  if (pending) return pending;
  const p = crossContext(`platewatch-key:${key}`, async () => {
    const existing = await getKv<StoredKey>(key);
    if (existing?.privateKey) return existing;
    const k = await generateSigningKey();
    const stored: StoredKey = { ...k, createdAt: Date.now() };
    await putKv(key, stored);
    return stored;
  });
  creating.set(key, p);
  void p.finally(() => creating.delete(key)).catch(() => undefined);
  return p;
}

async function chain(keyId: string): Promise<ChainState> {
  const c = await getKv<ChainState>(CHAIN());
  return c && c.keyId === keyId ? c : { keyId, prevHash: GENESIS_HASH, pools: {} };
}

export async function getBundle(number: string): Promise<StoredBundle | undefined> {
  return getKv<StoredBundle>(bundleKey(number));
}

/** The new chain head, the signed bundle and its outbox row: one transaction (never a chain gap). */
async function commit(chainState: ChainState, b: StoredBundle): Promise<void> {
  await putKvsAndQueue([[CHAIN(), chainState], [bundleKey(b.number), b]], { kind: 'infringement', id: b.number });
}

const poolKey = (officer: string, day: string) => `${officer.padStart(5, '0')}|${day}`;

/**
 * Raise the daily pools to what the backend has already accepted for this officer (a replacement
 * or second handset the same day must continue the officer's sequence, not restart at 001).
 */
export function raisePoolFloors(officer: string, pools: readonly { day: string; lastSequence: number }[]): Promise<void> {
  return exclusive(async () => {
    const k = await deviceKey();
    const c = await chain(k.keyId);
    let changed = false;
    const next = { ...c.pools };
    for (const p of pools) {
      const key = poolKey(officer, p.day);
      if ((next[key] ?? 0) < p.lastSequence) {
        next[key] = p.lastSequence;
        changed = true;
      }
    }
    if (changed) await putKv(CHAIN(), { ...c, pools: next } satisfies ChainState);
  });
}

/** Allocate the next number for `officer` today. Queued for the backend at once (no chain gaps). */
export function allocateNumber(args: { officer: string; council: string; scanId: string; now?: number }): Promise<StoredBundle> {
  return exclusive(async () => {
    const k = await deviceKey();
    const c = await chain(k.keyId);
    const now = args.now ?? Date.now();
    const d = new Date(now);
    const day = `${String(d.getFullYear() % 100).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const pool = poolKey(args.officer, day);
    const sequence = (c.pools[pool] ?? 0) + 1;
    const { number, allocation } = await allocate({ privateKey: k.privateKey, keyId: k.keyId, council: args.council, officer: args.officer, sequence, prevHash: c.prevHash, now, timestamp: toLocalIso(now) });
    const b: StoredBundle = { number, scanId: args.scanId, keyId: k.keyId, allocation: allocation as unknown as IssueBundle['allocation'], createdAt: now };
    await commit({ ...c, prevHash: allocation.hash, pools: { ...c.pools, [pool]: sequence } }, b);
    return b;
  });
}

/** Sign the issue statement over the record, or a cancel statement (the number is consumed). */
export function closeNumber(number: string, record: IssuedRecord | null, now = Date.now()): Promise<StoredBundle> {
  return exclusive(async () => {
    const b = await getBundle(number);
    if (!b) throw new Error(`No allocation on this device for ${number}.`);
    if (b.closing) {
      // Already closed. Issuing a number that was cancelled meanwhile (recovered as abandoned) must
      // fail loudly: the wizard would otherwise report an issue that was never signed.
      if (record && (b.closing.statement as { type?: string }).type !== 'issue') throw new Error(`${number} was already cancelled as left open; start the infringement again for a new number.`);
      return b;
    }
    const k = await deviceKey();
    // Allocated under another backend's key: only that key (and that backend) can close it.
    if (b.keyId !== k.keyId) throw new Error(`${number} was allocated for another backend; switch back to it to close the number.`);
    const c = await chain(k.keyId);
    const statement: IssueStatement = {
      v: 1,
      type: record ? 'issue' : 'cancel',
      number,
      keyId: k.keyId,
      allocationHash: b.allocation.hash,
      ...(record ? { recordHash: await sha256Hex(canonical(record)) } : {}),
      timestamp: toLocalIso(now),
      prevHash: c.prevHash,
    };
    const closing = await signStatement(k.privateKey, statement);
    const next: StoredBundle = { ...b, closing: closing as unknown as IssueBundle['closing'], ...(record ? { record } : {}) };
    await commit({ ...c, prevHash: closing.hash }, next);
    return next;
  });
}

/**
 * Open wizards. A number allocated but never issued or cancelled (app closed mid-wizard) is
 * recovered with a signed cancel; a number whose wizard is still open, in this page or in another
 * tab or the installed PWA, must not be. An open wizard holds a Web Lock on its number, released when
 * it closes (or when its page goes away), and recovery only proceeds if it can take that lock.
 */
const openWizards = new Set<string>();
const wizardLock = (n: string) => `platewatch-wizard:${n}`;

/** Hold `n` open until the returned release is called. Resolves once the hold is in place. */
export function holdWizard(n: string): Promise<() => void> {
  openWizards.add(n);
  const done = () => openWizards.delete(n);
  const locks = lockManager();
  if (!locks) return Promise.resolve(() => void done());
  return new Promise((granted) => {
    void locks.request(wizardLock(n), { mode: 'exclusive' }, () => new Promise<void>((release) => granted(() => { done(); release(); })));
  });
}

export function isWizardOpen(n: string): boolean {
  return openWizards.has(n);
}

/** Run `recover` for `n` only if no wizard holds it anywhere. True when it ran. */
export async function ifAbandoned(n: string, recover: () => Promise<unknown>): Promise<boolean> {
  if (openWizards.has(n)) return false;
  const locks = lockManager();
  if (!locks) return (await recover(), true);
  return locks.request(wizardLock(n), { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await recover();
    return true;
  });
}

export type { AllocationStatement };
