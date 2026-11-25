import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A minimal Web Locks stand-in shared by both "tabs" (exclusive locks, queued per name). */
function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, _opts: { mode: 'exclusive' }, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

/** Two independent copies of the signer, as two tabs of the PWA would load, sharing IndexedDB. */
async function twoTabs() {
  vi.resetModules();
  const a = await import('../src/lib/signer');
  vi.resetModules();
  const b = await import('../src/lib/signer');
  return [a, b] as const;
}

describe('I-N signer across tabs sharing one device key', () => {
  beforeEach(async () => {
    await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('platewatch'); r.onsuccess = () => res(); r.onerror = () => res(); });
    Object.defineProperty(globalThis.navigator, 'locks', { value: fakeLocks(), configurable: true });
  });
  afterEach(() => {
    delete (globalThis.navigator as { locks?: unknown }).locks;
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
});
