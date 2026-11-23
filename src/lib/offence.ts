/**
 * Offences 701 / 702 offered by digital chalking (WF-S30). Pure: the officer decides; nothing is
 * issued from here (OQ9-6). Codes as published by the City of Melbourne:
 *   701 — Road Safety Road Rules 2017 r 205, parked for period longer than indicated
 *   702 — r 207, meter expired / no valid ticket
 * Labels and penalties come from the council's offence table in EnforcementMAPS (OQ30-8); the
 * labels below are the defaults shown on the device.
 *
 * Decision table (WF-S30, owner decisions 23/11/2026):
 * - Paid session found at the first scan: re-scan after the allowance → 701 (time from = first
 *   sighting); after paid to + 5 min grace → 702 (time from = paid to). Both reached: the one reached
 *   first is offered, the other is secondary (OQ30-5, proposed).
 * - No payment found at the first scan → 702 at once (time from = first scan). Timing still runs,
 *   so a later re-scan can add 701 as secondary (OQ30-6, proposed).
 * - Timed, not paid → 701 after the allowance (unchanged).
 * - Disability permit displayed (concession) → no payment required: 701 after 2 × allowance, never 702.
 */
import type { Observation, PaymentCheck } from './types';

export const PAID_TO_GRACE_MINUTES = 5;

export type OffenceCode = '701' | '702';
export type OffenceBasis = 'allowance_exceeded' | 'paid_to_passed' | 'no_payment_found';

export const OFFENCE_LABEL: Record<OffenceCode, string> = {
  '701': 'Parked longer than indicated',
  '702': 'Meter expired / no valid ticket',
};

export interface OffenceOffer {
  code: OffenceCode;
  basis: OffenceBasis;
  /** Epoch ms: the wizard's locked time-from. */
  timeFrom: number;
  /** When the offence became available (for ordering, OQ30-5). */
  reachedAt: number;
  secondary?: { code: OffenceCode; basis: OffenceBasis; timeFrom: number };
}

type Timing = Pick<Observation, 'startedAt' | 'limitMinutes' | 'graceMinutes' | 'concession' | 'payment'>;

/** The offence the scan at `at` supports for a timing, or null. */
export function offenceFor(o: Timing, at: number): OffenceOffer | null {
  const offers: OffenceOffer[] = [];
  const allowanceAt = o.startedAt + (o.limitMinutes + o.graceMinutes) * 60_000;
  if (at >= allowanceAt) offers.push({ code: '701', basis: 'allowance_exceeded', timeFrom: o.startedAt, reachedAt: allowanceAt });
  if (!o.concession && o.payment) {
    if (o.payment.status === 'not_found') offers.push({ code: '702', basis: 'no_payment_found', timeFrom: o.startedAt, reachedAt: o.startedAt });
    else if (o.payment.paidTo !== undefined) {
      const graceEnds = o.payment.paidTo + PAID_TO_GRACE_MINUTES * 60_000;
      if (at >= graceEnds) offers.push({ code: '702', basis: 'paid_to_passed', timeFrom: o.payment.paidTo, reachedAt: graceEnds });
    }
  }
  if (!offers.length) return null;
  offers.sort((a, b) => a.reachedAt - b.reachedAt);
  const [first, second] = offers;
  return second ? { ...first!, secondary: { code: second.code, basis: second.basis, timeFrom: second.timeFrom } } : first!;
}

/**
 * A payment check as entered at the first scan (OQ30-2, proposed): a paid session whose paid to is
 * already past the scan time counts as paid within the 5-minute grace; beyond it, as no payment
 * found (the expired paid to is kept on the record).
 */
export function effectivePayment(check: Pick<PaymentCheck, 'status' | 'paidTo'>, scanAt: number): { status: 'paid' | 'not_found'; paidTo?: number } {
  if (check.status === 'not_found') return { status: 'not_found' };
  if (check.paidTo !== undefined && scanAt >= check.paidTo + PAID_TO_GRACE_MINUTES * 60_000) return { status: 'not_found', paidTo: check.paidTo };
  return { status: 'paid', paidTo: check.paidTo };
}

/** Local epoch ms for "HH:MM" on the day of `ref`. */
export function timeOnDay(ref: number, hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const d = new Date(ref);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return Number(m[1]) < 24 && Number(m[2]) < 60 ? d.getTime() : null;
}
