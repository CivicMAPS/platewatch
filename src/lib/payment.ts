import type { PaymentAreas } from './types';

/** Paid-parking identifiers as shown on the evidence data bar and "Check payment before enforcing". */
export function paymentLines(payment?: PaymentAreas): string[] {
  return [
    ...(payment?.parkingArea ? [`Parking area ${payment.parkingArea}`] : []),
    ...(payment?.easyPark ?? []).map(area => `EasyPark AreaNumber ${area}`),
    ...(payment?.payStay ?? []).map(({ zone, meter }) => `PayStay ParkingZone ${zone}${meter ? ` · Meter ID ${meter}` : ''}`),
  ];
}
