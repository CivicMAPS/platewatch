/**
 * Bulk import of lists: the normalised CSV templates (timed segments, allow lists, hot lists)
 * and the CivicMAPS-preview parking data files (kerbside v1, road-segment, field-survey and
 * parking-area-zone JSON).
 *
 * One timed list = one side of a road segment, or one sub-segment of a side where the signs
 * change part way along (bounded by a bay, an address or a cross street). Signs with a time
 * allowance become restrictions; signs without one (No Stopping, No Parking, an untimed Loading
 * Zone) are kept as notes, and a side or sub-segment with nothing to time is skipped and
 * reported. A segment whose rules are still to be surveyed is imported as a placeholder, so it
 * can be found and scanned against, and its restrictions added later.
 *
 * Everything here is pure; src/ui/views/importView.ts reads the files and saves the plan.
 */
import { normalisePayment } from './payment';
import { uid } from './db';
import { systemSource } from './listPolicy';
import { RELEASE_SCHEMA, validateRelease, type KerbsideRelease } from './kerbsideRelease';
import { areaDatasetToRelease, isAreaDataset, releaseToDrafts } from './releaseAdapters';
import { normalisePlate, plateKey } from './plate';
import { minutesFromCode } from './restriction';
import {
  RISK_LEVEL_LABELS,
  RISK_TAG_LABELS,
  RISK_TAGS,
  type AllowEntry,
  type AllowList,
  type HotEntry,
  type HotList,
  type PaymentAreas,
  type PlateList,
  type RiskLevel,
  type RiskTag,
  type StreetSegment,
  type StreetSide,
  type TimedList,
  type TimedRestriction,
  type UntimedControl,
  type VehicleDetails,
  type Weekday,
} from './types';
import { compactVehicle, REGISTRATION_STATES, registrationTypeCode, vehicleOf, vehicleTypeCode } from './vehicle';
import { parsePermitNumber, permitRecords, permitToEntry, validatePermitRecord } from './permit';

/* ───────────────────────────── Results ───────────────────────────── */

type Draftable<T extends PlateList> = Omit<T, 'id' | 'createdAt' | 'updatedAt'>;

export interface TimedDraft {
  kind: 'timed';
  list: Draftable<TimedList>;
  /** No timed rules yet (still to be surveyed): imported so the segment exists. */
  pending: boolean;
  /** File (and row) it came from, for the import report. */
  source: string;
}
export interface AllowDraft {
  kind: 'allow';
  list: Draftable<AllowList>;
  source: string;
}
export interface HotDraft {
  kind: 'hot';
  list: Draftable<HotList>;
  source: string;
}
/** Numbered bays (with positions) for a timed list, from the bays CSV. */
export interface BaysDraft {
  kind: 'bays';
  target: { segment: StreetSegment; externalId?: string };
  bays: number[];
  points: { bay: number; lat: number; lng: number; sign?: string }[];
  source: string;
}
export type ImportDraft = TimedDraft | AllowDraft | HotDraft | BaysDraft;

export interface ImportIssue {
  file: string;
  /** 1-based line in a CSV file (the header is row 1). */
  row?: number;
  message: string;
}

export type ImportKind =
  | 'timed-csv'
  | 'allow-csv'
  | 'hot-csv'
  | 'bays-csv'
  | 'civicmaps-kerbside'
  | 'civicmaps-road-segment'
  | 'civicmaps-survey'
  | 'civicmaps-parking-areas'
  | 'civicmaps-mixed'
  | 'civicmaps-release'
  | 'area-dataset'
  | 'permits-json'
  | 'unknown';

export interface ImportResult {
  file: string;
  kind: ImportKind;
  drafts: ImportDraft[];
  /** Rows or records that could not be imported. */
  issues: ImportIssue[];
  /** Sides and stretches left out on purpose (nothing to time), for the report. */
  skipped: string[];
}

/* ───────────────────────────── Templates ───────────────────────────── */

/**
 * The normalised CSV templates. docs/IMPORT-TEMPLATES.md documents each column; the files in
 * templates/ are generated from these (a test keeps them identical).
 */
export const CSV_TEMPLATES = {
  timed: {
    fileName: 'platewatch-timed-segments-template.csv',
    header:
      'segment_id,part_id,road_segment_id,patrol_zone,patrol_zone_name,road,locality,between_from,between_to,side,part_from,part_to,permit_area,parking_area,easypark_areas,paystay_zones,meter_ids,restrictions_status,control,sign_code,limit_minutes,days,start,end,exceptions,grace_minutes,list_name,notes',
    example: [
      'copp-normanby-road-from-boundary-to-montague,all,,10,,Normanby Road,South Melbourne,Boundary Street,Montague Street,both,,,,,,,,pending_field_capture,,,,,,,,,,Signs still to be surveyed',
      'copp-31065,all,31065,10,,Coventry Street,South Melbourne,Montague Street,Ferrars Street,north,,,7,,,338831065001:CVT1,,supplied,ticket,2P,120,Mon-Fri,08:00,18:00,Permit Zone 7 excepted,5,,Example – illustrative asset ID and signs; replace',
      'copp-31065,all,31065,10,,Coventry Street,South Melbourne,Montague Street,Ferrars Street,north,,,7,,,,,supplied,no_stopping,,,Mon-Fri,07:00,09:00,,,,Example – illustrative asset ID and signs; replace',
      'com-20055,bay-58-bay-72,20055,,Chinatown,Little Bourke Street,Melbourne,Swanston Street,Elizabeth Street,south,Bay 58,Bay 72,,645,,,,supplied,loading_zone,LZ 30,30,Mon-Fri,07:00,16:00,Commercial vehicles only,,,',
      'com-20055,bay-58-bay-72,20055,,Chinatown,Little Bourke Street,Melbourne,Swanston Street,Elizabeth Street,south,Bay 58,Bay 72,,645,7514,,,supplied,metered,2P,120,Sat-Sun,07:00,22:00,,,,',
    ].join('\n'),
  },
  bays: {
    fileName: 'platewatch-bays-template.csv',
    header: 'segment_id,part_id,road,between_from,between_to,side,part_from,part_to,bay,lat,lng,sign_number',
    example: [
      'com-20055,bay-58-bay-72,Little Bourke Street,Swanston Street,Elizabeth Street,south,Bay 58,Bay 72,58,-37.8127332,144.9645599,',
      'com-20055,bay-58-bay-72,Little Bourke Street,Swanston Street,Elizabeth Street,south,Bay 58,Bay 72,59,-37.8127544,144.9644881,',
      'com-20055,bay-58-bay-72,Little Bourke Street,Swanston Street,Elizabeth Street,south,Bay 58,Bay 72,61,-37.8128019,144.9643276,',
    ].join('\n'),
  },
  allow: {
    fileName: 'platewatch-allow-list-template.csv',
    header: 'list_name,plate,permit_no,council,linking_id,valid_from,valid_to,parking_area,street_number,street,registration_state,registration_type,type,make,colour,label',
    example: [
      'RPA 7 residents,1AB2CD,RPA-2026-0789,com,,2026-07-01,2027-06-30,7,12,Gladstone Street,VIC,private,sedan,Toyota,White,',
      'RPA 7 residents,XYZ789,RPA/COMB/FS-2026-0791/1,com,,01/07/2026,31/12/2026,7,3/45,Gladstone Street,VIC,lease,hatchback,Mazda,Blue,',
      'Street permits,STR001,RSP-2026-0790,com,,2026-07-01,2027-06-30,,8,Smith Street,VIC,private,suv,Kia,Silver,',
    ].join('\n'),
  },
  hot: {
    fileName: 'platewatch-hot-list-template.csv',
    header: 'list_name,plate,risk_level,risks,registration_state,registration_type,type,make,colour,notes,alert_message,owner_description',
    example: 'Officer safety,ABC123,high,Aggressive;Threats / intimidation,VIC,private,ute,Toyota,White,Approach with a second officer,Do not approach — prior aggressive male driver interaction,"Male, 40s, heavy build"',
  },
} as const;

/**
 * Vehicle details from a CSV row (registration_type, make, type, colour). Older columns still read:
 * body_type → type, color → colour, and a free-text `vehicle` (older permit files) → make.
 */
function vehicleColumns(row: Record<string, string | undefined>): { vehicle: Partial<VehicleDetails>; problems: string[] } {
  const problems: string[] = [];
  // Registration type and vehicle type are fixed lists (codes or labels, any case).
  const regType = registrationTypeCode(row.registration_type);
  if (regType === null) problems.push(`registration_type "${row.registration_type}" is not private, commercial, company, lease, diplomatic or other`);
  const rawType = row.type || row.body_type || '';
  const type = vehicleTypeCode(rawType);
  if (type === null) problems.push(`type "${rawType}" is not a vehicle type on the list`);
  const state = (row.registration_state ?? '').trim().toUpperCase();
  if (state && !(REGISTRATION_STATES as readonly string[]).includes(state)) problems.push(`registration_state "${state}" is not an Australian state or territory`);
  return {
    vehicle: {
      registrationType: regType ?? '',
      make: row.make || row.vehicle || '',
      bodyType: type ?? '',
      colour: row.colour || row.color || '',
      registrationState: state || 'VIC',
    },
    problems,
  };
}

export const templateCsv = (kind: keyof typeof CSV_TEMPLATES) => `${CSV_TEMPLATES[kind].header}\n${CSV_TEMPLATES[kind].example}\n`;

/* ───────────────────────────── CSV ───────────────────────────── */

/** RFC 4180 CSV: quoted fields with commas, quotes and newlines; CRLF; an Excel BOM. Blank lines dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/* ───────────────────────────── Signs, days, times ───────────────────────────── */

export type ParsedSign = { code: string; minutes: number; description: string } | { note: string; control: UntimedControl['control'] };

const NOTE_LABELS: Record<string, [string, UntimedControl['control']]> = {
  no_stopping: ['No stopping', 'no_stopping'],
  no_stopping_area: ['No stopping', 'no_stopping'],
  no_parking: ['No parking', 'no_parking'],
  clearway: ['Clearway', 'clearway'],
  bus_zone: ['Bus zone', 'bus_zone'],
  taxi_zone: ['Taxi zone', 'taxi_zone'],
  permit_zone: ['Permit zone', 'permit_zone'],
  disabled: ['Disabled parking', 'accessible'],
  accessible: ['Accessible parking', 'accessible'],
  works_zone: ['Works zone', 'works_zone'],
};

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

/**
 * A sign as written in the CSV template ("2P", "2P Meter", "1/2P", "P15", "LZ30", "No Stopping")
 * or a CivicMAPS-preview sign type ("2p_meter", "loading_zone_30_min", "no_stopping"), with an
 * optional separate limit ("30_min").
 */
export function parseSign(input: string, limit?: string | null): ParsedSign {
  const raw = input.trim();
  const k = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const limitMin = limit ? Number(/(\d+)/.exec(limit)?.[1]) : NaN;

  // Loading zones: "LZ30", "loading_zone_30_min", "Loading Zone 15 min", or a separate limit.
  const lz = /^lz_?(\d+)$/.exec(k) ?? /^loading_zone(?:_(\d+)_?(?:m|min|mins|minutes))?$/.exec(k);
  if (lz) {
    const minutes = lz[1] ? Number(lz[1]) : limitMin;
    return Number.isFinite(minutes) && minutes > 0 ? { code: `LZ${minutes}`, minutes, description: '' } : { note: 'Loading zone (no time limit given)', control: 'loading_zone' };
  }
  // "2P", "2p_meter", "1/2P", "1_2p", "P15", "2P Ticket", "15_min".
  const parts = k.split('_');
  const suffix = (from: number) => titleCase(parts.slice(from).join(' '));
  let m = /^(\d+)\/(\d+)p$/.exec(parts[0]!);
  if (m) return timedSign(`${m[1]}/${m[2]}P`, 1);
  if (/^\d+$/.test(parts[0]!) && /^\d+p$/.test(parts[1] ?? '')) return timedSign(`${parts[0]}/${parts[1]!.toUpperCase()}`, 2);
  m = /^(\d+(?:\.\d+)?)p$/.exec(parts[0]!);
  if (m) return timedSign(`${m[1]}P`, 1);
  m = /^p(\d+)$/.exec(parts[0]!);
  if (m) return timedSign(`P${m[1]}`, 1);
  // "15min", "15_min", "30 minutes".
  const joined = /^(\d+)(?:m|min|mins|minutes)$/.exec(parts[0]!);
  const separate = /^\d+$/.test(parts[0]!) && /^(?:m|min|mins|minutes)$/.test(parts[1] ?? '');
  if (joined || separate) {
    const minutes = Number(joined ? joined[1] : parts[0]);
    return { code: `${minutes} min`, minutes, description: suffix(separate ? 2 : 1) };
  }
  const known = NOTE_LABELS[k];
  if (known) return { note: known[0], control: known[1] };
  return { note: titleCase(raw), control: 'other' };

  function timedSign(code: string, descFrom: number): ParsedSign {
    const minutes = minutesFromCode(code);
    return minutes ? { code, minutes, description: suffix(descFrom) } : { note: titleCase(raw), control: 'other' };
  }
}

const DAY_INDEX: Record<string, Weekday> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ALL_DAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** "Mon-Fri", "Sat-Sun", "Mon,Wed,Fri", "Every day", "all_days", "Weekdays". Null when unreadable. */
export function parseDays(input: string): Weekday[] | null {
  const s = input.trim().toLowerCase().replace(/_/g, ' ');
  if (!s || /^(every ?day|all days|daily|mon ?- ?sun|any day)$/.test(s)) return [...ALL_DAYS];
  if (s === 'weekdays') return [1, 2, 3, 4, 5];
  if (s === 'weekends') return [0, 6];
  const out = new Set<Weekday>();
  for (const part of s.split(/[,;&/]|\band\b/).map((p) => p.trim()).filter(Boolean)) {
    const range = /^([a-z]{3})[a-z]*\s*(?:-|–|to)\s*([a-z]{3})[a-z]*$/.exec(part);
    if (range) {
      const a = DAY_INDEX[range[1]!];
      const b = DAY_INDEX[range[2]!];
      if (a === undefined || b === undefined) return null;
      for (let d = a; ; d = ((d + 1) % 7) as Weekday) {
        out.add(d);
        if (d === b) break;
      }
      continue;
    }
    const day = DAY_INDEX[part.slice(0, 3)];
    if (day === undefined || !/^[a-z]+$/.test(part)) return null;
    out.add(day);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

const HHMM = /^([01]?\d|2[0-4])[:.]?([0-5]\d)$/;
function hhmm(input: string): string | null {
  const m = HHMM.exec(input.trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h === 24 && m[2] !== '00') return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** Start and end time, or all day. Null when unreadable. */
function parseTimes(start: string, end: string): { allDay: boolean; startTime: string; endTime: string } | null {
  const a = start.trim().toLowerCase();
  const b = end.trim().toLowerCase();
  if ((!a && !b) || /^all[ _]?times?$/.test(a)) return { allDay: true, startTime: '00:00', endTime: '24:00' };
  const s = hhmm(a);
  const e = hhmm(b);
  if (!s || !e || s === e) return null;
  if (s === '00:00' && e === '24:00') return { allDay: true, startTime: '00:00', endTime: '24:00' };
  return { allDay: false, startTime: s, endTime: e };
}

/** CivicMAPS-preview rule time: "07:00-16:00", "00:00-24:00", "all_times". */
function parseRuleTime(time: string): { allDay: boolean; startTime: string; endTime: string } | null {
  const t = time.trim();
  if (/^all[ _]?times?$/i.test(t)) return parseTimes('', '');
  const m = /^(\S+?)\s*[-–]\s*(\S+)$/.exec(t);
  return m ? parseTimes(m[1]!, m[2]!) : null;
}

/** "54-62;70", "54, 55, 56" → sorted bay numbers. */
export function parseBays(input: string): number[] | null {
  const out = new Set<number>();
  for (const part of input.split(/[;,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > 500) return null;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/** [54, 55, 56, 61] → "54–56, 61" (display); "54-56;61" with ascii = true (CSV). */
export function formatBays(bays: readonly number[] | undefined, ascii = false): string {
  const sorted = [...new Set(bays ?? [])].sort((x, y) => x - y);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}${ascii ? '-' : '–'}${sorted[j]}` : `${sorted[i]}`);
    i = j;
  }
  return parts.join(ascii ? ';' : ', ');
}


/* ───────────────────────────── Segments and names ───────────────────────────── */

const SUFFIX: Record<string, string> = { st: 'street', rd: 'road', ave: 'avenue', av: 'avenue', pde: 'parade', pl: 'place', hwy: 'highway', cres: 'crescent', ct: 'court', dr: 'drive', tce: 'terrace', bvd: 'boulevard', blvd: 'boulevard', cl: 'close', sq: 'square' };
const SHORT: Record<string, string> = { street: 'St', road: 'Rd', avenue: 'Ave', parade: 'Pde', place: 'Pl', highway: 'Hwy', crescent: 'Cres', court: 'Ct', drive: 'Dr', terrace: 'Tce', boulevard: 'Bvd', lane: 'Lane' };

/** Lower case, single spaces, a trailing St/Rd/Ave… spelled out ("Smith St" = "smith street"). */
export function normName(s: string | undefined | null): string {
  const words = (s ?? '').toLowerCase().replace(/[.']/g, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length > 1) words[words.length - 1] = SUFFIX[words[words.length - 1]!] ?? words[words.length - 1]!;
  return words.join(' ');
}

/** Short display name: "Little Bourke Street" → "Little Bourke St". */
export function shortName(s: string): string {
  const words = s.trim().split(/\s+/);
  const last = words[words.length - 1]?.toLowerCase() ?? '';
  if (words.length > 1 && SHORT[last]) words[words.length - 1] = SHORT[last];
  return words.join(' ');
}

/**
 * Identity of a timed list for matching on re-import: street, the unordered pair of cross
 * streets, the side, and the sub-segment bounds.
 */
export function segmentKey(seg: StreetSegment): string {
  const a = normName(seg.fromStreet);
  const b = normName(seg.toStreet);
  const sub = [normName(seg.subFrom), normName(seg.subTo)].filter(Boolean).join('>');
  return [normName(seg.street), a < b ? `${a}|${b}` : `${b}|${a}`, seg.side, sub].join('::');
}

const SIDE_LETTER: Record<StreetSide, string> = { both: '', north: 'N', south: 'S', east: 'E', west: 'W', centre: 'C', odd: 'odd', even: 'even' };

/** "Little Bourke St, Swanston St – Elizabeth St (S) · Bay 58 – Bay 72". */
export function defaultListName(seg: StreetSegment): string {
  const side = SIDE_LETTER[seg.side] ? ` (${SIDE_LETTER[seg.side]})` : '';
  const sub = seg.subFrom ? ` · ${shortName(seg.subFrom)}${seg.subTo ? ` – ${shortName(seg.subTo)}` : ''}` : '';
  return `${shortName(seg.street)}, ${shortName(seg.fromStreet)} – ${shortName(seg.toStreet)}${side}${sub}`;
}

/** "northern", "North side", "N", "centre", "both sides", "odd" → a StreetSide. */
export function parseSide(input: string | null | undefined): StreetSide | null {
  const s = (input ?? '').trim().toLowerCase();
  if (!s || /^both/.test(s)) return 'both';
  if (/^(c|centre|center|central|median)\b/.test(s)) return 'centre';
  if (/^n/.test(s)) return 'north';
  if (/^s/.test(s)) return 'south';
  if (/^e(ast|$)/.test(s)) return 'east';
  if (/^w/.test(s)) return 'west';
  if (/^odd/.test(s)) return 'odd';
  if (/^even/.test(s)) return 'even';
  return null;
}

/** All-caps zone names from CivicMAPS ("CHINATOWN") shown as "Chinatown". */
const zoneTitle = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

const cleanPayment = (p: PaymentAreas): PaymentAreas | undefined => {
  const n = normalisePayment(p);
  return n.parkingArea || n.easyPark.length || n.payStay.length || n.meters ? n : undefined;
};

function newRestriction(code: string, minutes: number, days: Weekday[], t: { allDay: boolean; startTime: string; endTime: string }, grace = 0, description = ''): TimedRestriction {
  return { id: uid(), code, limitMinutes: minutes, graceMinutes: grace, days, startTime: t.startTime, endTime: t.endTime, allDay: t.allDay, description };
}

/* ───────────────────────────── Timed CSV ───────────────────────────── */

type Row = Record<string, string>;

/**
 * Column names as in civicmaps.kerbside_release, mapped to the names used here (which the first
 * templates used, so older CSV files keep importing).
 */
const COLUMN_ALIASES: Record<string, string> = {
  road: 'street',
  road_segment_name: 'street',
  between_from: 'from_street',
  between_street_name: 'from_street',
  between_to: 'to_street',
  and_street_name: 'to_street',
  locality: 'suburb',
  part_from: 'sub_from',
  part_to: 'sub_to',
  permit_area: 'rpa',
  sign_code: 'sign',
  limit_minutes: 'minutes',
  grace_minutes: 'grace',
  latitude: 'lat',
  longitude: 'lng',
  bay_number: 'bay',
  road_side: 'side',
  enforcement_zone: 'patrol_zone',
  road_segment_asset_id: 'road_segment_id',
  meters: 'meter_ids',
  meter_id: 'meter_ids',
};

function rowsWithHeader(table: string[][]): { header: string[]; rows: { line: number; row: Row }[] } {
  const header = (table[0] ?? []).map((h) => {
    const name = h.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return COLUMN_ALIASES[name] ?? name;
  });
  const rows = table.slice(1).map((cells, i) => {
    const row: Row = {};
    header.forEach((h, j) => (row[h] = (cells[j] ?? '').trim()));
    return { line: i + 2, row };
  });
  return { header, rows };
}

const splitList = (s: string) => s.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);

/** Controls with no time allowance unless a limit is given. */
const UNTIMED_CONTROLS = new Set(['permit_zone', 'no_stopping', 'no_parking', 'clearway', 'bus_zone', 'taxi_zone', 'accessible', 'works_zone', 'other']);
const ALL_CONTROLS = new Set([...UNTIMED_CONTROLS, 'time_limit', 'metered', 'ticket', 'loading_zone']);
const CONTROL_TEXT: Record<string, string> = {
  permit_zone: 'Permit zone', no_stopping: 'No stopping', no_parking: 'No parking', clearway: 'Clearway', bus_zone: 'Bus zone', taxi_zone: 'Taxi zone',
  accessible: 'Accessible parking', works_zone: 'Works zone', other: 'Other', loading_zone: 'Loading zone (no time limit given)',
};

/** The extent ID "<segment_id>:<side>:<part>" when the CSV gives a segment_id, as in civicmaps.kerbside_release (no part_id: "all"). */
function csvExternalId(row: Row, side: StreetSide): string | undefined {
  return row.segment_id ? `${row.segment_id}:${side}:${row.part_id || 'all'}` : undefined;
}

function timedFromCsv(file: string, table: string[][], out: ImportResult): void {
  const groups = new Map<string, { draft: TimedDraft; notes: string[]; untimed: UntimedControl[]; timed: number; lines: number[] }>();
  for (const { line, row } of rowsWithHeader(table).rows) {
    const issue = (message: string) => out.issues.push({ file, row: line, message });
    if (!row.street || !row.from_street || !row.to_street) {
      issue('road, between_from and between_to are required.');
      continue;
    }
    const side = parseSide(row.side);
    if (!side) {
      issue(`side "${row.side}" is not north, south, east, west, both, odd or even.`);
      continue;
    }
    const status = (row.restrictions_status || '').toLowerCase();
    if (status && !['supplied', 'pending_field_capture', 'no_parking_spaces'].includes(status)) {
      issue(`restrictions_status "${row.restrictions_status}" must be supplied, pending_field_capture or no_parking_spaces.`);
      continue;
    }
    const control = (row.control || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (control && !ALL_CONTROLS.has(control)) {
      issue(`control "${row.control}" is not one of ${[...ALL_CONTROLS].join(', ')}.`);
      continue;
    }
    let bays: number[] | undefined;
    if (row.bays) {
      const b = parseBays(row.bays);
      if (!b) {
        issue(`bays "${row.bays}" must be numbers or ranges such as 54-62;70.`);
        continue;
      }
      bays = b;
    }
    const segment: StreetSegment = {
      street: row.street,
      fromStreet: row.from_street,
      toStreet: row.to_street,
      side,
      suburb: row.suburb ?? '',
      ...(row.sub_from ? { subFrom: row.sub_from } : {}),
      ...(row.sub_to ? { subTo: row.sub_to } : {}),
    };
    if (status === 'no_parking_spaces') {
      out.skipped.push(`${describeSegment(segment)}: no parking spaces — row ${line}`);
      continue;
    }

    // A sign needs readable days and times; check before the row joins its list.
    let restriction: TimedRestriction | null = null;
    let untimed: UntimedControl | null = null;
    const hasSign = status !== 'pending_field_capture' && Boolean(row.sign || row.minutes || control);
    if (hasSign) {
      const override = row.minutes ? Number(row.minutes) : NaN;
      if (row.minutes && !(Number.isInteger(override) && override >= 1 && override <= 1440)) {
        issue(`limit_minutes "${row.minutes}" must be a whole number between 1 and 1440.`);
        continue;
      }
      const days = parseDays(row.days ?? '');
      if (!days) {
        issue(`days "${row.days}" not understood (use Mon-Fri, Sat-Sun, Mon,Wed or Every day).`);
        continue;
      }
      const times = parseTimes(row.start ?? '', row.end ?? '');
      if (!times) {
        issue(`start/end "${row.start}"–"${row.end}" must be HH:MM (24 h), or both blank for all times.`);
        continue;
      }
      const grace = row.grace ? Number(row.grace) : 0;
      if (!(grace >= 0 && grace <= 120)) {
        issue(`grace_minutes "${row.grace}" must be between 0 and 120.`);
        continue;
      }
      const parsed: ParsedSign | null = row.sign ? parseSign(row.sign, row.minutes || null) : null;
      const exceptions = splitList(row.exceptions ?? '').join(' · ');
      const timedByControl = control && !UNTIMED_CONTROLS.has(control) && (Number.isFinite(override) || (parsed && 'code' in parsed));
      if ((parsed && 'code' in parsed && !UNTIMED_CONTROLS.has(control)) || timedByControl) {
        const code = parsed && 'code' in parsed ? parsed.code : row.sign ? row.sign.toUpperCase() : control === 'loading_zone' ? `LZ${override}` : `${override} min`;
        const minutes = Number.isFinite(override) ? override : (parsed as { minutes: number }).minutes;
        const kind = control === 'metered' ? 'Meter' : control === 'ticket' ? 'Ticket' : '';
        const signDesc = parsed && 'code' in parsed ? parsed.description : '';
        const description = [kind && signDesc.toLowerCase() !== kind.toLowerCase() ? kind : '', signDesc, exceptions].filter(Boolean).join(' · ');
        restriction = newRestriction(code, minutes, days, times, grace, description);
      } else if (!control && Number.isFinite(override) && row.sign) {
        restriction = newRestriction(row.sign.toUpperCase(), override, days, times, grace, exceptions);
      } else {
        const c = (control || (parsed && 'control' in parsed ? parsed.control : 'other')) as UntimedControl['control'];
        const label = parsed && 'note' in parsed ? parsed.note : row.sign || CONTROL_TEXT[c] || 'Other';
        untimed = { control: c, label, days, ...times, description: exceptions };
      }
    }

    const ext = csvExternalId(row, side);
    const key = ext ? `ext:${ext}` : segmentKey(segment);
    let g = groups.get(key);
    if (!g) {
      g = {
        draft: {
          kind: 'timed',
          pending: true,
          source: `${file} row ${line}`,
          list: {
            type: 'timed',
            name: row.list_name || defaultListName(segment),
            notes: '',
            segment,
            restrictions: [],
            allowListIds: [],
            payment: { easyPark: [], payStay: [] },
            ...(ext ? { externalId: ext } : {}),
          },
        },
        notes: [],
        untimed: [],
        timed: 0,
        lines: [],
      };
      groups.set(key, g);
    }
    g.lines.push(line);
    const l = g.draft.list;
    // First value given wins for single-valued fields; lists of IDs are combined.
    if (!l.patrolZone && row.patrol_zone) l.patrolZone = row.patrol_zone;
    if (!l.patrolZoneName && row.patrol_zone_name) l.patrolZoneName = row.patrol_zone_name;
    if (!l.rpa && row.rpa) l.rpa = row.rpa;
    if (!l.roadSegmentId && row.road_segment_id) l.roadSegmentId = row.road_segment_id;
    if (!l.segment.suburb && row.suburb) l.segment = { ...l.segment, suburb: row.suburb };
    if (row.list_name && l.name === defaultListName(l.segment)) l.name = row.list_name;
    const pay = l.payment!;
    if (!pay.parkingArea && row.parking_area) pay.parkingArea = row.parking_area;
    // The numbers on a sign's row pay for that sign's restriction; `zone:meter` ties a meter to a zone.
    const rowAreas = splitList(row.easypark_areas ?? '');
    const rowZones: string[] = [];
    const meters = (pay.meters ??= []);
    for (const a of rowAreas) if (!pay.easyPark.includes(a)) pay.easyPark.push(a);
    for (const z of splitList(row.paystay_zones ?? '')) {
      const [zone = '', meter = ''] = z.split(':').map((x) => x.trim());
      if (!zone) continue;
      rowZones.push(zone);
      if (!pay.payStay.some((p) => p.zone === zone)) pay.payStay.push({ zone });
      if (meter) meters.push({ id: meter, easyPark: [], payStay: [zone] });
    }
    // Meters for the whole segment (and its parking area).
    for (const m of splitList(row.meter_ids ?? '')) meters.push({ id: m, easyPark: [], payStay: [] });
    if (restriction && (rowAreas.length || rowZones.length)) restriction.paidBy = { easyPark: rowAreas, payStay: [...new Set(rowZones)] };
    if (bays) l.bays = [...new Set([...(l.bays ?? []), ...bays])].sort((x, y) => x - y);
    if (row.notes && !g.notes.includes(row.notes)) g.notes.push(row.notes);
    if (untimed) g.untimed.push(untimed);
    if (restriction) {
      l.restrictions.push(restriction);
      g.timed++;
    }
    if (hasSign) g.draft.pending = false;
  }
  for (const g of groups.values()) {
    const l = g.draft.list;
    l.notes = g.notes.join('\n');
    l.payment = cleanPayment(l.payment!);
    if (g.untimed.length) l.untimedControls = g.untimed;
    // Signs given but none of them timed (e.g. No Stopping only): nothing to time.
    if (!g.draft.pending && !g.timed) {
      out.skipped.push(`${describeSegment(l.segment)}: no timed parking (${[...new Set(g.untimed.map((u) => u.label))].join('; ')}) — rows ${g.lines.join(', ')}`);
      continue;
    }
    out.drafts.push(g.draft);
  }
}

/** Bays CSV: one row per numbered bay, with its position and plate number where known. */
function baysFromCsv(file: string, table: string[][], out: ImportResult): void {
  const groups = new Map<string, BaysDraft>();
  for (const { line, row } of rowsWithHeader(table).rows) {
    const issue = (message: string) => out.issues.push({ file, row: line, message });
    if (!row.street || !row.from_street || !row.to_street) {
      issue('road, between_from and between_to are required.');
      continue;
    }
    const side = parseSide(row.side);
    if (!side) {
      issue(`side "${row.side}" is not north, south, east, west, both, odd or even.`);
      continue;
    }
    const bay = Number(row.bay);
    if (!Number.isInteger(bay) || bay < 0) {
      issue(`bay "${row.bay}" must be a whole number.`);
      continue;
    }
    const lat = row.lat ? Number(row.lat) : NaN;
    const lng = row.lng ? Number(row.lng) : NaN;
    if ((row.lat || row.lng) && !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
      issue(`lat/lng "${row.lat}, ${row.lng}" must be decimal degrees (WGS84), e.g. -37.8125, 144.9649.`);
      continue;
    }
    const segment: StreetSegment = {
      street: row.street,
      fromStreet: row.from_street,
      toStreet: row.to_street,
      side,
      suburb: row.suburb ?? '',
      ...(row.sub_from ? { subFrom: row.sub_from } : {}),
      ...(row.sub_to ? { subTo: row.sub_to } : {}),
    };
    const ext = csvExternalId(row, side);
    const key = ext ? `ext:${ext}` : segmentKey(segment);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { kind: 'bays', source: `${file} row ${line}`, target: { segment, ...(ext ? { externalId: ext } : {}) }, bays: [], points: [] }));
    if (!g.bays.includes(bay)) g.bays.push(bay);
    if (Number.isFinite(lat)) g.points = [...g.points.filter((p) => p.bay !== bay), { bay, lat, lng, ...(row.sign_number ? { sign: row.sign_number } : {}) }];
  }
  for (const g of groups.values()) g.bays.sort((a, b) => a - b);
  out.drafts.push(...groups.values());
}

function describeSegment(seg: StreetSegment): string {
  const sub = seg.subFrom ? `, ${seg.subFrom}${seg.subTo ? ` – ${seg.subTo}` : ''}` : '';
  return `${seg.street} ${seg.fromStreet} – ${seg.toStreet}, ${seg.side === 'both' ? 'both sides' : `${seg.side} side`}${sub}`;
}

/* ───────────────────────────── Allow and hot CSV ───────────────────────────── */

/** "2026-07-01" or Australian "01/07/2026" → "2026-07-01"; null when unreadable. */
function isoDate(input: string): string | null {
  const s = input.trim();
  if (!s) return '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return null;
}

/** Allow or hot list drafts by name (case-insensitive), in the order first seen. */
function namedLists<T extends AllowDraft | HotDraft>(make: (name: string) => T): { get: (name: string) => T; all: () => T[] } {
  const byName = new Map<string, T>();
  return {
    get(name) {
      const k = name.trim().toLowerCase();
      let d = byName.get(k);
      if (!d) byName.set(k, (d = make(name.trim())));
      return d;
    },
    all: () => [...byName.values()],
  };
}

function allowFromCsv(file: string, table: string[][], out: ImportResult): void {
  const lists = namedLists<AllowDraft>((name) => ({ kind: 'allow', source: file, list: { type: 'allow', name, notes: '', entries: [] } }));
  for (const { line, row } of rowsWithHeader(table).rows) {
    const plate = normalisePlate(row.plate ?? '');
    if (!row.list_name || !plate) {
      out.issues.push({ file, row: line, message: 'list_name and plate are required.' });
      continue;
    }
    const validFrom = isoDate(row.valid_from ?? '');
    const validTo = isoDate(row.valid_to ?? '');
    if (validFrom === null || validTo === null) {
      out.issues.push({ file, row: line, message: 'valid_from / valid_to must be YYYY-MM-DD or DD/MM/YYYY.' });
      continue;
    }
    const { vehicle, problems } = vehicleColumns(row);
    if (problems.length) {
      out.issues.push({ file, row: line, message: `${problems.join('; ')}.` });
      continue;
    }
    const permitNo = (row.permit_no ?? '').trim().toUpperCase();
    const parts = permitNo ? parsePermitNumber(permitNo) : null;
    const entry: AllowEntry = { id: uid(), plate, key: plateKey(plate), label: row.label ?? '', permitNo, validFrom, validTo, addedAt: Date.now() };
    // Permit details the council holds: vehicle details (infringement structure), types, area, address.
    Object.assign(entry, compactVehicle(vehicle));
    if (parts) entry.permitTypes = parts.types;
    const council = (row.council ?? '').trim().toLowerCase();
    if (council) entry.council = { code: council, ...(row.linking_id?.trim() ? { linkingId: row.linking_id.trim() } : {}) };
    if (row.street?.trim()) entry.address = { streetNumber: (row.street_number ?? '').trim(), street: row.street.trim() };
    const rpa = (row.parking_area ?? row.rpa ?? '').trim();
    const streets = [
      ...(row.streets ?? '').split(/[;|]/).map((x) => x.trim()).filter(Boolean),
      // RSP / RP apply on the registered address's street.
      ...(parts?.types.some((t) => t === 'RSP' || t === 'RP') && entry.address ? [entry.address.street] : []),
    ];
    if (rpa) entry.rpa = rpa;
    if (streets.length) entry.streets = [...new Set(streets)];
    const entries = lists.get(row.list_name).list.entries;
    const i = entries.findIndex((e) => e.key === entry.key);
    if (i >= 0) entries[i] = { ...entry, id: entries[i]!.id };
    else entries.push(entry);
  }
  out.drafts.push(...lists.all());
}

const RISK_BY_LABEL = new Map<string, RiskTag>(RISK_TAGS.flatMap((t) => [[t, t], [RISK_TAG_LABELS[t].toLowerCase(), t]] as [string, RiskTag][]));
const LEVEL_BY_LABEL = new Map<string, RiskLevel>(
  (Object.keys(RISK_LEVEL_LABELS) as RiskLevel[]).flatMap((l) => [[l, l], [RISK_LEVEL_LABELS[l].toLowerCase(), l]] as [string, RiskLevel][]),
);

function hotFromCsv(file: string, table: string[][], out: ImportResult): void {
  const lists = namedLists<HotDraft>((name) => ({ kind: 'hot', source: file, list: { type: 'hot', name, notes: '', entries: [] } }));
  for (const { line, row } of rowsWithHeader(table).rows) {
    const plate = normalisePlate(row.plate ?? '');
    if (!row.list_name || !plate) {
      out.issues.push({ file, row: line, message: 'list_name and plate are required.' });
      continue;
    }
    const level = LEVEL_BY_LABEL.get((row.risk_level || 'caution').toLowerCase());
    if (!level) {
      out.issues.push({ file, row: line, message: `risk_level "${row.risk_level}" must be caution, high or extreme.` });
      continue;
    }
    const hotVehicle = vehicleColumns(row);
    if (hotVehicle.problems.length) {
      out.issues.push({ file, row: line, message: `${hotVehicle.problems.join('; ')}.` });
      continue;
    }
    const risks: RiskTag[] = [];
    const unknown: string[] = [];
    for (const r of (row.risks ?? '').split(/[;|]/).map((x) => x.trim()).filter(Boolean)) {
      const tag = RISK_BY_LABEL.get(r.toLowerCase().replace(/\s+/g, ' ')) ?? RISK_BY_LABEL.get(r.toLowerCase().replace(/[\s/]+/g, '_'));
      if (tag) risks.push(tag);
      else unknown.push(r);
    }
    if (unknown.length) {
      out.issues.push({ file, row: line, message: `risks not recognised: ${unknown.join(', ')} (use ${RISK_TAGS.map((t) => RISK_TAG_LABELS[t]).join(', ')}).` });
      continue;
    }
    const entry: HotEntry = {
      id: uid(),
      plate,
      key: plateKey(plate),
      risks: [...new Set(risks)],
      riskLevel: level,
      ...vehicleOf(hotVehicle.vehicle),
      // Model is not part of the vehicle-details structure: an older file's model column goes to notes.
      notes: [row.notes ?? '', row.model?.trim() ? `Model: ${row.model.trim()}` : ''].filter(Boolean).join(' · '),
      ...(row.alert_message?.trim() ? { alertMessage: row.alert_message.trim().slice(0, 160) } : {}),
      ...(row.owner_description?.trim() ? { ownerDescription: row.owner_description.trim().slice(0, 300) } : {}),
      addedAt: Date.now(),
    };
    const entries = lists.get(row.list_name).list.entries;
    const i = entries.findIndex((e) => e.key === entry.key);
    if (i >= 0) entries[i] = { ...entry, id: entries[i]!.id };
    else entries.push(entry);
  }
  out.drafts.push(...lists.all());
}

/* ───────────────────────────── CivicMAPS-preview JSON ───────────────────────────── */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A sub-segment bound: a street, "Bay 58", an address, or a coordinate object. */
function bound(v: unknown): string {
  if (isObj(v) && Array.isArray(v.value)) return `point ${(v.value as number[]).map((n) => Number(n).toFixed(5)).join(', ')}`;
  return str(v);
}

/** EasyPark area as a number, null, or a map of stretch → number. */
function easyParkAreas(v: unknown): string[] {
  if (isObj(v)) return Object.values(v).map(str).filter(Boolean);
  const s = str(v);
  return s ? [s] : [];
}

interface RuleSet {
  type: string;
  limit?: string;
  rules: { days: string; time: string }[];
}

function ruleSets(v: unknown): RuleSet[] {
  return arr(v)
    .filter(isObj)
    .map((s) => ({
      type: str(s.type ?? s.restriction),
      limit: str(s.limit) || undefined,
      rules: arr(s.rules).filter(isObj).map((r) => ({ days: str(r.days), time: str(r.time) })),
    }))
    .filter((s) => s.type);
}

interface SubSegment {
  street: string;
  fromStreet: string;
  toStreet: string;
  side: StreetSide;
  subFrom?: string;
  subTo?: string;
  zoneName?: string;
  roadSegmentId?: string;
  parkingArea?: string;
  easyPark: string[];
  bays?: number[];
  bayPoints?: { bay: number; lat: number; lng: number }[];
  signs: RuleSet[];
  /** Explicitly still to be surveyed. */
  pending: boolean;
  notes: string[];
}

/** Turn one side or sub-segment into a timed list draft, or a skip reason. */
function draftFromSub(file: string, s: SubSegment, out: ImportResult): void {
  const segment: StreetSegment = {
    street: s.street,
    fromStreet: s.fromStreet,
    toStreet: s.toStreet,
    side: s.side,
    suburb: '',
    ...(s.subFrom ? { subFrom: s.subFrom } : {}),
    ...(s.subTo ? { subTo: s.subTo } : {}),
  };
  const restrictions: TimedRestriction[] = [];
  const untimed: UntimedControl[] = [];
  for (const set of s.signs) {
    const sign = parseSign(set.type, set.limit);
    const rules = set.rules.length ? set.rules : [{ days: 'all_days', time: 'all_times' }];
    for (const r of rules) {
      const days = parseDays(r.days);
      const times = parseRuleTime(r.time);
      if ('code' in sign) {
        if (!days || !times) {
          out.issues.push({ file, message: `${describeSegment(segment)}: ${set.type} "${r.days} ${r.time}" not understood; rule left out.` });
          continue;
        }
        restrictions.push(newRestriction(sign.code, sign.minutes, days, times, 0, sign.description));
      } else if (days && times) {
        untimed.push({ control: sign.control, label: sign.note, days, ...times, description: '' });
      } else {
        // Unreadable times on an untimed sign ("all_other_times"): keep it, as signed, every day.
        untimed.push({ control: sign.control, label: sign.note, days: days ?? [0, 1, 2, 3, 4, 5, 6], allDay: true, startTime: '00:00', endTime: '24:00', description: `${r.days} ${r.time}`.trim() });
      }
    }
  }
  if (s.signs.length && !restrictions.length) {
    out.skipped.push(`${describeSegment(segment)}: no timed parking (${[...new Set(untimed.map((u) => u.label))].join('; ')})`);
    return;
  }
  const payment = cleanPayment({ ...(s.parkingArea ? { parkingArea: s.parkingArea } : {}), easyPark: s.easyPark, payStay: [] });
  out.drafts.push({
    kind: 'timed',
    pending: !restrictions.length,
    source: file,
    list: {
      type: 'timed',
      name: defaultListName(segment),
      notes: s.notes.join('\n'),
      segment,
      restrictions,
      allowListIds: [],
      ...(untimed.length ? { untimedControls: untimed } : {}),
      ...(s.bayPoints?.length ? { bayPoints: s.bayPoints } : {}),
      ...(s.zoneName ? { patrolZoneName: zoneTitle(s.zoneName) } : {}),
      ...(s.roadSegmentId ? { roadSegmentId: s.roadSegmentId } : {}),
      ...(payment ? { payment } : {}),
      ...(s.bays?.length ? { bays: s.bays } : {}),
    },
  });
}

/** Sub-segment bounds only when they are a part of the side, not the whole of it. */
function partOf(from: string, to: string, segFrom: string, segTo: string): { subFrom?: string; subTo?: string } {
  const whole = [normName(from), normName(to)].sort().join('|') === [normName(segFrom), normName(segTo)].sort().join('|');
  return whole || (!from && !to) ? {} : { ...(from ? { subFrom: from } : {}), ...(to ? { subTo: to } : {}) };
}

/** civicmaps.kerbside_parking_segment.v1 */
function fromKerbside(file: string, d: Json, out: ImportResult): void {
  const street = str(d.on_street);
  const fromStreet = str(d.street_from);
  const toStreet = str(d.street_to);
  for (const side of arr(d.sides).filter(isObj)) {
    const sideName = parseSide(str(side.street_side) || str(side.display_side)) ?? 'both';
    for (const sub of arr(side.sub_segments).filter(isObj)) {
      const from = bound(sub.from);
      const to = bound(sub.to);
      const base = { street, fromStreet, toStreet, side: sideName, ...partOf(from, to, fromStreet, toStreet) };
      if (str(sub.sub_segment_type) === 'no_parking_spaces') {
        out.skipped.push(`${describeSegment({ ...base, suburb: '' })}: no parking spaces`);
        continue;
      }
      const bayObjs = arr(sub.bays).filter(isObj);
      const bays = bayObjs.map((b) => Number(b.bay)).filter((n) => Number.isFinite(n));
      const bayPoints = bayObjs
        .filter((b) => Number.isFinite(Number(b.bay)) && isObj(b.location) && typeof b.location.latitude === 'number' && typeof b.location.longitude === 'number')
        .map((b) => ({ bay: Number(b.bay), lat: (b.location as Json).latitude as number, lng: (b.location as Json).longitude as number }));
      draftFromSub(file, {
        ...base,
        zoneName: str(d.patrol_zone) || undefined,
        roadSegmentId: str(d.road_segment_id) || undefined,
        parkingArea: str(sub.parking_area) || undefined,
        easyPark: easyParkAreas(sub.easypark_area),
        bays: [...new Set(bays)].sort((x, y) => x - y),
        bayPoints,
        signs: ruleSets(sub.parking_rules),
        pending: /pending/.test(str(sub.parking_rules_status)),
        notes: str(sub.notes) && !/^Bay allocation inferred/.test(str(sub.notes)) ? [str(sub.notes)] : [],
      }, out);
    }
  }
}

/** road-segments/<street>/<from>-to-<to>.json: { street, segments: [{ between, side, signs | sub_segments }] } */
function fromRoadSegments(file: string, d: Json, out: ImportResult): void {
  const street = str(d.street);
  for (const seg of arr(d.segments).filter(isObj)) {
    const between = isObj(seg.between) ? seg.between : {};
    const fromStreet = str(between.from);
    const toStreet = str(between.to);
    const side = parseSide(str(seg.side)) ?? 'both';
    const parkingArea = str(seg.parking_area_number) || undefined;
    const subs = arr(seg.sub_segments).filter(isObj);
    if (!subs.length) {
      draftFromSub(file, { street, fromStreet, toStreet, side, parkingArea, easyPark: easyParkAreas(seg.easypark_area), signs: ruleSets(seg.signs), pending: !arr(seg.signs).length, notes: [] }, out);
      continue;
    }
    for (const sub of subs) {
      draftFromSub(file, {
        street,
        fromStreet,
        toStreet,
        side,
        ...partOf(bound(sub.from), bound(sub.to), fromStreet, toStreet),
        parkingArea: str(sub.parking_area_number) || parkingArea,
        easyPark: easyParkAreas(sub.easypark_area ?? seg.easypark_area),
        signs: ruleSets(sub.signs),
        pending: !arr(sub.signs).length,
        notes: [],
      }, out);
    }
  }
}

/** Field survey (civicmaps.parking_segment): { street, between, sides: [{ side, restrictions: [...] }], laneways } */
function fromSurvey(file: string, d: Json, out: ImportResult): void {
  const street = str(d.street);
  const between = isObj(d.between) ? d.between : {};
  const fromStreet = str(between.from);
  const toStreet = str(between.to);
  const parkingArea = str(d.parking_area_number) || undefined;
  const easyPark = easyParkAreas(d.easypark_area);
  for (const side of arr(d.sides).filter(isObj)) {
    const sideName = parseSide(str(side.side)) ?? 'both';
    // Restrictions at the same place (address reference and bays) form one sub-segment.
    const places = new Map<string, { from: string; to: string; bays: number[]; signs: Json[] }>();
    for (const r of arr(side.restrictions).filter(isObj)) {
      const bays = arr(r.bay_numbers).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
      const ref = str(r.location_reference);
      const from = ref || str(r.from) || (bays.length ? `Bay ${bays.join(', ')}` : '');
      const to = ref ? '' : str(r.to);
      const key = `${from}|${to}|${bays.join(',')}`;
      const p = places.get(key) ?? { from, to, bays, signs: [] };
      p.signs.push(r);
      places.set(key, p);
    }
    for (const p of places.values()) {
      draftFromSub(file, {
        street,
        fromStreet,
        toStreet,
        side: sideName,
        ...partOf(p.from, p.to, fromStreet, toStreet),
        parkingArea,
        easyPark,
        bays: p.bays,
        signs: ruleSets(p.signs),
        pending: false,
        notes: [],
      }, out);
    }
  }
  for (const lane of arr(d.laneways).filter(isObj)) {
    const b = isObj(lane.between) ? lane.between : {};
    draftFromSub(file, { street: str(lane.street), fromStreet: str(b.from), toStreet: str(b.to), side: 'both', easyPark: [], signs: ruleSets([lane]), pending: false, notes: [] }, out);
  }
}

/** parking-area-zones/<area>.json: { area, parking_zones | records | numeric_records: [...] } */
function fromParkingAreas(file: string, d: Json, out: ImportResult): void {
  const rows = arr(d.parking_zones ?? d.records ?? d.numeric_records).filter(isObj);
  let missing = 0;
  for (const r of rows) {
    const street = str(r.onstreet);
    const fromStreet = str(r.streetfrom);
    const toStreet = str(r.streetto);
    if (!street || !fromStreet || !toStreet) {
      missing++;
      continue;
    }
    const meters = Number(r.meter_count);
    draftFromSub(file, {
      street,
      fromStreet,
      toStreet,
      side: 'both',
      zoneName: str(d.area) || undefined,
      roadSegmentId: str(r.segment_id) || undefined,
      parkingArea: str(r.parking_area_number) || undefined,
      easyPark: easyParkAreas(r.easy_park_area_number),
      signs: [],
      pending: true,
      notes: Number.isFinite(meters) && meters > 0 ? [`${meters} parking meter${meters === 1 ? '' : 's'}`] : [],
    }, out);
  }
  if (missing) out.skipped.push(`${missing} parking area record${missing === 1 ? '' : 's'} without a street segment yet (still to be completed)`);
}

function jsonKind(d: Json): ImportKind {
  if (d.schema === RELEASE_SCHEMA) return 'civicmaps-release';
  if (isAreaDataset(d)) return 'area-dataset';
  if (str(d.schema).startsWith('civicmaps.kerbside_parking_segment') || (Array.isArray(d.sides) && 'on_street' in d)) return 'civicmaps-kerbside';
  if (Array.isArray(d.segments) && 'street' in d) return 'civicmaps-road-segment';
  if (Array.isArray(d.sides) && 'street' in d) return 'civicmaps-survey';
  if ('area' in d && (Array.isArray(d.parking_zones) || Array.isArray(d.records) || Array.isArray(d.numeric_records))) return 'civicmaps-parking-areas';
  return 'unknown';
}

/** civicmaps.kerbside_release: validated first; a release with problems is not imported at all. */
function fromRelease(file: string, r: KerbsideRelease, out: ImportResult): void {
  const errors = validateRelease(r);
  if (errors.length) {
    for (const e of errors.slice(0, 200)) out.issues.push({ file, message: `${e.path}: ${e.message}` });
    if (errors.length > 200) out.issues.push({ file, message: `…and ${errors.length - 200} more problems.` });
    return;
  }
  const { drafts, skipped } = releaseToDrafts(r);
  out.skipped.push(...skipped);
  for (const x of drafts) out.drafts.push({ kind: 'timed', list: x.list, pending: x.pending, source: file });
}

/** Council "street_segments + record_defaults" area datasets, adapted to a candidate release on the way in. */
function fromAreaDataset(file: string, d: Json, out: ImportResult): void {
  const { release, warnings } = areaDatasetToRelease(d);
  for (const w of warnings) out.issues.push({ file, message: w });
  fromRelease(file, release, out);
}

/* ───────────────────────────── Entry point ───────────────────────────── */

/** Read one file (CSV template or CivicMAPS-preview JSON) into drafts, issues and skips. */
/**
 * Permit JSON: one permit list per council in the file, "Permits · <council>". Each record is
 * validated against the permit schema rules; a record with problems is listed and not imported.
 */
function permitsFromJson(file: string, records: unknown[], out: ImportResult): void {
  const lists = new Map<string, AllowDraft>();
  records.forEach((r, i) => {
    const errs = validatePermitRecord(r, `permits[${i}].`);
    if (errs.length) {
      for (const message of errs) out.issues.push({ file, message });
      return;
    }
    const entry = permitToEntry(r as Record<string, any>, uid());
    const council = entry.council!.code;
    let d = lists.get(council);
    if (!d) lists.set(council, (d = { kind: 'allow', source: file, list: { type: 'allow', name: `Permits · ${council}`, notes: '', entries: [] } }));
    const i2 = d.list.entries.findIndex((e) => e.key === entry.key && e.permitNo === entry.permitNo);
    if (i2 >= 0) d.list.entries[i2] = entry;
    else d.list.entries.push(entry);
  });
  out.drafts.push(...lists.values());
}

export function parseImportFile(text: string, file: string): ImportResult {
  const out: ImportResult = { file, kind: 'unknown', drafts: [], issues: [], skipped: [] };
  const trimmed = text.replace(/^﻿/, '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      out.issues.push({ file, message: 'File is not valid JSON.' });
      return out;
    }
    // Residential parking permits (schemas/civicmaps-parking-permit.v1.schema.json).
    const permits = permitRecords(data);
    if (permits) {
      out.kind = 'permits-json';
      permitsFromJson(file, permits, out);
      return out;
    }
    const docs = Array.isArray(data) ? data.filter(isObj) : isObj(data) ? [data] : [];
    const kinds = new Set<ImportKind>();
    for (const d of docs) {
      const kind = jsonKind(d);
      kinds.add(kind);
      if (kind === 'civicmaps-release') fromRelease(file, d as unknown as KerbsideRelease, out);
      else if (kind === 'area-dataset') fromAreaDataset(file, d, out);
      else if (kind === 'civicmaps-kerbside') fromKerbside(file, d, out);
      else if (kind === 'civicmaps-road-segment') fromRoadSegments(file, d, out);
      else if (kind === 'civicmaps-survey') fromSurvey(file, d, out);
      else if (kind === 'civicmaps-parking-areas') fromParkingAreas(file, d, out);
    }
    kinds.delete('unknown');
    out.kind = kinds.size === 1 ? [...kinds][0]! : kinds.size > 1 ? 'civicmaps-mixed' : 'unknown';
    if (out.kind === 'unknown') {
      out.issues.push({ file, message: 'Not a recognised file: expected a civicmaps.kerbside_release, an area dataset (street_segments), a PlateWatch CSV template, or a CivicMAPS-preview kerbside, road-segment, field-survey or parking-area-zone JSON file.' });
    }
    return out;
  }
  const table = parseCsv(trimmed);
  const { header } = rowsWithHeader(table);
  if (header.includes('bay') && header.includes('street')) {
    out.kind = 'bays-csv';
    baysFromCsv(file, table, out);
  } else if (header.includes('street') && header.includes('from_street')) {
    out.kind = 'timed-csv';
    timedFromCsv(file, table, out);
  } else if (header.includes('plate') && header.includes('risk_level')) {
    out.kind = 'hot-csv';
    hotFromCsv(file, table, out);
  } else if (header.includes('plate') && header.includes('list_name')) {
    out.kind = 'allow-csv';
    allowFromCsv(file, table, out);
  } else if (/\.(csv|txt)$/i.test(file)) {
    out.issues.push({ file, row: 1, message: 'CSV header not recognised: start from one of the PlateWatch templates (timed segments, allow list or hot list).' });
  } else {
    out.issues.push({ file, message: 'Not a recognised file: expected a PlateWatch CSV template or a CivicMAPS-preview JSON data file.' });
  }
  return out;
}

/* ───────────────────────────── Plan ───────────────────────────── */

export interface ImportPlan {
  created: PlateList[];
  updated: PlateList[];
  /** Matching lists left as they were (updating turned off). */
  unchanged: number;
  /** Bays CSV rows whose segment has no timed list on the device or in the import. */
  unmatchedBays: string[];
  /** Timed lists with no restrictions yet, among created. */
  placeholders: number;
}

/**
 * Match drafts against the lists on the device: timed lists by segment (street, cross streets,
 * side, sub-segment), allow and hot lists by name. Matching lists are updated (when allowed):
 * imported fields replace theirs, the list keeps its id, name, linked allow lists and history,
 * and a placeholder never wipes restrictions already entered.
 */
export function planImport(drafts: readonly ImportDraft[], existing: readonly PlateList[], opts: { updateExisting: boolean }, now = Date.now()): ImportPlan {
  // A timed list is found by its dataset external ID first, then by its segment.
  const keysOf = (l: { type: PlateList['type']; name: string; segment?: StreetSegment; externalId?: string }): string[] =>
    l.type === 'timed' ? [...(l.externalId ? [`ext:${l.externalId}`] : []), `timed:${segmentKey(l.segment!)}`] : [`${l.type}:${l.name.trim().toLowerCase()}`];
  const index = new Map<string, PlateList>();
  for (const l of existing) for (const k of keysOf(l)) if (!index.has(k)) index.set(k, l);
  const changed = new Map<string, { list: PlateList; isNew: boolean }>();
  const leftAlone = new Set<string>();

  const unmatchedBays: string[] = [];
  /** Files each changed list came from (a draft's source is "file" or "file row n"). */
  const filesById = new Map<string, Set<string>>();
  const noteFile = (id: string, source: string) => {
    let set = filesById.get(id);
    if (!set) filesById.set(id, (set = new Set()));
    set.add(source.replace(/ row \d+$/, ''));
  };

  for (const d of drafts) {
    const keys = d.kind === 'bays' ? keysOf({ type: 'timed', name: '', ...d.target }) : keysOf(d.list as PlateList);
    const found = keys.map((k) => index.get(k)).find(Boolean);
    const target = found ? changed.get(found.id)?.list ?? found : undefined;
    if (d.kind === 'bays') {
      // Bays attach to a timed list already on the device or in this import; they never create one.
      if (!target || target.type !== 'timed') {
        unmatchedBays.push(`${describeSegment(d.target.segment)}: no timed list for bays ${formatBays(d.bays)} (${d.source})`);
        continue;
      }
      const isNewTarget = changed.get(target.id)?.isNew ?? false;
      if (!isNewTarget && !opts.updateExisting) {
        leftAlone.add(target.id);
        continue;
      }
      const points = new Map((target.bayPoints ?? []).map((p) => [p.bay, p]));
      for (const p of d.points) points.set(p.bay, p);
      const merged: TimedList = {
        ...target,
        bays: [...new Set([...(target.bays ?? []), ...d.bays])].sort((a, b) => a - b),
        ...(points.size ? { bayPoints: [...points.values()].sort((a, b) => a.bay - b.bay) } : {}),
        updatedAt: now,
      };
      changed.set(merged.id, { list: merged, isNew: isNewTarget });
      noteFile(merged.id, d.source);
      for (const k of keysOf(merged)) index.set(k, merged);
      continue;
    }
    let next: PlateList;
    let isNew = true;
    if (!target) next = { ...structuredClone(d.list), id: uid(), createdAt: now, updatedAt: now } as PlateList;
    else {
      isNew = changed.get(target.id)?.isNew ?? false;
      if (!isNew && !opts.updateExisting) {
        leftAlone.add(target.id);
        continue;
      }
      next = mergeInto(target, d, now);
    }
    changed.set(next.id, { list: next, isNew });
    noteFile(next.id, d.source);
    for (const k of [...keys, ...keysOf(next)]) index.set(k, next);
  }
  // Every list an import creates or changes is a system list (OQ26-5): in EnforcementMAPS its
  // settings are not edited on the device. Record which file(s) it came from.
  for (const [id, files] of filesById) {
    const c = changed.get(id);
    if (c) c.list = { ...c.list, source: systemSource([...files].join(', '), now) };
  }
  const createdLists = [...changed.values()].filter((c) => c.isNew).map((c) => c.list);
  return {
    created: createdLists,
    updated: [...changed.values()].filter((c) => !c.isNew).map((c) => c.list),
    unchanged: leftAlone.size,
    unmatchedBays,
    placeholders: createdLists.filter((l) => l.type === 'timed' && !l.restrictions.length).length,
  };
}

function mergeInto(target: PlateList, d: ImportDraft, now: number): PlateList {
  if (d.kind === 'timed' && target.type === 'timed') {
    const l = d.list;
    return {
      ...target,
      ...(l.patrolZone ? { patrolZone: l.patrolZone } : {}),
      ...(l.patrolZoneName ? { patrolZoneName: l.patrolZoneName } : {}),
      ...(l.rpa ? { rpa: l.rpa } : {}),
      ...(l.roadSegmentId ? { roadSegmentId: l.roadSegmentId } : {}),
      ...(l.bays?.length ? { bays: l.bays } : {}),
      ...(l.bayPoints?.length ? { bayPoints: l.bayPoints } : {}),
      ...(l.externalId ? { externalId: l.externalId } : {}),
      ...(l.displayId ? { displayId: l.displayId } : {}),
      ...(l.untimedControls?.length ? { untimedControls: structuredClone(l.untimedControls) } : {}),
      ...(l.payment ? { payment: l.payment } : {}),
      segment: { ...target.segment, ...(l.segment.suburb ? { suburb: l.segment.suburb } : {}) },
      restrictions: d.pending ? target.restrictions : structuredClone(l.restrictions),
      notes: l.notes || target.notes,
      updatedAt: now,
    };
  }
  if ((d.kind === 'allow' && target.type === 'allow') || (d.kind === 'hot' && target.type === 'hot')) {
    const entries = [...target.entries] as (AllowEntry | HotEntry)[];
    for (const e of d.list.entries as (AllowEntry | HotEntry)[]) {
      const i = entries.findIndex((x) => x.key === e.key);
      if (i >= 0) entries[i] = { ...e, id: entries[i]!.id, addedAt: entries[i]!.addedAt };
      else entries.push(e);
    }
    return { ...target, entries, updatedAt: now } as PlateList;
  }
  return target;
}
