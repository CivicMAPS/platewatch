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
import { uid } from './db';
import { normalisePlate, plateKey } from './plate';
import { minutesFromCode, summariseDays } from './restriction';
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
  type Weekday,
} from './types';

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
export type ImportDraft = TimedDraft | AllowDraft | HotDraft;

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
  | 'civicmaps-kerbside'
  | 'civicmaps-road-segment'
  | 'civicmaps-survey'
  | 'civicmaps-parking-areas'
  | 'civicmaps-mixed'
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
      'patrol_zone,patrol_zone_name,street,from_street,to_street,side,suburb,sub_from,sub_to,rpa,parking_area,easypark_areas,paystay_zones,bays,sign,minutes,days,start,end,grace,road_segment_id,list_name,notes',
    example: [
      '9,South Melbourne Market,Coventry Street,Cecil Street,Market Street,south,South Melbourne,,,7,,,338851200002,,2P,,Mon-Fri,08:00,18:00,0,,,',
      '9,South Melbourne Market,Coventry Street,Cecil Street,Market Street,south,South Melbourne,,,7,,,338851200002,,2P,,Sat,08:00,12:30,0,,,',
      '14,Flagstaff,Little Bourke Street,Swanston Street,Elizabeth Street,south,Melbourne,Bay 58,Bay 72,,645,7514,,58-59;61-65;67-72,LZ30,,Mon-Fri,07:00,16:00,,20055,,Commercial vehicles only',
      '14,Flagstaff,Little Bourke Street,Swanston Street,Elizabeth Street,south,Melbourne,Bay 58,Bay 72,,645,7514,,58-59;61-65;67-72,2P Meter,,Sat-Sun,07:00,22:00,,20055,,',
      '14,Flagstaff,Lonsdale Street,William Street,Queen Street,north,Melbourne,,,,637,7306;7307,,,,,,,,,,,Signs still to be surveyed',
    ].join('\n'),
  },
  allow: {
    fileName: 'platewatch-allow-list-template.csv',
    header: 'list_name,plate,label,permit_no,valid_from,valid_to',
    example: ['RPA 7 residents,1AB2CD,Resident,P-1001,2026-07-01,2027-06-30', 'RPA 7 residents,XYZ789,Visitor,V-2044,01/07/2026,31/12/2026'].join('\n'),
  },
  hot: {
    fileName: 'platewatch-hot-list-template.csv',
    header: 'list_name,plate,risk_level,risks,make,model,body_type,colour,notes',
    example: 'Officer safety,ABC123,high,Aggressive;Threats / intimidation,Toyota,Hilux,Ute,White,Approach with a second officer',
  },
} as const;

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

export type ParsedSign = { code: string; minutes: number; description: string } | { note: string };

const NOTE_LABELS: Record<string, string> = {
  no_stopping: 'No stopping',
  no_stopping_area: 'No stopping',
  no_parking: 'No parking',
  clearway: 'Clearway',
  bus_zone: 'Bus zone',
  taxi_zone: 'Taxi zone',
  permit_zone: 'Permit zone',
  disabled: 'Disabled parking',
  works_zone: 'Works zone',
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
    return Number.isFinite(minutes) && minutes > 0 ? { code: `LZ${minutes}`, minutes, description: '' } : { note: 'Loading zone (no time limit given)' };
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
  if (NOTE_LABELS[k]) return { note: NOTE_LABELS[k] };
  return { note: titleCase(raw) };

  function timedSign(code: string, descFrom: number): ParsedSign {
    const minutes = minutesFromCode(code);
    return minutes ? { code, minutes, description: suffix(descFrom) } : { note: titleCase(raw) };
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

function describeRule(label: string, days: Weekday[], t: { allDay: boolean; startTime: string; endTime: string }): string {
  return `${label} ${summariseDays(days)} ${t.allDay ? 'all times' : `${t.startTime}–${t.endTime}`}`;
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

const SIDE_LETTER: Record<StreetSide, string> = { both: '', north: 'N', south: 'S', east: 'E', west: 'W', odd: 'odd', even: 'even' };

/** "Little Bourke St, Swanston St – Elizabeth St (S) · Bay 58 – Bay 72". */
export function defaultListName(seg: StreetSegment): string {
  const side = SIDE_LETTER[seg.side] ? ` (${SIDE_LETTER[seg.side]})` : '';
  const sub = seg.subFrom ? ` · ${shortName(seg.subFrom)}${seg.subTo ? ` – ${shortName(seg.subTo)}` : ''}` : '';
  return `${shortName(seg.street)}, ${shortName(seg.fromStreet)} – ${shortName(seg.toStreet)}${side}${sub}`;
}

/** "northern", "North side", "N", "both sides", "odd" → a StreetSide. */
export function parseSide(input: string | null | undefined): StreetSide | null {
  const s = (input ?? '').trim().toLowerCase();
  if (!s || /^both/.test(s)) return 'both';
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

const cleanPayment = (p: PaymentAreas): PaymentAreas | undefined =>
  p.parkingArea || p.easyPark.length || p.payStay.length ? p : undefined;

function newRestriction(code: string, minutes: number, days: Weekday[], t: { allDay: boolean; startTime: string; endTime: string }, grace = 0, description = ''): TimedRestriction {
  return { id: uid(), code, limitMinutes: minutes, graceMinutes: grace, days, startTime: t.startTime, endTime: t.endTime, allDay: t.allDay, description };
}

/* ───────────────────────────── Timed CSV ───────────────────────────── */

type Row = Record<string, string>;

function rowsWithHeader(table: string[][]): { header: string[]; rows: { line: number; row: Row }[] } {
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const rows = table.slice(1).map((cells, i) => {
    const row: Row = {};
    header.forEach((h, j) => (row[h] = (cells[j] ?? '').trim()));
    return { line: i + 2, row };
  });
  return { header, rows };
}

const splitList = (s: string) => s.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);

function timedFromCsv(file: string, table: string[][], out: ImportResult): void {
  const groups = new Map<string, { draft: TimedDraft; notes: string[]; timed: number; lines: number[] }>();
  for (const { line, row } of rowsWithHeader(table).rows) {
    const issue = (message: string) => out.issues.push({ file, row: line, message });
    if (!row.street || !row.from_street || !row.to_street) {
      issue('street, from_street and to_street are required.');
      continue;
    }
    const side = parseSide(row.side);
    if (!side) {
      issue(`side "${row.side}" is not north, south, east, west, both, odd or even.`);
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
    // A timed sign needs readable days and times; check before the row joins its list.
    let restriction: TimedRestriction | null = null;
    let note: string | null = null;
    if (row.sign || row.minutes) {
      const sign = row.sign ? parseSign(row.sign) : { note: '' };
      const override = row.minutes ? Number(row.minutes) : NaN;
      if (row.minutes && !(override >= 1 && override <= 1440)) {
        issue(`minutes "${row.minutes}" must be between 1 and 1440.`);
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
        issue(`grace "${row.grace}" must be between 0 and 120 minutes.`);
        continue;
      }
      if ('code' in sign) restriction = newRestriction(sign.code, Number.isFinite(override) ? override : sign.minutes, days, times, grace, sign.description);
      else if (Number.isFinite(override)) restriction = newRestriction(row.sign!.toUpperCase(), override, days, times, grace);
      else note = describeRule(sign.note, days, times);
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
    const key = segmentKey(segment);
    let g = groups.get(key);
    if (!g) {
      g = {
        draft: {
          kind: 'timed',
          pending: true,
          source: `${file} row ${line}`,
          list: { type: 'timed', name: row.list_name || defaultListName(segment), notes: '', segment, restrictions: [], allowListIds: [], payment: { easyPark: [], payStay: [] } },
        },
        notes: [],
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
    for (const a of splitList(row.easypark_areas ?? '')) if (!pay.easyPark.includes(a)) pay.easyPark.push(a);
    for (const z of splitList(row.paystay_zones ?? '')) {
      const [zone, meter = ''] = z.split(':').map((x) => x.trim());
      if (zone && !pay.payStay.some((p) => p.zone === zone)) pay.payStay.push({ zone, meter });
    }
    if (bays) l.bays = [...new Set([...(l.bays ?? []), ...bays])].sort((x, y) => x - y);
    if (row.notes && !g.notes.includes(row.notes)) g.notes.push(row.notes);
    if (note) g.notes.push(note);
    if (restriction) {
      l.restrictions.push(restriction);
      g.timed++;
    }
    if (row.sign || row.minutes) g.draft.pending = false;
  }
  for (const g of groups.values()) {
    const l = g.draft.list;
    l.notes = g.notes.join('\n');
    l.payment = cleanPayment(l.payment!);
    // Signs given but none of them timed (e.g. No Stopping only): nothing to time.
    if (!g.draft.pending && !g.timed) {
      out.skipped.push(`${describeSegment(l.segment)}: no timed parking (${g.notes.join('; ')}) — rows ${g.lines.join(', ')}`);
      continue;
    }
    out.drafts.push(g.draft);
  }
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
    const entry: AllowEntry = { id: uid(), plate, key: plateKey(plate), label: row.label ?? '', permitNo: row.permit_no ?? '', validFrom, validTo, addedAt: Date.now() };
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
      make: row.make ?? '',
      model: row.model ?? '',
      bodyType: row.body_type ?? '',
      colour: row.colour ?? row.color ?? '',
      notes: row.notes ?? '',
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
  const notes = [...s.notes];
  const untimed: string[] = [];
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
      } else {
        const text = days && times ? describeRule(sign.note, days, times) : `${sign.note} ${r.days} ${r.time}`.trim();
        notes.push(text);
        untimed.push(sign.note);
      }
    }
  }
  if (s.signs.length && !restrictions.length) {
    out.skipped.push(`${describeSegment(segment)}: no timed parking (${[...new Set(untimed)].join('; ')})`);
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
      notes: notes.join('\n'),
      segment,
      restrictions,
      allowListIds: [],
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
      const bays = arr(sub.bays).filter(isObj).map((b) => Number(b.bay)).filter((n) => Number.isFinite(n));
      draftFromSub(file, {
        ...base,
        zoneName: str(d.patrol_zone) || undefined,
        roadSegmentId: str(d.road_segment_id) || undefined,
        parkingArea: str(sub.parking_area) || undefined,
        easyPark: easyParkAreas(sub.easypark_area),
        bays: [...new Set(bays)].sort((x, y) => x - y),
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
  if (str(d.schema).startsWith('civicmaps.kerbside_parking_segment') || (Array.isArray(d.sides) && 'on_street' in d)) return 'civicmaps-kerbside';
  if (Array.isArray(d.segments) && 'street' in d) return 'civicmaps-road-segment';
  if (Array.isArray(d.sides) && 'street' in d) return 'civicmaps-survey';
  if ('area' in d && (Array.isArray(d.parking_zones) || Array.isArray(d.records) || Array.isArray(d.numeric_records))) return 'civicmaps-parking-areas';
  return 'unknown';
}

/* ───────────────────────────── Entry point ───────────────────────────── */

/** Read one file (CSV template or CivicMAPS-preview JSON) into drafts, issues and skips. */
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
    const docs = Array.isArray(data) ? data.filter(isObj) : isObj(data) ? [data] : [];
    const kinds = new Set<ImportKind>();
    for (const d of docs) {
      const kind = jsonKind(d);
      kinds.add(kind);
      if (kind === 'civicmaps-kerbside') fromKerbside(file, d, out);
      else if (kind === 'civicmaps-road-segment') fromRoadSegments(file, d, out);
      else if (kind === 'civicmaps-survey') fromSurvey(file, d, out);
      else if (kind === 'civicmaps-parking-areas') fromParkingAreas(file, d, out);
    }
    kinds.delete('unknown');
    out.kind = kinds.size === 1 ? [...kinds][0]! : kinds.size > 1 ? 'civicmaps-mixed' : 'unknown';
    if (out.kind === 'unknown') {
      out.issues.push({ file, message: 'Not a recognised file: expected a PlateWatch CSV template or a CivicMAPS-preview kerbside, road-segment, field-survey or parking-area-zone JSON file.' });
    }
    return out;
  }
  const table = parseCsv(trimmed);
  const { header } = rowsWithHeader(table);
  if (header.includes('street') && header.includes('from_street')) {
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
  const byKey = new Map<string, PlateList>();
  for (const l of existing) byKey.set(l.type === 'timed' ? `timed:${segmentKey(l.segment)}` : `${l.type}:${l.name.trim().toLowerCase()}`, l);
  const created = new Map<string, PlateList>();
  const updated = new Map<string, PlateList>();
  let unchanged = 0;

  for (const d of drafts) {
    const key = d.kind === 'timed' ? `timed:${segmentKey(d.list.segment)}` : `${d.kind}:${d.list.name.trim().toLowerCase()}`;
    const target = created.get(key) ?? updated.get(key) ?? byKey.get(key);
    if (!target) {
      created.set(key, { ...structuredClone(d.list), id: uid(), createdAt: now, updatedAt: now } as PlateList);
      continue;
    }
    const isNew = created.has(key);
    if (!isNew && !opts.updateExisting) {
      if (!updated.has(key)) unchanged++;
      continue;
    }
    const merged = mergeInto(target, d, now);
    (isNew ? created : updated).set(key, merged);
  }
  const createdLists = [...created.values()];
  return {
    created: createdLists,
    updated: [...updated.values()],
    unchanged,
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
