import { describe, expect, it } from 'vitest';
import { newObservation } from '../src/lib/engine';
import { firstLookalike, hotLookalikes, logChoice, permitLookalikes, sameVehicleLink, timedLookalikes } from '../src/lib/lookalike';
import { allow, at, hot, r2P, timed } from './fixtures';

const list = timed();
const inst = { restriction: r2P(), start: at(2026, 11, 21, 8), end: at(2026, 11, 21, 18) };
const obs = (plate: string, h: number, id = `o-${plate}`) => newObservation({ id, list, plate, scanId: `s-${plate}`, at: at(2026, 11, 21, h), instance: inst });

describe('look-alike candidates by source (WF-S28)', () => {
  it('finds a running timing on this segment by look-alike class (R·P: the 1UP6YF / 1UR6YF field misread)', () => {
    const got = timedLookalikes('1UP6YF', list.id, [obs('1UR6YF', 9), obs('1UD6YF', 10), obs('1UP6YF', 11)]);
    expect(got.map((x) => x.observation.plate)).toEqual(['1UR6YF']); // D is not in the R·P class; exact is not a look-alike
  });

  it('orders several timed candidates oldest first', () => {
    const got = timedLookalikes('DA8B99', list.id, [obs('DABB99', 10), obs('DA8899', 9)]);
    expect(got.map((x) => x.observation.plate)).toEqual(['DA8899', 'DABB99']);
  });

  it('finds hot-list look-alikes on every hot list', () => {
    expect(hotLookalikes('2AF402', [hot(['ZAF402'])]).map((x) => x.entry.plate)).toEqual(['ZAF402']);
    expect(hotLookalikes('ZAF402', [hot(['ZAF402'])])).toEqual([]); // exact: a hit, not a look-alike
  });

  it('finds permit look-alikes on allow lists linked to the segment only', () => {
    expect(permitLookalikes('2FE707', list, [allow(['2FE70T'])]).map((x) => x.entry.plate)).toEqual(['2FE70T']);
    expect(permitLookalikes('2FE707', timed({ allowListIds: [] }), [allow(['2FE70T'])])).toEqual([]);
  });

  it('hints in the routing order hot → permit → timed', () => {
    const sources = { hotLists: [hot(['DA8899'])], allowLists: [allow(['DA8899'])], observations: [obs('DA8899', 9)], list };
    expect(firstLookalike('DA8B99', sources)?.source).toBe('hot');
    expect(firstLookalike('DA8B99', { ...sources, hotLists: [] })?.source).toBe('allow');
    expect(firstLookalike('DA8B99', { ...sources, hotLists: [], allowLists: [] })?.source).toBe('timed');
    expect(firstLookalike('XYZ999', sources)).toBeNull();
  });

  it('logs each choice with the plate as read and the candidate', () => {
    const o = obs('1UR6YF', 9, 'obs-1');
    const link = logChoice('1UP6YF', { source: 'timed', observation: o }, 'same', 1234);
    expect(link).toEqual({ readAs: '1UP6YF', candidatePlate: '1UR6YF', source: 'timed', candidateId: 'obs-1', choice: 'same', decidedAt: 1234 });
    expect(sameVehicleLink([logChoice('1UP6YF', { source: 'timed', observation: o }, 'different'), link])).toBe(link);
    expect(sameVehicleLink([logChoice('1UP6YF', { source: 'timed', observation: o }, 'different')])).toBeUndefined();
  });
});
