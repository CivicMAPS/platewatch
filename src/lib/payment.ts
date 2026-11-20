import type { PaymentAreas } from './types';

export function paymentLines(payment?: PaymentAreas): string[] {
  return [
    ...(payment?.easyPark ?? []).map(area => `EasyPark AreaNumber ${area}`),
    ...(payment?.payStay ?? []).map(({ zone, meter }) => `PayStay ParkingZone ${zone} · Meter ID ${meter}`),
  ];
}
