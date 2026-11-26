/**
 * Offences 701 / 702 offered by digital chalking (WF-S30). Pure: the officer decides; nothing is
 * issued from here (OQ9-6). Codes as published by the City of Melbourne:
 *   701 — Road Safety Road Rules 2017 r 205, parked for period longer than indicated
 *   702 — r 207, failed to pay / obey signed payment instructions (meter expired / no valid ticket)
 * Labels and penalties come from the council's offence table in EnforcementMAPS (OQ30-8); the
 * labels below are the defaults shown on the device. No dollar figure is shown on the device.
 *
 * Decision rule (owner, 25/11/2026) — **time first, then payment**:
 * 1. Elapsed time past the signed allowance (+ grace) → **701**, whatever the payment state (paid,
 *    expired or never paid). Payment is context only.
 * 2. Only within the allowance: no valid payment found → **702**; a paid session whose paid to
 *    (+ 5 min grace, OQ30-11) has passed → **702**.
 * 701 and 702 are never offered together. Timing always starts at the first scan, so a 702 at one
 * scan can be followed by a 701 at a later scan once the allowance is exceeded.
 *
 * 702e: City of Melbourne's internal analytics split of 702 ("paid session expired"). Legally, on
 * the notice and for the customer it **is 702**. The officer is never offered or shown a 702e
 * option: PlateWatch derives `internalVariant` from the payment check (`expired_session` when a
 * paid session was found and its paid to has passed; `no_payment` when none was found), locked,
 * recomputed whenever the plate or payment changes before issue. It travels in internal data only.
 *
 * Disability permit displayed (concession) → no payment required: 701 after 2 × allowance, never 702.
 */
import type { Observation, PaymentCheck } from './types';

export const PAID_TO_GRACE_MINUTES = 5;

export type OffenceCode = '701' | '702';
export type OffenceBasis = 'allowance_exceeded' | 'paid_to_passed' | 'no_payment_found';
/** Internal 702 classification (702 / 702e). `unknown` only for infringements issued without a payment check. */
export type InternalVariant = 'no_payment' | 'expired_session' | 'unknown';

export const OFFENCE_LABEL: Record<OffenceCode, string> = {
  '701': 'Parked longer than indicated',
  '702': 'Failed to pay / obey payment instructions',
};

/** What the officer sees on the offence chip: the code and a plain description, never "702e". */
export function offenceChipText(o: Pick<OffenceOffer, 'code' | 'internalVariant'>): string {
  if (o.code === '701') return `701 · ${OFFENCE_LABEL['701']}`;
  return o.internalVariant === 'expired_session' ? '702 · Paid session expired' : '702 · No valid payment';
}

export interface OffenceOffer {
  code: OffenceCode;
  basis: OffenceBasis;
  /** Epoch ms: the wizard's locked time-from. */
  timeFrom: number;
  /** When the offence became available. */
  reachedAt: number;
  /** 702 only: derived internal classification (702 vs 702e). Never chosen by the officer. */
  internalVariant?: Exclude<InternalVariant, 'unknown'>;
  variantSource?: 'derived';
}

type Timing = Pick<Observation, 'startedAt' | 'limitMinutes' | 'graceMinutes' | 'concession' | 'payment' | 'paymentWaived'>;

/** Derived internal 702 classification from the payment state carried on the timing. */
export function deriveInternalVariant(payment: Pick<NonNullable<Observation['payment']>, 'paidTo'> | undefined): Exclude<InternalVariant, 'unknown'> {
  return payment?.paidTo !== undefined ? 'expired_session' : 'no_payment';
}

/** The offence the scan at `at` supports for a timing, or null. Time first, then payment. */
export function offenceFor(o: Timing, at: number): OffenceOffer | null {
  const allowanceAt = o.startedAt + (o.limitMinutes + o.graceMinutes) * 60_000;
  if (at >= allowanceAt) return { code: '701', basis: 'allowance_exceeded', timeFrom: o.startedAt, reachedAt: allowanceAt };
  // Disability permit (2 × allowance) or FS permit in a foreshore space: no payment required.
  if (o.concession || o.paymentWaived || !o.payment) return null;
  const variant = deriveInternalVariant(o.payment);
  if (o.payment.status === 'not_found') {
    return { code: '702', basis: 'no_payment_found', timeFrom: o.startedAt, reachedAt: o.startedAt, internalVariant: variant, variantSource: 'derived' };
  }
  if (o.payment.paidTo !== undefined) {
    const graceEnds = o.payment.paidTo + PAID_TO_GRACE_MINUTES * 60_000;
    if (at >= graceEnds) return { code: '702', basis: 'paid_to_passed', timeFrom: o.payment.paidTo, reachedAt: graceEnds, internalVariant: 'expired_session', variantSource: 'derived' };
  }
  return null;
}

/** Shortfall for 702e analytics: scan time − paid to, in whole minutes (null without a paid to). */
export function shortfallMinutes(paidTo: number | undefined, scanAt: number): number | null {
  return paidTo === undefined ? null : Math.max(0, Math.floor((scanAt - paidTo) / 60_000));
}

/**
 * A payment check as entered at the first scan (OQ30-2, proposed): a paid session whose paid to is
 * already past the scan time counts as paid within the 5-minute grace; beyond it, as no valid
 * payment (702 at the first scan). The expired paid to is kept, so the derived internal
 * classification is `expired_session` (702e) — a valid session existed (handoff 25/11/2026).
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
