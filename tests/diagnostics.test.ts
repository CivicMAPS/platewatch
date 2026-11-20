import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDiagnostics,
  configureDiagnostics,
  countDiagnostics,
  diagnosticsExport,
  logDiag,
  MAX_EVENTS,
  pruneDiagnostics,
} from '../src/lib/diagnostics';

beforeEach(async () => {
  configureDiagnostics(true);
  await clearDiagnostics();
});

describe('field diagnostics', () => {
  it('records events while enabled', async () => {
    await logDiag('capture', { surface: 'default', plate: 'ABC123' });
    await logDiag('record', { ocrPlate: 'ABC12', plate: 'ABC123', corrected: true });
    expect(await countDiagnostics()).toBe(2);
  });

  it('records nothing while disabled', async () => {
    configureDiagnostics(false);
    await logDiag('capture', { surface: 'default' });
    expect(await countDiagnostics()).toBe(0);
  });

  it('exports events in order with a timestamp and the app version', async () => {
    await logDiag('patrol_start', { mode: 'vehicle' });
    await logDiag('sighting', { plate: 'XYZ789' });
    const out = JSON.parse(await (await diagnosticsExport('1.2.3')).text());
    expect(out.appVersion).toBe('1.2.3');
    expect(out.events.map((e: { kind: string }) => e.kind)).toEqual(['patrol_start', 'sighting']);
    expect(typeof out.events[0].t).toBe('number');
    expect(out.events[1].plate).toBe('XYZ789');
  });

  it('keeps only the newest events once the cap is passed', async () => {
    for (let i = 0; i < 5; i++) await logDiag('sample', { i });
    await pruneDiagnostics(3);
    const out = JSON.parse(await (await diagnosticsExport('x')).text());
    expect(out.events.map((e: { i: number }) => e.i)).toEqual([2, 3, 4]);
    expect(MAX_EVENTS).toBeGreaterThan(1000);
  });

  it('clears all events', async () => {
    await logDiag('sample', {});
    await clearDiagnostics();
    expect(await countDiagnostics()).toBe(0);
  });
});
