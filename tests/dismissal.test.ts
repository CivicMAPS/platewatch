import { describe, expect, it } from 'vitest';
import { applyDismissal, confirmFlag, DISMISS_REASONS, FLAG_MESSAGE } from '../src/lib/dismissal';
import { evaluate, newObservation } from '../src/lib/engine';
import type { Observation, ScanRecord } from '../src/lib/types';
import { at, r2P, timed } from './fixtures';

const list = timed({ allowListIds: [] });
const MON_0900 = at(2026, 11, 16, 9, 0);
const MON_1130 = at(2026, 11, 16, 11, 30);
const obs: Observation = newObservation({ id: 'o1', list, plate: 'ABC123', scanId: 's1', at: MON_0900, instance: { restriction: r2P(), start: at(2026, 11, 16, 8), end: at(2026, 11, 16, 18) } });
const scan = { id: 's2', plate: 'ABC123', outcome: 'overstay', meta: { capturedAt: MON_1130 } } as unknown as ScanRecord;
const base = { list, hotLists: [], allowLists: [] };

describe('dismissing an overstay alert', () => {
  it('offers the three reasons; only disability and emergency tag the plate', () => {
    expect(DISMISS_REASONS.map((r) => [r.reason, r.flag ?? null])).toEqual([
      ['disability_permit', 'disability'],
      ['emergency_vehicle', 'emergency'],
      ['permit_displayed', null],
    ]);
  });

  it('keeps the scan with the reason and closes the timing as dismissed', () => {
    const out = applyDismissal({ scan, observation: obs, reason: 'permit_displayed', at: MON_1130 + 5000 });
    expect(out.scan).toMatchObject({ outcome: 'overstay', alertDismissal: { reason: 'permit_displayed', at: MON_1130 + 5000 } });
    expect(out.observation).toMatchObject({ status: 'dismissed', dismissReason: 'permit_displayed', closedAt: MON_1130 + 5000 });
    expect(out.flag).toBeUndefined();
  });

  it('tags the plate on a disability or emergency dismissal, confirmed for the day of the scan', () => {
    const out = applyDismissal({ scan, observation: obs, reason: 'emergency_vehicle', at: MON_1130 });
    expect(out.flag).toEqual({ key: 'ABC123', plate: 'ABC123', kind: 'emergency', createdAt: MON_1130, sourceScanId: 's2', confirmedDay: '2026-11-16' });
  });
});

describe('the whole flow, day by day', () => {
  const dismissed = applyDismissal({ scan, observation: obs, reason: 'disability_permit', at: MON_1130 });
  const flag = dismissed.flag!;

  it('same day: no further alert, recorded without a timer', () => {
    const d = evaluate({ ...base, observations: [dismissed.observation], flags: [flag], at: at(2026, 11, 16, 14, 0), plate: 'ABC123' }).decision;
    expect(d.kind).toBe('timed_dismissed');
  });

  it('next day: the check pop-up, with normal timing behind it if not confirmed', () => {
    const d = evaluate({ ...base, observations: [dismissed.observation], flags: [flag], at: at(2026, 11, 17, 9, 0), plate: 'ABC123' }).decision;
    expect(d).toMatchObject({ kind: 'timed_flag_check', flag: { kind: 'disability' }, then: { kind: 'timed_new' } });
    expect(FLAG_MESSAGE.disability).toMatch(/check vehicle for displayed permit/);
  });

  it('confirmed: tag kept and later scans that day need no check', () => {
    const kept = confirmFlag(flag, at(2026, 11, 17, 9, 0));
    expect(kept.confirmedDay).toBe('2026-11-17');
    expect(evaluate({ ...base, observations: [], flags: [kept], at: at(2026, 11, 17, 15, 0), plate: 'ABC123' }).decision.kind).toBe('timed_flag_exempt');
    // and the day after that, the check again
    expect(evaluate({ ...base, observations: [], flags: [kept], at: at(2026, 11, 18, 9, 0), plate: 'ABC123' }).decision.kind).toBe('timed_flag_check');
  });

  it('dismissed (tag removed): timed as usual', () => {
    expect(evaluate({ ...base, observations: [], flags: [], at: at(2026, 11, 17, 9, 0), plate: 'ABC123' }).decision.kind).toBe('timed_new');
  });
});
