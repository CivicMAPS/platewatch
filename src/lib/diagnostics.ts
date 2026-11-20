/**
 * Field diagnostics: an on-device event log for development field tests.
 *
 * Records camera, recognition, location and power measurements so a field test produces numbers
 * (read rate, OCR accuracy, fix accuracy and age, battery drain, thermal status) instead of
 * impressions. Kept in its own IndexedDB database so the evidence database schema is untouched.
 * Nothing leaves the device unless the officer exports the file from Settings.
 */
import { openDB, type IDBPDatabase } from 'idb';

export const MAX_EVENTS = 20_000;
const PRUNE_EVERY = 250;

export interface DiagEvent {
  id?: number;
  /** Epoch ms. */
  t: number;
  kind: string;
  [field: string]: unknown;
}

let enabled = false;
let writes = 0;
let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB('platewatch-diagnostics', 1, {
    upgrade(d) {
      d.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
    },
  });
  return dbPromise;
}

export function configureDiagnostics(on: boolean): void {
  enabled = on;
}

export function diagnosticsEnabled(): boolean {
  return enabled;
}

/** Record an event. Never throws: diagnostics must not break a capture. */
export async function logDiag(kind: string, data: Record<string, unknown> = {}): Promise<void> {
  if (!enabled) return;
  try {
    await (await db()).add('events', { ...data, t: Date.now(), kind });
    if (++writes % PRUNE_EVERY === 0) await pruneDiagnostics();
  } catch (e) {
    console.warn('[diagnostics]', e);
  }
}

export async function countDiagnostics(): Promise<number> {
  return (await db()).count('events');
}

/** Delete the oldest events beyond `max`. */
export async function pruneDiagnostics(max = MAX_EVENTS): Promise<void> {
  const d = await db();
  const excess = (await d.count('events')) - max;
  if (excess <= 0) return;
  const tx = d.transaction('events', 'readwrite');
  let cursor = await tx.store.openCursor();
  for (let i = 0; i < excess && cursor; i++) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function clearDiagnostics(): Promise<void> {
  await (await db()).clear('events');
}

export async function diagnosticsExport(appVersion: string): Promise<Blob> {
  const events = (await (await db()).getAll('events')) as DiagEvent[];
  const body = {
    schema: 'platewatch-diagnostics',
    version: 1,
    appVersion,
    exportedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    events: events.map(({ id: _id, ...e }) => e),
  };
  return new Blob([JSON.stringify(body, null, 1)], { type: 'application/json' });
}
