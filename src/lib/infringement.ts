/**
 * Issue Infringement hand-off (WF-S31, `PlateWatch - Issue Infringement Requirements`). PlateWatch
 * is the entry point: it builds a pre-fill payload from the sighting
 * (`schemas/platewatch-infringement-handoff.v1.schema.json`) and hands it to the EnforcementMAPS
 * wizard, which allocates the infringement number on the handset, takes the officer through the
 * four steps and issues. PlateWatch stores the result back. Nothing is issued from an OCR read
 * alone (IR-1); the development build has no wizard and hides Issue (IR-3).
 */
import { host } from './host';
import { sameVehicleLink } from './lookalike';
import { OFFENCE_LABEL, PAID_TO_GRACE_MINUTES, type OffenceOffer } from './offence';
import { formatClock, formatDuration, toLocalIso } from './time';
import type { InfringementRecord, LookalikeLink, Observation, PaymentCheck, ScanRecord, TimedList, VehicleDetails } from './types';
import { plateReentry } from './vehicle';
import { normalisePlate } from './plate';

export type InfringementHandoff = Record<string, unknown> & {
  schemaVersion: '1.0';
  handoffId: string;
  source: 'platewatch';
  officerNumber: string;
  offence: { suggestedCode: '701' | '702'; basis: OffenceOffer['basis'] } & Record<string, unknown>;
  times: { timeFrom: string; timeTo: string } & Record<string, unknown>;
};

/** What the wizard returns (requirements §11). */
export interface InfringementResult {
  status: 'issued' | 'cancelled';
  number?: string;
  offenceCode?: string;
  timeFrom?: number;
  timeTo?: number;
  issuedAt?: number;
  sync?: 'pending' | 'synced' | 'rejected';
}

/** Issue infringement is offered only inside EnforcementMAPS (IR-3: hidden in the development build). */
export function canIssueInfringement(): boolean {
  return !!host()?.startInfringement;
}

const SOURCE_TEXT: Record<PaymentCheck['source'], string> = { easypark: 'EasyPark', paystay: 'PayStay', meter: 'Meter', ticket: 'Ticket', other: 'Other' };
const iso = (ms: number) => toLocalIso(ms);
const hms = (ms: number) => formatClock(ms);
const paidWith = (p: PaymentCheck) => `${SOURCE_TEXT[p.source]}${p.sourceRef ? ` ${p.sourceRef}` : ''}`;

/** The look-alike the officer acted on, if any (OQ28-6: the wizard then asks for the plate check). */
function actedLookalike(links: readonly LookalikeLink[] | undefined): LookalikeLink | undefined {
  return sameVehicleLink(links) ?? links?.find((l) => l.choice === 'hot_confirmed' || l.choice === 'permit_plate');
}

/** Requirements §5: officer notes template per offence. */
export function notesTemplate(args: { offer: OffenceOffer; observation: Observation; scanAt: number; code: string; payment?: PaymentCheck; lookalike?: LookalikeLink }): string {
  const { offer, observation: o, scanAt, payment: p } = args;
  const lines: string[] = [];
  if (offer.code === '701') {
    const allowanceEnds = o.startedAt + (o.limitMinutes + o.graceMinutes) * 60_000;
    lines.push(`First sighted ${hms(o.startedAt)}, re-sighted ${hms(scanAt)}, ${args.code} allowance exceeded by ${formatDuration(scanAt - allowanceEnds)}.`);
    if (p?.status === 'paid' && p.paidTo !== undefined) lines.push(`Paid to ${hms(p.paidTo)} (${paidWith(p)}).`);
  } else if (offer.basis === 'no_payment_found') {
    lines.push(`No paid session found at ${hms(o.startedAt)}${p ? ` (${paidWith(p)} checked)` : ''}.`);
  } else if (p?.paidTo !== undefined) {
    lines.push(`Paid to ${hms(p.paidTo)} (${paidWith(p)}); vehicle still parked at ${hms(scanAt)}, ${formatDuration(scanAt - p.paidTo)} after paid to.`);
  }
  const l = args.lookalike;
  if (l) lines.push(`Plate read as ${l.readAs}; linked to timing for ${l.candidatePlate} by officer at ${hms(l.decidedAt)}.`);
  return lines.join(' ');
}

/** Release rule type kept in the restriction description ("Meter" / "Ticket", OQ30-7). */
function spaceType(description: string): 'timed' | 'meter' | 'ticket' {
  return /\bticket\b/i.test(description) ? 'ticket' : /\bmeter\b/i.test(description) ? 'meter' : 'timed';
}

/** Requirements §4 / §10: the pre-fill payload for the wizard. */
export function buildHandoff(args: {
  handoffId: string;
  list: TimedList;
  observation: Observation;
  scan: ScanRecord;
  firstScan?: ScanRecord;
  offer: OffenceOffer;
  officerNumber: string;
  device: string;
  /** Vehicle details entered (or confirmed) by the officer at hand-off. */
  vehicle: VehicleDetails;
  /** Second entry of the licence plate; must match the first (plateReentry). */
  plateSecondEntry: { plate: string; at: number };
}): InfringementHandoff {
  if (plateReentry(args.scan.plate, args.plateSecondEntry.plate) !== 'match') throw new Error('The licence plate entries do not match.');
  const { list: l, observation: o, scan, offer } = args;
  const first = args.firstScan && args.firstScan.id !== scan.id ? args.firstScan : undefined;
  const r = l.restrictions.find((x) => x.id === o.restrictionId);
  const payment = (first ?? scan).payment ?? scan.payment;
  const loc = scan.meta.location;
  const pay = scan.meta.payment;
  const lookalike = actedLookalike(scan.lookalikes);
  const evidence = [...(first ? [{ s: first, role: 'first_sighting' as const }] : []), { s: scan, role: 'current_scan' as const }].map(({ s, role }) => ({
    scanId: s.id,
    role,
    capturedAt: iso(s.meta.capturedAt),
    sha256: s.sha256,
    mime: 'image/jpeg' as const,
    ...(s.meta.location ? { lat: s.meta.location.latitude, lng: s.meta.location.longitude, accuracyM: s.meta.location.accuracy } : {}),
  }));
  return {
    schemaVersion: '1.0',
    handoffId: args.handoffId,
    source: 'platewatch',
    officerNumber: args.officerNumber,
    device: args.device,
    location: {
      listId: l.id,
      ...(l.displayId ? { displayId: l.displayId } : {}),
      ...(l.externalId ? { externalId: l.externalId } : {}),
      street: l.segment.street,
      fromStreet: l.segment.fromStreet,
      toStreet: l.segment.toStreet,
      side: l.segment.side,
      ...(l.segment.suburb ? { suburb: l.segment.suburb } : {}),
      ...(pay?.parkingArea ? { parkingArea: pay.parkingArea } : l.payment?.parkingArea ? { parkingArea: l.payment.parkingArea } : {}),
      easyPark: (pay?.easyPark ?? []).filter(Boolean),
      payStay: [...new Set((pay?.payStay ?? []).map((z) => z.zone).filter(Boolean))],
      ...(l.patrolZone ? { patrolZone: l.patrolZone } : {}),
      ...(loc ? { lat: loc.latitude, lng: loc.longitude, accuracyM: loc.accuracy } : {}),
    },
    vehicle: {
      registration: scan.plate,
      registrationType: args.vehicle.registrationType.trim(),
      make: args.vehicle.make.trim(),
      type: args.vehicle.bodyType.trim(),
      colour: args.vehicle.colour.trim(),
      plateReentry: { second: normalisePlate(args.plateSecondEntry.plate), matched: true, at: iso(args.plateSecondEntry.at) },
      ocrText: scan.ocrText,
      corrected: scan.corrected,
      plateCheckedOnVehicle: false,
      ...(lookalike ? { lookalike: { readAs: lookalike.readAs, candidatePlate: lookalike.candidatePlate, source: lookalike.source, choice: lookalike.choice, decidedAt: iso(lookalike.decidedAt) } } : {}),
    },
    offence: {
      suggestedCode: offer.code,
      paidToGraceMinutes: PAID_TO_GRACE_MINUTES,
      basis: offer.basis,
      ...(offer.secondary ? { secondary: { code: offer.secondary.code, timeFrom: iso(offer.secondary.timeFrom) } } : {}),
      restrictionCode: o.restrictionCode,
      spaceType: spaceType(r?.description ?? ''),
      limitMinutes: o.limitMinutes,
      graceMinutes: o.graceMinutes,
      ...(o.concession ? { concession: o.concession.kind } : {}),
    },
    times: { timeFrom: iso(offer.timeFrom), timeTo: iso(scan.meta.capturedAt), firstSightingAt: iso(o.startedAt), scanAt: iso(scan.meta.capturedAt) },
    ...(payment
      ? {
          payment: {
            status: payment.status,
            source: payment.source,
            ...(payment.sourceRef ? { sourceRef: payment.sourceRef } : {}),
            ...(payment.paidFrom !== undefined ? { paidFrom: iso(payment.paidFrom) } : {}),
            ...(payment.paidTo !== undefined ? { paidTo: iso(payment.paidTo) } : {}),
            checkedAt: iso(payment.checkedAt),
            checkedBy: payment.checkedBy,
          },
        }
      : {}),
    evidence,
    notesTemplate: notesTemplate({ offer, observation: o, scanAt: scan.meta.capturedAt, code: o.restrictionCode, payment, lookalike }),
    sighting: {
      observationId: o.id,
      scanId: scan.id,
      scanCount: o.scanCount,
      ...(scan.alertDismissal ? { alertDismissal: { reason: scan.alertDismissal.reason, at: iso(scan.alertDismissal.at) } } : {}),
    },
  };
}

/** Requirements §11: store the wizard's result on the scan and close the timing as issued. */
export function applyInfringementResult(args: { scan: ScanRecord; observation: Observation; handoff: InfringementHandoff; result: InfringementResult; now?: number }): {
  scan: ScanRecord;
  observation: Observation;
} {
  const { scan, observation, handoff, result } = args;
  if (!result.number) return { scan, observation };
  const suggested = handoff.offence.suggestedCode;
  const record: InfringementRecord = {
    status: result.status === 'issued' ? 'issued' : 'cancelled',
    sync: result.sync ?? 'pending',
    pinSource: 'device',
    handoffId: handoff.handoffId,
    number: result.number,
    offenceCode: result.offenceCode ?? suggested,
    offenceOverridden: (result.offenceCode ?? suggested) !== suggested,
    timeFrom: result.timeFrom ?? Date.parse(handoff.times.timeFrom),
    timeTo: result.timeTo ?? Date.parse(handoff.times.timeTo),
    ...(result.issuedAt !== undefined ? { issuedAt: result.issuedAt } : {}),
    officerNumber: handoff.officerNumber,
  };
  const issuedAt = result.issuedAt ?? args.now ?? Date.now();
  return {
    scan: { ...scan, infringement: record },
    observation: result.status === 'issued' ? { ...observation, status: 'issued', closedAt: issuedAt } : observation,
  };
}

/** I-N as printed: `OOOOO YYMMDD SSS TTTT CC`. */
export function formatInfringementNumber(n: string): string {
  return n.length === 20 ? `${n.slice(0, 5)} ${n.slice(5, 11)} ${n.slice(11, 14)} ${n.slice(14, 18)} ${n.slice(18)}` : n;
}

export { OFFENCE_LABEL };
