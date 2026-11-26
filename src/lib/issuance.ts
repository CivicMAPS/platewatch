/**
 * Issuing from the hand-off (WF-S31 step 3–4 rules), shared by the development host on the device
 * and the backend, which re-derives everything here instead of trusting the client.
 *
 * - Time from is locked: 701 → first sighting; 702 with a paid session that ended within the
 *   allowance → paid to; 702 otherwise → first scan (requirements pre-fill map).
 * - Time to is editable but never before time from (8d-iii.4).
 * - The internal 702 classification is derived from the payment check, never chosen (25/11/2026):
 *   paid session found with a paid to → `expired_session` (702e); none found → `no_payment`; no
 *   payment check on record (e.g. the officer changed 701 to 702 in an unpaid space) → `unknown`.
 * - Fewer than 3 evidence images needs an override reason (8d-ii.1 / 8d-ii.2).
 */
import type { InfringementHandoff } from './infringement';
import type { IssuedRecord, VoidReason } from './types';

export const MIN_EVIDENCE_IMAGES = 3;

export const VOID_REASON_LABEL: Record<VoidReason, string> = {
  officer_error: 'Officer error',
  permit_displayed: 'Permit displayed',
  incorrect_offence: 'Incorrect offence',
  incorrect_vehicle_details: 'Incorrect vehicle details',
  non_conforming_signage: 'Non-conforming signage',
  other: 'Other',
};

type HandoffLike = Pick<InfringementHandoff, 'offence' | 'times'> & { payment?: unknown; evidence?: unknown };

interface PaymentJson {
  status?: string;
  paidTo?: string;
}

const payment = (h: HandoffLike) => (h.payment && typeof h.payment === 'object' ? (h.payment as PaymentJson) : undefined);

/** Locked time from (ISO) for the chosen code. */
export function timeFromFor(h: HandoffLike, code: '701' | '702'): string {
  if (code === '701') return String(h.times.firstSightingAt ?? h.times.timeFrom);
  if (h.offence.suggestedCode === '702' && h.offence.basis === 'paid_to_passed') return h.times.timeFrom;
  const p = payment(h);
  if (h.offence.suggestedCode === '701' && p?.status === 'paid' && p.paidTo && Date.parse(p.paidTo) < Date.parse(String(h.times.scanAt ?? h.times.timeTo))) return p.paidTo;
  return String(h.times.firstSightingAt ?? h.times.timeFrom);
}

/** Derived internal classification for a 702 (undefined for a 701). */
export function variantFor(h: HandoffLike, code: '701' | '702'): IssuedRecord['internalVariant'] {
  if (code !== '702') return undefined;
  const p = payment(h);
  if (!p) return 'unknown';
  // 702e only when the paid session had actually ended by the scan (an officer can change a 701 to
  // 702 while the session is still valid: no payment basis, so "unknown", never "expired").
  if (p.paidTo) return Date.parse(p.paidTo) <= Date.parse(String(h.times.scanAt ?? h.times.timeTo)) ? 'expired_session' : 'unknown';
  return p.status === 'not_found' ? 'no_payment' : 'unknown';
}

export function evidenceCount(h: HandoffLike): number {
  return Array.isArray(h.evidence) ? h.evidence.length : 0;
}

export interface WizardValues {
  offenceCode: '701' | '702';
  /** Epoch ms. */
  timeTo: number;
  notes: string;
  vehicle: Record<string, unknown>;
  evidenceOverride?: string;
}

/** Problems that block Issue (empty = can issue). */
export function issueProblems(h: HandoffLike, v: WizardValues): string[] {
  const out: string[] = [];
  if (!Number.isFinite(v.timeTo)) out.push('Enter time to.');
  else if (v.timeTo < Date.parse(timeFromFor(h, v.offenceCode))) out.push('Time to is before time from.');
  if (evidenceCount(h) < MIN_EVIDENCE_IMAGES && !v.evidenceOverride?.trim()) out.push(`Fewer than ${MIN_EVIDENCE_IMAGES} photos: give the override reason.`);
  for (const k of ['make', 'type', 'colour', 'registrationType'] as const) if (!String(v.vehicle[k] ?? '').trim()) out.push(`Vehicle ${k === 'registrationType' ? 'registration type' : k} is required.`);
  return out;
}

export function buildIssuedRecord(args: {
  number: string;
  handoff: InfringementHandoff;
  values: WizardValues;
  issuedAt: string;
  toIso: (ms: number) => string;
  reissueOf?: string;
  reissueReason?: VoidReason;
}): IssuedRecord {
  const { handoff: h, values: v } = args;
  const variant = variantFor(h, v.offenceCode);
  return {
    number: args.number,
    handoffId: h.handoffId,
    handoff: h,
    offenceCode: v.offenceCode,
    offenceOverridden: v.offenceCode !== h.offence.suggestedCode,
    ...(variant ? { internalVariant: variant } : {}),
    timeFrom: timeFromFor(h, v.offenceCode),
    timeTo: args.toIso(v.timeTo),
    issuedAt: args.issuedAt,
    notes: v.notes.trim(),
    ...(v.evidenceOverride?.trim() ? { evidenceOverride: { reason: v.evidenceOverride.trim() } } : {}),
    vehicle: { ...(h.vehicle as Record<string, unknown>), ...v.vehicle },
    officerNumber: h.officerNumber,
    ...(args.reissueOf ? { reissueOf: args.reissueOf } : {}),
    ...(args.reissueReason ? { reissueReason: args.reissueReason } : {}),
  };
}

/** What the customer-facing notice may carry: the offence code only (702, never 702e). */
export function noticeOffenceCode(r: Pick<IssuedRecord, 'offenceCode'>): '701' | '702' {
  return r.offenceCode;
}
