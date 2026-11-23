/**
 * Residential parking permits (owner direction 23/11/2026, schemas/civicmaps-parking-permit.v1.schema.json).
 *
 * - The permit number is authoritative: `RPA-2026-0789/1` → types, issue year, sequential ID and
 *   amendment are derived from it (parts given separately must match).
 * - Status for the officer is only valid / expired: valid from 00:00 on valid-from until midnight at
 *   the end of valid-to. Both show the same details for the officer to check visually.
 * - Areas are council-scoped: `com-rpa7` user facing, `<linkingId>-com-rpa7` operationally.
 */
import { localDateString } from './time';
import { normalisePlate, plateKey } from './plate';
import { registrationTypeCode, vehicleTypeCode, REGISTRATION_STATES } from './vehicle';
import type { AllowEntry, PermitType } from './types';

export const PERMIT_TYPE_LABEL: Record<PermitType, string> = {
  RPA: 'Residential parking area',
  RSP: 'Residential street permit',
  RP: 'Resident permit',
  FS: 'Foreshore',
};

const NUMBER = /^((?:RPA|RSP|RP|FS|COMB)(?:\/(?:RPA|RSP|RP|FS|COMB))*)-(\d{4})-(\d{4})(?:\/(\d+))?$/;

export interface PermitNumberParts {
  prefix: string;
  types: PermitType[];
  combination: boolean;
  issueYear: number;
  sequentialId: string;
  amendmentVersion: number | null;
}

/** Parse a permit number, or null when it does not follow the format. */
export function parsePermitNumber(n: string): PermitNumberParts | null {
  const m = NUMBER.exec(n.trim().toUpperCase());
  if (!m) return null;
  const tokens = m[1]!.split('/');
  const combination = tokens.includes('COMB');
  const types = [...new Set(tokens.filter((t) => t !== 'COMB'))] as PermitType[];
  // A combination lists two or more types with COMB; a single type has no COMB.
  if (!types.length || (combination ? types.length < 2 : types.length > 1)) return null;
  const year = Number(m[2]);
  if (year < 2000 || year > 2099) return null;
  return { prefix: m[1]!, types, combination, issueYear: year, sequentialId: m[3]!, amendmentVersion: m[4] ? Number(m[4]) : null };
}

/** valid / expired at `at`: expiry is midnight at the end of valid-to; before valid-from is not valid either. */
export function permitValidity(e: Pick<AllowEntry, 'validFrom' | 'validTo'>, at: number): { status: 'valid' | 'expired'; notYetValid: boolean } {
  const today = localDateString(at);
  if (e.validFrom && today < e.validFrom) return { status: 'expired', notYetValid: true };
  if (e.validTo && today > e.validTo) return { status: 'expired', notYetValid: false };
  return { status: 'valid', notYetValid: false };
}

/** Area ID: `com-rpa7` user facing; `<linkingId>-com-rpa7` operationally (once onboarded). */
export function areaId(council: { code: string; linkingId?: string }, area: string, operational = false): string {
  const a = `${council.code.toLowerCase()}-rpa${area.toUpperCase()}`;
  return operational && council.linkingId ? `${council.linkingId}-${a}` : a;
}

/**
 * Area code from any of its spellings: 7, RPA 7, rpa7, com-rpa7, com-rpa-7, 919379201-com-rpa7.
 * Returns the council code when the spelling carries one.
 */
export function parseArea(v: string): { area: string; council?: string } {
  const m = /^(?:\d+-)?(?:([a-z]{2,8})-)?(?:rpa)?-?\s*([0-9]{1,2}[a-z]?)$/i.exec(v.trim().replace(/\s+/g, ' ').replace(/^rpa\s+/i, 'rpa'));
  return m ? { area: m[2]!.toUpperCase(), ...(m[1] && m[1].toLowerCase() !== 'rpa' ? { council: m[1].toLowerCase() } : {}) } : { area: v.trim().toUpperCase() };
}

/* ───────────────────────────── Permit JSON records ───────────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with one permit record (schema rules plus the derived-parts check), by path. */
export function validatePermitRecord(r: unknown, path = ''): string[] {
  const p = (k: string) => `${path}${k}`;
  if (!isObj(r)) return [`${path || 'permit'} must be an object`];
  const errs: string[] = [];
  const allowed = ['authority', 'permitNumber', 'prefix', 'issueYear', 'sequentialId', 'amendmentVersion', 'validFrom', 'validTo', 'parkingAreaCode', 'address', 'vehicle'];
  for (const k of Object.keys(r)) if (!allowed.includes(k)) errs.push(`${p(k)} is not a permit field`);
  const a = r.authority;
  if (!isObj(a) || typeof a.councilCode !== 'string' || !/^[a-z]{2,8}$/.test(a.councilCode)) errs.push(`${p('authority.councilCode')} must be a council code (e.g. com)`);
  else if (a.linkingId != null && (typeof a.linkingId !== 'string' || !/^\d+$/.test(a.linkingId))) errs.push(`${p('authority.linkingId')} must be digits`);
  const parts = typeof r.permitNumber === 'string' ? parsePermitNumber(r.permitNumber) : null;
  if (!parts) errs.push(`${p('permitNumber')} must be like RPA-2026-0789, RSP-2026-0790/1 or RPA/COMB/FS-2026-0791`);
  else {
    if (r.prefix !== undefined && r.prefix !== parts.prefix) errs.push(`${p('prefix')} does not match the permit number (${parts.prefix})`);
    if (r.issueYear !== undefined && r.issueYear !== parts.issueYear) errs.push(`${p('issueYear')} does not match the permit number (${parts.issueYear})`);
    if (r.sequentialId !== undefined && r.sequentialId !== parts.sequentialId) errs.push(`${p('sequentialId')} does not match the permit number (${parts.sequentialId})`);
    if (r.amendmentVersion !== undefined && (r.amendmentVersion ?? null) !== parts.amendmentVersion) errs.push(`${p('amendmentVersion')} does not match the permit number (${parts.amendmentVersion ?? 'none'})`);
    if (parts.types.includes('RPA') && (typeof r.parkingAreaCode !== 'string' || !r.parkingAreaCode)) errs.push(`${p('parkingAreaCode')} is required for an RPA permit`);
  }
  if (r.parkingAreaCode !== undefined && (typeof r.parkingAreaCode !== 'string' || !/^\d{1,2}[A-Z]?$/.test(r.parkingAreaCode))) errs.push(`${p('parkingAreaCode')} must be like 7, 4B or 15A`);
  for (const k of ['validFrom', 'validTo'] as const) if (typeof r[k] !== 'string' || !DATE.test(r[k] as string)) errs.push(`${p(k)} must be YYYY-MM-DD`);
  if (typeof r.validFrom === 'string' && typeof r.validTo === 'string' && r.validTo < r.validFrom) errs.push(`${p('validTo')} is before validFrom`);
  const ad = r.address;
  if (!isObj(ad) || typeof ad.streetNumber !== 'string' || !ad.streetNumber.trim() || typeof ad.street !== 'string' || !ad.street.trim()) errs.push(`${p('address')} needs streetNumber and street`);
  const v = r.vehicle;
  if (!isObj(v)) errs.push(`${p('vehicle')} is required`);
  else {
    for (const k of Object.keys(v)) if (!['registrationNumber', 'registrationState', 'registrationType', 'vehicleType', 'make', 'colour'].includes(k)) errs.push(`${p(`vehicle.${k}`)} is not a vehicle field`);
    if (typeof v.registrationNumber !== 'string' || !/^[A-Z0-9]{1,10}$/.test(v.registrationNumber)) errs.push(`${p('vehicle.registrationNumber')} must be 1–10 capital letters or digits`);
    if (v.registrationState !== undefined && !(REGISTRATION_STATES as readonly unknown[]).includes(v.registrationState)) errs.push(`${p('vehicle.registrationState')} must be one of ${REGISTRATION_STATES.join(', ')}`);
    if (typeof v.registrationType !== 'string' || !registrationTypeCode(v.registrationType)) errs.push(`${p('vehicle.registrationType')} must be private, commercial, company, lease, diplomatic or other`);
    if (typeof v.vehicleType !== 'string' || !vehicleTypeCode(v.vehicleType)) errs.push(`${p('vehicle.vehicleType')} is not a vehicle type on the list`);
    for (const k of ['make', 'colour'] as const) if (typeof v[k] !== 'string' || !(v[k] as string).trim()) errs.push(`${p(`vehicle.${k}`)} is required`);
  }
  return errs;
}

/** A validated permit record as a permit (allow) list entry. */
export function permitToEntry(r: Record<string, any>, id: string, now = Date.now()): AllowEntry {
  const parts = parsePermitNumber(r.permitNumber)!;
  const plate = normalisePlate(r.vehicle.registrationNumber);
  return {
    id,
    plate,
    key: plateKey(plate),
    label: parts.types.map((t) => PERMIT_TYPE_LABEL[t]).join(' + '),
    permitNo: r.permitNumber.trim().toUpperCase(),
    validFrom: r.validFrom,
    validTo: r.validTo,
    addedAt: now,
    permitTypes: parts.types,
    council: { code: r.authority.councilCode, ...(r.authority.linkingId ? { linkingId: r.authority.linkingId } : {}) },
    address: { streetNumber: r.address.streetNumber.trim(), street: r.address.street.trim() },
    ...(r.parkingAreaCode ? { rpa: r.parkingAreaCode } : {}),
    // RSP / RP apply on the registered address's street.
    ...(parts.types.some((t) => t === 'RSP' || t === 'RP') ? { streets: [r.address.street.trim()] } : {}),
    registrationType: registrationTypeCode(r.vehicle.registrationType)!,
    registrationState: r.vehicle.registrationState ?? 'VIC',
    bodyType: vehicleTypeCode(r.vehicle.vehicleType)!,
    make: r.vehicle.make.trim(),
    colour: r.vehicle.colour.trim(),
  };
}

/** Permit records in a JSON file: one permit, an array, or `{ "permits": [...] }`. Null when not permits. */
export function permitRecords(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data.length && data.every((x) => isObj(x) && 'permitNumber' in x) ? data : null;
  if (isObj(data) && Array.isArray(data.permits)) return data.permits;
  if (isObj(data) && 'permitNumber' in data) return [data];
  return null;
}
