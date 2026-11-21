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
  // City of Melbourne: zone number with an operational name, one parking area number per segment.
  seg('lonsdale', 'Lonsdale Street', 'William Street', 'Queen Street', { patrolZone: '14', patrolZoneName: 'Flagstaff', payment: { parkingArea: '637', easyPark: [], payStay: [] } }),
  seg('latrobe', 'La Trobe Street', 'King Street', 'William Street', { patrolZone: '14', patrolZoneName: 'Flagstaff', payment: { parkingArea: '63', easyPark: [], payStay: [] } }),
  // City of Port Phillip: PayStay numbers are 3388 + assigned segment number + four digits for the side.
  seg('market', 'Coventry Street', 'Cecil Street', 'Market Street', { patrolZone: '9', patrolZoneName: 'South Melbourne Market', payment: { easyPark: [], payStay: [{ zone: '338851200001', meter: '' }, { zone: '338851200002', meter: '' }] } }),
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
  it('finds a patrol zone by its operational name', () => {
    expect(ids('flagstaff')).toEqual(expect.arrayContaining(['lonsdale', 'latrobe']));
    expect(ids('flagstaff')).toHaveLength(2);
    expect(ids('south melbourne market')).toEqual(['market']);
  });
  it('finds a segment by parking area number', () => {
    expect(ids('area 637')).toEqual(['lonsdale']);
  });
  it('finds the segment from a bay sign number: parking area + bay (63758 → area 637, bay 58)', () => {
    const [best, next] = searchTimedLists(lists, '63758');
    expect(best?.list.id).toBe('lonsdale');
    expect(best?.matches[0]).toEqual({ label: 'Bay sign', value: '63758 = area 637 · bay 58' });
    // A shorter area that also prefixes the sign ranks below the longer one.
    expect(next?.list.id).toBe('latrobe');
    expect(ids('bay 63758')[0]).toBe('lonsdale');
  });
  it('finds a Port Phillip PayStay zone by its assigned segment number or the full number', () => {
    expect(ids('5120')).toEqual(['market']);
    expect(ids('338851200002')).toEqual(['market']);
    expect(searchTimedLists(lists, '338851200002')[0]?.matches[0]).toEqual({ label: 'PayStay zone', value: '338851200002' });
  });
  it('treats field words that are part of an address as ordinary words (Bay Street + suburb)', () => {
    expect(ids('bay street south melbourne')[0]).toBe('loose');
    expect(ids('york street cecil')[0]).toBe('york');
    // A leading field word still narrows the search.
    expect(ids('rpa 12')).toEqual(['york']);
  });
  it('finds a segment by its council road segment ID', () => {
    const withId = [...lists, seg('lb-south', 'Little Bourke Street', 'Swanston Street', 'Elizabeth Street', { roadSegmentId: '20055' })];
    expect(searchTimedLists(withId, '20055').map((r) => r.list.id)).toEqual(['lb-south']);
    expect(searchTimedLists(withId, '20055')[0]?.matches[0]?.label).toBe('Segment ID');
  });
  it('uses bay numbers to pick the sub-segment a bay sign belongs to', () => {
    const subs = [
      seg('bays-58-72', 'Little Bourke Street', 'Swanston Street', 'Elizabeth Street', { payment: { parkingArea: '645', easyPark: [], payStay: [] }, bays: [58, 59, 72] }),
      seg('bays-80-90', 'Little Bourke Street', 'Swanston Street', 'Elizabeth Street', { payment: { parkingArea: '645', easyPark: [], payStay: [] }, bays: [80, 90] }),
      seg('no-bays', 'Little Bourke Street', 'Swanston Street', 'Elizabeth Street', { payment: { parkingArea: '645', easyPark: [], payStay: [] } }),
    ];
    const ids = searchTimedLists(subs, '64558').map((r) => r.list.id);
    // Bay 58 is listed for the first; the second lists its bays without 58; the third does not list bays.
    expect(ids).toEqual(['bays-58-72', 'no-bays']);
  });
  it('finds a bay by its own plate number when it does not follow area + bay', () => {
    const odd = seg('odd-plates', 'Bay Street', 'Graham Street', 'Ross Street', { bays: [3], bayPoints: [{ bay: 3, lat: -37.84, lng: 144.94, sign: 'PM-0003' }] });
    expect(searchTimedLists([...lists, odd], 'PM-0003').map((r) => r.list.id)).toEqual(['odd-plates']);
  });
  it('matches sub-segment bounds such as an address', () => {
    const part = seg('part', 'Little Bourke Street', 'Swanston Street', 'Russell Street');
    part.segment = { ...part.segment, subFrom: 'Russell Street', subTo: '234 Little Bourke Street' };
    expect(searchTimedLists([...lists, part], '234').map((r) => r.list.id)).toEqual(['part']);
  });
  it('matches nothing for unrelated text', () => {
    expect(ids('qqqq')).toEqual([]);
  });
});

describe('groupByZone', () => {
  it('groups by patrol zone (natural order, no zone last), then by road segment name', () => {
    const groups = groupByZone(lists);
    expect(groups.map((g) => g.zone)).toEqual(['1', '2', '9', '10', '14', NO_ZONE]);
    expect(groups.find((g) => g.zone === '14')?.name).toBe('Flagstaff');
    const zone1 = groups[0]!;
    expect(zone1.streets.map((s) => s.street)).toEqual(['Coventry Street', 'York Street']);
    // Segments of one road are ordered by their first cross street.
    expect(zone1.streets[1]!.lists.map((l) => l.id)).toEqual(['york-west', 'york']);
  });
  it('lists the zones for the filter and labels them', () => {
    expect(patrolZones(lists)).toEqual(['1', '2', '9', '10', '14']);
    expect(zoneLabel('1')).toBe('Patrol zone 1');
    expect(zoneLabel('14', 'Flagstaff')).toBe('Patrol zone 14 · Flagstaff');
    expect(zoneLabel('North')).toBe('North');
    expect(zoneLabel(NO_ZONE)).toBe('No patrol zone');
  });
});
