import { describe, expect, it } from 'vitest';
import { applyDismissal, confirmFlag, disabilityBlocked, DISMISS_REASONS, FLAG_MESSAGE } from '../src/lib/dismissal';
import { disabilityDoubles, evaluate, newObservation } from '../src/lib/engine';
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

describe('disability permit: twice the allowance', () => {
  // 2P first seen 09:00; overstay at 11:30. With a permit the allowance is 4P (ends 13:00).
  const dismissed = applyDismissal({ scan, observation: obs, reason: 'disability_permit', at: MON_1130 });
  const flag = dismissed.flag!;

  it('re-times the vehicle against 2 × the allowance instead of closing the timing', () => {
    expect(dismissed.observation).toMatchObject({ status: 'active', limitMinutes: 240, allowanceEndsAt: at(2026, 11, 16, 13, 0), concession: { kind: 'disability', baseLimitMinutes: 120 } });
    expect(dismissed.scan.alertDismissal?.reason).toBe('disability_permit');
    expect(flag).toMatchObject({ kind: 'disability', confirmedDay: '2026-11-16' });
  });

  it('same day: re-sightings are timed against 4P — within at 12:30, overstay at 13:10', () => {
    const within = evaluate({ ...base, observations: [dismissed.observation], flags: [flag], at: at(2026, 11, 16, 12, 30), plate: 'ABC123' }).decision;
    expect(within).toMatchObject({ kind: 'timed_resighting', overstay: false });
    const over = evaluate({ ...base, observations: [dismissed.observation], flags: [flag], at: at(2026, 11, 16, 13, 10), plate: 'ABC123' }).decision;
    expect(over).toMatchObject({ kind: 'timed_resighting', overstay: true });
  });

  it('refuses the disability reason when the vehicle is over even twice the allowance', () => {
    expect(disabilityBlocked(obs, MON_1130)).toBeNull();
    expect(disabilityBlocked(obs, at(2026, 11, 16, 13, 30))).toBe('over_double');
    expect(disabilityBlocked(dismissed.observation, at(2026, 11, 16, 13, 30))).toBe('over_double');
  });

  it('applies the prescribed time in disability-only spaces, and nothing in statutory ones', () => {
    expect(disabilityBlocked({ ...obs, restrictionCode: '2P' }, MON_1130, 'Disabled permit holders only')).toBe('disability_only');
    expect(disabilityBlocked({ ...obs, restrictionCode: 'LZ30' }, MON_1130)).toBe('not_eligible');
    expect(disabilityDoubles('2P Meter')).toBe(true);
    expect(disabilityDoubles('2P DIS')).toBe(false);
    expect(disabilityDoubles('NSEGCV 15')).toBe(false);
  });

  it('next day: Confirmed times a new sighting against 2 × the allowance; Dismiss times it as signed', () => {
    const d = evaluate({ ...base, observations: [], flags: [flag], at: at(2026, 11, 17, 9, 0), plate: 'ABC123' }).decision;
    expect(d).toMatchObject({ kind: 'timed_flag_check', then: { kind: 'timed_new' }, confirmed: { kind: 'timed_new', concession: 'disability' } });
    if (d.kind !== 'timed_flag_check' || d.confirmed.kind !== 'timed_new') return;
    const o = newObservation({ id: 'o2', list, plate: 'ABC123', scanId: 's3', at: at(2026, 11, 17, 9, 0), instance: d.confirmed.instance, concession: 'disability' });
    expect(o).toMatchObject({ limitMinutes: 240, allowanceEndsAt: at(2026, 11, 17, 13, 0) });
  });

  it('confirmed today: later scans need no check and stay on 2 ×', () => {
    const kept = confirmFlag(flag, at(2026, 11, 17, 9, 0));
    const d = evaluate({ ...base, observations: [], flags: [kept], at: at(2026, 11, 17, 15, 0), plate: 'ABC123' }).decision;
    expect(d).toMatchObject({ kind: 'timed_new', concession: 'disability' });
  });

  it('a running timing for a confirmed vehicle is doubled on re-sighting', () => {
    const kept = confirmFlag(flag, at(2026, 11, 17, 9, 0));
    const running: Observation = { ...obs, startedAt: at(2026, 11, 17, 9, 0), allowanceEndsAt: at(2026, 11, 17, 11, 0), windowEndsAt: at(2026, 11, 17, 18, 0) };
    const d = evaluate({ ...base, observations: [running], flags: [kept], at: at(2026, 11, 17, 11, 30), plate: 'ABC123' }).decision;
    expect(d).toMatchObject({ kind: 'timed_resighting', overstay: false, observation: { limitMinutes: 240 } });
  });
});

describe('emergency vehicle and displayed permit: timing closed', () => {
  const dismissed = applyDismissal({ scan, observation: obs, reason: 'emergency_vehicle', at: MON_1130 });
  const flag = dismissed.flag!;

  it('same day: no further alert, recorded without a timer', () => {
    const d = evaluate({ ...base, observations: [dismissed.observation], flags: [flag], at: at(2026, 11, 16, 14, 0), plate: 'ABC123' }).decision;
    expect(d.kind).toBe('timed_dismissed');
  });

  it('next day: the check pop-up; Confirmed is recorded without a timer', () => {
    const d = evaluate({ ...base, observations: [dismissed.observation], flags: [flag], at: at(2026, 11, 17, 9, 0), plate: 'ABC123' }).decision;
    expect(d).toMatchObject({ kind: 'timed_flag_check', flag: { kind: 'emergency' }, then: { kind: 'timed_new' }, confirmed: { kind: 'timed_flag_exempt' } });
    expect(FLAG_MESSAGE.emergency).toMatch(/emergency services vehicle — check vehicle/);
    const kept = confirmFlag(flag, at(2026, 11, 17, 9, 0));
    expect(evaluate({ ...base, observations: [], flags: [kept], at: at(2026, 11, 17, 15, 0), plate: 'ABC123' }).decision.kind).toBe('timed_flag_exempt');
    expect(evaluate({ ...base, observations: [], flags: [kept], at: at(2026, 11, 18, 9, 0), plate: 'ABC123' }).decision.kind).toBe('timed_flag_check');
  });

  it('dismissed (tag removed): timed as usual', () => {
    expect(evaluate({ ...base, observations: [], flags: [], at: at(2026, 11, 17, 9, 0), plate: 'ABC123' }).decision.kind).toBe('timed_new');
  });
});
