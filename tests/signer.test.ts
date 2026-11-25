import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A minimal Web Locks stand-in shared by both "tabs" (exclusive locks, queued per name, ifAvailable). */
function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const held = new Set<string>();
  return {
    request<T>(name: string, opts: { mode: 'exclusive'; ifAvailable?: boolean }, fn: (lock: unknown) => Promise<T>): Promise<T> {
      if (opts.ifAvailable && held.has(name)) return Promise.resolve().then(() => fn(null));
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(async () => {
        held.add(name);
        try {
          return await fn({ name });
        } finally {
          held.delete(name);
        }
      });
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

/** Two independent copies of the signer, as two tabs of the PWA would load, sharing IndexedDB. */
const openTabs: (() => Promise<void>)[] = [];
async function twoTabs() {
  vi.resetModules();
  const a = await import('../src/lib/signer');
  openTabs.push((await import('../src/lib/db')).closeDb);
  vi.resetModules();
  const b = await import('../src/lib/signer');
  openTabs.push((await import('../src/lib/db')).closeDb);
  return [a, b] as const;
}

describe('I-N signer across tabs sharing one device key', () => {
  beforeEach(async () => {
    await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('platewatch'); r.onsuccess = () => res(); r.onerror = () => res(); });
    Object.defineProperty(globalThis.navigator, 'locks', { value: fakeLocks(), configurable: true });
  });
  afterEach(async () => {
    delete (globalThis.navigator as { locks?: unknown }).locks;
    for (const close of openTabs.splice(0)) await close();
  });

  it('two tabs allocating at once chain one after the other (never the same head and sequence)', async () => {
    const [a, b] = await twoTabs();
    const [x, y] = await Promise.all([
      a.allocateNumber({ officer: '4471', council: 'com', scanId: 's1' }),
      b.allocateNumber({ officer: '4471', council: 'com', scanId: 's2' }),
    ]);
    expect(x.keyId).toBe(y.keyId); // one device key, created once
    const sx = x.allocation.statement as { sequence: number; prevHash: string };
    const sy = y.allocation.statement as { sequence: number; prevHash: string };
    expect([sx.sequence, sy.sequence].sort()).toEqual([1, 2]);
    const [first, second] = sx.sequence === 1 ? [x, y] : [y, x];
    expect((second.allocation.statement as { prevHash: string }).prevHash).toBe(first.allocation.hash);
  });

  it('a number whose wizard is open in another tab is not recovered; issuing a number cancelled meanwhile fails loudly', async () => {
    const [a, b] = await twoTabs();
    const n = await a.allocateNumber({ officer: '4471', council: 'com', scanId: 's1', now: Date.now() - 120_000 });
    const release = await a.holdWizard(n.number); // tab A: wizard open
    expect(await b.ifAbandoned(n.number, () => b.closeNumber(n.number, null))).toBe(false); // tab B's sync leaves it
    expect((await b.getBundle(n.number))?.closing).toBeUndefined();
    release(); // tab A closed the wizard without issuing (e.g. the page went away)
    await new Promise((r) => setTimeout(r, 0)); // locks are released asynchronously
    expect(await b.ifAbandoned(n.number, () => b.closeNumber(n.number, null))).toBe(true);
    expect((await b.getBundle(n.number))?.closing?.statement).toMatchObject({ type: 'cancel' });
    await expect(a.closeNumber(n.number, { number: n.number } as never)).rejects.toThrow(/already cancelled/);
  });

  it('pool floors fetched from one backend never raise another backend\'s chain', async () => {
    const [a] = await twoTabs();
    const d = new Date();
    const day = `${String(d.getFullYear() % 100).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    a.setSigningScope(() => 'https://b.example');
    await a.raisePoolFloors('4471', [{ day, lastSequence: 10 }], 'https://a.example'); // Settings changed mid-request
    expect(((await a.allocateNumber({ officer: '4471', council: 'com', scanId: 's1' })).allocation.statement as { sequence: number }).sequence).toBe(1);
    await a.raisePoolFloors('4471', [{ day, lastSequence: 10 }], 'https://b.example');
    expect(((await a.allocateNumber({ officer: '4471', council: 'com', scanId: 's2' })).allocation.statement as { sequence: number }).sequence).toBe(11);
  });
});
