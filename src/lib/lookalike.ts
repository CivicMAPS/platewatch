/**
 * Look-alike plates (WF-S28): a read that is an OCR look-alike (`comparePlates` → `possible`) of a
 * plate already held. Candidates come from three places, each handled differently, in this order:
 *
 *   1. hot list    → the hot-list interrupt in verify form; the officer must choose (28e)
 *   2. permit      → "Similar permit plate — check the displayed permit"; never exempts (28f)
 *   3. timed       → "Possible earlier sighting" with the candidates side by side (28b, 28c)
 *
 * Nothing here decides: a look-alike is never resolved without the officer (OQ28-3).
 */
import { comparePlates } from './plate';
import type { AllowEntry, AllowList, HotEntry, HotList, LookalikeLink, Observation, TimedList } from './types';

export interface HotLookalike {
  source: 'hot';
  list: HotList;
  entry: HotEntry;
}
export interface PermitLookalike {
  source: 'allow';
  list: AllowList;
  entry: AllowEntry;
}
export interface TimedLookalike {
  source: 'timed';
  observation: Observation;
}
export type Lookalike = HotLookalike | PermitLookalike | TimedLookalike;

/** Hot-list entries the read is a look-alike of (every hot list: officer safety). */
export function hotLookalikes(plate: string, hotLists: readonly HotList[]): HotLookalike[] {
  return hotLists.flatMap((list) => list.entries.filter((e) => comparePlates(plate, e.plate) === 'possible').map((entry) => ({ source: 'hot' as const, list, entry })));
}

/**
 * Permit entries the read is a look-alike of: allow lists linked to the timed list (the lists a
 * permit would apply through). A plate exactly on a list is a permit, not a look-alike.
 */
export function permitLookalikes(plate: string, list: TimedList, allowLists: readonly AllowList[]): PermitLookalike[] {
  return allowLists
    .filter((a) => list.allowListIds.includes(a.id))
    .flatMap((a) => a.entries.filter((e) => comparePlates(plate, e.plate) === 'possible').map((entry) => ({ source: 'allow' as const, list: a, entry })));
}

/** Running timings on this list whose plate the read resembles, oldest first. */
export function timedLookalikes(plate: string, listId: string, observations: readonly Observation[]): TimedLookalike[] {
  return observations
    .filter((o) => o.listId === listId && o.status === 'active' && comparePlates(plate, o.plate) === 'possible')
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((observation) => ({ source: 'timed' as const, observation }));
}

/**
 * The confirm-screen hint (28a): the first look-alike in the routing order hot → permit → timed,
 * or null. Updates as the officer edits the plate.
 */
export function firstLookalike(
  plate: string,
  sources: { hotLists: readonly HotList[]; allowLists: readonly AllowList[]; observations: readonly Observation[]; list: TimedList | null },
): Lookalike | null {
  if (!plate) return null;
  return (
    hotLookalikes(plate, sources.hotLists)[0] ??
    (sources.list ? permitLookalikes(plate, sources.list, sources.allowLists)[0] : undefined) ??
    (sources.list ? timedLookalikes(plate, sources.list.id, sources.observations)[0] : undefined) ??
    null
  );
}

/** The plate and id of a candidate, as stored on the scan's look-alike log. */
export function candidateOf(l: Lookalike): { plate: string; id: string } {
  return l.source === 'timed' ? { plate: l.observation.plate, id: l.observation.id } : { plate: l.entry.plate, id: l.entry.id };
}

/** One logged choice (requirement 5: every choice is logged with its time). */
export function logChoice(readAs: string, l: Lookalike, choice: LookalikeLink['choice'], at = Date.now()): LookalikeLink {
  const c = candidateOf(l);
  return { readAs, candidatePlate: c.plate, source: l.source, candidateId: c.id, choice, decidedAt: at };
}

/** The look-alike link a scan joined a timing through ("Same vehicle"), if any. */
export function sameVehicleLink(links: readonly LookalikeLink[] | undefined): LookalikeLink | undefined {
  return links?.find((x) => x.source === 'timed' && x.choice === 'same');
}
