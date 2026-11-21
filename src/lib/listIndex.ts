/**
 * Finding timed lists in the field: fuzzy search over the identifiers an officer has to hand
 * (patrol zone, RPA, road segment, EasyPark area, PayStay zone, meter ID), and grouping by
 * patrol zone, then road segment name.
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
type FieldKind = 'zone' | 'rpa' | 'street' | 'cross' | 'suburb' | 'name' | 'easypark' | 'paystay' | 'meter';

/** Words that say which field the following words refer to ("rpa 12", "meter 4521"). */
const FIELD_WORDS: Record<string, FieldKind[]> = {
  zone: ['zone', 'paystay'],
  patrol: ['zone'],
  pez: ['zone'],
  rpa: ['rpa'],
  permit: ['rpa'],
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
  add('rpa', 'RPA', l.rpa);
  add('street', 'Road segment', l.segment.street);
  add('cross', 'Between', l.segment.fromStreet);
  add('cross', 'And', l.segment.toStreet);
  add('suburb', 'Suburb', l.segment.suburb);
  add('name', 'List', l.name);
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
 * Lists matching every word of the query, best first. Field words narrow the search ("rpa 12"
 * looks at RPAs only); every other word must match some field.
 */
export function searchTimedLists(lists: readonly TimedList[], query: string): SearchResult[] {
  const raw = query.trim().split(/\s+/).map(norm).filter(Boolean);
  if (!raw.length) return lists.map((list) => ({ list, score: 0, matches: [] }));
  const hinted = raw.filter((t) => FIELD_WORDS[t]);
  const terms = raw.filter((t) => !FIELD_WORDS[t]);
  // Only field words ("zone"): treat them as ordinary words.
  const tokens = terms.length ? terms : raw;
  const allowed = terms.length && hinted.length ? new Set(hinted.flatMap((t) => FIELD_WORDS[t]!)) : null;

  const out: SearchResult[] = [];
  for (const list of lists) {
    const fs = fields(list).filter((f) => !allowed || allowed.has(f.kind));
    let score = 0;
    const matches: (FieldMatch & { s: number })[] = [];
    let all = true;
    for (const t of tokens) {
      let best: (FieldMatch & { s: number }) | null = null;
      for (const f of fs) {
        const s = tokenScore(t, f.value);
        if (s > (best?.s ?? 0)) best = { label: f.label, value: f.value, s };
      }
      if (!best) {
        all = false;
        break;
      }
      score += best.s;
      matches.push(best);
    }
    if (all) out.push({ list, score, matches: matches.sort((a, b) => b.s - a.s).map(({ label, value }) => ({ label, value })) });
  }
  return out.sort((a, b) => b.score - a.score || compareText(a.list.segment.street, b.list.segment.street));
}

const collator = new Intl.Collator('en-AU', { numeric: true, sensitivity: 'base' });
const compareText = (a: string, b: string) => collator.compare(a, b);

export interface StreetGroup {
  street: string;
  lists: TimedList[];
}
export interface ZoneGroup {
  zone: string;
  streets: StreetGroup[];
}

/** Patrol zones in natural order (1, 2, 10), for the zone filter. */
export function patrolZones(lists: readonly TimedList[]): string[] {
  return [...new Set(lists.map((l) => l.patrolZone?.trim() ?? '').filter(Boolean))].sort(compareText);
}

/** "1" → "Patrol zone 1"; a named zone is shown as entered. */
export function zoneLabel(zone: string): string {
  if (zone === NO_ZONE) return 'No patrol zone';
  return /^\d+[a-z]?$/i.test(zone) ? `Patrol zone ${zone}` : zone;
}

/**
 * Group by patrol zone (natural order, lists without a zone last), then by road segment name;
 * segments of one road are ordered by their first cross street.
 */
export function groupByZone(lists: readonly TimedList[]): ZoneGroup[] {
  const zones = new Map<string, Map<string, TimedList[]>>();
  for (const l of lists) {
    const zone = l.patrolZone?.trim() ?? NO_ZONE;
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
      streets: [...streets.entries()]
        .sort(([a], [b]) => compareText(a, b))
        .map(([street, ls]) => ({
          street,
          lists: ls.sort((a, b) => compareText(a.segment.fromStreet, b.segment.fromStreet) || compareText(a.segment.toStreet, b.segment.toStreet)),
        })),
    }));
}
