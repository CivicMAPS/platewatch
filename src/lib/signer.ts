/**
 * The handset's I-N signer (development host): one non-exportable ECDSA P-256 key per device,
 * kept in IndexedDB, a hash chain over every statement it signs, and the per-officer daily pools.
 * Allocation works offline; the backend verifies when the statements arrive (`docs/BACKEND.md`).
 */
import { enqueue, getKv, putKv } from './db';
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

const KEY = 'signingKey';
const CHAIN = 'inChain';
const bundleKey = (n: string) => `inBundle:${n}`;

let lock: Promise<unknown> = Promise.resolve();
/** Serialise everything that reads and advances the chain. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

export async function deviceKey(): Promise<StoredKey> {
  const existing = await getKv<StoredKey>(KEY);
  if (existing?.privateKey) return existing;
  const k = await generateSigningKey();
  const stored: StoredKey = { ...k, createdAt: Date.now() };
  await putKv(KEY, stored);
  return stored;
}

async function chain(keyId: string): Promise<ChainState> {
  const c = await getKv<ChainState>(CHAIN);
  return c && c.keyId === keyId ? c : { keyId, prevHash: GENESIS_HASH, pools: {} };
}

export async function getBundle(number: string): Promise<StoredBundle | undefined> {
  return getKv<StoredBundle>(bundleKey(number));
}

async function saveBundle(b: StoredBundle): Promise<void> {
  await putKv(bundleKey(b.number), b);
  await enqueue('infringement', b.number);
}

/** Allocate the next number for `officer` today. Queued for the backend at once (no chain gaps). */
export function allocateNumber(args: { officer: string; council: string; scanId: string; now?: number }): Promise<StoredBundle> {
  return exclusive(async () => {
    const k = await deviceKey();
    const c = await chain(k.keyId);
    const now = args.now ?? Date.now();
    const d = new Date(now);
    const day = `${String(d.getFullYear() % 100).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const pool = `${args.officer.padStart(5, '0')}|${day}`;
    const sequence = (c.pools[pool] ?? 0) + 1;
    const { number, allocation } = await allocate({ privateKey: k.privateKey, keyId: k.keyId, council: args.council, officer: args.officer, sequence, prevHash: c.prevHash, now, timestamp: toLocalIso(now) });
    await putKv(CHAIN, { ...c, prevHash: allocation.hash, pools: { ...c.pools, [pool]: sequence } } satisfies ChainState);
    const b: StoredBundle = { number, scanId: args.scanId, keyId: k.keyId, allocation: allocation as unknown as IssueBundle['allocation'], createdAt: now };
    await saveBundle(b);
    return b;
  });
}

/** Sign the issue statement over the record, or a cancel statement (the number is consumed). */
export function closeNumber(number: string, record: IssuedRecord | null, now = Date.now()): Promise<StoredBundle> {
  return exclusive(async () => {
    const b = await getBundle(number);
    if (!b) throw new Error(`No allocation on this device for ${number}.`);
    if (b.closing) return b;
    const k = await deviceKey();
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
    await putKv(CHAIN, { ...c, prevHash: closing.hash } satisfies ChainState);
    const next: StoredBundle = { ...b, closing: closing as unknown as IssueBundle['closing'], ...(record ? { record } : {}) };
    await saveBundle(next);
    return next;
  });
}

/** Numbers allocated but never issued or cancelled (app closed mid-wizard). */
let openWizardNumber: string | null = null;
export function markWizardOpen(n: string | null): void {
  openWizardNumber = n;
}
export function isWizardOpen(n: string): boolean {
  return openWizardNumber === n;
}

export type { AllocationStatement };
