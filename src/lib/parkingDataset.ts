/**
 * civicmaps.parking_dataset v1: the normalised exchange format for street segments and their
 * parking data, shared by PlateWatch and EnforcementMAPS (CivicMAPS). Specified in
 * docs/PARKING-DATA-SCHEMA.md and schemas/civicmaps-parking-dataset.v1.schema.json.
 *
 * The structure is fixed and identical for every council: every record carries every key, with
 * null (or an empty list) where a value is unknown or not yet acquired. Council data is adapted
 * to this structure on the way in; the structure never adapts to a council's own system.
 *
 * Identifiers follow one rule for every council, from the council code ("com", "copp"):
 *   dataset      <code>-<area slug>                 copp-patrol-area-10
 *   segment      <code>-<road_segment_id>           copp-31065, com-20055
 *                (asset ID not yet known: <code>-<road>-<from>-<to>, provisional)
 *   patrol zone  <code>-<number | name slug>        copp-10, com-chinatown
 *   permit area  <code>-rpa-<code>                  copp-rpa-7
 *
 * Model: dataset → segments (one road between two cross streets or boundaries) → sides → parts
 * (the whole side, or the stretch between two bounds where signs change) → payment, permit
 * area, restrictions and bays.
 */
import { uid } from './db';
import { minutesFromCode } from './restriction';
import type { PaymentAreas, StreetSide, TimedList, TimedRestriction, UntimedControl, Weekday } from './types';

export const DATASET_SCHEMA = 'civicmaps.parking_dataset';
export const DATASET_VERSION = '1.0.0';

/* ───────────────────────────── Types (mirror the JSON: every key present) ───────────────────────────── */

export interface LatLng {
  lat: number;
  lng: number;
}

export type VerificationStatus = 'verified' | 'field_checked' | 'unverified' | 'inferred' | 'pending_field_capture';

export interface DataQuality {
  status: VerificationStatus;
  source: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  last_verified: string | null;
  notes: string | null;
}

export interface DatasetSource {
  id: string;
  name: string;
  publisher: string | null;
  url: string | null;
  format: string | null;
  reference_date: string | null;
  data_used: string[];
  limitations: string[];
}

export type DayCode = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
/** In the order of Date#getDay (Sunday first). */
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
  sign_code: string | null;
  /** Time allowance; required for time_limit, metered and ticket, and for a timed loading zone. */
  limit_minutes: number | null;
  days: DayCode[];
  all_day: boolean;
  /** Local 24 h "HH:MM" (null when all_day); end may be "24:00"; an end before the start runs overnight. */
  start: string | null;
  end: string | null;
  public_holidays: 'applies' | 'excluded' | null;
  exceptions: string[];
  exempt_permit_areas: string[];
  grace_minutes: number | null;
  source_sign_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  data_quality: DataQuality;
}

export type BoundKind = 'intersection' | 'segment_end' | 'bay' | 'address' | 'point' | 'boundary';
export interface Bound {
  kind: BoundKind;
  label: string;
  location: LatLng | null;
}

export interface PaystayZone {
  zone: string;
  meter_id: string | null;
}

export interface Meter {
  id: string;
  location: LatLng | null;
}

export interface Payment {
  parking_area: string | null;
  easypark_areas: string[];
  paystay_zones: PaystayZone[];
  meters: Meter[];
}

export type BayKind = 'standard' | 'accessible' | 'loading' | 'motorcycle' | 'ev' | 'other';
export interface Bay {
  number: number;
  /** Kerb plate number when it does not follow conventions.bay_sign_format; otherwise null. */
  sign_number: string | null;
  location: LatLng | null;
  kind: BayKind | null;
  data_quality: DataQuality;
  notes: string | null;
}

export type RestrictionsStatus = 'supplied' | 'pending_field_capture' | 'no_parking_spaces';

export interface Part {
  /** Unique within its side: "all" for the whole side, otherwise from the bounds ("bay-58-bay-72"). */
  id: string;
  /** Null from/to: the part is the whole side. */
  from: Bound | null;
  to: Bound | null;
  permit_area: string | null;
  payment: Payment;
  restrictions_status: RestrictionsStatus;
  restrictions: Restriction[];
  bays: Bay[];
  data_quality: DataQuality;
  notes: string | null;
}

export type SideCode = 'both' | 'north' | 'south' | 'east' | 'west' | 'odd' | 'even';
export interface Side {
  side: SideCode;
  parts: Part[];
}

export interface Geometry {
  type: 'LineString' | 'MultiLineString';
  coordinates: unknown[];
}

export interface Segment {
  /** <code>-<road_segment_id>; provisional <code>-<road>-<from>-<to> until the asset ID is known. */
  id: string;
  /** The council's road segment asset ID; null until acquired. */
  road_segment_id: string | null;
  /** patrol_zones[].id */
  patrol_zone: string | null;
  road: { name: string; locality: string | null; external_ids: Record<string, string> };
  between: { from: string; to: string };
  geometry: Geometry | null;
  sides: Side[];
  data_quality: DataQuality;
  notes: string | null;
}

export interface PatrolZone {
  id: string;
  number: string | null;
  name: string | null;
  kind: 'patrol_area' | 'enforcement_zone' | 'precinct';
  geometry: unknown | null;
}

export interface PermitArea {
  id: string;
  code: string;
  name: string | null;
}

export interface Municipality {
  name: string;
  /** Short council code used in every identifier: "com" (City of Melbourne), "copp" (City of Port Phillip). */
  code: string;
  state: string | null;
  country: string | null;
  timezone: string;
}

export interface Conventions {
  /** How kerb bay plates are numbered, e.g. "{parking_area}{bay}" (City of Melbourne); null: no numbered plates. */
  bay_sign_format: string | null;
  paystay_zone_pattern: string | null;
  easypark_area_pattern: string | null;
  notes: string[];
}

export interface ParkingDataset {
  schema: typeof DATASET_SCHEMA;
  schema_version: string;
  dataset: {
    id: string;
    title: string;
    status: 'draft' | 'in_review' | 'enforcement_ready' | 'superseded';
    generated_at: string | null;
    municipality: Municipality;
    sources: DatasetSource[];
    notes: string[];
  };
  conventions: Conventions;
  patrol_zones: PatrolZone[];
  permit_areas: PermitArea[];
  segments: Segment[];
}

/* ───────────────────────────── Councils and identifiers ───────────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Councils whose code and conventions are known. Others get a code from their name's initials. */
export const COUNCILS: Record<string, { code: string; state: string; conventions: Partial<Conventions> }> = {
  'city of melbourne': {
    code: 'com',
    state: 'VIC',
    conventions: { bay_sign_format: '{parking_area}{bay}', notes: ['Kerb bay plates: parking area followed by bay number (645 + 58 = 64558).'] },
  },
  'city of port phillip': {
    code: 'copp',
    state: 'VIC',
    conventions: { paystay_zone_pattern: '^3388\\d+$', notes: ['PayStay zones: 3388, the assigned segment number, then four digits for the side of the road.'] },
  },
};

/** "City of Port Phillip" → "copp", "City of Melbourne" → "com"; otherwise the initials of the name. */
export function councilCode(name: string): string {
  const known = COUNCILS[name.trim().toLowerCase()];
  if (known) return known.code;
  return (
    name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w[0]!.toLowerCase())
      .join('') || 'council'
  );
}

/** Road and street names in the usual short form for identifiers: "Normanby Road" → "normanby-rd". */
const ID_SHORT: Record<string, string> = { street: 'st', road: 'rd', avenue: 'ave', parade: 'pde', place: 'pl', highway: 'hwy', crescent: 'cres', court: 'ct', drive: 'dr', terrace: 'tce', boulevard: 'bvd', lane: 'la' };
const idName = (s: string) =>
  slug(s)
    .split('-')
    .map((w, i, all) => (i === all.length - 1 && all.length > 1 ? ID_SHORT[w] ?? w : w))
    .join('-');

/** <code>-<road_segment_id>, or the provisional <code>-<road>-<from>-<to> while the asset ID is unknown. */
export function segmentIdFor(code: string, roadSegmentId: string | null, road: string, from: string, to: string): string {
  return roadSegmentId ? `${code}-${slug(roadSegmentId)}` : `${code}-${idName(road)}-${idName(from)}-${idName(to)}`;
}

export const zoneIdFor = (code: string, number: string | null, name: string | null) => `${code}-${slug(number || name || 'zone')}`;
export const permitAreaIdFor = (code: string, permitCode: string) => `${code}-rpa-${slug(permitCode)}`;
export const partIdFor = (from: Bound | null, to: Bound | null) => (from || to ? slug(`${from?.label ?? 'start'}-${to?.label ?? 'end'}`) : 'all');

/** Consistent capitals for names that arrive all lower or all upper case ("montague street" → "Montague Street"). */
export function tidyName(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t !== t.toLowerCase() && t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s'(-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

/* ───────────────────────────── Constructors: every record complete ───────────────────────────── */

export const dataQuality = (status: VerificationStatus, more: Partial<Omit<DataQuality, 'status'>> = {}): DataQuality => ({
  status,
  source: more.source ?? null,
  confidence: more.confidence ?? null,
  last_verified: more.last_verified ?? null,
  notes: more.notes ?? null,
});

export const emptyPayment = (): Payment => ({ parking_area: null, easypark_areas: [], paystay_zones: [], meters: [] });

export function makeRestriction(r: Pick<Restriction, 'control' | 'days'> & Partial<Restriction>): Restriction {
  const allDay = r.all_day ?? !(r.start && r.end);
  return {
    control: r.control,
    sign_code: r.sign_code ?? null,
    limit_minutes: r.limit_minutes ?? null,
    days: r.days,
    all_day: allDay,
    start: allDay ? null : r.start!,
    end: allDay ? null : r.end!,
    public_holidays: r.public_holidays ?? null,
    exceptions: r.exceptions ?? [],
    exempt_permit_areas: r.exempt_permit_areas ?? [],
    grace_minutes: r.grace_minutes ?? null,
    source_sign_id: r.source_sign_id ?? null,
    effective_from: r.effective_from ?? null,
    effective_to: r.effective_to ?? null,
    data_quality: r.data_quality ?? dataQuality('unverified'),
  };
}

export function makeBay(b: Pick<Bay, 'number'> & Partial<Bay>): Bay {
  return { number: b.number, sign_number: b.sign_number ?? null, location: b.location ?? null, kind: b.kind ?? null, data_quality: b.data_quality ?? dataQuality('unverified'), notes: b.notes ?? null };
}

export function makePart(p: Partial<Part> = {}): Part {
  const from = p.from ?? null;
  const to = p.to ?? null;
  const restrictions = p.restrictions ?? [];
  const status = p.restrictions_status ?? (restrictions.length ? 'supplied' : 'pending_field_capture');
  return {
    id: p.id ?? partIdFor(from, to),
    from,
    to,
    permit_area: p.permit_area ?? null,
    payment: { ...emptyPayment(), ...(p.payment ?? {}) },
    restrictions_status: status,
    restrictions,
    bays: p.bays ?? [],
    data_quality: p.data_quality ?? dataQuality(status === 'pending_field_capture' ? 'pending_field_capture' : 'unverified'),
    notes: p.notes ?? null,
  };
}

export function makeSegment(
  code: string,
  s: { road: { name: string; locality?: string | null; external_ids?: Record<string, string> }; between: { from: string; to: string } } & Partial<Omit<Segment, 'road' | 'between'>>,
): Segment {
  const road = tidyName(s.road.name);
  const from = tidyName(s.between.from);
  const to = tidyName(s.between.to);
  const roadSegmentId = s.road_segment_id ?? null;
  return {
    id: s.id ?? segmentIdFor(code, roadSegmentId, road, from, to),
    road_segment_id: roadSegmentId,
    patrol_zone: s.patrol_zone ?? null,
    road: { name: road, locality: s.road.locality ? tidyName(s.road.locality) : null, external_ids: s.road.external_ids ?? {} },
    between: { from, to },
    geometry: s.geometry ?? null,
    sides: s.sides ?? [{ side: 'both', parts: [makePart()] }],
    data_quality: s.data_quality ?? dataQuality('pending_field_capture'),
    notes: s.notes ?? null,
  };
}

export function makeDataset(meta: {
  id: string;
  title: string;
  municipality: string;
  code?: string;
  timezone?: string;
  status?: ParkingDataset['dataset']['status'];
  generatedAt?: string | null;
  sources?: DatasetSource[];
  notes?: string[];
}): ParkingDataset {
  const known = COUNCILS[meta.municipality.trim().toLowerCase()];
  const code = meta.code ?? councilCode(meta.municipality);
  return {
    schema: DATASET_SCHEMA,
    schema_version: DATASET_VERSION,
    dataset: {
      id: meta.id,
      title: meta.title,
      status: meta.status ?? 'draft',
      generated_at: meta.generatedAt ?? null,
      municipality: { name: meta.municipality, code, state: known?.state ?? null, country: known ? 'AU' : null, timezone: meta.timezone ?? 'Australia/Melbourne' },
      sources: meta.sources ?? [],
      notes: meta.notes ?? [],
    },
    conventions: { bay_sign_format: null, paystay_zone_pattern: null, easypark_area_pattern: null, notes: [], ...(known?.conventions ?? {}) },
    patrol_zones: [],
    permit_areas: [],
    segments: [],
  };
}

/* ───────────────────────────── Validation ───────────────────────────── */

export interface DatasetError {
  path: string;
  message: string;
}

const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const SIDES: SideCode[] = ['both', 'north', 'south', 'east', 'west', 'odd', 'even'];
const TIMED_CONTROLS = new Set<Control>(['time_limit', 'metered', 'ticket', 'loading_zone']);

/** The keys every record of each kind must carry (values may be null or empty). */
const KEYS = {
  root: ['schema', 'schema_version', 'dataset', 'conventions', 'patrol_zones', 'permit_areas', 'segments'],
  dataset: ['id', 'title', 'status', 'generated_at', 'municipality', 'sources', 'notes'],
  municipality: ['name', 'code', 'state', 'country', 'timezone'],
  conventions: ['bay_sign_format', 'paystay_zone_pattern', 'easypark_area_pattern', 'notes'],
  source: ['id', 'name', 'publisher', 'url', 'format', 'reference_date', 'data_used', 'limitations'],
  patrolZone: ['id', 'number', 'name', 'kind', 'geometry'],
  permitArea: ['id', 'code', 'name'],
  segment: ['id', 'road_segment_id', 'patrol_zone', 'road', 'between', 'geometry', 'sides', 'data_quality', 'notes'],
  road: ['name', 'locality', 'external_ids'],
  between: ['from', 'to'],
  side: ['side', 'parts'],
  part: ['id', 'from', 'to', 'permit_area', 'payment', 'restrictions_status', 'restrictions', 'bays', 'data_quality', 'notes'],
  bound: ['kind', 'label', 'location'],
  payment: ['parking_area', 'easypark_areas', 'paystay_zones', 'meters'],
  paystay: ['zone', 'meter_id'],
  meter: ['id', 'location'],
  restriction: ['control', 'sign_code', 'limit_minutes', 'days', 'all_day', 'start', 'end', 'public_holidays', 'exceptions', 'exempt_permit_areas', 'grace_minutes', 'source_sign_id', 'effective_from', 'effective_to', 'data_quality'],
  bay: ['number', 'sign_number', 'location', 'kind', 'data_quality', 'notes'],
  dataQuality: ['status', 'source', 'confidence', 'last_verified', 'notes'],
} as const;

/**
 * Checks that the dataset has the fixed structure (every key on every record) and the rules that
 * matter on a device. The JSON Schema says the same; this gives readable paths in the app.
 */
export function validateDataset(input: unknown): DatasetError[] {
  const errors: DatasetError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  /** True when v is an object; reports missing keys and keys outside the schema. */
  const shape = (v: unknown, keys: readonly string[], path: string): v is Record<string, unknown> => {
    if (!isObj(v)) {
      err(path || 'dataset', 'must be an object');
      return false;
    }
    const missing = keys.filter((k) => !(k in v));
    const extra = Object.keys(v).filter((k) => !keys.includes(k));
    if (missing.length) err(path || '(root)', `is missing ${missing.join(', ')} (use null or [] when unknown)`);
    if (extra.length) err(path || '(root)', `has keys outside the schema: ${extra.join(', ')}`);
    return true;
  };
  const dq = (v: unknown, path: string) => {
    if (shape(v, KEYS.dataQuality, path) && !['verified', 'field_checked', 'unverified', 'inferred', 'pending_field_capture'].includes(v.status as string)) err(`${path}.status`, 'is not a known verification status');
  };
  const latLng = (v: unknown, path: string) => {
    if (v !== null && !(isObj(v) && typeof v.lat === 'number' && typeof v.lng === 'number' && Math.abs(v.lat) <= 90 && Math.abs(v.lng) <= 180)) err(path, 'must be null or { lat −90…90, lng −180…180 }');
  };
  const validateRestriction = (r: unknown, p: string) => {
    if (!shape(r, KEYS.restriction, p)) return;
    if (!CONTROLS.includes(r.control as Control)) err(`${p}.control`, `must be one of ${CONTROLS.join(', ')}`);
    if (!Array.isArray(r.days) || !r.days.length || r.days.some((d) => !DAY_CODES.includes(d as DayCode))) err(`${p}.days`, 'must list days as mon…sun');
    if (r.all_day === true) {
      if (r.start !== null || r.end !== null) err(p, 'start and end must be null when all_day is true');
    } else if (r.all_day !== false || !HHMM.test(String(r.start)) || !HHMM.test(String(r.end)) || r.start === r.end) err(p, 'needs start and end (HH:MM), or all_day: true');
    if (['time_limit', 'metered', 'ticket'].includes(r.control as string) && !(Number.isInteger(r.limit_minutes) && (r.limit_minutes as number) > 0))
      err(`${p}.limit_minutes`, `is required for ${String(r.control)}`);
    dq(r.data_quality, `${p}.data_quality`);
  };

  if (!shape(input, KEYS.root, '')) return errors;
  if (input.schema !== DATASET_SCHEMA) err('schema', `must be "${DATASET_SCHEMA}"`);
  if (typeof input.schema_version !== 'string' || !/^1\.\d+\.\d+$/.test(input.schema_version)) err('schema_version', 'must be a 1.x.y version');
  if (shape(input.dataset, KEYS.dataset, 'dataset')) {
    const ds = input.dataset;
    if (typeof ds.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(ds.id)) err('dataset.id', 'must be lower-case letters, digits, dot, dash or underscore');
    if (shape(ds.municipality, KEYS.municipality, 'dataset.municipality')) {
      if (typeof ds.municipality.name !== 'string' || !ds.municipality.name) err('dataset.municipality.name', 'is required');
      if (typeof ds.municipality.code !== 'string' || !/^[a-z0-9]+$/.test(ds.municipality.code)) err('dataset.municipality.code', 'must be the council code in lower case, e.g. "copp"');
      if (typeof ds.municipality.timezone !== 'string' || !ds.municipality.timezone) err('dataset.municipality.timezone', 'is required');
    }
    (Array.isArray(ds.sources) ? ds.sources : []).forEach((s, i) => shape(s, KEYS.source, `dataset.sources[${i}]`));
  }
  shape(input.conventions, KEYS.conventions, 'conventions');
  const zones = new Set<string>();
  (Array.isArray(input.patrol_zones) ? input.patrol_zones : []).forEach((z, i) => {
    if (shape(z, KEYS.patrolZone, `patrol_zones[${i}]`)) zones.add(z.id as string);
  });
  const permits = new Set<string>();
  (Array.isArray(input.permit_areas) ? input.permit_areas : []).forEach((p, i) => {
    if (shape(p, KEYS.permitArea, `permit_areas[${i}]`)) permits.add(p.id as string);
  });
  if (!Array.isArray(input.segments)) return [...errors, { path: 'segments', message: 'must be an array' }];

  const ids = new Set<string>();
  input.segments.forEach((s, i) => {
    const p = `segments[${i}]`;
    if (!shape(s, KEYS.segment, p)) return;
    if (typeof s.id !== 'string' || !s.id) err(`${p}.id`, 'is required');
    else if (ids.has(s.id)) err(`${p}.id`, `"${s.id}" is used twice`);
    else ids.add(s.id);
    if (shape(s.road, KEYS.road, `${p}.road`) && (typeof s.road.name !== 'string' || !s.road.name)) err(`${p}.road.name`, 'is required');
    if (shape(s.between, KEYS.between, `${p}.between`) && (!s.between.from || !s.between.to)) err(`${p}.between`, 'needs from and to');
    if (s.patrol_zone !== null && !zones.has(s.patrol_zone as string)) err(`${p}.patrol_zone`, `"${String(s.patrol_zone)}" is not in patrol_zones`);
    dq(s.data_quality, `${p}.data_quality`);
    if (!Array.isArray(s.sides) || !s.sides.length) return err(`${p}.sides`, 'needs at least one side');
    s.sides.forEach((side: unknown, j: number) => {
      const sp = `${p}.sides[${j}]`;
      if (!shape(side, KEYS.side, sp)) return;
      if (!SIDES.includes(side.side as SideCode)) err(`${sp}.side`, `must be one of ${SIDES.join(', ')}`);
      if (!Array.isArray(side.parts) || !side.parts.length) return err(`${sp}.parts`, 'needs at least one part');
      const partIds = new Set<string>();
      side.parts.forEach((part: unknown, k: number) => {
        const pp = `${sp}.parts[${k}]`;
        if (!shape(part, KEYS.part, pp)) return;
        if (typeof part.id !== 'string' || !part.id) err(`${pp}.id`, 'is required');
        else if (partIds.has(part.id)) err(`${pp}.id`, `"${part.id}" is used twice on this side`);
        else partIds.add(part.id);
        for (const end of ['from', 'to'] as const) if (part[end] !== null && shape(part[end], KEYS.bound, `${pp}.${end}`)) latLng((part[end] as Record<string, unknown>).location, `${pp}.${end}.location`);
        if (part.permit_area !== null && !permits.has(part.permit_area as string)) err(`${pp}.permit_area`, `"${String(part.permit_area)}" is not in permit_areas`);
        if (shape(part.payment, KEYS.payment, `${pp}.payment`)) {
          const pay = part.payment;
          (Array.isArray(pay.paystay_zones) ? pay.paystay_zones : []).forEach((z, m) => shape(z, KEYS.paystay, `${pp}.payment.paystay_zones[${m}]`));
          (Array.isArray(pay.meters) ? pay.meters : []).forEach((z, m) => {
            if (shape(z, KEYS.meter, `${pp}.payment.meters[${m}]`)) latLng(z.location, `${pp}.payment.meters[${m}].location`);
          });
        }
        if (!['supplied', 'pending_field_capture', 'no_parking_spaces'].includes(part.restrictions_status as string)) err(`${pp}.restrictions_status`, 'must be supplied, pending_field_capture or no_parking_spaces');
        if (!Array.isArray(part.restrictions)) err(`${pp}.restrictions`, 'must be an array (empty when pending)');
        else part.restrictions.forEach((r: unknown, m: number) => validateRestriction(r, `${pp}.restrictions[${m}]`));
        if (!Array.isArray(part.bays)) err(`${pp}.bays`, 'must be an array (empty when there are no numbered bays)');
        else
          part.bays.forEach((b: unknown, m: number) => {
            const bp = `${pp}.bays[${m}]`;
            if (!shape(b, KEYS.bay, bp)) return;
            if (!Number.isInteger(b.number) || (b.number as number) < 0) err(`${bp}.number`, 'must be a whole number');
            latLng(b.location, `${bp}.location`);
            dq(b.data_quality, `${bp}.data_quality`);
          });
        dq(part.data_quality, `${pp}.data_quality`);
      });
    });
  });
  return errors;
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
  return r.all_day || (r.start === '00:00' && r.end === '24:00') ? { allDay: true, startTime: '00:00', endTime: '24:00' } : { allDay: false, startTime: r.start!, endTime: r.end! };
}

export const externalId = (dataset: string, segment: string, side: string, part: string) => `${dataset}/${segment}/${side}/${part}`;

/** One PlateWatch timed list per part; its external ID ties it back to the dataset. */
export function datasetToDrafts(d: ParkingDataset): { drafts: DatasetDraft[]; skipped: string[] } {
  const zones = new Map(d.patrol_zones.map((z) => [z.id, z]));
  const permits = new Map(d.permit_areas.map((p) => [p.id, p.code]));
  const drafts: DatasetDraft[] = [];
  const skipped: string[] = [];
  for (const s of d.segments) {
    const zone = s.patrol_zone ? zones.get(s.patrol_zone) : undefined;
    for (const side of s.sides) {
      for (const part of side.parts) {
        const where = `${s.road.name} ${s.between.from} – ${s.between.to}, ${side.side === 'both' ? 'both sides' : `${side.side} side`}${part.id !== 'all' ? ` (${part.id})` : ''}`;
        if (part.restrictions_status === 'no_parking_spaces') {
          skipped.push(`${where}: no parking spaces`);
          continue;
        }
        const restrictions: TimedRestriction[] = [];
        const untimed: UntimedControl[] = [];
        for (const r of part.restrictions) {
          const t = timesOf(r);
          const days = [...new Set(r.days.map((x) => DAY_INDEX[x]))].sort((a, b) => a - b);
          const description = [r.control === 'metered' || r.control === 'ticket' ? CONTROL_LABEL[r.control] : '', ...r.exceptions].filter(Boolean).join(' · ');
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
        const pay = part.payment;
        const payment: PaymentAreas = {
          ...(pay.parking_area ? { parkingArea: pay.parking_area } : {}),
          easyPark: [...pay.easypark_areas],
          payStay: pay.paystay_zones.map((z) => ({ zone: z.zone, meter: z.meter_id ?? '' })),
        };
        const located = part.bays.filter((b) => b.location);
        drafts.push({
          pending: !restrictions.length,
          list: {
            type: 'timed',
            name: listName(s, side.side, part),
            notes: [part.notes, s.notes].filter(Boolean).join('\n'),
            segment: {
              street: s.road.name,
              fromStreet: s.between.from,
              toStreet: s.between.to,
              side: side.side as StreetSide,
              suburb: s.road.locality ?? '',
              ...(part.from ? { subFrom: part.from.label } : {}),
              ...(part.to ? { subTo: part.to.label } : {}),
            },
            restrictions,
            allowListIds: [],
            externalId: externalId(d.dataset.id, s.id, side.side, part.id),
            ...(zone?.number ? { patrolZone: zone.number } : {}),
            ...(zone?.name ? { patrolZoneName: zoneTitle(zone.name) } : {}),
            ...(part.permit_area ? { rpa: permits.get(part.permit_area) ?? part.permit_area } : {}),
            ...(s.road_segment_id ? { roadSegmentId: s.road_segment_id } : {}),
            ...(payment.parkingArea || payment.easyPark.length || payment.payStay.length ? { payment } : {}),
            ...(part.bays.length ? { bays: [...new Set(part.bays.map((b) => b.number))].sort((a, b) => a - b) } : {}),
            ...(located.length ? { bayPoints: located.map((b) => ({ bay: b.number, lat: b.location!.lat, lng: b.location!.lng, ...(b.sign_number ? { sign: b.sign_number } : {}) })) } : {}),
            ...(untimed.length ? { untimedControls: untimed } : {}),
          },
        });
      }
    }
  }
  return { drafts, skipped };
}

function listName(s: Segment, side: SideCode, part: Part): string {
  const short = (n: string) =>
    n.replace(/\b(Street|Road|Avenue|Parade|Place|Highway|Crescent|Court|Drive|Terrace|Boulevard)$/, (w) => ({ Street: 'St', Road: 'Rd', Avenue: 'Ave', Parade: 'Pde', Place: 'Pl', Highway: 'Hwy', Crescent: 'Cres', Court: 'Ct', Drive: 'Dr', Terrace: 'Tce', Boulevard: 'Bvd' })[w] ?? w);
  const sideLetter = side === 'both' ? '' : ` (${side === 'odd' || side === 'even' ? side : side[0]!.toUpperCase()})`;
  const sub = part.from || part.to ? ` · ${part.from ? short(part.from.label) : '…'} – ${part.to ? short(part.to.label) : '…'}` : '';
  return `${short(s.road.name)}, ${short(s.between.from)} – ${short(s.between.to)}${sideLetter}${sub}`;
}

/* ───────────────────────────── PlateWatch → Dataset ───────────────────────────── */

function boundFrom(label: string | undefined): Bound | null {
  if (!label) return null;
  const kind: BoundKind = /^bay\s*\d+/i.test(label) ? 'bay' : /^point\s+-?\d/i.test(label) ? 'point' : /^\d/.test(label) || /\b(outside|opposite)\b/i.test(label) ? 'address' : 'intersection';
  return { kind, label, location: null };
}

function restrictionFrom(r: TimedRestriction): Restriction {
  const metered = /\bmeter\b/i.test(r.description);
  const ticket = /\bticket\b/i.test(r.description);
  return makeRestriction({
    control: /^LZ/i.test(r.code) ? 'loading_zone' : metered ? 'metered' : ticket ? 'ticket' : 'time_limit',
    sign_code: r.code,
    limit_minutes: r.limitMinutes,
    days: r.days.map((d) => DAY_CODES[d]!),
    all_day: r.allDay,
    start: r.startTime,
    end: r.endTime,
    exceptions: r.description
      .split(' · ')
      .map((x) => x.trim())
      .filter((x) => x && !/^(meter|ticket)$/i.test(x)),
    grace_minutes: r.graceMinutes || null,
  });
}

function untimedFrom(u: UntimedControl): Restriction {
  return makeRestriction({
    control: u.control,
    sign_code: u.label && u.label !== CONTROL_LABEL[u.control] ? u.label : null,
    days: u.days.map((d) => DAY_CODES[d]!),
    all_day: u.allDay,
    start: u.startTime,
    end: u.endTime,
    exceptions: u.description ? [u.description] : [],
  });
}

/**
 * Export timed lists as a dataset in the fixed structure. Lists imported from a dataset keep
 * their segment, side and part IDs; others get IDs by the rule (council code + asset ID, or the
 * provisional name-based ID). Lists of one road segment become one segment, a side per list side.
 */
export function listsToDataset(
  lists: readonly TimedList[],
  meta: { id?: string; title: string; municipality: string; code?: string; timezone: string; generatedAt?: string },
): ParkingDataset {
  const code = meta.code ?? councilCode(meta.municipality);
  const generatedAt = meta.generatedAt ?? new Date().toISOString();
  const d = makeDataset({ id: meta.id ?? `${code}-platewatch-export-${generatedAt.slice(0, 10)}`, title: meta.title, municipality: meta.municipality, code, timezone: meta.timezone, generatedAt });
  const segments = new Map<string, Segment>();
  const zones = new Map<string, PatrolZone>();
  const permitAreas = new Map<string, PermitArea>();
  for (const l of lists) {
    const [, segId, , partId] = (l.externalId ?? '').split('/');
    const zoneNumber = l.patrolZone?.trim() || null;
    const zoneName = l.patrolZoneName?.trim() || null;
    const zoneId = zoneNumber || zoneName ? zoneIdFor(code, zoneNumber, zoneName) : null;
    if (zoneId && !zones.has(zoneId)) zones.set(zoneId, { id: zoneId, number: zoneNumber, name: zoneName, kind: 'patrol_area', geometry: null });
    const permitId = l.rpa ? permitAreaIdFor(code, l.rpa) : null;
    if (permitId && !permitAreas.has(permitId)) permitAreas.set(permitId, { id: permitId, code: l.rpa!, name: null });

    const [a, b] = [l.segment.fromStreet, l.segment.toStreet].sort();
    const id = segId || segmentIdFor(code, l.roadSegmentId ?? null, l.segment.street, a!, b!);
    let seg = segments.get(id);
    if (!seg) {
      seg = makeSegment(code, {
        id,
        road_segment_id: l.roadSegmentId ?? null,
        patrol_zone: zoneId,
        road: { name: l.segment.street, locality: l.segment.suburb || null },
        between: { from: l.segment.fromStreet, to: l.segment.toStreet },
        sides: [],
        data_quality: dataQuality('unverified', { source: 'PlateWatch' }),
      });
      segments.set(id, seg);
    }
    let side = seg.sides.find((x) => x.side === l.segment.side);
    if (!side) seg.sides.push((side = { side: l.segment.side, parts: [] }));
    const points = new Map((l.bayPoints ?? []).map((p) => [p.bay, p]));
    const restrictions = [...l.restrictions.map(restrictionFrom), ...(l.untimedControls ?? []).map(untimedFrom)];
    const from = boundFrom(l.segment.subFrom);
    const to = boundFrom(l.segment.subTo);
    side.parts.push(
      makePart({
        id: partId || partIdFor(from, to),
        from,
        to,
        permit_area: permitId,
        payment: {
          parking_area: l.payment?.parkingArea ?? null,
          easypark_areas: [...(l.payment?.easyPark ?? [])],
          paystay_zones: (l.payment?.payStay ?? []).map((p) => ({ zone: p.zone, meter_id: p.meter || null })),
          meters: [],
        },
        restrictions_status: restrictions.length ? 'supplied' : 'pending_field_capture',
        restrictions,
        bays: (l.bays ?? []).map((n) => {
          const p = points.get(n);
          return makeBay({ number: n, location: p ? { lat: p.lat, lng: p.lng } : null, sign_number: p?.sign ?? null });
        }),
        notes: l.notes || null,
      }),
    );
  }
  d.patrol_zones = [...zones.values()];
  d.permit_areas = [...permitAreas.values()];
  d.segments = [...segments.values()];
  return d;
}

/* ───────────────────────────── Council area datasets → dataset ───────────────────────────── */

/** "street_segments" area datasets (e.g. City of Port Phillip Patrol Area 10, with record_defaults). */
export function isAreaDataset(v: unknown): boolean {
  return isObj(v) && Array.isArray(v.street_segments) && (isObj(v.record_defaults) || 'dataset_title' in v);
}

/**
 * Adapt an area dataset to civicmaps.parking_dataset. Its record_defaults are applied to each
 * record; identifiers are rebuilt by the rule (the council's own segment_id is kept in
 * road.external_ids.source_segment_id); a placeholder restriction (restriction_applied null)
 * becomes a pending part with no restrictions.
 */
export function convertAreaDataset(src: Record<string, unknown>, opts: { timezone?: string } = {}): { dataset: ParkingDataset; warnings: string[] } {
  const warnings: string[] = [];
  const defaults = isObj(src.record_defaults) ? src.record_defaults : {};
  const scope = isObj(src.scope) ? src.scope : {};
  const municipality = str(scope.municipality) || 'Unknown council';
  const code = councilCode(municipality);
  const area = str(defaults.enforcement_zone) || (Array.isArray(scope.requested_enforcement_zones) ? str(scope.requested_enforcement_zones[0]) : '');
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
  const notes = [
    str(scope.area_depicted),
    str(scope.important_distinction),
    ...(Array.isArray(src.missing_authoritative_fields) ? [`Missing authoritative fields: ${src.missing_authoritative_fields.map(str).join(', ')}`] : []),
  ].filter(Boolean);
  const d = makeDataset({
    id: `${code}-${area ? `patrol-area-${slug(area)}` : slug(str(src.dataset_title)) || 'segments'}`,
    title: str(src.dataset_title) || `${municipality} street segments`,
    municipality,
    code,
    timezone: opts.timezone,
    sources,
    notes,
  });
  const zones = new Map<string, PatrolZone>();
  const seen = new Map<string, number>();
  for (const raw of (src.street_segments as unknown[]).filter(isObj)) {
    const r = { ...defaults, ...raw } as Record<string, unknown>;
    const zoneNumber = str(r.enforcement_zone) || null;
    const zoneId = zoneNumber ? zoneIdFor(code, zoneNumber, null) : null;
    if (zoneId && !zones.has(zoneId)) zones.set(zoneId, { id: zoneId, number: zoneNumber, name: null, kind: 'patrol_area', geometry: null });
    const sideCode = (SIDES as string[]).includes(str(r.road_side)) ? (str(r.road_side) as SideCode) : 'both';
    const restrictions: Restriction[] = [];
    for (const pr of (Array.isArray(r.parking_restrictions) ? r.parking_restrictions : []).filter(isObj)) {
      if (!pr.restriction_applied) continue; // placeholder: nothing shown on the source map
      const mapped = mapAreaRestriction(pr);
      if (mapped) restrictions.push(mapped);
      else warnings.push(`${str(r.segment_id)}: restriction "${str(pr.restriction_applied)}" could not be mapped and was left out.`);
    }
    const dq = isObj(r.data_quality) ? r.data_quality : {};
    const sourceId = str(r.segment_id);
    const seg = makeSegment(code, {
      road_segment_id: str(r.road_segment_id) || str(r.road_segment_asset_id) || str(r.asset_id) || null,
      patrol_zone: zoneId,
      road: { name: str(r.road_segment_name), locality: str(r.locality) || null, external_ids: sourceId ? { source_segment_id: sourceId } : {} },
      between: { from: str(r.between_street_name), to: str(r.and_street_name) },
      geometry: isObj(r.geometry) ? (r.geometry as unknown as Geometry) : null,
      sides: [{ side: sideCode, parts: [makePart({ restrictions })] }],
      data_quality: dataQuality(restrictions.length ? 'unverified' : 'pending_field_capture', {
        source: str(dq.street_segment_source) || null,
        notes: [str(dq.endpoints_status), str(dq.restriction_status)].filter(Boolean).join('; ') || null,
      }),
    });
    // Two records for the same road and cross streets would share a provisional id: number them.
    const n = (seen.get(seg.id) ?? 0) + 1;
    seen.set(seg.id, n);
    if (n > 1) {
      warnings.push(`${sourceId || seg.id}: same road and cross streets as an earlier record; given id ${seg.id}-${n}.`);
      seg.id = `${seg.id}-${n}`;
    }
    d.segments.push(seg);
  }
  d.patrol_zones = [...zones.values()];
  return { dataset: d, warnings };
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

function mapAreaRestriction(pr: Record<string, unknown>): Restriction | null {
  const text = str(pr.restriction_applied);
  const code = /(\d+\/\d+P|\d+P|P\d+)/i.exec(text)?.[1]?.toUpperCase() ?? null;
  const control = AREA_CONTROL.find(([re]) => re.test(text))?.[1] ?? (code ? 'time_limit' : null);
  if (!control) return null;
  const days = (Array.isArray(pr.applicable_days) ? pr.applicable_days : [])
    .map((x) => str(x).slice(0, 3).toLowerCase())
    .filter((x): x is DayCode => DAY_CODES.includes(x as DayCode));
  const t = isObj(pr.applicable_times) ? pr.applicable_times : {};
  const start = str(t.start);
  const end = str(t.end);
  return makeRestriction({
    control,
    sign_code: code ?? text,
    limit_minutes: code ? minutesFromCode(code) : null,
    days: days.length ? days : [...DAY_CODES],
    all_day: !(start && end),
    start: start || null,
    end: end || null,
    exceptions: (Array.isArray(pr.permit_or_vehicle_exceptions) ? pr.permit_or_vehicle_exceptions : []).map(str).filter(Boolean),
    source_sign_id: str(pr.source_sign_or_asset_id) || null,
    effective_from: str(pr.effective_from) || null,
    effective_to: str(pr.effective_to) || null,
    data_quality: dataQuality(str(pr.verification_status) === 'verified' ? 'verified' : 'unverified'),
  });
}
