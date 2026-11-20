import { describe, expect, it } from 'vitest';
import { evaluate, newObservation } from '../src/lib/engine';
import type { Observation } from '../src/lib/types';
import { allow, at, hot, r2P, timed } from './fixtures';

const MON_0900 = at(2026, 11, 16, 9, 0);
const list = timed();

function observe(plate: string, startedAt: number, patch: Partial<Observation> = {}): Observation {
  const inst = { restriction: r2P(), start: at(2026, 11, 16, 8), end: at(2026, 11, 16, 18) };
  return { ...newObservation({ id: `o-${plate}`, list, plate, scanId: `s-${plate}`, at: startedAt, instance: inst }), ...patch };
}

const base = { list, hotLists: [], allowLists: [allow(['RES001'])], observations: [] as Observation[] };

describe('timed list workflow', () => {
  it('a plate on a linked allow list has a valid permit (no allowance clock)', () => {
    const r = evaluate({ ...base, at: MON_0900, plate: 'res 001' });
    expect(r.decision.kind).toBe('timed_exempt');
  });

  it('a valid permit wins over an allowance clock already running for the plate (never an overstay)', () => {
    // E.g. the vehicle was recorded before its permit was added to the linked allow list.
    const running = observe('RES001', MON_0900);
    const r = evaluate({ ...base, observations: [running], at: at(2026, 11, 16, 12, 0), plate: 'RES001' });
    expect(r.decision.kind).toBe('timed_exempt');
  });

  it('a permit valid only from today, or only until today, is valid all day', () => {
    const a = allow(['RES001']);
    a.entries[0]!.validFrom = '2026-11-16';
    a.entries[0]!.validTo = '2026-11-16';
    for (const t of [at(2026, 11, 16, 0, 1), MON_0900, at(2026, 11, 16, 23, 59)])
      expect(evaluate({ ...base, allowLists: [a], at: t, plate: 'RES001' }).decision.kind).toBe('timed_exempt');
  });

  it('ignores allow lists that are not linked', () => {
    const r = evaluate({ ...base, list: timed({ allowListIds: [] }), at: MON_0900, plate: 'RES001' });
    expect(r.decision.kind).toBe('timed_new');
  });

  it('does not exempt an expired permit', () => {
    const a = allow(['RES001']);
    a.entries[0]!.validTo = '2026-11-15';
    const r = evaluate({ ...base, allowLists: [a], at: MON_0900, plate: 'RES001' });
    expect(r.decision.kind).toBe('timed_new');
  });

  it('first sighting creates a record with the allowance of the restriction in force', () => {
    const r = evaluate({ ...base, at: MON_0900, plate: 'ABC123' });
    expect(r.decision.kind).toBe('timed_new');
    if (r.decision.kind !== 'timed_new') return;
    const o = newObservation({ id: 'o', list, plate: 'ABC123', scanId: 's', at: MON_0900, instance: r.decision.instance });
    expect(o.allowanceEndsAt).toBe(at(2026, 11, 16, 11, 0));
    expect(o.windowEndsAt).toBe(at(2026, 11, 16, 18, 0));
  });

  it('re-sighting within the allowance shows elapsed time without overstay', () => {
    const r = evaluate({ ...base, observations: [observe('ABC123', MON_0900)], at: at(2026, 11, 16, 10, 15), plate: 'ABC123' });
    expect(r.decision).toMatchObject({ kind: 'timed_resighting', overstay: false, elapsedMs: 75 * 60_000, remainingMs: 45 * 60_000 });
  });

  it('flags overstay once allowance + grace has elapsed', () => {
    const withGrace = observe('ABC123', MON_0900, { graceMinutes: 5 });
    const at1104 = evaluate({ ...base, observations: [withGrace], at: at(2026, 11, 16, 11, 4), plate: 'ABC123' });
    expect(at1104.decision).toMatchObject({ kind: 'timed_resighting', overstay: false });
    const at1105 = evaluate({ ...base, observations: [withGrace], at: at(2026, 11, 16, 11, 5), plate: 'ABC123' });
    expect(at1105.decision).toMatchObject({ kind: 'timed_resighting', overstay: true, elapsedMs: 125 * 60_000 });
  });

  it('flags OCR lookalikes for review', () => {
    const r = evaluate({ ...base, observations: [observe('AB0123', MON_0900)], at: at(2026, 11, 16, 9, 30), plate: 'ABO123' });
    expect(r.decision.kind).toBe('timed_possible');
  });

  it('asks the officer to verify near matches (B/8 etc.)', () => {
    const r = evaluate({ ...base, observations: [observe('1BC123', MON_0900)], at: at(2026, 11, 16, 9, 30), plate: '18C123' });
    expect(r.decision.kind).toBe('timed_possible');
  });

  it('expires observations once the restriction period ends and starts fresh next period', () => {
    const o = observe('ABC123', MON_0900);
    const tue = at(2026, 11, 17, 9, 0);
    const r = evaluate({ ...base, observations: [o], at: tue, plate: 'ABC123' });
    expect(r.expireObservationIds).toEqual([o.id]);
    expect(r.decision.kind).toBe('timed_new');
  });

  it('reports not in force outside restriction hours', () => {
    const r = evaluate({ ...base, at: at(2026, 11, 16, 19, 0), plate: 'ABC123' });
    expect(r.decision.kind).toBe('timed_not_in_force');
    if (r.decision.kind === 'timed_not_in_force') expect(r.decision.next?.start).toBe(at(2026, 11, 17, 8));
  });

  it('ignores reset/expired observations', () => {
    const r = evaluate({ ...base, observations: [observe('ABC123', MON_0900, { status: 'reset' })], at: at(2026, 11, 16, 12), plate: 'ABC123' });
    expect(r.decision.kind).toBe('timed_new');
  });
});

describe('hot lists', () => {
  it('always raises hot-list hits, even while working a timed list', () => {
    const r = evaluate({ ...base, hotLists: [hot(['BAD999'])], at: MON_0900, plate: 'BAD999' });
    expect(r.hotHits).toHaveLength(1);
    expect(r.hotHits[0]!.strength).toBe('exact');
    expect(r.decision.kind).toBe('timed_new');
  });
  it('raises possible hot-list hits for confusable plates', () => {
    const r = evaluate({ ...base, hotLists: [hot(['8AD999'])], at: MON_0900, plate: 'BAD999' });
    expect(r.hotHits[0]!.strength).toBe('possible');
  });
  it('hot list mode reports match / no match', () => {
    const h = hot(['BAD999']);
    expect(evaluate({ ...base, list: h, hotLists: [h], at: MON_0900, plate: 'BAD999' }).decision.kind).toBe('hot_match');
    expect(evaluate({ ...base, list: h, hotLists: [h], at: MON_0900, plate: 'GOOD11' }).decision.kind).toBe('hot_none');
  });
});

describe('allow list mode', () => {
  it('reports membership and validity', () => {
    const a = allow(['RES001']);
    a.entries[0]!.validFrom = '2026-12-01';
    const r = evaluate({ ...base, list: a, at: MON_0900, plate: 'RES001' });
    expect(r.decision).toMatchObject({ kind: 'allow_member', validNow: false });
    expect(evaluate({ ...base, list: a, at: MON_0900, plate: 'NOPE1' }).decision.kind).toBe('allow_none');
  });
});
