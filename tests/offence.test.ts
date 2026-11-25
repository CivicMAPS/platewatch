import { describe, expect, it } from 'vitest';
import { deriveInternalVariant, effectivePayment, offenceChipText, offenceFor, shortfallMinutes, timeOnDay } from '../src/lib/offence';
import { at } from './fixtures';

const t = (h: number, m = 0, s = 0) => at(2026, 11, 21, h, m, s);
// 2P from 08:20:05, no grace.
const base = { startedAt: t(8, 20, 5), limitMinutes: 120, graceMinutes: 0 };

describe('701 / 702 decision table (WF-S30, owner 25/11/2026: time first, then payment)', () => {
  it('timed, not paid: 701 after the allowance, nothing before', () => {
    expect(offenceFor(base, t(10, 0))).toBeNull();
    expect(offenceFor(base, t(10, 41, 7))).toMatchObject({ code: '701', basis: 'allowance_exceeded', timeFrom: t(8, 20, 5) });
    expect(offenceFor(base, t(10, 41, 7))?.internalVariant).toBeUndefined();
  });

  it('nP Meter, paid session current, within allowance → no offence', () => {
    expect(offenceFor({ ...base, payment: { status: 'paid', paidTo: t(12, 15) } }, t(10, 0))).toBeNull();
  });

  it('allowance exceeded → 701 whatever the payment state (current, expired or never paid)', () => {
    for (const payment of [{ status: 'paid' as const, paidTo: t(12, 45) }, { status: 'paid' as const, paidTo: t(9, 0) }, { status: 'not_found' as const }, { status: 'not_found' as const, paidTo: t(8, 0) }]) {
      const offer = offenceFor({ ...base, payment }, t(10, 41, 7));
      expect(offer).toMatchObject({ code: '701', basis: 'allowance_exceeded', timeFrom: t(8, 20, 5) });
      expect(offer).not.toHaveProperty('secondary');
    }
  });

  it('within allowance, paid to + 5 min grace passed → 702, derived internal expired_session (702e); time from = paid to', () => {
    const o = { ...base, limitMinutes: 300, payment: { status: 'paid' as const, paidTo: t(12, 15) } };
    expect(offenceFor(o, t(12, 19, 59))).toBeNull();
    expect(offenceFor(o, t(12, 20, 30))).toEqual({ code: '702', basis: 'paid_to_passed', timeFrom: t(12, 15), reachedAt: t(12, 20), internalVariant: 'expired_session', variantSource: 'derived' });
  });

  it('within allowance, no payment found → 702 at the first scan, derived internal no_payment; later past the allowance → 701', () => {
    const o = { ...base, payment: { status: 'not_found' as const } };
    expect(offenceFor(o, t(8, 20, 5))).toMatchObject({ code: '702', basis: 'no_payment_found', timeFrom: t(8, 20, 5), internalVariant: 'no_payment', variantSource: 'derived' });
    expect(offenceFor(o, t(10, 41))).toMatchObject({ code: '701' });
  });

  it('paid session found at the first scan but already ended (OQ30-2): 702 at once, derived expired_session', () => {
    const o = { ...base, payment: { status: 'not_found' as const, paidTo: t(8, 0) } };
    expect(offenceFor(o, t(8, 20, 5))).toMatchObject({ code: '702', basis: 'no_payment_found', timeFrom: t(8, 20, 5), internalVariant: 'expired_session' });
  });

  it('disability permit displayed: never 702; 701 after twice the allowance', () => {
    const o = { ...base, limitMinutes: 240, concession: { kind: 'disability' as const, baseLimitMinutes: 120 }, payment: { status: 'not_found' as const } };
    expect(offenceFor(o, t(10, 41))).toBeNull();
    expect(offenceFor(o, t(12, 30))).toMatchObject({ code: '701' });
  });

  it('foreshore permit (payment waived): never 702', () => {
    expect(offenceFor({ ...base, paymentWaived: 'foreshore', payment: { status: 'not_found' } }, t(9, 0))).toBeNull();
  });

  it('the officer is only ever shown 702 — never 702e', () => {
    expect(offenceChipText({ code: '702', internalVariant: 'expired_session' })).toBe('702 · Paid session expired');
    expect(offenceChipText({ code: '702', internalVariant: 'no_payment' })).toBe('702 · No valid payment');
    expect(offenceChipText({ code: '701' })).toBe('701 · Parked longer than indicated');
    for (const v of ['no_payment', 'expired_session'] as const) expect(offenceChipText({ code: '702', internalVariant: v })).not.toMatch(/702e/i);
  });

  it('derives the variant and shortfall from the payment state', () => {
    expect(deriveInternalVariant(undefined)).toBe('no_payment');
    expect(deriveInternalVariant({ paidTo: t(9, 0) })).toBe('expired_session');
    expect(shortfallMinutes(t(9, 0), t(9, 41, 30))).toBe(41);
    expect(shortfallMinutes(undefined, t(9, 41))).toBeNull();
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
