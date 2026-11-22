import { describe, expect, it } from 'vitest';
import { evaluate, findPermits, newObservation } from '../src/lib/engine';
import type { AllowList, Observation } from '../src/lib/types';
import { allow, at, hot, r2P, timed } from './fixtures';

const MON_0900 = at(2026, 11, 16, 9, 0);
const list = timed();

function observe(plate: string, startedAt: number, patch: Partial<Observation> = {}): Observation {
  const inst = { restriction: r2P(), start: at(2026, 11, 16, 8), end: at(2026, 11, 16, 18) };
  return { ...newObservation({ id: `o-${plate}`, list, plate, scanId: `s-${plate}`, at: startedAt, instance: inst }), ...patch };
}

const base = { list, hotLists: [], allowLists: [allow(['RES001'])], observations: [] as Observation[] };

describe('timed list workflow', () => {
  it('a plate on a linked allow list raises the permit pop-up as in area; the officer decides', () => {
    const r = evaluate({ ...base, at: MON_0900, plate: 'res 001' });
    expect(r.decision).toMatchObject({ kind: 'timed_permit', hits: [{ status: 'ACTIVE_IN_AREA', linked: true }], then: { kind: 'timed_new' } });
  });

  it('a permit is shown even when a clock is already running for the plate (the officer can exempt it)', () => {
    const running = observe('RES001', MON_0900);
    const r = evaluate({ ...base, observations: [running], at: at(2026, 11, 16, 12, 0), plate: 'RES001' });
    expect(r.decision).toMatchObject({ kind: 'timed_permit', then: { kind: 'timed_resighting', overstay: true } });
  });

  it('a permit valid only from today, or only until today, is active all day', () => {
    const a = allow(['RES001']);
    a.entries[0]!.validFrom = '2026-11-16';
    a.entries[0]!.validTo = '2026-11-16';
    for (const t of [at(2026, 11, 16, 0, 1), MON_0900, at(2026, 11, 16, 23, 59)])
      expect(findPermits('RES001', list, [a], t)[0]!.status).toBe('ACTIVE_IN_AREA');
  });

  it('shows a permit on a list that is not linked, with its scope unknown', () => {
    const r = evaluate({ ...base, list: timed({ allowListIds: [] }), at: MON_0900, plate: 'RES001' });
    expect(r.decision).toMatchObject({ kind: 'timed_permit', hits: [{ status: 'ACTIVE_SCOPE_UNKNOWN', linked: false }] });
  });

  it('reports an expired or not-yet-active permit as such, never as exempt', () => {
    const a = allow(['RES001', 'RES002']);
    a.entries[0]!.validTo = '2026-11-15';
    a.entries[1]!.validFrom = '2026-11-17';
    expect(evaluate({ ...base, allowLists: [a], at: MON_0900, plate: 'RES001' }).decision).toMatchObject({ kind: 'timed_permit', hits: [{ status: 'NOT_ACTIVE_EXPIRED' }], then: { kind: 'timed_new' } });
    expect(evaluate({ ...base, allowLists: [a], at: MON_0900, plate: 'RES002' }).decision).toMatchObject({ kind: 'timed_permit', hits: [{ status: 'NOT_YET_ACTIVE' }] });
  });

  it('compares a permit area or street with the segment (either one matching is in area)', () => {
    const l = timed({ allowListIds: [], rpa: 'com-rpa-12' });
    const permit = (patch: Partial<AllowList['entries'][number]>) => { const a = allow(['RES001']); Object.assign(a.entries[0]!, patch); return [a]; };
    const status = (patch: Partial<AllowList['entries'][number]>, list = l) => {
      const d = evaluate({ ...base, list, allowLists: permit(patch), at: MON_0900, plate: 'RES001' }).decision;
      return d.kind === 'timed_permit' ? d.hits[0]!.status : d.kind;
    };
    expect(status({ rpa: '12' })).toBe('ACTIVE_IN_AREA');
    expect(status({ rpa: 'RPA 12' })).toBe('ACTIVE_IN_AREA');
    expect(status({ rpa: '5A' })).toBe('ACTIVE_NOT_IN_AREA');
    expect(status({ streets: ['Smith St'] })).toBe('ACTIVE_IN_AREA');
    expect(status({ streets: ['Brunswick Street'] })).toBe('ACTIVE_NOT_IN_AREA');
    expect(status({ rpa: '5A', streets: ['smith street'] })).toBe('ACTIVE_IN_AREA');
    // A scoped permit on a linked list still has to match: the link does not widen it.
    expect(status({ rpa: '5A' }, timed({ rpa: '12' }))).toBe('ACTIVE_NOT_IN_AREA');
  });

  it('shows no permit and records nothing when no restriction is in force', () => {
    const r = evaluate({ ...base, at: at(2026, 11, 16, 20, 0), plate: 'RES001' });
    expect(r.decision.kind).toBe('timed_not_in_force');
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

describe('known vehicles and dismissed alerts', () => {
  const flag = (kind: 'disability' | 'emergency', confirmedDay: string) => ({ key: 'ABC123', plate: 'ABC123', kind, createdAt: 0, sourceScanId: 's0', confirmedDay });

  it('asks the officer to check a tagged vehicle on a new day, with the timing to apply if not confirmed', () => {
    const r = evaluate({ ...base, flags: [flag('disability', '2026-11-13')], at: MON_0900, plate: 'ABC123' });
    expect(r.decision).toMatchObject({ kind: 'timed_flag_check', flag: { kind: 'disability' }, then: { kind: 'timed_new' } });
  });

  it('records a tagged vehicle confirmed earlier today without a timer', () => {
    const r = evaluate({ ...base, flags: [flag('emergency', '2026-11-16')], at: MON_0900, plate: 'ABC123' });
    expect(r.decision).toMatchObject({ kind: 'timed_flag_exempt' });
  });

  it('never applies a tag or a permit in a statutory restriction (loading zone)', () => {
    const lz = timed({ restrictions: [r2P({ code: 'LZ30', limitMinutes: 30 })] });
    const r = evaluate({ ...base, list: lz, flags: [flag('disability', '2026-11-13')], at: MON_0900, plate: 'ABC123' });
    expect(r.decision.kind).toBe('timed_new');
    expect(evaluate({ ...base, list: lz, at: MON_0900, plate: 'RES001' }).decision.kind).toBe('timed_new');
  });

  it('exempts a plate whose overstay alert was dismissed earlier in the same restriction period', () => {
    const d = observe('ABC123', MON_0900, { status: 'dismissed', dismissReason: 'permit_displayed', closedAt: at(2026, 11, 16, 11, 30) });
    const r = evaluate({ ...base, observations: [d], at: at(2026, 11, 16, 13, 0), plate: 'ABC123' });
    expect(r.decision).toMatchObject({ kind: 'timed_dismissed', reason: 'permit_displayed' });
    // Next day: a new restriction period, timed as usual.
    expect(evaluate({ ...base, observations: [d], at: at(2026, 11, 17, 9, 0), plate: 'ABC123' }).decision.kind).toBe('timed_new');
  });
});

describe('isStatutoryRestriction', () => {
  it('recognises loading, bus and taxi zones, no stopping / parking and clearways, not time limits', async () => {
    const { isStatutoryRestriction } = await import('../src/lib/engine');
    for (const c of ['LZ30', 'LZ 15', 'Loading Zone', 'BZ', 'Bus Zone', 'Taxi Zone', 'NS', 'No Stopping', 'No Parking', 'Clearway', 'Works Zone', 'Police Vehicles Only', 'Except Authorised Vehicles', 'Except authorized vehicles', 'NSEGCV', 'NSEGCV 15', 'No Stopping Except Goods Carrying Vehicles'])
      expect(isStatutoryRestriction(c)).toBe(true);
    for (const c of ['2P', '1/2P', 'P15', '2P Meter', '4P Ticket', 'P5', '2P Permit Zone']) expect(isStatutoryRestriction(c)).toBe(false);
  });
});

describe('statutory sign in the restriction description', () => {
  it('applies no tag or permit when the description is a red sign', () => {
    const l = timed({ restrictions: [r2P({ code: '2P', description: 'Except authorised vehicles' })] });
    const flag = { key: 'ABC123', plate: 'ABC123', kind: 'disability' as const, createdAt: 0, sourceScanId: 's', confirmedDay: '2026-11-13' };
    expect(evaluate({ ...base, list: l, flags: [flag], at: MON_0900, plate: 'ABC123' }).decision.kind).toBe('timed_new');
  });
});
