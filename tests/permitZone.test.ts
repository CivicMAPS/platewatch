import { describe, expect, it } from 'vitest';
import { BACKUP_SCHEMA, BACKUP_VERSION, parseBackup } from '../src/lib/backup';
import { evaluate } from '../src/lib/engine';
import type { AllowEntry, PermitZoneList } from '../src/lib/types';
import { allow, at, hot, timed } from './fixtures';

const zone: PermitZoneList = {
  type: 'permit_zone', id: 'zone-1', name: 'Smith Street residents', notes: '', createdAt: 0, updatedAt: 0,
  councilCode: 'copp', rpa: '4B', segment: timed().segment,
};
const base = allow(['RES001']);
const permit: AllowEntry = {
  ...base.entries[0]!, permitNo: 'RPA-2026-0001', validFrom: '2026-01-01', validTo: '2026-11-25',
  council: { code: 'copp' }, rpa: '4B', address: { street: 'Smith St.', streetNumber: '12' },
};
const scan = (entry: Partial<AllowEntry>, plate = 'RES001') => evaluate({
  plate, list: zone, allowLists: [{ ...base, entries: [{ ...permit, ...entry }] }],
  at: at(2026, 11, 25, 23, 59), hotLists: [hot(['RES001'])], observations: [],
});
const hit = (entry: Partial<AllowEntry>) => {
  const { decision } = scan(entry);
  if (decision.kind !== 'zone_permits') throw new Error('Expected permit details for officer review');
  return decision.hits[0];
};

describe('non-timed residential permit zone', () => {
  it('accepts a current council area permit through the end of its last day, independently of address', () => {
    expect(hit({ rpa: '123-copp-rpa4B', address: undefined })).toMatchObject({ validity: 'valid', scope: 'applies', basis: 'RPA' });
  });
  it('accepts a street permit on the signed street regardless of its parking area', () => {
    expect(hit({ permitNo: 'RSP-2026-0001', rpa: '9' })).toMatchObject({ scope: 'applies', basis: 'RSP' });
    expect(hit({ permitNo: 'RPA/COMB/RSP-2026-0001', rpa: '9' })).toMatchObject({ scope: 'applies', basis: 'RSP' });
  });
  it.each<Partial<AllowEntry>>([
    { rpa: '5' }, { rpa: 'com-rpa4B' }, { council: { code: 'com' } }, { council: undefined },
    { permitNo: 'RSP-2026-0001', address: { streetNumber: '12', street: 'Smith Road' } },
    { permitNo: 'FS-2026-0001' }, { permitNo: 'RP-2026-0001' }, { permitNo: 'legacy' },
  ])('withholds confirmation for incompatible or unknown entitlement %j', (entry) => {
    expect(hit(entry)?.scope).not.toBe('applies');
  });
  it.each([
    ['2026-01-01', '2026-11-24', 'expired'], ['2026-11-26', '2027-02-01', 'expired'],
    ['', '2026-12-01', 'unverified'], ['2026-01-01', '2026-11-31', 'unverified'],
  ])('checks the validity window %s to %s', (validFrom, validTo, validity) => {
    expect(hit({ validFrom, validTo })?.validity).toBe(validity);
  });
  it('requires the exact plate and still checks hot lists on a permit-zone scan', () => {
    expect(scan({}, 'RESOO1').decision).toEqual({ kind: 'permit_unconfirmed' });
    expect(scan({}).hotHits[0]?.strength).toBe('exact');
  });
  it('restores the segment and authority from backup and rejects a zone missing its authority', () => {
    const backup = JSON.stringify({ schema: BACKUP_SCHEMA, version: BACKUP_VERSION, lists: [zone, { ...zone, councilCode: '' }] });
    expect(parseBackup(backup).lists).toEqual([zone]);
  });
});
