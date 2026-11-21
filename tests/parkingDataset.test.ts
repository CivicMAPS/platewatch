import { readFileSync, writeFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { planImport, parseImportFile } from '../src/lib/importer';
import {
  convertAreaDataset,
  councilCode,
  dataQuality,
  datasetToDrafts,
  listsToDataset,
  makeBay,
  makeDataset,
  makePart,
  makeRestriction,
  makeSegment,
  permitAreaIdFor,
  segmentIdFor,
  validateDataset,
  zoneIdFor,
  type ParkingDataset,
} from '../src/lib/parkingDataset';
import type { TimedList } from '../src/lib/types';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path: string) => JSON.parse(read(path));
const schema = readJson('schemas/civicmaps-parking-dataset.v1.schema.json');
const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaErrors = (d: unknown) => (ajv.validate(schema, d) ? [] : (ajv.errors ?? []).map((e) => `${e.instancePath} ${e.message}`));
const toLists = (d: ParkingDataset): TimedList[] => datasetToDrafts(d).drafts.map((x, i) => ({ ...x.list, id: `l${i}`, createdAt: 0, updatedAt: 0 }));
/** Compare/write a generated file in datasets/ (regenerate with UPDATE_DATASETS=1). */
const matchesFile = (path: string, d: unknown) => {
  const url = new URL(`../${path}`, import.meta.url);
  const text = JSON.stringify(d, null, 2) + '\n';
  if (process.env.UPDATE_DATASETS) writeFileSync(url, text);
  expect(readFileSync(url, 'utf8')).toBe(text);
};

/** Every key path of a value, so two records can be compared for identical structure. */
function keyPaths(v: unknown, prefix = ''): string[] {
  if (Array.isArray(v)) return v.length ? keyPaths(v[0], `${prefix}[]`) : [`${prefix}[]`];
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [`${prefix}.${k}`, ...(k === 'external_ids' ? [] : keyPaths(x, `${prefix}.${k}`))]);
  return [];
}

/* The two-council example, built with the same constructors the importer and exporter use. */
function buildExample(): ParkingDataset {
  const kerbside = readJson('tests/fixtures/civicmaps-preview/kerbside-chinatown-20055.json');
  const south = kerbside.sides.find((s: { street_side: string }) => s.street_side === 'southern');
  const bayPart = south.sub_segments.find((s: { from: string }) => s.from === 'Bay 58');
  const d = makeDataset({
    id: 'example-com-copp',
    title: 'Example: City of Melbourne (numbered bays, parking area, EasyPark) and City of Port Phillip (PayStay, permit area)',
    municipality: 'Example (two councils)',
    code: 'example',
    generatedAt: '2026-11-21T00:00:00Z',
    sources: [
      {
        id: 'civicmaps-kerbside-v1',
        name: 'CivicMAPS kerbside parking assets v1 (CHINATOWN, road segment 20055)',
        publisher: 'CivicMAPS',
        url: null,
        format: 'JSON',
        reference_date: null,
        data_used: ['parking area', 'EasyPark area', 'bay numbers and positions', 'parking rules'],
        limitations: ['bay positions inferred from coordinate sequence'],
      },
    ],
    notes: [
      'One file holds two councils only to show that their records are identical in structure; a real dataset covers one council.',
      'City of Port Phillip segment 31065 and its restrictions are illustrative, not a real asset ID or surveyed signs.',
    ],
  });
  d.conventions = {
    bay_sign_format: '{parking_area}{bay}',
    paystay_zone_pattern: '^3388\\d+$',
    easypark_area_pattern: null,
    notes: ['City of Melbourne kerb plates: parking area followed by bay number (645 + 58 = 64558).', 'City of Port Phillip PayStay zones: 3388, the assigned segment number, then four digits for the side.'],
  };
  d.patrol_zones = [
    { id: zoneIdFor('com', null, 'Chinatown'), number: null, name: 'Chinatown', kind: 'patrol_area', geometry: null },
    { id: zoneIdFor('copp', '9', null), number: '9', name: 'South Melbourne Market', kind: 'patrol_area', geometry: null },
  ];
  d.permit_areas = [
    { id: permitAreaIdFor('com', '7'), code: '7', name: null },
    { id: permitAreaIdFor('copp', '7'), code: '7', name: null },
  ];
  const all = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
  const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
  d.segments = [
    makeSegment('com', {
      road_segment_id: '20055',
      patrol_zone: 'com-chinatown',
      road: { name: 'Little Bourke Street', locality: 'Melbourne' },
      between: { from: 'Swanston Street', to: 'Elizabeth Street' },
      data_quality: dataQuality('unverified', { source: 'CivicMAPS kerbside parking assets v1' }),
      sides: [
        {
          side: 'north',
          parts: [makePart({ restrictions: [makeRestriction({ control: 'no_stopping', days: [...all], all_day: true })], notes: 'No stopping end to end.' })],
        },
        {
          side: 'south',
          parts: [
            makePart({ from: { kind: 'intersection', label: 'Swanston Street', location: null }, to: { kind: 'bay', label: 'Bay 58', location: null }, payment: { parking_area: '645', easypark_areas: [], paystay_zones: [], meters: [] }, restrictions_status: 'no_parking_spaces' }),
            makePart({
              from: { kind: 'bay', label: 'Bay 58', location: null },
              to: { kind: 'bay', label: 'Bay 72', location: null },
              payment: { parking_area: '645', easypark_areas: ['7514'], paystay_zones: [], meters: [] },
              restrictions: [
                makeRestriction({ control: 'loading_zone', sign_code: 'LZ 30', limit_minutes: 30, days: [...weekdays], start: '07:00', end: '16:00', exceptions: ['Commercial vehicles only'] }),
                makeRestriction({ control: 'metered', sign_code: '2P', limit_minutes: 120, days: ['sat', 'sun'], start: '07:00', end: '22:00' }),
              ],
              bays: bayPart.bays.map((b: { bay: number; location: { latitude: number; longitude: number } }) =>
                makeBay({ number: b.bay, kind: 'standard', location: { lat: Number(b.location.latitude.toFixed(7)), lng: Number(b.location.longitude.toFixed(7)) }, data_quality: dataQuality('inferred', { source: 'CivicMAPS kerbside parking assets v1', confidence: 'medium' }) }),
              ),
            }),
            makePart({ from: { kind: 'bay', label: 'Bay 72', location: null }, to: { kind: 'intersection', label: 'Elizabeth Street', location: null }, payment: { parking_area: '645', easypark_areas: [], paystay_zones: [], meters: [] } }),
          ],
        },
      ],
    }),
    makeSegment('copp', {
      road_segment_id: '31065',
      patrol_zone: 'copp-9',
      road: { name: 'coventry street', locality: 'south melbourne' },
      between: { from: 'montague street', to: 'ferrars street' },
      data_quality: dataQuality('unverified', { notes: 'Illustrative segment.' }),
      sides: [
        {
          side: 'north',
          parts: [
            makePart({
              permit_area: 'copp-rpa-7',
              payment: { parking_area: null, easypark_areas: [], paystay_zones: [{ zone: '338831065001', meter_id: null }], meters: [] },
              restrictions: [makeRestriction({ control: 'ticket', sign_code: '2P', limit_minutes: 120, days: [...weekdays], start: '08:00', end: '18:00', exceptions: ['Permit Zone 7 excepted'], exempt_permit_areas: ['copp-rpa-7'], grace_minutes: 5 })],
            }),
          ],
        },
        {
          side: 'south',
          parts: [
            makePart({
              payment: { parking_area: null, easypark_areas: [], paystay_zones: [{ zone: '338831065002', meter_id: null }], meters: [] },
              restrictions: [
                makeRestriction({ control: 'time_limit', sign_code: '1P', limit_minutes: 60, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '08:00', end: '18:00' }),
                makeRestriction({ control: 'no_stopping', days: [...weekdays], start: '07:00', end: '09:00' }),
              ],
            }),
          ],
        },
      ],
    }),
  ];
  return d;
}

const example = buildExample();

describe('identifiers: one rule for every council', () => {
  it('council code, segment, patrol zone and permit area', () => {
    expect(councilCode('City of Melbourne')).toBe('com');
    expect(councilCode('City of Port Phillip')).toBe('copp');
    expect(councilCode('Shire of Example Valley')).toBe('soev');
    expect(segmentIdFor('com', '20055', 'Little Bourke Street', 'Swanston Street', 'Elizabeth Street')).toBe('com-20055');
    expect(segmentIdFor('copp', '31065', 'Coventry Street', 'Montague Street', 'Ferrars Street')).toBe('copp-31065');
    // Asset ID not yet acquired: provisional, from the names.
    expect(segmentIdFor('copp', null, 'Normanby Road', 'Boundary Street', 'Montague Street')).toBe('copp-normanby-rd-boundary-st-montague-st');
    expect(zoneIdFor('copp', '10', null)).toBe('copp-10');
    expect(zoneIdFor('com', null, 'Flagstaff')).toBe('com-flagstaff');
    // The same permit number in two councils stays distinct.
    expect(permitAreaIdFor('com', '7')).toBe('com-rpa-7');
    expect(permitAreaIdFor('copp', '7')).toBe('copp-rpa-7');
  });

  it('council data is adapted to the structure: names get consistent capitals', () => {
    const s = example.segments[1]!;
    expect(s).toMatchObject({ id: 'copp-31065', road_segment_id: '31065', road: { name: 'Coventry Street', locality: 'South Melbourne' }, between: { from: 'Montague Street', to: 'Ferrars Street' } });
  });
});

describe('fixed structure', () => {
  it('a City of Melbourne and a City of Port Phillip segment have exactly the same keys', () => {
    const [com, copp] = example.segments;
    expect(keyPaths({ ...copp, sides: [] })).toEqual(keyPaths({ ...com, sides: [] }));
    const comPart = com!.sides[1]!.parts[1]!;
    const coppPart = copp!.sides[0]!.parts[0]!;
    expect(Object.keys(coppPart)).toEqual(Object.keys(comPart));
    expect(Object.keys(coppPart.payment)).toEqual(Object.keys(comPart.payment));
    expect(Object.keys(coppPart.restrictions[0]!)).toEqual(Object.keys(comPart.restrictions[0]!));
    // Unknown values are present as null or [], not left out.
    expect(coppPart).toMatchObject({ from: null, to: null, bays: [], payment: { parking_area: null, easypark_areas: [], meters: [] } });
    expect(com!.sides[1]!.parts[1]!.permit_area).toBeNull();
  });

  it('the example passes the JSON Schema and the in-app validator', () => {
    expect(schemaErrors(example)).toEqual([]);
    expect(validateDataset(example)).toEqual([]);
    matchesFile('datasets/examples/example-com-copp.parking.json', example);
  });

  it('rejects a record with a key left out, an extra key, or a broken rule (schema and app agree)', () => {
    const bad = structuredClone(example) as unknown as { segments: Record<string, unknown>[] };
    delete bad.segments[1]!.road_segment_id; // left out instead of null
    (bad.segments[1]!.road as Record<string, unknown>).council_street_code = 'X1'; // council-specific key
    const part = ((bad.segments[0]!.sides as { parts: Record<string, unknown>[] }[])[1]!.parts[1]!) as { restrictions: Record<string, unknown>[] };
    part.restrictions[1]!.limit_minutes = null; // a metered sign needs its allowance
    expect(schemaErrors(bad).length).toBeGreaterThan(0);
    expect(validateDataset(bad).map((e) => `${e.path}: ${e.message}`)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^segments\[1\]: is missing road_segment_id/),
        expect.stringMatching(/^segments\[1\]\.road: has keys outside the schema: council_street_code/),
        expect.stringMatching(/^segments\[0\]\.sides\[1\]\.parts\[1\]\.restrictions\[1\]\.limit_minutes: is required for metered/),
      ]),
    );
  });
});

describe('Area 10 (council area dataset) → civicmaps.parking_dataset', () => {
  const source = readJson('tests/fixtures/copp-area-10-source.json');
  const { dataset, warnings } = convertAreaDataset(source);

  it('adapts all 55 segments to the fixed structure and the identifier rule', () => {
    expect(warnings).toEqual([]);
    expect(dataset.dataset).toMatchObject({ id: 'copp-patrol-area-10', status: 'draft', municipality: { name: 'City of Port Phillip', code: 'copp', state: 'VIC', country: 'AU', timezone: 'Australia/Melbourne' } });
    expect(dataset.conventions.paystay_zone_pattern).toBe('^3388\\d+$');
    expect(dataset.dataset.sources.map((s) => s.name)).toContain('City of Port Phillip Parking Machines');
    expect(dataset.patrol_zones).toEqual([{ id: 'copp-10', number: '10', name: null, kind: 'patrol_area', geometry: null }]);
    expect(dataset.segments).toHaveLength(55);
    expect(dataset.segments[0]).toEqual({
      id: 'copp-normanby-rd-boundary-st-montague-st',
      road_segment_id: null,
      patrol_zone: 'copp-10',
      road: { name: 'Normanby Road', locality: null, external_ids: { source_segment_id: 'normanby-rd-boundary-st-montague-st' } },
      between: { from: 'Boundary Street', to: 'Montague Street' },
      geometry: null,
      sides: [{ side: 'both', parts: [makePart()] }],
      data_quality: dataQuality('pending_field_capture', { source: 'user_supplied_area_10_pdf', notes: 'interpreted_from visible map intersections; requires GIS validation; not shown and not inferred from map symbology' }),
      notes: null,
    });
    // Same keys as the City of Melbourne segment.
    expect(keyPaths({ ...dataset.segments[0], sides: [] })).toEqual(keyPaths({ ...example.segments[0], sides: [] }));
    expect(schemaErrors(dataset)).toEqual([]);
    expect(validateDataset(dataset)).toEqual([]);
    matchesFile('datasets/copp-patrol-area-10.parking.json', dataset);
  });

  it('uses the road segment asset ID for the identifier once the council supplies it', () => {
    const withIds = structuredClone(source);
    withIds.street_segments[0].road_segment_asset_id = '31001';
    withIds.street_segments[1].road_segment_id = 31002;
    withIds.street_segments[2].asset_id = '31003';
    const segs = convertAreaDataset(withIds).dataset.segments;
    expect(segs.slice(0, 4).map((s) => [s.id, s.road_segment_id])).toEqual([
      ['copp-31001', '31001'],
      ['copp-31002', '31002'],
      ['copp-31003', '31003'],
      ['copp-woodgate-st-boundary-st-kings-way', null],
    ]);
  });

  it('maps restrictions once they are supplied', () => {
    const withSigns = structuredClone(source);
    withSigns.street_segments[0].parking_restrictions = [
      { applicable_days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], applicable_times: { start: '08:00', end: '18:00' }, restriction_applied: '2P', permit_or_vehicle_exceptions: ['Permit Zone 7 excepted'], source_sign_or_asset_id: 'S-1001', verification_status: 'verified' },
      { applicable_days: [], applicable_times: { start: null, end: null }, restriction_applied: 'No Stopping', verification_status: 'verified' },
    ];
    const part = convertAreaDataset(withSigns).dataset.segments[0]!.sides[0]!.parts[0]!;
    expect(part.restrictions_status).toBe('supplied');
    expect(part.restrictions[0]).toMatchObject({ control: 'time_limit', sign_code: '2P', limit_minutes: 120, days: ['mon', 'tue', 'wed', 'thu', 'fri'], all_day: false, start: '08:00', end: '18:00', exceptions: ['Permit Zone 7 excepted'], source_sign_id: 'S-1001', data_quality: { status: 'verified' } });
    expect(part.restrictions[1]).toMatchObject({ control: 'no_stopping', all_day: true, start: null, end: null });
  });

  it('a list imported before the asset ID was known is updated, not duplicated, when it arrives', () => {
    const before = planImport(parseImportFile(JSON.stringify(dataset), 'a.json').drafts, [], { updateExisting: true }).created;
    const withId = structuredClone(source);
    withId.street_segments[0].road_segment_asset_id = '31001';
    const after = planImport(parseImportFile(JSON.stringify(convertAreaDataset(withId).dataset), 'b.json').drafts, before, { updateExisting: true });
    expect(after.created).toEqual([]);
    const normanby = after.updated.find((l) => l.type === 'timed' && l.segment.street === 'Normanby Road' && l.segment.toStreet === 'Montague Street') as TimedList;
    expect(normanby).toMatchObject({ roadSegmentId: '31001', externalId: 'copp-patrol-area-10/copp-31001/both/all' });
  });
});

describe('dataset → PlateWatch timed lists', () => {
  const { drafts, skipped } = datasetToDrafts(example);
  const byId = (suffix: string) => drafts.find((d) => d.list.externalId?.endsWith(suffix))!.list;

  it('one list per part, with payment, bays, bay positions and the external ID', () => {
    const bays = byId('com-20055/south/bay-58-bay-72');
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

  it('permit area shows as its code; untimed signs are structured; PayStay and grace carried', () => {
    const north = byId('copp-31065/north/all');
    expect(north).toMatchObject({ patrolZone: '9', patrolZoneName: 'South Melbourne Market', rpa: '7', roadSegmentId: '31065', payment: { payStay: [{ zone: '338831065001', meter: '' }] } });
    expect(north.restrictions[0]).toMatchObject({ code: '2P', graceMinutes: 5, description: 'Ticket · Permit Zone 7 excepted' });
    expect(byId('copp-31065/south/all').untimedControls).toEqual([{ control: 'no_stopping', label: 'No stopping', days: [1, 2, 3, 4, 5], allDay: false, startTime: '07:00', endTime: '09:00', description: '' }]);
  });

  it('skips stretches with no parking spaces or nothing to time; pending parts are placeholders', () => {
    expect(skipped.join('\n')).toMatch(/swanston-street-bay-58\): no parking spaces/);
    expect(skipped.join('\n')).toMatch(/north side: no timed parking \(No stopping\)/);
    expect(drafts.find((d) => d.list.externalId?.endsWith('bay-72-elizabeth-street'))!.pending).toBe(true);
  });
});

describe('PlateWatch timed lists → dataset (export)', () => {
  it('round-trips the example in the fixed structure, permit areas per council', () => {
    const exported = listsToDataset(toLists(example).filter((l) => l.externalId?.includes('copp-')), { title: 'Export', municipality: 'City of Port Phillip', timezone: 'Australia/Melbourne', generatedAt: '2026-11-21T00:00:00Z' });
    expect(schemaErrors(exported)).toEqual([]);
    expect(validateDataset(exported)).toEqual([]);
    expect(exported.dataset).toMatchObject({ id: 'copp-platewatch-export-2026-11-21', municipality: { code: 'copp' } });
    expect(exported.permit_areas).toEqual([{ id: 'copp-rpa-7', code: '7', name: null }]);
    expect(exported.patrol_zones[0]).toMatchObject({ id: 'copp-9', number: '9', name: 'South Melbourne Market' });
    const seg = exported.segments[0]!;
    expect(seg.id).toBe('copp-31065');
    expect(keyPaths({ ...seg, sides: [] })).toEqual(keyPaths({ ...example.segments[1], sides: [] }));
    const north = seg.sides.find((s) => s.side === 'north')!.parts[0]!;
    expect(north).toMatchObject({ id: 'all', permit_area: 'copp-rpa-7', payment: { paystay_zones: [{ zone: '338831065001', meter_id: null }] } });
    expect(north.restrictions[0]).toMatchObject({ control: 'ticket', sign_code: '2P', limit_minutes: 120, grace_minutes: 5, exceptions: ['Permit Zone 7 excepted'] });
  });

  it('exports lists entered in the app with identifiers by the rule', () => {
    const base = { type: 'timed' as const, notes: '', allowListIds: [], createdAt: 0, updatedAt: 0 };
    const r1P = { id: 'r', code: '1P', limitMinutes: 60, graceMinutes: 0, days: [1, 2, 3, 4, 5] as (0 | 1 | 2 | 3 | 4 | 5 | 6)[], startTime: '08:00', endTime: '18:00', allDay: false, description: '' };
    const lists: TimedList[] = [
      { ...base, id: 'a', name: 'a', segment: { street: 'York Street', fromStreet: 'Cecil Street', toStreet: 'Clarendon Street', side: 'north', suburb: 'South Melbourne' }, restrictions: [], patrolZone: '9', rpa: '7' },
      { ...base, id: 'b', name: 'b', segment: { street: 'York Street', fromStreet: 'Clarendon Street', toStreet: 'Cecil Street', side: 'south', suburb: 'South Melbourne' }, restrictions: [r1P] },
      { ...base, id: 'c', name: 'c', segment: { street: 'Coventry Street', fromStreet: 'Montague Street', toStreet: 'Ferrars Street', side: 'both', suburb: '' }, restrictions: [r1P], roadSegmentId: '31065' },
    ];
    const d = listsToDataset(lists, { title: 'Field entries', municipality: 'City of Port Phillip', timezone: 'Australia/Melbourne', generatedAt: '2026-11-21T00:00:00Z' });
    expect(schemaErrors(d)).toEqual([]);
    expect(d.segments.map((s) => s.id)).toEqual(['copp-york-st-cecil-st-clarendon-st', 'copp-31065']);
    expect(d.segments[0]!.sides.map((s) => [s.side, s.parts[0]!.restrictions_status, s.parts[0]!.permit_area])).toEqual([
      ['north', 'pending_field_capture', 'copp-rpa-7'],
      ['south', 'supplied', null],
    ]);
  });
});
