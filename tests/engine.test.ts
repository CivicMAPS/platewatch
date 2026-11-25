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
  it('a plate on a linked allow list raises the permit pop-up (valid, applies); the officer decides', () => {
    const r = evaluate({ ...base, at: MON_0900, plate: 'res 001' });
    expect(r.decision).toMatchObject({ kind: 'timed_permit', hits: [{ validity: 'valid', scope: 'applies', linked: true }], then: { kind: 'timed_new' } });
  });

  it('a permit is shown even when a clock is already running for the plate (the officer can exempt it)', () => {
    const running = observe('RES001', MON_0900);
    const r = evaluate({ ...base, observations: [running], at: at(2026, 11, 16, 12, 0), plate: 'RES001' });
    expect(r.decision).toMatchObject({ kind: 'timed_permit', then: { kind: 'timed_resighting', overstay: true } });
  });

  it('valid from 00:00 on valid-from until midnight at the end of valid-to', () => {
    const a = allow(['RES001']);
    a.entries[0]!.validFrom = '2026-11-16';
    a.entries[0]!.validTo = '2026-11-16';
    for (const t of [at(2026, 11, 16, 0, 0), MON_0900, at(2026, 11, 16, 23, 59, 59)]) expect(findPermits('RES001', list, [a], t)[0]!.validity).toBe('valid');
    expect(findPermits('RES001', list, [a], at(2026, 11, 17, 0, 0))[0]).toMatchObject({ validity: 'expired', notYetValid: false });
    expect(findPermits('RES001', list, [a], at(2026, 11, 15, 23, 59))[0]).toMatchObject({ validity: 'expired', notYetValid: true });
  });

  it('shows a permit on a list that is not linked, with its scope unknown', () => {
    const r = evaluate({ ...base, list: timed({ allowListIds: [] }), at: MON_0900, plate: 'RES001' });
    expect(r.decision).toMatchObject({ kind: 'timed_permit', hits: [{ validity: 'valid', scope: 'unknown', linked: false }] });
  });

  it('only two statuses: expired and not yet valid are both "expired", never exempt by themselves', () => {
    const a = allow(['RES001', 'RES002']);
    a.entries[0]!.validTo = '2026-11-15';
    a.entries[1]!.validFrom = '2026-11-17';
    expect(evaluate({ ...base, allowLists: [a], at: MON_0900, plate: 'RES001' }).decision).toMatchObject({ kind: 'timed_permit', hits: [{ validity: 'expired' }], then: { kind: 'timed_new' } });
    expect(evaluate({ ...base, allowLists: [a], at: MON_0900, plate: 'RES002' }).decision).toMatchObject({ kind: 'timed_permit', hits: [{ validity: 'expired', notYetValid: true }] });
  });

  it('permits held without types: an area or a street matching applies (older lists)', () => {
    const l = timed({ allowListIds: [], rpa: 'com-rpa-12' });
    const permit = (patch: Partial<AllowList['entries'][number]>) => { const a = allow(['RES001']); Object.assign(a.entries[0]!, patch); return [a]; };
    const scope = (patch: Partial<AllowList['entries'][number]>, list = l) => {
      const d = evaluate({ ...base, list, allowLists: permit(patch), at: MON_0900, plate: 'RES001' }).decision;
      return d.kind === 'timed_permit' ? d.hits[0]!.scope : d.kind;
    };
    expect(scope({ rpa: '12' })).toBe('applies');
    expect(scope({ rpa: 'RPA 12' })).toBe('applies');
    expect(scope({ rpa: '5A' })).toBe('other_area');
    expect(scope({ streets: ['Smith St'] })).toBe('applies');
    expect(scope({ streets: ['Brunswick Street'] })).toBe('other_area');
    expect(scope({ rpa: '5A', streets: ['smith street'] })).toBe('applies');
    expect(scope({ rpa: '5A' }, timed({ rpa: '12' }))).toBe('other_area');
  });

  it('permit types: RPA by area (council-scoped), RSP / RP by the registered street, FS only in a foreshore space', () => {
    const l = timed({ allowListIds: [], rpa: 'com-rpa-7', displayId: 'com-20055', restrictions: [r2P({ description: 'Meter' })] });
    const hit = (patch: Partial<AllowList['entries'][number]>, list = l) => {
      const a = allow(['RES001']);
      Object.assign(a.entries[0]!, { council: { code: 'com' }, address: { streetNumber: '12', street: 'Gladstone Street' }, ...patch });
      return findPermits('RES001', list, [a], MON_0900, list.restrictions[0])[0]!;
    };
    expect(hit({ permitTypes: ['RPA'], rpa: '7' })).toMatchObject({ scope: 'applies', basis: 'RPA' });
    expect(hit({ permitTypes: ['RPA'], rpa: '7', council: { code: 'copp' } })).toMatchObject({ scope: 'other_area' }); // copp 7 is not com 7
    expect(hit({ permitTypes: ['RPA'], rpa: '7' }, { ...l, rpa: '919379201-com-rpa7' })).toMatchObject({ scope: 'applies' }); // operational ID
    expect(hit({ permitTypes: ['RSP'], address: { streetNumber: '12', street: 'Smith Street' } })).toMatchObject({ scope: 'applies', basis: 'RSP' });
    expect(hit({ permitTypes: ['RP'], address: { streetNumber: '3/45', street: 'Smith St' } })).toMatchObject({ scope: 'applies', basis: 'RP' });
    expect(hit({ permitTypes: ['RSP'] })).toMatchObject({ scope: 'other_area' });
    expect(hit({ permitTypes: ['FS'] })).toMatchObject({ scope: 'other_area' }); // not a foreshore space
    const fore = { ...l, restrictions: [r2P({ description: 'Meter · Foreshore' })] };
    expect(hit({ permitTypes: ['FS'] }, fore)).toMatchObject({ scope: 'payment_only', basis: 'FS' });
    expect(hit({ permitTypes: ['FS'], council: { code: 'copp' } }, fore)).toMatchObject({ scope: 'other_area' }); // own municipality only
    // A combination: RPA in area wins; outside the area its FS still waives payment in a foreshore space.
    expect(hit({ permitTypes: ['RPA', 'FS'], rpa: '7' }, fore)).toMatchObject({ scope: 'applies', basis: 'RPA' });
    expect(hit({ permitTypes: ['RPA', 'FS'], rpa: '9' }, fore)).toMatchObject({ scope: 'payment_only', basis: 'FS' });
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
