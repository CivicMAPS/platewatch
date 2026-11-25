import { describe, expect, it } from 'vitest';
import { normalisePayment, paymentFor, paymentLines, prunePaidBy, restrictionPaymentLabel } from '../src/lib/payment';
import type { PaymentAreas } from '../src/lib/types';

// Gladstone St, Boundary St – Montague St (north), as entered in the field: one PayStay zone per
// restriction, several meters per zone.
const gladstone: PaymentAreas = {
  easyPark: [],
  payStay: [{ zone: '33883296' }, { zone: '33883294' }, { zone: '33883292' }],
  meters: [
    { id: 'GLP1', easyPark: [], payStay: ['33883296'] },
    { id: 'GLP2', easyPark: [], payStay: ['33883294'] },
    { id: 'GLP4', easyPark: [], payStay: ['33883296'] },
    { id: 'GLP6', easyPark: [], payStay: ['33883292'] },
  ],
};
const oneP = { paidBy: { easyPark: [], payStay: ['33883296'] } };

describe('payment tied to restrictions', () => {
  it('moves meters stored with each PayStay zone (older lists) into meters, listing each zone once', () => {
    const legacy: PaymentAreas = {
      easyPark: [],
      payStay: [{ zone: '33883296', meter: 'GLP1' }, { zone: '33883294', meter: 'GLP2' }, { zone: '33883296', meter: 'GLP4' }, { zone: '33883292', meter: 'GLP6' }],
    };
    const p = normalisePayment(legacy);
    expect(p.payStay).toEqual([{ zone: '33883296' }, { zone: '33883294' }, { zone: '33883292' }]);
    expect(p.meters).toEqual([
      { id: 'GLP1', easyPark: [], payStay: ['33883296'] },
      { id: 'GLP2', easyPark: [], payStay: ['33883294'] },
      { id: 'GLP4', easyPark: [], payStay: ['33883296'] },
      { id: 'GLP6', easyPark: [], payStay: ['33883292'] },
    ]);
  });

  it('lists each number once with the meters that serve it', () => {
    expect(paymentLines(gladstone)).toEqual([
      'PayStay ParkingZone 33883296 · Meter ID GLP1, GLP4',
      'PayStay ParkingZone 33883294 · Meter ID GLP2',
      'PayStay ParkingZone 33883292 · Meter ID GLP6',
    ]);
  });

  it('gives a restriction only its own numbers and their meters', () => {
    expect(paymentLines(paymentFor(gladstone, oneP))).toEqual(['PayStay ParkingZone 33883296 · Meter ID GLP1, GLP4']);
    expect(restrictionPaymentLabel(gladstone, oneP)).toBe('PayStay 33883296 (meters GLP1, GLP4)');
    expect(restrictionPaymentLabel(gladstone, { paidBy: { easyPark: [], payStay: ['33883292'] } })).toBe('PayStay 33883292 (meter GLP6)');
  });

  it('a restriction tied to no number gets the whole segment, and nothing is labelled', () => {
    expect(paymentFor(gladstone, {})).toEqual(gladstone);
    expect(restrictionPaymentLabel(gladstone, {})).toBe('');
  });

  it('a meter can serve the whole segment and parking area, or several numbers', () => {
    const com: PaymentAreas = {
      parkingArea: '637',
      easyPark: ['7514', '7515'],
      payStay: [],
      meters: [
        { id: 'M-SEG', easyPark: [], payStay: [] },
        { id: 'M-BOTH', easyPark: ['7514', '7515'], payStay: [] },
      ],
    };
    expect(paymentLines(com)).toEqual([
      'Parking area 637',
      'EasyPark AreaNumber 7514 · Meter ID M-BOTH',
      'EasyPark AreaNumber 7515 · Meter ID M-BOTH',
      'Meter ID M-SEG · whole segment',
    ]);
    // Paid with 7515: the parking area and whole-segment meter still apply.
    expect(paymentLines(paymentFor(com, { paidBy: { easyPark: ['7515'], payStay: [] } }))).toEqual([
      'Parking area 637',
      'EasyPark AreaNumber 7515 · Meter ID M-BOTH',
      'Meter ID M-SEG · whole segment',
    ]);
  });

  it('drops links to numbers no longer on the segment', () => {
    expect(prunePaidBy({ easyPark: ['1'], payStay: ['33883296', '999'] }, gladstone)).toEqual({ easyPark: [], payStay: ['33883296'] });
    expect(prunePaidBy({ easyPark: ['1'], payStay: [] }, gladstone)).toBeUndefined();
  });
});

describe('paymentLines (evidence data bar and "Check payment before enforcing")', () => {
  it('lists the parking area number first, then EasyPark and PayStay', () => {
    expect(paymentLines({ parkingArea: '637', easyPark: ['3051'], payStay: [{ zone: '338851200001', meter: '' }] })).toEqual([
      'Parking area 637',
      'EasyPark AreaNumber 3051',
      'PayStay ParkingZone 338851200001',
    ]);
  });
  it('adds the meter ID only when there is one, including evidence saved before meters were separate', () => {
    expect(paymentLines({ easyPark: [], payStay: [{ zone: '00042', meter: '4521' }] })).toEqual(['PayStay ParkingZone 00042 · Meter ID 4521']);
    expect(paymentLines(undefined)).toEqual([]);
  });
});

describe('paid session from the provider lookup', () => {
  it("ignores a session that ended before the scan's day (it would otherwise be moved onto today)", async () => {
    const { paidSessionForScan } = await import('../src/lib/payment');
    const scan = new Date(2026, 10, 25, 9, 0).getTime();
    const yesterday = { paidFrom: new Date(2026, 10, 24, 8, 0).getTime(), paidTo: new Date(2026, 10, 24, 10, 0).getTime() };
    const today = { paidFrom: new Date(2026, 10, 25, 8, 0).getTime(), paidTo: new Date(2026, 10, 25, 8, 30).getTime() };
    const overnight = { paidFrom: new Date(2026, 10, 24, 22, 0).getTime(), paidTo: new Date(2026, 10, 25, 1, 0).getTime() };
    expect(paidSessionForScan(yesterday, scan)).toBeNull();
    expect(paidSessionForScan(today, scan)).toBe(today);
    expect(paidSessionForScan(overnight, scan)).toBe(overnight);
    expect(paidSessionForScan(null, scan)).toBeNull();
  });
});
