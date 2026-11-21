import { describe, expect, it } from 'vitest';
import { groupByZone, patrolZones, searchTimedLists, zoneLabel, NO_ZONE } from '../src/lib/listIndex';
import type { TimedList } from '../src/lib/types';
import { timed } from './fixtures';

const seg = (
  id: string,
  street: string,
  fromStreet: string,
  toStreet: string,
  extra: Partial<TimedList> = {},
): TimedList => ({
  ...timed(),
  id,
  name: id,
  segment: { street, fromStreet, toStreet, side: 'north', suburb: 'South Melbourne' },
  ...extra,
});

const lists = [
  seg('york', 'York Street', 'Northumberland Street', 'Cecil Street', { patrolZone: '1', rpa: '12', payment: { easyPark: ['3051'], payStay: [{ zone: '00042', meter: '4521' }] } }),
  seg('coventry', 'Coventry Street', 'Clarendon Street', 'Cecil Street', { patrolZone: '1', rpa: '7' }),
  seg('york-west', 'York Street', 'Clarendon Street', 'Northumberland Street', { patrolZone: '1' }),
  seg('fitzroy', 'Fitzroy Street', 'Grey Street', 'Park Street', { patrolZone: '10', payment: { easyPark: [], payStay: [{ zone: '00099', meter: '7788' }] } }),
  seg('chapel', 'Chapel Street', 'Dandenong Road', 'Inkerman Street', { patrolZone: '2' }),
  seg('loose', 'Bay Street', 'Graham Street', 'Ross Street'),
];

const ids = (q: string) => searchTimedLists(lists, q).map((r) => r.list.id);

describe('searchTimedLists', () => {
  it('returns every list for an empty query', () => {
    expect(ids('  ')).toHaveLength(lists.length);
  });
  it('finds a segment by meter ID, EasyPark area or PayStay zone and says which field matched', () => {
    const [hit] = searchTimedLists(lists, '4521');
    expect(hit?.list.id).toBe('york');
    expect(hit?.matches[0]).toEqual({ label: 'Meter ID', value: '4521' });
    expect(ids('3051')).toEqual(['york']);
    expect(ids('00099')).toEqual(['fitzroy']);
  });
  it('uses field words in the query to narrow the field (rpa 12 is not patrol zone 12)', () => {
    expect(ids('rpa 12')).toEqual(['york']);
    expect(ids('rpa 7')).toEqual(['coventry']);
    expect(ids('zone 10')).toEqual(['fitzroy']);
    expect(ids('meter 7788')).toEqual(['fitzroy']);
  });
  it('matches road segment names by prefix, across words, and with one typo', () => {
    expect(ids('chap')).toEqual(['chapel']);
    expect(ids('fitzroi')).toEqual(['fitzroy']);
    expect(ids('york cecil')).toEqual(['york']);
    expect(ids('clarendon')).toEqual(expect.arrayContaining(['coventry', 'york-west']));
  });
  it('ranks an exact field match above a partial one', () => {
    expect(ids('york')[0]).toMatch(/^york/);
    expect(searchTimedLists(lists, '1')[0]?.matches[0]?.label).toBe('Patrol zone');
  });
  it('matches nothing for unrelated text', () => {
    expect(ids('qqqq')).toEqual([]);
  });
});

describe('groupByZone', () => {
  it('groups by patrol zone (natural order, no zone last), then by road segment name', () => {
    const groups = groupByZone(lists);
    expect(groups.map((g) => g.zone)).toEqual(['1', '2', '10', NO_ZONE]);
    const zone1 = groups[0]!;
    expect(zone1.streets.map((s) => s.street)).toEqual(['Coventry Street', 'York Street']);
    // Segments of one road are ordered by their first cross street.
    expect(zone1.streets[1]!.lists.map((l) => l.id)).toEqual(['york-west', 'york']);
  });
  it('lists the zones for the filter and labels them', () => {
    expect(patrolZones(lists)).toEqual(['1', '2', '10']);
    expect(zoneLabel('1')).toBe('Patrol zone 1');
    expect(zoneLabel('North')).toBe('North');
    expect(zoneLabel(NO_ZONE)).toBe('No patrol zone');
  });
});
