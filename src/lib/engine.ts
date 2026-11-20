/**
 * Pure decision engine. Given a confirmed plate, the list being worked and the
 * current state, decide what happens. No I/O — fully unit tested.
 *
 * Timed list workflow (per the specification):
 *   1. Plate on a linked allow list (valid today)         → exempt, no alert, no record
 *   2. No restriction in force right now                  → not in force, no record
 *   3. Active observation (same restriction period) found → re-sighting: show scan 1 vs
 *      scan 2 with time elapsed; OVERSTAY when elapsed ≥ allowance + grace
 *   4. Otherwise                                          → create scan record and start
 *      the allowance clock for this segment
 * Hot lists are always checked (officer safety), whichever list is selected.
 */
import { comparePlates, plateKey, type MatchStrength } from './plate';
import { restrictionInForce, nextRestrictionStart, type RestrictionInstance } from './restriction';
import { localDateString } from './time';
import type { AllowEntry, AllowList, HotEntry, HotList, Observation, PlateList, TimedList } from './types';

export interface HotHit {
  list: HotList;
  entry: HotEntry;
  strength: Exclude<MatchStrength, 'none'>;
}

export interface AllowHit {
  list: AllowList;
  entry: AllowEntry;
}

export type Decision =
  | { kind: 'timed_exempt'; hit: AllowHit }
  | { kind: 'timed_not_in_force'; next: RestrictionInstance | null }
  | { kind: 'timed_new'; instance: RestrictionInstance }
  | {
      kind: 'timed_resighting';
      observation: Observation;
      elapsedMs: number;
      remainingMs: number;
      overstay: boolean;
    }
  | { kind: 'timed_possible'; candidates: Observation[]; instance: RestrictionInstance }
  | { kind: 'hot_match' }
  | { kind: 'hot_none' }
  | { kind: 'allow_member'; hit: AllowHit; validNow: boolean }
  | { kind: 'allow_none'; possible: AllowEntry[] };

export interface EngineInput {
  at: number;
  plate: string;
  list: PlateList;
  hotLists: readonly HotList[];
  allowLists: readonly AllowList[];
  /** Observations for `list` (timed lists only); any status. */
  observations: readonly Observation[];
}

export interface EngineResult {
  decision: Decision;
  hotHits: HotHit[];
  /** Active observations whose restriction window has closed — persist as expired. */
  expireObservationIds: string[];
}

export function isAllowEntryValid(entry: AllowEntry, at: number): boolean {
  const today = localDateString(at);
  if (entry.validFrom && today < entry.validFrom) return false;
  if (entry.validTo && today > entry.validTo) return false;
  return true;
}

export function findHotHits(plate: string, hotLists: readonly HotList[]): HotHit[] {
  const hits: HotHit[] = [];
  for (const list of hotLists) {
    for (const entry of list.entries) {
      const strength = comparePlates(plate, entry.plate);
      if (strength !== 'none') hits.push({ list, entry, strength });
    }
  }
  const rank = { extreme: 0, high: 1, caution: 2 } as const;
  return hits.sort(
    (a, b) =>
      (a.strength === 'exact' ? 0 : 1) - (b.strength === 'exact' ? 0 : 1) ||
      rank[a.entry.riskLevel] - rank[b.entry.riskLevel],
  );
}

/** Exact-key allow match only — a fuzzy match must never silently exempt a vehicle. */
export function findAllowHit(plate: string, lists: readonly AllowList[], at: number): AllowHit | null {
  const key = plateKey(plate);
  for (const list of lists) {
    for (const entry of list.entries) {
      if (plateKey(entry.plate) === key && isAllowEntryValid(entry, at)) return { list, entry };
    }
  }
  return null;
}

export function resighting(observation: Observation, at: number): Extract<Decision, { kind: 'timed_resighting' }> {
  const elapsedMs = Math.max(0, at - observation.startedAt);
  const thresholdMs = (observation.limitMinutes + observation.graceMinutes) * 60_000;
  return {
    kind: 'timed_resighting',
    observation,
    elapsedMs,
    remainingMs: observation.allowanceEndsAt - at,
    overstay: elapsedMs >= thresholdMs,
  };
}

function decideTimed(input: EngineInput, list: TimedList, expireIds: Set<string>): Decision {
  const { at, plate } = input;
  const linked = input.allowLists.filter((a) => list.allowListIds.includes(a.id));
  const allowHit = findAllowHit(plate, linked, at);
  if (allowHit) return { kind: 'timed_exempt', hit: allowHit };

  const active = input.observations.filter(
    (o) => o.listId === list.id && o.status === 'active' && !expireIds.has(o.id),
  );

  const key = plateKey(plate);
  const exact = active
    .filter((o) => plateKey(o.plate) === key)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (exact) return resighting(exact, at);

  const instance = restrictionInForce(list, at);
  if (!instance) return { kind: 'timed_not_in_force', next: nextRestrictionStart(list, at) };

  const possible = active.filter((o) => comparePlates(plate, o.plate) === 'possible');
  if (possible.length) return { kind: 'timed_possible', candidates: possible, instance };

  return { kind: 'timed_new', instance };
}

export function evaluate(input: EngineInput): EngineResult {
  const { at, list } = input;
  const expireIds = new Set(
    input.observations.filter((o) => o.status === 'active' && o.windowEndsAt <= at).map((o) => o.id),
  );
  const hotHits = findHotHits(input.plate, input.hotLists);

  let decision: Decision;
  switch (list.type) {
    case 'timed':
      decision = decideTimed(input, list, expireIds);
      break;
    case 'hot':
      decision = hotHits.some((h) => h.list.id === list.id) ? { kind: 'hot_match' } : { kind: 'hot_none' };
      break;
    case 'allow': {
      const key = plateKey(input.plate);
      const entry = list.entries.find((e) => plateKey(e.plate) === key);
      decision = entry
        ? { kind: 'allow_member', hit: { list, entry }, validNow: isAllowEntryValid(entry, at) }
        : {
            kind: 'allow_none',
            possible: list.entries.filter((e) => comparePlates(input.plate, e.plate) === 'possible'),
          };
      break;
    }
  }
  return { decision, hotHits, expireObservationIds: [...expireIds] };
}

/** Build a new observation anchored on the first scan. */
export function newObservation(args: {
  id: string;
  list: TimedList;
  plate: string;
  scanId: string;
  at: number;
  instance: RestrictionInstance;
}): Observation {
  const r = args.instance.restriction;
  return {
    id: args.id,
    listId: args.list.id,
    plate: args.plate,
    key: plateKey(args.plate),
    firstScanId: args.scanId,
    lastScanId: args.scanId,
    startedAt: args.at,
    restrictionId: r.id,
    restrictionCode: r.code,
    limitMinutes: r.limitMinutes,
    graceMinutes: r.graceMinutes,
    allowanceEndsAt: args.at + r.limitMinutes * 60_000,
    windowEndsAt: args.instance.end,
    status: 'active',
    overstayFlaggedAt: null,
    closedAt: null,
    scanCount: 1,
  };
}
