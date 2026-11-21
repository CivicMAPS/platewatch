import { describe, expect, it } from 'vitest';
import { paymentLines } from '../src/lib/payment';

describe('paymentLines (evidence data bar and "Check payment before enforcing")', () => {
  it('lists the parking area number first, then EasyPark and PayStay', () => {
    expect(paymentLines({ parkingArea: '637', easyPark: ['3051'], payStay: [{ zone: '338851200001', meter: '' }] })).toEqual([
      'Parking area 637',
      'EasyPark AreaNumber 3051',
      'PayStay ParkingZone 338851200001',
    ]);
  });
  it('adds the meter ID only when there is one', () => {
    expect(paymentLines({ easyPark: [], payStay: [{ zone: '00042', meter: '4521' }] })).toEqual(['PayStay ParkingZone 00042 · Meter ID 4521']);
    expect(paymentLines(undefined)).toEqual([]);
  });
});
