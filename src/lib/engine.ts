/**
 * Pure decision engine. Given a confirmed plate, the list being worked and the
 * current state, decide what happens. No I/O — fully unit tested.
 *
 * Timed list workflow: see decideTimed(). Permits, known-vehicle tags and earlier dismissals are
 * shown to the officer, who decides; nothing here issues or waives an offence on its own.
 * Hot lists are always checked (officer safety), whichever list is selected.
 */
import { comparePlates, plateKey, type MatchStrength } from './plate';
import { restrictionInForce, nextRestrictionStart, type RestrictionInstance } from './restriction';
import { localDateString } from './time';
import type { AllowEntry, AllowList, DismissReason, HotEntry, HotList, Observation, PermitType, PlateFlag, PlateList, TimedList } from './types';
import { parseArea, permitValidity } from './permit';

export interface HotHit {
  list: HotList;
  entry: HotEntry;
  strength: Exclude<MatchStrength, 'none'>;
}

export interface AllowHit {
  list: AllowList;
  entry: AllowEntry;
}

/**
 * A permit held for the plate (CIVICMAPS-PARK-ARCH-001 §5, owner direction 23/11/2026). The officer
 * sees only valid / expired — valid from 00:00 on valid-from until midnight at the end of valid-to —
 * with the same details either way, and where the permit applies here:
 *   applies       RPA: the area matches · RSP / RP: the registered address's street is this segment
 *                 (RP: the officer checks it is directly in front of the street number) · or, for a
 *                 permit with no area or street held, its list is linked to this segment
 *   payment_only  FS: a paid foreshore space in the permit's council — no payment, time limits apply
 *   other_area    held for another area / street / council
 *   unknown       no area or street held and the list is not linked here — the officer checks
 * The officer decides; nothing here exempts on its own.
 */
export type PermitScope = 'applies' | 'payment_only' | 'other_area' | 'unknown';

export interface PermitHit extends AllowHit {
  validity: 'valid' | 'expired';
  /** Expired because valid-from is still to come. */
  notYetValid: boolean;
  scope: PermitScope;
  /** The permit type the scope came from (absent for permits held without types). */
  basis?: PermitType;
  /** Linked to this segment through the timed list's allow lists. */
  linked: boolean;
}

export type Decision =
  | { kind: 'timed_exempt'; hit: AllowHit }
  /** Permit(s) held for the plate: show the details; the officer accepts (exempt) or continues with `then`. */
  | { kind: 'timed_permit'; hits: PermitHit[]; then: Decision }
  /**
   * Tagged vehicle on a new day. Confirmed applies `confirmed` (emergency: recorded, no timer;
   * disability: timed against twice the allowance); Dismiss removes the tag and applies `then`.
   */
  | { kind: 'timed_flag_check'; flag: PlateFlag; then: Decision; confirmed: Decision }
  /** Tagged emergency vehicle already confirmed today: recorded without a timer. */
  | { kind: 'timed_flag_exempt'; flag: PlateFlag }
  /** An overstay alert for this plate was dismissed earlier in this restriction period. */
  | { kind: 'timed_dismissed'; observation: Observation; reason: DismissReason }
  | { kind: 'timed_not_in_force'; next: RestrictionInstance | null }
  /** `concession`: a confirmed disability permit — the allowance is twice the signed time. */
  | { kind: 'timed_new'; instance: RestrictionInstance; concession?: 'disability' }
  | {
      kind: 'timed_resighting';
      observation: Observation;
      elapsedMs: number;
      remainingMs: number;
      overstay: boolean;
    }
  | { kind: 'timed_possible'; candidates: Observation[]; instance: RestrictionInstance; concession?: 'disability' }
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
  /** Plate record tags (disability / emergency vehicles). */
  flags?: readonly PlateFlag[];
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

/**
 * Statutory (red) restrictions — loading, bus and taxi zones, no stopping / parking, clearways,
 * works zones, police vehicles only, except authorised vehicles, NSEGCV (no stopping except goods
 * carrying vehicles). A disability permit, a displayed resident permit or a known-vehicle tag
 * never exempts here, so those options are not offered.
 */
export function isStatutoryRestriction(code: string): boolean {
  return (
    /^\s*(LZ|L\/Z|LOADING|BZ|BUS|TZ|TAXI|NSEGCV|NS\b|NP\b|NO\s*(STOP|PARK)|CW\b|CLEARWAY|WORKS|MC\b)/i.test(code) ||
    // Red signs reserved for particular vehicles: police only, authorised vehicles, goods vehicles.
    /POLICE|AUTHORI[SZ]ED\s+VEHICLES?|EXCEPT\s+GOODS|GOODS\s+(CARRYING\s+)?VEHICLES?/i.test(code)
  );
}

const STREET_TYPES = /\b(street|st|road|rd|avenue|ave|place|pl|lane|ln|parade|pde|drive|dr|crescent|cres|terrace|tce|boulevard|blvd|highway|hwy|way|close|cl|court|ct)\b\.?/g;
const streetKey = (v: string) => v.toLowerCase().replace(STREET_TYPES, '').replace(/[^a-z0-9]/g, '');

/** A foreshore space (FS permits): "Foreshore" in the restriction's sign code or description. */
export const isForeshoreRestriction = (code: string, description = '') => /foreshore/i.test(`${code} ${description}`);

/** The council a timed list belongs to, from its owner-prefixed ID (com-20055 → com), if known. */
function listCouncil(l: TimedList): string | undefined {
  const m = /^(?:\d+-)?([a-z]{2,8})-/.exec(l.displayId ?? l.externalId ?? '');
  return m?.[1];
}

/**
 * Every permit held for the plate on any allow list (exact plate only), with its validity and where
 * it applies here. `restriction` is the one in force (FS needs a foreshore space).
 */
export function findPermits(plate: string, list: TimedList, allowLists: readonly AllowList[], at: number, restriction?: { code: string; description: string }): PermitHit[] {
  const key = plateKey(plate);
  const council = listCouncil(list);
  const listArea = list.rpa?.trim() ? parseArea(list.rpa) : null;
  const segStreet = streetKey(list.segment.street);
  const hits: PermitHit[] = [];
  for (const a of allowLists) {
    const linked = list.allowListIds.includes(a.id);
    for (const entry of a.entries) {
      if (plateKey(entry.plate) !== key) continue;
      const { status: validity, notYetValid } = permitValidity(entry, at);
      // Areas and foreshore rights are council-scoped: com 7 is not copp 7 (§13).
      const sameCouncil = !entry.council || !council || entry.council.code === council;
      const permitArea = entry.rpa?.trim() ? parseArea(entry.rpa) : null;
      const inArea = !!permitArea && !!listArea && permitArea.area === listArea.area && sameCouncil && (!listArea.council || !entry.council || listArea.council === entry.council.code);
      const streets = [...(entry.streets ?? []), ...(entry.address ? [entry.address.street] : [])].map(streetKey).filter(Boolean);
      const onStreet = streets.includes(segStreet) && sameCouncil;
      const types = entry.permitTypes ?? [];
      let scope: PermitScope;
      let basis: PermitType | undefined;
      if (types.length) {
        if (types.includes('RPA') && inArea) [scope, basis] = ['applies', 'RPA'];
        else if (types.includes('RSP') && onStreet) [scope, basis] = ['applies', 'RSP'];
        else if (types.includes('RP') && onStreet) [scope, basis] = ['applies', 'RP'];
        else if (types.includes('FS') && sameCouncil && restriction && isForeshoreRestriction(restriction.code, restriction.description)) [scope, basis] = ['payment_only', 'FS'];
        else scope = 'other_area';
      } else {
        // Held without types (older lists): an area, a street or both; either matching applies.
        const hasScope = !!permitArea || streets.length > 0;
        scope = inArea || onStreet ? 'applies' : hasScope ? 'other_area' : linked ? 'applies' : 'unknown';
      }
      hits.push({ list: a, entry, validity, notYetValid, scope, ...(basis ? { basis } : {}), linked });
    }
  }
  const rank: Record<PermitScope, number> = { applies: 0, payment_only: 1, unknown: 2, other_area: 3 };
  return hits.sort((x, y) => (x.validity === y.validity ? 0 : x.validity === 'valid' ? -1 : 1) || rank[x.scope] - rank[y.scope]);
}

/** Restriction code a timing decision is about (for the statutory check). */
function decisionCode(d: Decision): string | null {
  if (d.kind === 'timed_new' || d.kind === 'timed_possible') return d.instance.restriction.code;
  if (d.kind === 'timed_resighting') return d.observation.restrictionCode;
  return null;
}

/** Disability-permit-only spaces: the prescribed time applies, a permit does not double it. */
export function isDisabilityOnlyRestriction(code: string, description = ''): boolean {
  return /DISAB|ACCESSIBLE|\bDIS\b|\bDPP\b/i.test(`${code} ${description}`);
}

/**
 * Whether a disability permit doubles the allowance for this restriction: yes in timed and paid +
 * timed spaces; no in disability-only spaces (prescribed time) and statutory spaces (no exemption).
 */
export function disabilityDoubles(code: string, description = ''): boolean {
  return !isStatutoryRestriction(code) && !isStatutoryRestriction(description) && !isDisabilityOnlyRestriction(code, description);
}

/** The observation timed against twice the signed allowance (idempotent). */
export function withDisabilityConcession(o: Observation): Observation {
  if (o.concession) return o;
  const limit = o.limitMinutes * 2;
  return { ...o, limitMinutes: limit, allowanceEndsAt: o.startedAt + limit * 60_000, overstayFlaggedAt: null, concession: { kind: 'disability', baseLimitMinutes: o.limitMinutes } };
}

/** Apply a confirmed disability permit to a timing decision (where the restriction allows it). */
function applyDisability(d: Decision, list: TimedList, at: number): Decision {
  if (d.kind === 'timed_new' || d.kind === 'timed_possible') {
    const r = d.instance.restriction;
    return disabilityDoubles(r.code, r.description) ? { ...d, concession: 'disability' } : d;
  }
  if (d.kind === 'timed_resighting') {
    const r = list.restrictions.find((x) => x.id === d.observation.restrictionId);
    return !d.observation.concession && disabilityDoubles(d.observation.restrictionCode, r?.description) ? resighting(withDisabilityConcession(d.observation), at) : d;
  }
  return d;
}

/**
 * Timed lists, in order:
 *   1. No running clock and no restriction in force          → not in force (nothing to check)
 *   2. Overstay alert dismissed earlier this restriction period → exempt, recorded
 *   3. Tagged vehicle (not in a statutory restriction)          → confirmed today: exempt; else check
 *   4. Permit(s) held for the plate                             → show details; officer decides
 *   5. Running clock → re-sighting; otherwise new sighting
 */
function decideTimed(input: EngineInput, list: TimedList, expireIds: Set<string>): Decision {
  const { at, plate } = input;
  const key = plateKey(plate);
  const rest = decideTiming(input, list, expireIds);
  if (rest.kind === 'timed_not_in_force') return rest;

  const dismissed = input.observations
    .filter((o) => o.listId === list.id && o.status === 'dismissed' && o.key === key && o.windowEndsAt > at && o.startedAt <= at)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (dismissed) return { kind: 'timed_dismissed', observation: dismissed, reason: dismissed.dismissReason ?? 'permit_displayed' };

  const code = decisionCode(rest) ?? '';
  const restrictionId = rest.kind === 'timed_resighting' ? rest.observation.restrictionId : rest.kind === 'timed_new' || rest.kind === 'timed_possible' ? rest.instance.restriction.id : '';
  const description = list.restrictions.find((r) => r.id === restrictionId)?.description ?? '';
  // The sign may be in the code ("NSEGCV 15") or the description ("Except authorised vehicles").
  const statutory = isStatutoryRestriction(code) || isStatutoryRestriction(description);
  const permits = statutory ? [] : findPermits(plate, list, input.allowLists, at, { code, description });
  const afterFlag: Decision = permits.length ? { kind: 'timed_permit', hits: permits, then: rest } : rest;

  const flag = statutory ? undefined : input.flags?.find((f) => f.key === key);
  if (!flag) return afterFlag;
  // Emergency: recorded without a timer. Disability: timed against twice the allowance (prescribed
  // time in disability-only spaces); a permit pop-up still follows if the plate holds one.
  const disabled = applyDisability(rest, list, at);
  const confirmed: Decision =
    flag.kind === 'emergency' ? { kind: 'timed_flag_exempt', flag } : permits.length ? { kind: 'timed_permit', hits: permits, then: disabled } : disabled;
  return flag.confirmedDay === localDateString(at) ? confirmed : { kind: 'timed_flag_check', flag, then: afterFlag, confirmed };
}

function decideTiming(input: EngineInput, list: TimedList, expireIds: Set<string>): Decision {
  const { at, plate } = input;
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
  /** Disability permit confirmed: allowance twice the signed time. */
  concession?: 'disability';
}): Observation {
  const r = args.instance.restriction;
  const base: Observation = {
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
  return args.concession === 'disability' && disabilityDoubles(r.code, r.description) ? withDisabilityConcession(base) : base;
}

/** The timing decision behind a permit pop-up or known-vehicle check (what "continue" applies). */
export function timingDecision(d: Decision): Decision {
  let x = d;
  while (x.kind === 'timed_permit' || x.kind === 'timed_flag_check') x = x.then;
  return x;
}
