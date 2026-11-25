import type { Meter, PaidBy, PaymentAreas, TimedRestriction } from './types';

const uniq = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/**
 * One shape for paid-parking details: PayStay zones listed once, and meters in `meters`. Lists
 * saved before meters were separate stored one meter with each PayStay zone entry (the same zone
 * repeated for each meter); each such meter becomes a meter tied to that zone.
 */
export function normalisePayment(p: PaymentAreas): PaymentAreas {
  const meters = new Map<string, Meter>();
  const addMeter = (m: Meter) => {
    const id = m.id.trim();
    if (!id) return;
    const prev = meters.get(id) ?? { id, easyPark: [], payStay: [] };
    meters.set(id, { id, easyPark: uniq([...prev.easyPark, ...m.easyPark]), payStay: uniq([...prev.payStay, ...m.payStay]) });
  };
  for (const m of p.meters ?? []) addMeter(m);
  for (const z of p.payStay) if (z.meter?.trim()) addMeter({ id: z.meter, easyPark: [], payStay: [z.zone] });
  const out: PaymentAreas = {
    ...(p.parkingArea?.trim() ? { parkingArea: p.parkingArea.trim() } : {}),
    easyPark: uniq(p.easyPark),
    payStay: uniq(p.payStay.map((z) => z.zone)).map((zone) => ({ zone })),
  };
  if (meters.size) out.meters = [...meters.values()];
  return out;
}

/** True when the restriction is tied to at least one payment number. */
export const isPaidBy = <T extends Pick<TimedRestriction, 'paidBy'>>(r?: T): r is T & { paidBy: PaidBy } => !!(r?.paidBy && (r.paidBy.easyPark.length || r.paidBy.payStay.length));

/**
 * The payment details that apply to one restriction: its tied EasyPark areas and PayStay zones,
 * the meters for those numbers, plus the parking area and whole-segment meters. A restriction tied
 * to no number gets the segment's full payment details.
 */
export function paymentFor(payment: PaymentAreas | undefined, restriction?: Pick<TimedRestriction, 'paidBy'>): PaymentAreas | undefined {
  if (!payment) return undefined;
  const p = normalisePayment(payment);
  if (!isPaidBy(restriction)) return p;
  const { easyPark, payStay } = restriction.paidBy;
  const meters = (p.meters ?? []).filter(
    (m) => (!m.easyPark.length && !m.payStay.length) || m.easyPark.some((a) => easyPark.includes(a)) || m.payStay.some((z) => payStay.includes(z)),
  );
  const out: PaymentAreas = {
    ...(p.parkingArea ? { parkingArea: p.parkingArea } : {}),
    easyPark: p.easyPark.filter((a) => easyPark.includes(a)),
    payStay: p.payStay.filter((z) => payStay.includes(z.zone)),
  };
  if (meters.length) out.meters = meters;
  return out;
}

/** Restrictions with no remaining payment number keep nothing stale after numbers are removed or renamed. */
export function prunePaidBy(paidBy: PaidBy | undefined, payment: PaymentAreas | undefined): PaidBy | undefined {
  if (!paidBy) return undefined;
  const easyPark = paidBy.easyPark.filter((a) => payment?.easyPark.includes(a));
  const payStay = paidBy.payStay.filter((z) => payment?.payStay.some((p) => p.zone === z));
  return easyPark.length || payStay.length ? { easyPark: uniq(easyPark), payStay: uniq(payStay) } : undefined;
}

const meterList = (ms: readonly Meter[]) => ms.map((m) => m.id).join(', ');

/**
 * Paid-parking identifiers as shown on the list, the evidence record and "Check payment before
 * enforcing": each payment number with the meters that serve it, then whole-segment meters.
 */
export function paymentLines(payment?: PaymentAreas): string[] {
  if (!payment) return [];
  const p = normalisePayment(payment);
  const meters = p.meters ?? [];
  const forArea = (a: string) => meters.filter((m) => m.easyPark.includes(a));
  const forZone = (z: string) => meters.filter((m) => m.payStay.includes(z));
  const segmentMeters = meters.filter((m) => !m.easyPark.length && !m.payStay.length);
  return [
    ...(p.parkingArea ? [`Parking area ${p.parkingArea}`] : []),
    ...p.easyPark.map((a) => `EasyPark AreaNumber ${a}${forArea(a).length ? ` · Meter ID ${meterList(forArea(a))}` : ''}`),
    ...p.payStay.map(({ zone }) => `PayStay ParkingZone ${zone}${forZone(zone).length ? ` · Meter ID ${meterList(forZone(zone))}` : ''}`),
    ...(segmentMeters.length ? [`Meter ID ${meterList(segmentMeters)} · whole segment`] : []),
  ];
}

/** Short form for a restriction line: "PayStay 33883296, EasyPark 7514". */
export function paidByLabel(paidBy?: PaidBy): string {
  if (!paidBy) return '';
  return [...paidBy.easyPark.map((a) => `EasyPark ${a}`), ...paidBy.payStay.map((z) => `PayStay ${z}`)].join(', ');
}

/**
 * A restriction's own payment numbers with their meters, for the restriction line:
 * "PayStay 33883296 (meters GLP1, GLP4)". Empty when the restriction is tied to no number.
 */
export function restrictionPaymentLabel(payment: PaymentAreas | undefined, r: Pick<TimedRestriction, 'paidBy'>): string {
  if (!isPaidBy(r) || !payment) return '';
  const meters = normalisePayment(payment).meters ?? [];
  const withMeters = (label: string, ms: Meter[]) => (ms.length ? `${label} (meter${ms.length > 1 ? 's' : ''} ${meterList(ms)})` : label);
  return [
    ...r.paidBy.easyPark.map((a) => withMeters(`EasyPark ${a}`, meters.filter((m) => m.easyPark.includes(a)))),
    ...r.paidBy.payStay.map((z) => withMeters(`PayStay ${z}`, meters.filter((m) => m.payStay.includes(z)))),
  ].join(', ');
}
