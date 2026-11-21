/**
 * Finding timed lists in the field: fuzzy search over the identifiers an officer has to hand
 * (patrol zone number or name, RPA, road segment, parking area, bay sign, EasyPark area, PayStay
 * zone, meter ID), and grouping by patrol zone, then road segment name.
 */
import type { TimedList } from './types';

/** Group key for timed lists without a patrol zone. */
export const NO_ZONE = '';

export interface FieldMatch {
  label: string;
  value: string;
}

export interface SearchResult {
  list: TimedList;
  score: number;
  /** The field each query word matched, best first. */
  matches: FieldMatch[];
}

type Field = FieldMatch & { kind: FieldKind };
type FieldKind = 'zone' | 'rpa' | 'street' | 'cross' | 'suburb' | 'name' | 'segmentid' | 'parkingarea' | 'easypark' | 'paystay' | 'meter';

/** Fields whose numbers start a bay's kerb sign: parking area 637 + bay 58 = sign 63758. */
const BAY_SIGN_KINDS = new Set<FieldKind>(['parkingarea', 'easypark']);

/** Words that say which field the following words refer to ("rpa 12", "meter 4521"). */
const FIELD_WORDS: Record<string, FieldKind[]> = {
  zone: ['zone', 'paystay'],
  patrol: ['zone'],
  pez: ['zone'],
  rpa: ['rpa'],
  permit: ['rpa'],
  area: ['parkingarea', 'easypark'],
  parking: ['parkingarea'],
  bay: ['parkingarea', 'easypark'],
  segment: ['segmentid'],
  meter: ['meter'],
  easypark: ['easypark'],
  paystay: ['paystay', 'meter'],
  street: ['street', 'cross'],
  road: ['street', 'cross'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function fields(l: TimedList): Field[] {
  const f: Field[] = [];
  const add = (kind: FieldKind, label: string, value: string | undefined) => {
    if (value?.trim()) f.push({ kind, label, value: value.trim() });
  };
  add('zone', 'Patrol zone', l.patrolZone);
  add('zone', 'Zone name', l.patrolZoneName);
  add('rpa', 'RPA', l.rpa);
  add('street', 'Road segment', l.segment.street);
  add('cross', 'Between', l.segment.fromStreet);
  add('cross', 'And', l.segment.toStreet);
  add('cross', 'Part from', l.segment.subFrom);
  add('cross', 'Part to', l.segment.subTo);
  add('segmentid', 'Segment ID', l.roadSegmentId);
  // Kerb plates that do not follow parking area + bay carry their own number.
  for (const p of l.bayPoints ?? []) if (p.sign) add('parkingarea', 'Bay sign', p.sign);
  add('suburb', 'Suburb', l.segment.suburb);
  add('name', 'List', l.name);
  add('parkingarea', 'Parking area', l.payment?.parkingArea);
  for (const a of l.payment?.easyPark ?? []) add('easypark', 'EasyPark area', a);
  for (const p of l.payment?.payStay ?? []) {
    add('paystay', 'PayStay zone', p.zone);
    add('meter', 'Meter ID', p.meter);
  }
  return f;
}

/** At most one insertion, deletion, substitution or adjacent swap. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].map((c, i) => (c === b[i] ? -1 : i)).filter((i) => i >= 0);
    if (diff.length <= 1) return true;
    return diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!];
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

/** How well one query word matches one field value (0 = no match). */
function tokenScore(t: string, value: string): number {
  const v = norm(value);
  if (v === t) return 100;
  if (v.startsWith(t)) return 80;
  const ws = words(value);
  if (ws.some((w) => w.startsWith(t))) return 70;
  if (t.length >= 2 && v.includes(t)) return 50;
  // Typos only for words of letters: numbers (meters, zones, areas) must be typed as shown.
  // A typo in a whole word ("fitzroi") or in the start of one ("fitzr0y" typed as "fizro").
  if (t.length >= 4 && /^[a-z]+$/.test(t) && ws.some((w) => withinOneEdit(t, w) || (w.length > t.length && withinOneEdit(t, w.slice(0, t.length)))))
    return 30;
  return 0;
}

/**
 * A bay's kerb sign is its parking area (or EasyPark area) number followed by a bay number of one
 * to three digits. Longer area numbers score higher, so area 637 beats area 63 for sign 63758.
 */
function baySign(t: string, f: Field, bays: readonly number[] | undefined): (FieldMatch & { s: number }) | null {
  const area = norm(f.value);
  if (!BAY_SIGN_KINDS.has(f.kind) || !/^\d+$/.test(t) || !/^\d+$/.test(area)) return null;
  const bay = t.slice(area.length);
  if (!t.startsWith(area) || bay.length < 1 || bay.length > 3) return null;
  // A list that records its bays only takes signs for those bays, and ranks above one that does not record them.
  const listed = bays?.length ? bays.includes(Number(bay)) : null;
  if (listed === false) return null;
  return { label: 'Bay sign', value: `${t} = area ${area} · bay ${Number(bay)}`, s: Math.min(95, 85 + area.length) + (listed ? 4 : 0) };
}

type Scored = FieldMatch & { s: number };

/** Every token must match one of the fields; returns the summed score, or null. */
function matchList(list: TimedList, tokens: readonly string[], allowed: Set<FieldKind> | null, bayLookup: boolean): { score: number; matches: FieldMatch[] } | null {
  const fs = fields(list).filter((f) => !allowed || allowed.has(f.kind));
  let score = 0;
  const matches: Scored[] = [];
  for (const t of tokens) {
    let best: Scored | null = null;
    for (const f of fs) {
      const s = tokenScore(t, f.value);
      if (s > (best?.s ?? 0)) best = { label: f.label, value: f.value, s };
      const sign = bayLookup && s < 100 ? baySign(t, f, list.bays) : null;
      if (sign && sign.s > (best?.s ?? 0)) best = sign;
    }
    if (!best) return null;
    score += best.s;
    matches.push(best);
  }
  return { score, matches: matches.sort((a, b) => b.s - a.s).map(({ label, value }) => ({ label, value })) };
}

/**
 * Lists matching every word of the query, best first. Field words at the start of the query
 * narrow the search ("rpa 12" looks at RPAs only, "bay 63758" at kerb signs). The same words
 * inside an address are ordinary words: a list that does not match the narrowed search is tried
 * again with every word against every field, so "Bay Street South Melbourne" still finds Bay
 * Street. Narrowed matches rank first.
 */
export function searchTimedLists(lists: readonly TimedList[], query: string): SearchResult[] {
  const raw = query.trim().split(/\s+/).map(norm).filter(Boolean);
  if (!raw.length) return lists.map((list) => ({ list, score: 0, matches: [] }));
  let lead = 0;
  while (lead < raw.length && FIELD_WORDS[raw[lead]!]) lead++;
  const hinted = raw.slice(0, lead);
  const terms = raw.slice(lead);
  // Only field words ("zone"), or none: no narrowing.
  const allowed = terms.length && hinted.length ? new Set(hinted.flatMap((t) => FIELD_WORDS[t]!)) : null;
  // "area 637" means the parking area itself; a plain number or "bay …" may be a kerb sign.
  const bayLookup = !allowed || hinted.includes('bay');

  const out: (SearchResult & { narrowed: boolean })[] = [];
  for (const list of lists) {
    const narrowed = allowed ? matchList(list, terms, allowed, bayLookup) : null;
    const plain = narrowed ? null : matchList(list, raw, null, true);
    const m = narrowed ?? plain;
    if (m) out.push({ list, ...m, narrowed: !!narrowed });
  }
  return out
    .sort((a, b) => Number(b.narrowed) - Number(a.narrowed) || b.score - a.score || compareText(a.list.segment.street, b.list.segment.street))
    .map(({ narrowed: _n, ...r }) => r);
}

const collator = new Intl.Collator('en-AU', { numeric: true, sensitivity: 'base' });
const compareText = (a: string, b: string) => collator.compare(a, b);

export interface StreetGroup {
  street: string;
  lists: TimedList[];
}
export interface ZoneGroup {
  zone: string;
  /** Operational name of the zone (e.g. "Flagstaff"), from the first list in it that has one. */
  name?: string;
  streets: StreetGroup[];
}

/** Grouping key: the zone number, or the zone name when a list has only a name. */
export function zoneKey(l: TimedList): string {
  return l.patrolZone?.trim() || l.patrolZoneName?.trim() || NO_ZONE;
}

/** Patrol zones in natural order (1, 2, 10), for the zone filter. */
export function patrolZones(lists: readonly TimedList[]): string[] {
  return [...new Set(lists.map(zoneKey).filter(Boolean))].sort(compareText);
}

/** Operational name for each zone key, from the first list that has one. */
export function zoneNames(lists: readonly TimedList[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const l of lists) {
    const name = l.patrolZoneName?.trim();
    if (name && !names.has(zoneKey(l))) names.set(zoneKey(l), name);
  }
  return names;
}

/** "9" → "Patrol zone 9", "9" + "South Melbourne Market" → "Patrol zone 9 · South Melbourne Market". */
export function zoneLabel(zone: string, name?: string): string {
  if (zone === NO_ZONE) return 'No patrol zone';
  const base = /^\d+[a-z]?$/i.test(zone) ? `Patrol zone ${zone}` : zone;
  return name && name !== zone ? `${base} · ${name}` : base;
}

/**
 * Group by patrol zone (natural order, lists without a zone last), then by road segment name;
 * segments of one road are ordered by their first cross street.
 */
export function groupByZone(lists: readonly TimedList[]): ZoneGroup[] {
  const zones = new Map<string, Map<string, TimedList[]>>();
  const names = zoneNames(lists);
  for (const l of lists) {
    const zone = zoneKey(l);
    const streetKey = l.segment.street.trim();
    const streets = zones.get(zone) ?? new Map<string, TimedList[]>();
    zones.set(zone, streets);
    // Group case-insensitively under the first spelling seen.
    const existing = [...streets.keys()].find((k) => compareText(k, streetKey) === 0) ?? streetKey;
    streets.set(existing, [...(streets.get(existing) ?? []), l]);
  }
  return [...zones.entries()]
    .sort(([a], [b]) => (a === NO_ZONE ? 1 : b === NO_ZONE ? -1 : compareText(a, b)))
    .map(([zone, streets]) => ({
      zone,
      ...(names.has(zone) ? { name: names.get(zone) } : {}),
      streets: [...streets.entries()]
        .sort(([a], [b]) => compareText(a, b))
        .map(([street, ls]) => ({
          street,
          lists: ls.sort(
            (a, b) =>
              compareText(a.segment.fromStreet, b.segment.fromStreet) ||
              compareText(a.segment.toStreet, b.segment.toStreet) ||
              compareText(a.segment.side, b.segment.side) ||
              compareText(a.segment.subFrom ?? '', b.segment.subFrom ?? ''),
          ),
        })),
    }));
}
