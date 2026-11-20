import { describe, expect, it } from 'vitest';
import { minutesFromCode, nextRestrictionStart, restrictionInForce, summariseDays, validateRestriction } from '../src/lib/restriction';
import { at, r2P } from './fixtures';

// 2026-11-16 is a Monday; 2026-11-21 Saturday.
describe('restriction codes', () => {
  it.each([
    ['2P', 120],
    ['1P', 60],
    ['1/2P', 30],
    ['1/4P', 15],
    ['P10', 10],
    ['4P', 240],
    ['XYZ', null],
  ])('%s → %s', (code, mins) => expect(minutesFromCode(code)).toBe(mins));
});

describe('restrictionInForce', () => {
  const list = { restrictions: [r2P()] };
  it('applies within hours on weekdays', () => {
    const inst = restrictionInForce(list, at(2026, 11, 16, 9, 30))!;
    expect(inst.restriction.code).toBe('2P');
    expect(inst.start).toBe(at(2026, 11, 16, 8));
    expect(inst.end).toBe(at(2026, 11, 16, 18));
  });
  it('is not in force before/after hours or on weekends', () => {
    expect(restrictionInForce(list, at(2026, 11, 16, 7, 59))).toBeNull();
    expect(restrictionInForce(list, at(2026, 11, 16, 18, 0))).toBeNull();
    expect(restrictionInForce(list, at(2026, 11, 21, 10))).toBeNull();
  });
  it('handles periods crossing midnight', () => {
    const night = { restrictions: [r2P({ days: [5], startTime: '22:00', endTime: '06:00' })] };
    // Friday 2026-11-20 23:00 and Saturday 03:00 belong to Friday's period.
    expect(restrictionInForce(night, at(2026, 11, 20, 23))!.end).toBe(at(2026, 11, 21, 6));
    expect(restrictionInForce(night, at(2026, 11, 21, 3))!.start).toBe(at(2026, 11, 20, 22));
    expect(restrictionInForce(night, at(2026, 11, 21, 7))).toBeNull();
  });
  it('merges consecutive all-day restrictions', () => {
    const allDay = { restrictions: [r2P({ allDay: true, days: [1, 2, 3, 4, 5] })] };
    const inst = restrictionInForce(allDay, at(2026, 11, 18, 23, 50))!;
    expect(inst.start).toBe(at(2026, 11, 16));
    expect(inst.end).toBe(at(2026, 11, 21));
  });
  it('picks the most restrictive overlapping restriction', () => {
    const l = { restrictions: [r2P(), r2P({ id: 'r-1p', code: '1P', limitMinutes: 60, startTime: '12:00', endTime: '14:00' })] };
    expect(restrictionInForce(l, at(2026, 11, 16, 12, 30))!.restriction.code).toBe('1P');
    expect(restrictionInForce(l, at(2026, 11, 16, 15))!.restriction.code).toBe('2P');
  });
  it('finds the next start', () => {
    expect(nextRestrictionStart(list, at(2026, 11, 21, 10))!.start).toBe(at(2026, 11, 23, 8));
    expect(nextRestrictionStart(list, at(2026, 11, 16, 6))!.start).toBe(at(2026, 11, 16, 8));
  });
});

describe('helpers', () => {
  it('summarises days', () => {
    expect(summariseDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(summariseDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
    expect(summariseDays([1, 2, 3, 5])).toBe('Mon–Wed, Fri');
  });
  it('validates restrictions', () => {
    expect(validateRestriction(r2P())).toEqual([]);
    expect(validateRestriction(r2P({ code: '', days: [], limitMinutes: 0 })).length).toBe(3);
    expect(validateRestriction(r2P({ startTime: '09:00', endTime: '09:00' })).length).toBe(1);
  });
});
