import { describe, expect, it } from 'vitest';
import { effectivePayment, offenceFor, timeOnDay } from '../src/lib/offence';
import { at } from './fixtures';

const t = (h: number, m = 0, s = 0) => at(2026, 11, 21, h, m, s);
// 2P from 08:20:05, no grace.
const base = { startedAt: t(8, 20, 5), limitMinutes: 120, graceMinutes: 0 };

describe('701 / 702 decision table (WF-S30)', () => {
  it('timed, not paid: 701 after the allowance, nothing before', () => {
    expect(offenceFor(base, t(10, 0))).toBeNull();
    expect(offenceFor(base, t(10, 41, 7))).toMatchObject({ code: '701', basis: 'allowance_exceeded', timeFrom: t(8, 20, 5) });
  });

  it('paid: within allowance and paid to → nothing', () => {
    expect(offenceFor({ ...base, payment: { status: 'paid', paidTo: t(12, 15) } }, t(10, 0))).toBeNull();
  });

  it('paid: allowance exceeded, paid to still valid → 701', () => {
    expect(offenceFor({ ...base, payment: { status: 'paid', paidTo: t(10, 45) } }, t(10, 41, 7))).toMatchObject({ code: '701' });
    expect(offenceFor({ ...base, payment: { status: 'paid', paidTo: t(10, 45) } }, t(10, 41, 7))?.secondary).toBeUndefined();
  });

  it('paid: 702 only once paid to + 5 min grace has passed; time from = paid to', () => {
    const o = { ...base, limitMinutes: 240, payment: { status: 'paid' as const, paidTo: t(12, 15) } };
    expect(offenceFor(o, t(12, 19, 59))).toBeNull();
    expect(offenceFor(o, t(12, 20, 30))).toMatchObject({ code: '702', basis: 'paid_to_passed', timeFrom: t(12, 15) });
  });

  it('both reached: the first reached is offered, the other secondary', () => {
    const o = { ...base, payment: { status: 'paid' as const, paidTo: t(9, 0) } }; // 702 from 09:05, 701 from 10:20:05
    expect(offenceFor(o, t(11, 0))).toMatchObject({ code: '702', secondary: { code: '701', timeFrom: t(8, 20, 5) } });
  });

  it('no payment found: 702 at the first scan; a later overstay adds 701 as secondary', () => {
    const o = { ...base, payment: { status: 'not_found' as const } };
    expect(offenceFor(o, t(8, 20, 5))).toMatchObject({ code: '702', basis: 'no_payment_found', timeFrom: t(8, 20, 5) });
    expect(offenceFor(o, t(10, 41))).toMatchObject({ code: '702', secondary: { code: '701' } });
  });

  it('disability permit displayed: never 702; 701 after twice the allowance', () => {
    const o = { ...base, limitMinutes: 240, concession: { kind: 'disability' as const, baseLimitMinutes: 120 }, payment: { status: 'not_found' as const } };
    expect(offenceFor(o, t(10, 41))).toBeNull();
    expect(offenceFor(o, t(12, 30))).toMatchObject({ code: '701' });
  });
});

describe('payment check as entered', () => {
  it('a paid to already past the scan counts as paid within the grace, else as not found', () => {
    expect(effectivePayment({ status: 'paid', paidTo: t(10, 38) }, t(10, 41))).toEqual({ status: 'paid', paidTo: t(10, 38) });
    expect(effectivePayment({ status: 'paid', paidTo: t(10, 30) }, t(10, 41))).toEqual({ status: 'not_found', paidTo: t(10, 30) });
    expect(effectivePayment({ status: 'not_found' }, t(10, 41))).toEqual({ status: 'not_found' });
  });

  it('reads HH:MM on the scan day', () => {
    expect(timeOnDay(t(10, 41), '12:15')).toBe(t(12, 15));
    expect(timeOnDay(t(10, 41), '25:00')).toBeNull();
    expect(timeOnDay(t(10, 41), 'noon')).toBeNull();
  });
});
