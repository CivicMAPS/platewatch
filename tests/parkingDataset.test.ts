import { readFileSync, writeFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { convertAreaDataset, datasetToDrafts, listsToDataset, resolvedSegments, validateDataset, type ParkingDataset } from '../src/lib/parkingDataset';
import type { TimedList } from '../src/lib/types';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const schema = read('schemas/civicmaps-parking-dataset.v1.schema.json');
const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaErrors = (d: unknown) => (ajv.validate(schema, d) ? [] : (ajv.errors ?? []).map((e) => `${e.instancePath} ${e.message}`));

const example = read('datasets/examples/example-two-councils.parking.json') as ParkingDataset;
const toLists = (d: ParkingDataset): TimedList[] => datasetToDrafts(d).drafts.map((x, i) => ({ ...x.list, id: `l${i}`, createdAt: 0, updatedAt: 0 }));

describe('civicmaps.parking_dataset schema', () => {
  it('accepts the example dataset (JSON Schema and in-app validation agree)', () => {
    expect(schemaErrors(example)).toEqual([]);
    expect(validateDataset(example)).toEqual([]);
  });

  it('rejects the mistakes that would break timing or matching', () => {
    const bad = structuredClone(example);
    const south = bad.segments[0]!.sides[1]!;
    delete south.parts[0]!.id; // several parts on a side need ids
    bad.segments[1]!.sides[1]!.parts[0]!.restrictions[0]!.limit_minutes = null; // a time limit needs its allowance
    bad.segments[1]!.id = 'com-20055'; // ids must be unique
    expect(schemaErrors(bad).length).toBeGreaterThan(0);
    const paths = validateDataset(bad).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['segments[0].sides[1].parts[0].id', 'segments[1].id', 'segments[1].sides[1].parts[0].restrictions[0].limit_minutes']));
  });
});

describe('Area 10 (street_segments + record_defaults) → civicmaps.parking_dataset', () => {
  const source = read('tests/fixtures/copp-area-10-source.json');
  const { dataset, warnings } = convertAreaDataset(source);

  it('keeps all 55 segments, zone 10, sources and the null policy (pending, nothing guessed)', () => {
    expect(warnings).toEqual([]);
    expect(dataset.dataset).toMatchObject({ id: 'city-of-port-phillip-patrol-area-10', status: 'draft', municipality: { name: 'City of Port Phillip', timezone: 'Australia/Melbourne' } });
    expect(dataset.dataset.sources?.map((s) => s.name)).toContain('City of Port Phillip Parking Machines');
    expect(dataset.patrol_zones).toEqual([{ id: '10', number: '10', name: null, kind: 'patrol_area' }]);
    expect(dataset.segments).toHaveLength(55);
    // Shared values sit in defaults, as record_defaults did; each segment keeps its id, road and between.
    expect(Object.keys(dataset.defaults!).sort()).toEqual(['data_quality', 'geometry', 'patrol_zone', 'sides']);
    expect(Object.keys(dataset.segments[0]!).sort()).toEqual(['between', 'id', 'road']);
    expect(resolvedSegments(dataset)[0]).toMatchObject({
      id: 'normanby-rd-boundary-st-montague-st',
      patrol_zone: '10',
      road: { name: 'Normanby Road' },
      between: { from: 'Boundary Street', to: 'Montague Street' },
      sides: [{ side: 'both', parts: [{ restrictions_status: 'pending_field_capture', restrictions: [] }] }],
      data_quality: { status: 'pending_field_capture' },
    });
    expect(schemaErrors(dataset)).toEqual([]);
    expect(validateDataset(dataset)).toEqual([]);
  });

  it('matches the converted file in datasets/ (regenerate with UPDATE_DATASETS=1)', () => {
    const url = new URL('../datasets/copp-patrol-area-10.parking.json', import.meta.url);
    const text = JSON.stringify(dataset, null, 2) + '\n';
    if (process.env.UPDATE_DATASETS) writeFileSync(url, text);
    expect(readFileSync(url, 'utf8')).toBe(text);
  });

  it('imports as 55 placeholder timed lists in patrol zone 10', () => {
    const { drafts } = datasetToDrafts(dataset);
    expect(drafts).toHaveLength(55);
    expect(drafts.every((d) => d.pending)).toBe(true);
    expect(drafts[0]!.list).toMatchObject({ patrolZone: '10', segment: { street: 'Normanby Road', side: 'both' }, externalId: 'city-of-port-phillip-patrol-area-10/normanby-rd-boundary-st-montague-st/both' });
  });

  it('maps restrictions once they are supplied', () => {
    const withSigns = structuredClone(source);
    withSigns.street_segments[0].parking_restrictions = [
      { applicable_days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], applicable_times: { start: '08:00', end: '18:00' }, restriction_applied: '2P', permit_or_vehicle_exceptions: ['Permit Zone 7 excepted'], source_sign_or_asset_id: 'S-1001', verification_status: 'verified' },
      { applicable_days: [], applicable_times: { start: null, end: null }, restriction_applied: 'No Stopping', verification_status: 'verified' },
    ];
    const seg = resolvedSegments(convertAreaDataset(withSigns).dataset)[0]!;
    expect(seg.sides[0]!.parts[0]).toMatchObject({
      restrictions_status: 'supplied',
      restrictions: [
        { control: 'time_limit', sign_code: '2P', limit_minutes: 120, days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '18:00', exceptions: ['Permit Zone 7 excepted'], source_sign_id: 'S-1001', data_quality: { status: 'verified' } },
        { control: 'no_stopping', all_day: true, days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
      ],
    });
  });
});

describe('dataset → PlateWatch timed lists', () => {
  const { drafts, skipped } = datasetToDrafts(example);
  const byId = (suffix: string) => drafts.find((d) => d.list.externalId?.endsWith(suffix))!.list;

  it('makes one list per part, with payment, bays, bay positions and the external ID', () => {
    const bays = byId('com-20055/south/bay-58-72');
    expect(bays).toMatchObject({
      patrolZoneName: 'Chinatown',
      roadSegmentId: '20055',
      segment: { street: 'Little Bourke Street', side: 'south', subFrom: 'Bay 58', subTo: 'Bay 72', suburb: 'Melbourne' },
      payment: { parkingArea: '645', easyPark: ['7514'], payStay: [] },
    });
    expect(bays.bays).toContain(58);
    expect(bays.bayPoints![0]).toMatchObject({ bay: 58, lat: expect.any(Number), lng: expect.any(Number) });
    expect(bays.restrictions.map((r) => [r.code, r.limitMinutes, r.description])).toEqual([
      ['LZ 30', 30, 'Commercial vehicles only'],
      ['2P', 120, 'Meter'],
    ]);
  });

  it('keeps untimed signs as structured controls, and PayStay, permit area and grace', () => {
    const south = byId('copp-coventry-st-cecil-st-market-st/south');
    expect(south.untimedControls).toEqual([{ control: 'no_stopping', label: 'No stopping', days: [1, 2, 3, 4, 5], allDay: false, startTime: '07:00', endTime: '09:00', description: '' }]);
    const north = byId('copp-coventry-st-cecil-st-market-st/north');
    expect(north).toMatchObject({ patrolZone: '9', patrolZoneName: 'South Melbourne Market', rpa: '7', payment: { payStay: [{ zone: '338851200001', meter: '' }] } });
    expect(north.restrictions[0]).toMatchObject({ code: '2P', graceMinutes: 5, description: 'Ticket · Permit Zone 7 excepted' });
  });

  it('skips stretches with no parking spaces or nothing to time, imports pending parts as placeholders', () => {
    expect(skipped.join('\n')).toMatch(/swanston-bay-58\): no parking spaces/);
    expect(skipped.join('\n')).toMatch(/north side: no timed parking \(No stopping\)/);
    expect(drafts.find((d) => d.list.externalId?.endsWith('bay-72-elizabeth'))!.pending).toBe(true);
  });
});

describe('PlateWatch timed lists → dataset (export)', () => {
  it('round-trips the example: valid dataset, same ids, payment, bays and restrictions', () => {
    const exported = listsToDataset(toLists(example), { id: 'example-two-councils', title: 'Export', municipality: 'Example', timezone: 'Australia/Melbourne', generatedAt: '2026-11-21T00:00:00Z' });
    expect(schemaErrors(exported)).toEqual([]);
    expect(validateDataset(exported)).toEqual([]);
    const part = exported.segments.find((s) => s.id === 'com-20055')!.sides.find((s) => s.side === 'south')!.parts.find((p) => p.id === 'bay-58-72')!;
    expect(part).toMatchObject({ from: { kind: 'bay', label: 'Bay 58' }, payment: { parking_area: '645', easypark_areas: ['7514'] }, restrictions_status: 'supplied' });
    expect(part.restrictions.map((r) => [r.control, r.sign_code, r.limit_minutes])).toEqual([
      ['loading_zone', 'LZ 30', 30],
      ['metered', '2P', 120],
    ]);
    expect(part.bays![0]).toMatchObject({ number: 58, location: { lat: expect.any(Number) } });
    // Imported again, the export gives the same lists.
    const again = toLists(exported).map((l) => [l.externalId, l.restrictions.length, l.bays?.length ?? 0, l.payment?.parkingArea ?? '']);
    expect(again).toEqual(toLists(example).map((l) => [l.externalId, l.restrictions.length, l.bays?.length ?? 0, l.payment?.parkingArea ?? '']));
  });

  it('exports lists entered in the app (no dataset IDs) as valid segments grouped by road segment', () => {
    const base = { type: 'timed' as const, notes: '', allowListIds: [], createdAt: 0, updatedAt: 0 };
    const lists: TimedList[] = [
      { ...base, id: 'a', name: 'a', segment: { street: 'York Street', fromStreet: 'Cecil Street', toStreet: 'Clarendon Street', side: 'north', suburb: 'South Melbourne' }, restrictions: [], patrolZone: '9' },
      { ...base, id: 'b', name: 'b', segment: { street: 'York Street', fromStreet: 'Clarendon Street', toStreet: 'Cecil Street', side: 'south', suburb: 'South Melbourne' }, restrictions: [{ id: 'r', code: '1P', limitMinutes: 60, graceMinutes: 0, days: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '18:00', allDay: false, description: '' }] },
    ];
    const d = listsToDataset(lists, { id: 'field-entries', title: 'Field entries', municipality: 'City of Port Phillip', timezone: 'Australia/Melbourne', generatedAt: '2026-11-21T00:00:00Z' });
    expect(schemaErrors(d)).toEqual([]);
    expect(d.segments).toHaveLength(1);
    expect(d.segments[0]!.sides.map((s) => [s.side, s.parts[0]!.restrictions_status])).toEqual([
      ['north', 'pending_field_capture'],
      ['south', 'supplied'],
    ]);
  });
});
