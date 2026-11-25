import { describe, expect, it } from 'vitest';
import { buildIssuedRecord, issueProblems, timeFromFor, variantFor } from '../src/lib/issuance';
import type { InfringementHandoff } from '../src/lib/infringement';

const base = {
  schemaVersion: '1.0', handoffId: 'h', source: 'platewatch', officerNumber: '4471',
  vehicle: { registration: 'DTS512' },
  times: { timeFrom: '2026-11-21T08:20:05.000+11:00', timeTo: '2026-11-21T10:41:07.000+11:00', firstSightingAt: '2026-11-21T08:20:05.000+11:00', scanAt: '2026-11-21T10:41:07.000+11:00' },
  evidence: [{}, {}],
} as const;
const h = (offence: Record<string, unknown>, payment?: Record<string, unknown>) => ({ ...base, offence, ...(payment ? { payment } : {}) }) as unknown as InfringementHandoff;
const veh = { make: 'Holden', type: 'Hatchback', colour: 'White', registrationType: 'Standard' };

describe('issuing from the hand-off', () => {
  it('locked time from per code; 702 paid session expired → paid to', () => {
    const expired = h({ suggestedCode: '702', basis: 'paid_to_passed' }, { status: 'paid', paidTo: '2026-11-21T09:00:00.000+11:00' });
    expect(timeFromFor({ ...expired, times: { ...expired.times, timeFrom: '2026-11-21T09:00:00.000+11:00' } }, '702')).toBe('2026-11-21T09:00:00.000+11:00');
    expect(timeFromFor(expired, '701')).toBe('2026-11-21T08:20:05.000+11:00');
  });

  it('derives the internal 702 classification; unknown without a payment check; none for 701', () => {
    expect(variantFor(h({ suggestedCode: '702', basis: 'no_payment_found' }, { status: 'not_found' }), '702')).toBe('no_payment');
    expect(variantFor(h({ suggestedCode: '702', basis: 'paid_to_passed' }, { status: 'paid', paidTo: '2026-11-21T09:00:00.000+11:00' }), '702')).toBe('expired_session');
    expect(variantFor(h({ suggestedCode: '701', basis: 'allowance_exceeded' }), '702')).toBe('unknown');
    expect(variantFor(h({ suggestedCode: '701', basis: 'allowance_exceeded' }), '701')).toBeUndefined();
  });

  it('blocks issue: time to before time from, fewer than 3 photos without an override, missing vehicle details', () => {
    const x = h({ suggestedCode: '701', basis: 'allowance_exceeded' });
    expect(issueProblems(x, { offenceCode: '701', timeTo: Date.parse('2026-11-21T08:00:00+11:00'), notes: '', vehicle: veh })).toEqual(['Time to is before time from.', 'Fewer than 3 photos: give the override reason.']);
    expect(issueProblems(x, { offenceCode: '701', timeTo: Date.parse(base.times.timeTo), notes: '', vehicle: { ...veh, colour: ' ' }, evidenceOverride: 'Vehicle left' })).toEqual(['Vehicle colour is required.']);
  });

  it('records an override of the suggested code', () => {
    const r = buildIssuedRecord({ number: '04471261121001836393', handoff: h({ suggestedCode: '701', basis: 'allowance_exceeded' }, { status: 'not_found' }), values: { offenceCode: '702', timeTo: Date.parse(base.times.timeTo), notes: ' n ', vehicle: veh }, issuedAt: 'x', toIso: (ms) => new Date(ms).toISOString() });
    expect(r).toMatchObject({ offenceCode: '702', offenceOverridden: true, internalVariant: 'no_payment', notes: 'n', vehicle: { registration: 'DTS512', colour: 'White' } });
  });
});
