import type { TimedList, TimedRestriction, Weekday } from './types';
import { atMinutes, localMidnight, parseHhmm } from './time';

export interface RestrictionInstance {
  restriction: TimedRestriction;
  /** Start of this occurrence of the restriction period (epoch ms). */
  start: number;
  /** End of this occurrence (exclusive, epoch ms). */
  end: number;
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function dayShort(d: Weekday): string {
  return DAY_SHORT[d];
}

/** Infer the allowance in minutes from common Australian signage codes. */
export function minutesFromCode(code: string): number | null {
  const c = code.toUpperCase().replace(/\s+/g, '');
  let m = /^(\d+)\/(\d+)P$/.exec(c);
  if (m) {
    const n = Number(m[1]);
    const d = Number(m[2]);
    return d > 0 ? Math.round((n / d) * 60) : null;
  }
  m = /^(\d+(?:\.\d+)?)P$/.exec(c);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /^P(\d+)$/.exec(c);
  if (m) return Number(m[1]);
  return null;
}

export function summariseDays(days: readonly Weekday[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (set.length === 0) return 'No days';
  if (set.length === 7) return 'Every day';
  const key = set.join(',');
  if (key === '1,2,3,4,5') return 'Mon–Fri';
  if (key === '0,6') return 'Sat–Sun';
  if (key === '1,2,3,4,5,6') return 'Mon–Sat';
  // Collapse runs, e.g. Mon–Wed, Fri
  const parts: string[] = [];
  let runStart = set[0]!;
  let prev = set[0]!;
  for (let i = 1; i <= set.length; i++) {
    const cur = set[i];
    if (cur !== undefined && cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(runStart === prev ? dayShort(runStart) : `${dayShort(runStart)}–${dayShort(prev)}`);
    if (cur !== undefined) {
      runStart = cur;
      prev = cur;
    }
  }
  return parts.join(', ');
}

export function describeRestriction(r: TimedRestriction): string {
  const hours = r.allDay ? 'All times' : `${r.startTime}–${r.endTime}`;
  return `${r.code} · ${summariseDays(r.days)} · ${hours}`;
}

export function validateRestriction(r: TimedRestriction): string[] {
  const errors: string[] = [];
  if (!r.code.trim()) errors.push('Restriction code is required (e.g. 2P).');
  if (!Number.isFinite(r.limitMinutes) || r.limitMinutes < 1 || r.limitMinutes > 24 * 60)
    errors.push('Time allowance must be between 1 and 1440 minutes.');
  if (!Number.isFinite(r.graceMinutes) || r.graceMinutes < 0 || r.graceMinutes > 120)
    errors.push('Grace must be between 0 and 120 minutes.');
  if (r.days.length === 0) errors.push('Select at least one day.');
  if (!r.allDay) {
    const s = parseHhmm(r.startTime);
    const e = parseHhmm(r.endTime);
    if (s === null) errors.push('Start time must be HH:MM.');
    if (e === null) errors.push('End time must be HH:MM.');
    if (s !== null && e !== null && s === e) errors.push('Start and end time cannot be the same (use "All times").');
  }
  return errors;
}

function instanceFor(r: TimedRestriction, at: number): RestrictionInstance | null {
  const days = new Set<number>(r.days);
  if (r.allDay) {
    const today = localMidnight(at);
    if (!days.has(today.getDay())) return null;
    // Merge consecutive applicable days so a vehicle chalked at 23:50 is not
    // released at midnight.
    let startOffset = 0;
    while (startOffset > -7 && days.has(localMidnight(at, startOffset - 1).getDay())) startOffset--;
    let endOffset = 1;
    while (endOffset < 8 && days.has(localMidnight(at, endOffset).getDay())) endOffset++;
    return {
      restriction: r,
      start: localMidnight(at, startOffset).getTime(),
      end: localMidnight(at, endOffset).getTime(),
    };
  }
  const s = parseHhmm(r.startTime);
  const e = parseHhmm(r.endTime);
  if (s === null || e === null || s === e) return null;
  const crosses = e < s;
  for (const offset of [0, -1]) {
    const mid = localMidnight(at, offset);
    if (!days.has(mid.getDay())) continue;
    const start = atMinutes(mid, s);
    const end = atMinutes(mid, crosses ? e + 1440 : e);
    if (at >= start && at < end) return { restriction: r, start, end };
  }
  return null;
}

/**
 * The restriction in force on a segment at `at`. When several overlap, the
 * most restrictive (shortest allowance) wins.
 */
export function restrictionInForce(list: Pick<TimedList, 'restrictions'>, at: number): RestrictionInstance | null {
  let best: RestrictionInstance | null = null;
  for (const r of list.restrictions) {
    const inst = instanceFor(r, at);
    if (!inst) continue;
    if (!best || inst.restriction.limitMinutes < best.restriction.limitMinutes) best = inst;
  }
  return best;
}

/** Next time (within 8 days) any restriction on the segment comes into force. */
export function nextRestrictionStart(list: Pick<TimedList, 'restrictions'>, from: number): RestrictionInstance | null {
  let best: RestrictionInstance | null = null;
  for (const r of list.restrictions) {
    const days = new Set<number>(r.days);
    const s = r.allDay ? 0 : parseHhmm(r.startTime);
    if (s === null) continue;
    for (let offset = 0; offset < 8; offset++) {
      const mid = localMidnight(from, offset);
      if (!days.has(mid.getDay())) continue;
      const start = atMinutes(mid, s);
      if (start <= from) continue;
      const inst = instanceFor(r, start);
      if (inst && (!best || inst.start < best.start)) best = inst;
      break;
    }
  }
  return best;
}
