/**
 * civicmaps.parking_dataset v1: the normalised exchange format for street segments and their
 * parking data, shared by PlateWatch and EnforcementMAPS (CivicMAPS). One dataset per council
 * area (a municipality, a patrol area, a precinct). Specified in docs/PARKING-DATA-SCHEMA.md
 * and schemas/civicmaps-parking-dataset.v1.schema.json.
 *
 * Model: dataset → segments (one road between two cross streets or boundaries) → sides → parts
 * (the whole side, or the stretch between two bounds where signs change) → payment, permit
 * area, restrictions and bays. Unknown values are null, never guessed; a part whose signs are
 * still to be surveyed says so in restrictions_status.
 *
 * This module validates and normalises datasets (applying `defaults`), turns them into
 * PlateWatch timed lists, and exports timed lists back to a dataset. It also converts the
 * earlier "street_segments + record_defaults" area datasets (e.g. City of Port Phillip
 * Patrol Area 10) into this format.
 */
import { uid } from './db';
import { minutesFromCode } from './restriction';
import type { PaymentAreas, StreetSide, TimedList, TimedRestriction, UntimedControl, Weekday } from './types';

export const DATASET_SCHEMA = 'civicmaps.parking_dataset';
export const DATASET_VERSION = '1.0.0';

/* ───────────────────────────── Types (mirror the JSON) ───────────────────────────── */

export interface LatLng {
  lat: number;
  lng: number;
}

export type VerificationStatus = 'verified' | 'field_checked' | 'unverified' | 'inferred' | 'pending_field_capture';

export interface DataQuality {
  status: VerificationStatus;
  source?: string | null;
  confidence?: 'high' | 'medium' | 'low' | null;
  last_verified?: string | null;
  notes?: string | null;
}

export interface DatasetSource {
  id: string;
  name: string;
  publisher?: string | null;
  url?: string | null;
  format?: string | null;
  reference_date?: string | null;
  data_used?: string[];
  limitations?: string[];
}

export type DayCode = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const DAY_CODES: readonly DayCode[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const CONTROLS = [
  'time_limit',
  'metered',
  'ticket',
  'loading_zone',
  'permit_zone',
  'no_stopping',
  'no_parking',
  'clearway',
  'bus_zone',
  'taxi_zone',
  'accessible',
  'works_zone',
  'other',
] as const;
export type Control = (typeof CONTROLS)[number];

export interface Restriction {
  control: Control;
  /** As printed on the sign: "2P", "1/2P", "P15", "LZ 30". */
  sign_code?: string | null;
  /** Time allowance; present for timed controls (time limit, metered, ticket, timed loading zone). */
  limit_minutes?: number | null;
  days: DayCode[];
  all_day?: boolean;
  /** Local 24 h "HH:MM"; end may be "24:00"; an end before the start runs overnight. */
  start?: string | null;
  end?: string | null;
  public_holidays?: 'applies' | 'excluded' | null;
  /** Exceptions as signed: "Permit Zone 7 excepted", "Disabled permit holders excepted". */
  exceptions?: string[];
  exempt_permit_areas?: string[];
  grace_minutes?: number | null;
  source_sign_id?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  data_quality?: DataQuality;
}

export type BoundKind = 'intersection' | 'segment_end' | 'bay' | 'address' | 'point' | 'boundary';
export interface Bound {
  kind: BoundKind;
  label: string;
  location?: LatLng | null;
}

export interface PaystayZone {
  zone: string;
  meter_id?: string | null;
}

export interface Payment {
  parking_area?: string | null;
  easypark_areas?: string[];
  paystay_zones?: PaystayZone[];
  meters?: { id: string; location?: LatLng | null }[];
}

export interface Bay {
  number: number;
  /** Number on the kerb plate when it is not given by the dataset's bay_sign convention. */
  sign_number?: string | null;
  location?: LatLng | null;
  kind?: 'standard' | 'accessible' | 'loading' | 'motorcycle' | 'ev' | 'other';
  data_quality?: DataQuality;
  notes?: string | null;
}

export type RestrictionsStatus = 'supplied' | 'pending_field_capture' | 'no_parking_spaces';

export interface Part {
  /** Unique within the segment; required when a side has more than one part. */
  id?: string;
  /** Absent from/to: the part is the whole side. */
  from?: Bound | null;
  to?: Bound | null;
  permit_area?: string | null;
  payment?: Payment;
  restrictions_status: RestrictionsStatus;
  restrictions: Restriction[];
  bays?: Bay[];
  data_quality?: DataQuality;
  notes?: string | null;
}

export type SideCode = 'both' | 'north' | 'south' | 'east' | 'west' | 'odd' | 'even';
export interface Side {
  side: SideCode;
  parts: Part[];
}

export interface Segment {
  /** Stable and unique within the dataset (re-imports match on it). */
  id: string;
  /** The council's road segment asset ID (e.g. City of Melbourne road corridor 20055); null until known. */
  road_segment_id?: string | null;
  patrol_zone?: string | null;
  road: { name: string; locality?: string | null; external_ids?: Record<string, string> };
  between: { from: string; to: string };
  geometry?: { type: 'LineString' | 'MultiLineString'; coordinates: unknown } | null;
  sides: Side[];
  data_quality?: DataQuality;
  notes?: string | null;
}

export interface PatrolZone {
  id: string;
  number?: string | null;
  name?: string | null;
  kind?: 'patrol_area' | 'enforcement_zone' | 'precinct';
  geometry?: unknown;
}

export interface ParkingDataset {
  schema: typeof DATASET_SCHEMA;
  schema_version: string;
  dataset: {
    id: string;
    title: string;
    status: 'draft' | 'in_review' | 'enforcement_ready' | 'superseded';
    generated_at?: string | null;
    municipality: { name: string; code?: string | null; state?: string | null; country?: string | null; timezone: string };
    sources?: DatasetSource[];
    notes?: string[];
  };
  conventions?: {
    /** How kerb bay plates are numbered, e.g. "{parking_area}{bay}" (City of Melbourne). Null: no numbered bay plates. */
    bay_sign_format?: string | null;
    paystay_zone_pattern?: string | null;
    easypark_area_pattern?: string | null;
    notes?: string[];
  };
  patrol_zones?: PatrolZone[];
  permit_areas?: { id: string; code: string; name?: string | null }[];
  /** Applied to every segment unless the segment gives its own value (objects merge, arrays replace). */
  defaults?: Partial<Omit<Segment, 'id' | 'road' | 'between'>>;
  segments: Segment[];
}

/* ───────────────────────────── Validation ───────────────────────────── */

export interface DatasetError {
  path: string;
  message: string;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const SIDES: SideCode[] = ['both', 'north', 'south', 'east', 'west', 'odd', 'even'];
const TIMED_CONTROLS = new Set<Control>(['time_limit', 'metered', 'ticket', 'loading_zone']);

/** Deep merge for `defaults`: objects merge, arrays and scalars from `over` replace. */
function merge<T>(base: unknown, over: T): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v === undefined ? base[k] : v;
  return out as T;
}

/** Segments with the dataset's defaults applied. */
export function resolvedSegments(d: ParkingDataset): Segment[] {
  return d.segments.map((s) => (d.defaults ? merge(structuredClone(d.defaults), s) : s));
}

/**
 * Structural checks with readable paths, after applying defaults. Mirrors the JSON Schema for
 * the rules that matter on a device (it does not replace schema validation in a pipeline).
 */
export function validateDataset(input: unknown): DatasetError[] {
  const errors: DatasetError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  if (!isObj(input)) return [{ path: '', message: 'Dataset must be a JSON object.' }];
  if (input.schema !== DATASET_SCHEMA) err('schema', `must be "${DATASET_SCHEMA}"`);
  if (typeof input.schema_version !== 'string' || !input.schema_version.startsWith('1.')) err('schema_version', 'must be a 1.x version');
  const ds = input.dataset;
  if (!isObj(ds)) err('dataset', 'is required');
  else {
    if (typeof ds.id !== 'string' || !ds.id) err('dataset.id', 'is required');
    if (typeof ds.title !== 'string') err('dataset.title', 'is required');
    if (!isObj(ds.municipality) || typeof ds.municipality.name !== 'string' || typeof ds.municipality.timezone !== 'string')
      err('dataset.municipality', 'needs name and timezone');
  }
  if (!Array.isArray(input.segments)) {
    err('segments', 'must be an array');
    return errors;
  }
  const zones = new Set((Array.isArray(input.patrol_zones) ? input.patrol_zones : []).filter(isObj).map((z) => z.id));
  const ids = new Set<string>();
  resolvedSegments(input as unknown as ParkingDataset).forEach((s, i) => {
    const p = `segments[${i}]`;
    if (!isObj(s)) return err(p, 'must be an object');
    if (typeof s.id !== 'string' || !s.id) err(`${p}.id`, 'is required');
    else if (ids.has(s.id)) err(`${p}.id`, `"${s.id}" is used twice`);
    else ids.add(s.id);
    if (!isObj(s.road) || typeof s.road.name !== 'string' || !s.road.name) err(`${p}.road.name`, 'is required');
    if (!isObj(s.between) || !s.between.from || !s.between.to) err(`${p}.between`, 'needs from and to');
    if (s.patrol_zone && zones.size && !zones.has(s.patrol_zone)) err(`${p}.patrol_zone`, `"${s.patrol_zone}" is not in patrol_zones`);
    if (!Array.isArray(s.sides) || !s.sides.length) return err(`${p}.sides`, 'needs at least one side (from the segment or defaults)');
    s.sides.forEach((side, j) => {
      const sp = `${p}.sides[${j}]`;
      if (!SIDES.includes(side?.side)) err(`${sp}.side`, `must be one of ${SIDES.join(', ')}`);
      if (!Array.isArray(side?.parts) || !side.parts.length) return err(`${sp}.parts`, 'needs at least one part');
      const partIds = new Set<string>();
      side.parts.forEach((part, k) => {
        const pp = `${sp}.parts[${k}]`;
        if (side.parts.length > 1 && !part.id) err(`${pp}.id`, 'is required when a side has more than one part');
        if (part.id && partIds.has(part.id)) err(`${pp}.id`, `"${part.id}" is used twice`);
        if (part.id) partIds.add(part.id);
        if (!['supplied', 'pending_field_capture', 'no_parking_spaces'].includes(part.restrictions_status)) err(`${pp}.restrictions_status`, 'must be supplied, pending_field_capture or no_parking_spaces');
        if (!Array.isArray(part.restrictions)) return err(`${pp}.restrictions`, 'must be an array (empty when pending)');
        part.restrictions.forEach((r, m) => validateRestriction(r, `${pp}.restrictions[${m}]`, err));
        (part.bays ?? []).forEach((b, m) => {
          if (!Number.isInteger(b?.number) || b.number < 0) err(`${pp}.bays[${m}].number`, 'must be a whole number');
          if (b?.location && !validLatLng(b.location)) err(`${pp}.bays[${m}].location`, 'needs lat −90…90 and lng −180…180');
        });
      });
    });
  });
  return errors;
}

const validLatLng = (l: unknown): boolean => isObj(l) && typeof l.lat === 'number' && typeof l.lng === 'number' && Math.abs(l.lat) <= 90 && Math.abs(l.lng) <= 180;

function validateRestriction(r: Restriction, p: string, err: (path: string, message: string) => void) {
  if (!CONTROLS.includes(r?.control)) return err(`${p}.control`, `must be one of ${CONTROLS.join(', ')}`);
  if (!Array.isArray(r.days) || !r.days.length || r.days.some((d) => !DAY_CODES.includes(d))) err(`${p}.days`, 'must list days as mon…sun');
  if (!r.all_day && (!HHMM.test(r.start ?? '') || !HHMM.test(r.end ?? '') || r.start === r.end)) err(`${p}`, 'needs start and end (HH:MM) or all_day: true');
  if ((r.control === 'time_limit' || r.control === 'metered' || r.control === 'ticket') && !(Number(r.limit_minutes) > 0))
    err(`${p}.limit_minutes`, `is required for ${r.control}`);
}

/* ───────────────────────────── Dataset → PlateWatch ───────────────────────────── */

export interface DatasetDraft {
  list: Omit<TimedList, 'id' | 'createdAt' | 'updatedAt'>;
  pending: boolean;
}

const DAY_INDEX: Record<DayCode, Weekday> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const CONTROL_LABEL: Record<Control, string> = {
  time_limit: 'Time limit',
  metered: 'Meter',
  ticket: 'Ticket',
  loading_zone: 'Loading zone',
  permit_zone: 'Permit zone',
  no_stopping: 'No stopping',
  no_parking: 'No parking',
  clearway: 'Clearway',
  bus_zone: 'Bus zone',
  taxi_zone: 'Taxi zone',
  accessible: 'Accessible parking',
  works_zone: 'Works zone',
  other: 'Other',
};

const zoneTitle = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

function timesOf(r: Restriction): { allDay: boolean; startTime: string; endTime: string } {
  return r.all_day || (r.start === '00:00' && r.end === '24:00')
    ? { allDay: true, startTime: '00:00', endTime: '24:00' }
    : { allDay: false, startTime: r.start!, endTime: r.end! };
}

/** One PlateWatch timed list per part: the external ID ties it back to the dataset. */
export function datasetToDrafts(d: ParkingDataset): { drafts: DatasetDraft[]; skipped: string[] } {
  const zones = new Map((d.patrol_zones ?? []).map((z) => [z.id, z]));
  const permits = new Map((d.permit_areas ?? []).map((p) => [p.id, p.code]));
  const drafts: DatasetDraft[] = [];
  const skipped: string[] = [];
  for (const s of resolvedSegments(d)) {
    const zone = s.patrol_zone ? zones.get(s.patrol_zone) : undefined;
    for (const side of s.sides) {
      for (const part of side.parts) {
        const where = `${s.road.name} ${s.between.from} – ${s.between.to}, ${side.side === 'both' ? 'both sides' : `${side.side} side`}${part.id ? ` (${part.id})` : ''}`;
        if (part.restrictions_status === 'no_parking_spaces') {
          skipped.push(`${where}: no parking spaces`);
          continue;
        }
        const restrictions: TimedRestriction[] = [];
        const untimed: UntimedControl[] = [];
        for (const r of part.restrictions) {
          const t = timesOf(r);
          const days = [...new Set(r.days.map((x) => DAY_INDEX[x]))].sort((a, b) => a - b);
          const description = [r.control === 'metered' || r.control === 'ticket' ? CONTROL_LABEL[r.control] : '', ...(r.exceptions ?? [])].filter(Boolean).join(' · ');
          const minutes = r.limit_minutes ?? (r.sign_code ? minutesFromCode(r.sign_code) : null);
          if (TIMED_CONTROLS.has(r.control) && minutes) {
            const code = r.sign_code || (r.control === 'loading_zone' ? `LZ${minutes}` : `${minutes} min`);
            restrictions.push({ id: uid(), code, limitMinutes: minutes, graceMinutes: r.grace_minutes ?? 0, days, ...t, description });
          } else {
            untimed.push({ control: r.control, label: r.sign_code || CONTROL_LABEL[r.control], days, ...t, description });
          }
        }
        if (part.restrictions_status === 'supplied' && !restrictions.length) {
          skipped.push(`${where}: no timed parking (${[...new Set(untimed.map((u) => u.label))].join('; ') || 'no restrictions'})`);
          continue;
        }
        const bays = (part.bays ?? []).filter((b) => Number.isInteger(b.number));
        const pay = part.payment ?? {};
        const payment: PaymentAreas = {
          ...(pay.parking_area ? { parkingArea: pay.parking_area } : {}),
          easyPark: [...(pay.easypark_areas ?? [])],
          payStay: (pay.paystay_zones ?? []).map((z) => ({ zone: z.zone, meter: z.meter_id ?? '' })),
        };
        const sub = part.from || part.to ? { ...(part.from ? { subFrom: part.from.label } : {}), ...(part.to ? { subTo: part.to.label } : {}) } : {};
        const notes = [part.notes, s.notes].filter(Boolean).join('\n');
        drafts.push({
          pending: !restrictions.length,
          list: {
            type: 'timed',
            name: listName(s, side.side, part),
            notes,
            segment: { street: s.road.name, fromStreet: s.between.from, toStreet: s.between.to, side: side.side as StreetSide, suburb: s.road.locality ?? '', ...sub },
            restrictions,
            allowListIds: [],
            externalId: externalId(d.dataset.id, s.id, side.side, part.id),
            // A zone listed with a number: that number; listed with only a name: the name; not listed: the id as given.
            ...(zoneNumber(s.patrol_zone, zone) ? { patrolZone: zoneNumber(s.patrol_zone, zone)! } : {}),
            ...(zone?.name ? { patrolZoneName: zoneTitle(zone.name) } : {}),
            ...(part.permit_area ? { rpa: permits.get(part.permit_area) ?? part.permit_area } : {}),
            ...(s.road_segment_id ? { roadSegmentId: s.road_segment_id } : {}),
            ...(payment.parkingArea || payment.easyPark.length || payment.payStay.length ? { payment } : {}),
            ...(bays.length ? { bays: [...new Set(bays.map((b) => b.number))].sort((a, b) => a - b) } : {}),
            ...(bays.some((b) => b.location) ? { bayPoints: bays.filter((b) => b.location).map((b) => ({ bay: b.number, lat: b.location!.lat, lng: b.location!.lng, ...(b.sign_number ? { sign: b.sign_number } : {}) })) } : {}),
            ...(untimed.length ? { untimedControls: untimed } : {}),
          },
        });
      }
    }
  }
  return { drafts, skipped };
}

function zoneNumber(id: string | null | undefined, zone: PatrolZone | undefined): string | null {
  if (!id) return null;
  if (!zone) return id;
  return zone.number ?? (zone.name ? null : zone.id);
}

export const externalId = (dataset: string, segment: string, side: string, part?: string) => `${dataset}/${segment}/${side}${part ? `/${part}` : ''}`;

function listName(s: Segment, side: SideCode, part: Part): string {
  const short = (n: string) => n.replace(/\b(Street|Road|Avenue|Parade|Place|Highway|Crescent|Court|Drive|Terrace|Boulevard)$/, (w) => ({ Street: 'St', Road: 'Rd', Avenue: 'Ave', Parade: 'Pde', Place: 'Pl', Highway: 'Hwy', Crescent: 'Cres', Court: 'Ct', Drive: 'Dr', Terrace: 'Tce', Boulevard: 'Bvd' })[w] ?? w);
  const sideLetter = side === 'both' ? '' : ` (${side === 'odd' || side === 'even' ? side : side[0]!.toUpperCase()})`;
  const sub = part.from || part.to ? ` · ${part.from ? short(part.from.label) : '…'} – ${part.to ? short(part.to.label) : '…'}` : '';
  return `${short(s.road.name)}, ${short(s.between.from)} – ${short(s.between.to)}${sideLetter}${sub}`;
}

/* ───────────────────────────── PlateWatch → Dataset ───────────────────────────── */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const WEEKDAY_CODE: DayCode[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function boundFrom(label: string | undefined): Bound | null {
  if (!label) return null;
  if (/^bay\s*\d+/i.test(label)) return { kind: 'bay', label };
  if (/^point\s+-?\d/i.test(label)) return { kind: 'point', label };
  if (/^\d/.test(label) || /\b(outside|opposite)\b/i.test(label)) return { kind: 'address', label };
  return { kind: 'intersection', label };
}

function restrictionFrom(r: TimedRestriction): Restriction {
  const metered = /\bmeter\b/i.test(r.description);
  const ticket = /\bticket\b/i.test(r.description);
  const exceptions = r.description.split(' · ').map((x) => x.trim()).filter((x) => x && !/^(meter|ticket)$/i.test(x));
  return {
    control: /^LZ/i.test(r.code) ? 'loading_zone' : metered ? 'metered' : ticket ? 'ticket' : 'time_limit',
    sign_code: r.code,
    limit_minutes: r.limitMinutes,
    days: r.days.map((d) => WEEKDAY_CODE[d]!),
    ...(r.allDay ? { all_day: true } : { start: r.startTime, end: r.endTime }),
    ...(exceptions.length ? { exceptions } : {}),
    ...(r.graceMinutes ? { grace_minutes: r.graceMinutes } : {}),
  };
}

function untimedFrom(u: UntimedControl): Restriction {
  return {
    control: u.control,
    ...(u.label && u.label !== CONTROL_LABEL[u.control] ? { sign_code: u.label } : {}),
    days: u.days.map((d) => WEEKDAY_CODE[d]!),
    ...(u.allDay ? { all_day: true } : { start: u.startTime, end: u.endTime }),
    ...(u.description ? { exceptions: [u.description] } : {}),
  };
}

/**
 * Export timed lists as a dataset. Lists imported from a dataset keep their segment, side and
 * part IDs; others get IDs from their street names. Lists of one road segment (same road,
 * cross streets or road segment ID) become one segment with a side per list side.
 */
export function listsToDataset(
  lists: readonly TimedList[],
  meta: { id: string; title: string; municipality: string; timezone: string; generatedAt?: string },
): ParkingDataset {
  const segments = new Map<string, Segment>();
  const zones = new Map<string, PatrolZone>();
  const permitAreas = new Map<string, { id: string; code: string }>();
  for (const l of lists) {
    const [, segId, , partId] = (l.externalId ?? '').split('/');
    const pairKey = [l.segment.fromStreet, l.segment.toStreet].map(slug).sort().join('--');
    const key = segId || l.roadSegmentId || `${slug(l.segment.street)}--${pairKey}`;
    const id = segId || (l.roadSegmentId ? `segment-${l.roadSegmentId}` : `${slug(l.segment.street)}-${slug(l.segment.fromStreet)}-${slug(l.segment.toStreet)}`);
    let seg = segments.get(key);
    const zoneId = l.patrolZone?.trim() || (l.patrolZoneName ? slug(l.patrolZoneName) : '');
    if (zoneId && !zones.has(zoneId)) zones.set(zoneId, { id: zoneId, number: l.patrolZone?.trim() || null, name: l.patrolZoneName?.trim() || null, kind: 'patrol_area' });
    if (!seg) {
      seg = {
        id,
        ...(l.roadSegmentId ? { road_segment_id: l.roadSegmentId } : {}),
        ...(zoneId ? { patrol_zone: zoneId } : {}),
        road: { name: l.segment.street, ...(l.segment.suburb ? { locality: l.segment.suburb } : {}) },
        between: { from: l.segment.fromStreet, to: l.segment.toStreet },
        sides: [],
      };
      segments.set(key, seg);
    }
    let side = seg.sides.find((x) => x.side === l.segment.side);
    if (!side) seg.sides.push((side = { side: l.segment.side, parts: [] }));
    const payment: Payment = {
      ...(l.payment?.parkingArea ? { parking_area: l.payment.parkingArea } : {}),
      ...(l.payment?.easyPark.length ? { easypark_areas: [...l.payment.easyPark] } : {}),
      ...(l.payment?.payStay.length ? { paystay_zones: l.payment.payStay.map((p) => ({ zone: p.zone, meter_id: p.meter || null })) } : {}),
    };
    if (l.rpa) permitAreas.set(l.rpa, { id: l.rpa, code: l.rpa });
    const points = new Map((l.bayPoints ?? []).map((b) => [b.bay, b]));
    const bays: Bay[] = (l.bays ?? []).map((n) => {
      const p = points.get(n);
      return { number: n, ...(p ? { location: { lat: p.lat, lng: p.lng } } : {}), ...(p?.sign ? { sign_number: p.sign } : {}) };
    });
    const restrictions = [...l.restrictions.map(restrictionFrom), ...(l.untimedControls ?? []).map(untimedFrom)];
    side.parts.push({
      ...(partId || l.segment.subFrom || l.segment.subTo ? { id: partId || slug(`${l.segment.subFrom ?? ''}-${l.segment.subTo ?? ''}`) } : {}),
      ...(l.segment.subFrom ? { from: boundFrom(l.segment.subFrom) } : {}),
      ...(l.segment.subTo ? { to: boundFrom(l.segment.subTo) } : {}),
      ...(l.rpa ? { permit_area: l.rpa } : {}),
      ...(Object.keys(payment).length ? { payment } : {}),
      restrictions_status: l.restrictions.length || l.untimedControls?.length ? 'supplied' : 'pending_field_capture',
      restrictions,
      ...(bays.length ? { bays } : {}),
      ...(l.notes ? { notes: l.notes } : {}),
    });
  }
  // A side with several parts needs an id on each.
  for (const seg of segments.values()) for (const side of seg.sides) if (side.parts.length > 1) side.parts.forEach((p, i) => (p.id ??= `part-${i + 1}`));
  return {
    schema: DATASET_SCHEMA,
    schema_version: DATASET_VERSION,
    dataset: { id: meta.id, title: meta.title, status: 'draft', generated_at: meta.generatedAt ?? new Date().toISOString(), municipality: { name: meta.municipality, timezone: meta.timezone } },
    ...(zones.size ? { patrol_zones: [...zones.values()] } : {}),
    ...(permitAreas.size ? { permit_areas: [...permitAreas.values()] } : {}),
    segments: [...segments.values()],
  };
}

/* ───────────────────────────── Earlier area datasets ───────────────────────────── */

/** "street_segments" + "record_defaults" area datasets, e.g. City of Port Phillip Patrol Area 10. */
export function isAreaDataset(v: unknown): boolean {
  return isObj(v) && Array.isArray(v.street_segments) && (isObj(v.record_defaults) || 'dataset_title' in v);
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/**
 * Convert an area dataset to civicmaps.parking_dataset. Its record_defaults become segment
 * values; placeholder restrictions (restriction_applied null) become pending_field_capture
 * parts with no restrictions; a supplied restriction is mapped to a control.
 */
export function convertAreaDataset(src: Json, opts: { municipalityTimezone?: string } = {}): { dataset: ParkingDataset; warnings: string[] } {
  const warnings: string[] = [];
  const defaults = isObj(src.record_defaults) ? src.record_defaults : {};
  const scope = isObj(src.scope) ? src.scope : {};
  const zoneIds = new Set<string>();
  const municipality = str(scope.municipality) || 'Unknown';
  const area = str(defaults.enforcement_zone) || (Array.isArray(scope.requested_enforcement_zones) ? str(scope.requested_enforcement_zones[0]) : '');
  const datasetId = slug(`${municipality} ${area ? `patrol area ${area}` : str(src.dataset_title)}`);
  const segments: Segment[] = [];
  for (const raw of (src.street_segments as unknown[]).filter(isObj)) {
    const r = { ...defaults, ...raw } as Json;
    const zone = str(r.enforcement_zone);
    if (zone) zoneIds.add(zone);
    const sideCode = (SIDES as string[]).includes(str(r.road_side)) ? (str(r.road_side) as SideCode) : 'both';
    const restrictions: Restriction[] = [];
    for (const pr of (Array.isArray(r.parking_restrictions) ? r.parking_restrictions : []).filter(isObj)) {
      if (!pr.restriction_applied) continue; // placeholder: nothing shown on the source map
      const mapped = mapAreaRestriction(pr);
      if (mapped) restrictions.push(mapped);
      else warnings.push(`${str(r.segment_id)}: restriction "${str(pr.restriction_applied)}" could not be mapped and was left out.`);
    }
    const dq = isObj(r.data_quality) ? r.data_quality : {};
    segments.push({
      id: str(r.segment_id) || slug(`${str(r.road_segment_name)}-${str(r.between_street_name)}-${str(r.and_street_name)}`),
      // The council's road segment asset ID; null (not guessed) until the source gives one.
      road_segment_id: str(r.road_segment_id) || str(r.road_segment_asset_id) || str(r.asset_id) || null,
      ...(zone ? { patrol_zone: zone } : {}),
      road: { name: str(r.road_segment_name) },
      between: { from: str(r.between_street_name), to: str(r.and_street_name) },
      geometry: isObj(r.geometry) ? (r.geometry as Segment['geometry']) : null,
      sides: [{ side: sideCode, parts: [{ restrictions_status: restrictions.length ? 'supplied' : 'pending_field_capture', restrictions }] }],
      data_quality: {
        status: restrictions.length ? 'unverified' : 'pending_field_capture',
        source: str(dq.street_segment_source) || null,
        notes: [str(dq.endpoints_status), str(dq.restriction_status)].filter(Boolean).join('; ') || null,
      },
    });
  }
  const sources: DatasetSource[] = (Array.isArray(src.accessible_sources) ? src.accessible_sources : []).filter(isObj).map((s, i) => ({
    id: slug(str(s.name)) || `source-${i + 1}`,
    name: str(s.name),
    publisher: str(s.publisher) || null,
    url: str(s.resource_url) || str(s.catalogue_url) || str(s.wfs_url) || null,
    format: str(s.format) || null,
    reference_date: str(s.reference_period) || str(s.document_date) || null,
    data_used: (Array.isArray(s.data_used) ? s.data_used : []).map(str).filter(Boolean),
    limitations: (Array.isArray(s.limitations) ? s.limitations : []).map(str).filter(Boolean),
  }));
  const notes = [str(scope.area_depicted), str(scope.important_distinction), ...(Array.isArray(src.missing_authoritative_fields) ? [`Missing authoritative fields: ${src.missing_authoritative_fields.map(str).join(', ')}`] : [])].filter(Boolean);
  return {
    warnings,
    dataset: {
      schema: DATASET_SCHEMA,
      schema_version: DATASET_VERSION,
      dataset: {
        id: datasetId,
        title: str(src.dataset_title) || datasetId,
        status: 'draft',
        generated_at: null,
        municipality: { name: municipality, state: /port phillip|melbourne/i.test(municipality) ? 'VIC' : null, country: 'AU', timezone: opts.municipalityTimezone ?? 'Australia/Melbourne' },
        sources,
        notes,
      },
      ...(/port phillip/i.test(municipality)
        ? { conventions: { bay_sign_format: null, paystay_zone_pattern: '^3388\\d+$', notes: ['PayStay zone numbers begin 3388, then the assigned segment number, then four digits for the side of the road.'] } }
        : {}),
      patrol_zones: [...zoneIds].map((z) => ({ id: z, number: z, name: null, kind: 'patrol_area' as const })),
      ...factorDefaults(segments),
    },
  };
}

/** Move values every segment shares (zone, sides, data quality) into `defaults`, as record_defaults did. */
function factorDefaults(segments: Segment[]): { defaults?: ParkingDataset['defaults']; segments: Segment[] } {
  const keys = ['road_segment_id', 'patrol_zone', 'sides', 'data_quality', 'geometry'] as const;
  const defaults: Record<string, unknown> = {};
  for (const k of keys) {
    const first = JSON.stringify(segments[0]?.[k]);
    if (segments.length > 1 && first !== undefined && segments.every((s) => JSON.stringify(s[k]) === first)) defaults[k] = segments[0]![k];
  }
  if (!Object.keys(defaults).length) return { segments };
  return {
    defaults: defaults as ParkingDataset['defaults'],
    segments: segments.map((s) => {
      const lean = { ...s } as Record<string, unknown>;
      for (const k of Object.keys(defaults)) delete lean[k];
      return lean as unknown as Segment;
    }),
  };
}

const AREA_CONTROL: [RegExp, Control][] = [
  [/no\s*stopping/i, 'no_stopping'],
  [/no\s*parking/i, 'no_parking'],
  [/clearway/i, 'clearway'],
  [/loading/i, 'loading_zone'],
  [/permit/i, 'permit_zone'],
  [/bus/i, 'bus_zone'],
  [/taxi/i, 'taxi_zone'],
  [/disab|accessible/i, 'accessible'],
  [/meter/i, 'metered'],
  [/ticket/i, 'ticket'],
];

function mapAreaRestriction(pr: Json): Restriction | null {
  const text = str(pr.restriction_applied);
  const code = /(\d+\/\d+P|\d+P|P\d+)/i.exec(text)?.[1]?.toUpperCase() ?? null;
  const control = AREA_CONTROL.find(([re]) => re.test(text))?.[1] ?? (code ? 'time_limit' : null);
  if (!control) return null;
  const days = (Array.isArray(pr.applicable_days) ? pr.applicable_days : []).map((d) => str(d).slice(0, 3).toLowerCase()).filter((d): d is DayCode => DAY_CODES.includes(d as DayCode));
  const t = isObj(pr.applicable_times) ? pr.applicable_times : {};
  const start = str(t.start);
  const end = str(t.end);
  const limit = code ? minutesFromCode(code) : null;
  return {
    control,
    sign_code: code ?? text,
    ...(limit ? { limit_minutes: limit } : {}),
    days: days.length ? days : [...DAY_CODES],
    ...(start && end ? { start, end } : { all_day: true }),
    exceptions: (Array.isArray(pr.permit_or_vehicle_exceptions) ? pr.permit_or_vehicle_exceptions : []).map(str).filter(Boolean),
    source_sign_id: str(pr.source_sign_or_asset_id) || null,
    effective_from: str(pr.effective_from) || null,
    effective_to: str(pr.effective_to) || null,
    data_quality: { status: str(pr.verification_status) === 'verified' ? 'verified' : 'unverified' },
  };
}
