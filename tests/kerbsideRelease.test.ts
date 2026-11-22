import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parseImportFile, planImport } from '../src/lib/importer';
import {
  assetName,
  emptyRelease,
  ids,
  relinkRelease,
  ReleaseBuilder,
  releaseToCsv,
  splitByZone,
  TABLE_NAMES,
  TABLES,
  validateRelease,
  type KerbsideRelease,
} from '../src/lib/kerbsideRelease';
import { areaDatasetToRelease, councilCode, listsToRelease, releaseToDrafts } from '../src/lib/releaseAdapters';
import type { TimedList } from '../src/lib/types';
import { zipStore } from '../src/lib/zip';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const schema = readJson('schemas/civicmaps-kerbside-release.v1.schema.json');
const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaErrors = (d: unknown) => (ajv.validate(schema, d) ? [] : (ajv.errors ?? []).map((e) => `${e.instancePath} ${e.message}`));
const valid = (r: unknown) => {
  expect(schemaErrors(r)).toEqual([]);
  expect(validateRelease(r)).toEqual([]);
};
/** Compare/write a generated file (regenerate with UPDATE_DATASETS=1). */
const matchesFile = (path: string, text: string) => {
  const url = new URL(`../${path}`, import.meta.url);
  if (process.env.UPDATE_DATASETS) {
    mkdirSync(new URL('.', url), { recursive: true });
    writeFileSync(url, text);
  }
  expect(readFileSync(url, 'utf8')).toBe(text);
};
const toLists = (r: KerbsideRelease): TimedList[] => releaseToDrafts(r).drafts.map((d, i) => ({ ...d.list, id: `l${i}`, createdAt: 0, updatedAt: 0 }));
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;

/** City of Melbourne example: Little Bourke St 20055 from CivicMAPS kerbside data, and the illustrative Bourke St 20567. */
function comExample(): KerbsideRelease {
  const kerbside = readJson('tests/fixtures/civicmaps-preview/kerbside-chinatown-20055.json');
  const bayPart = kerbside.sides.find((s: { street_side: string }) => s.street_side === 'southern').sub_segments.find((s: { from: string }) => s.from === 'Bay 58');
  const b = new ReleaseBuilder(
    emptyRelease({
      dataset_id: 'cbd-example',
      council_code: 'com',
      linking_id: null,
      municipality_name: 'City of Melbourne',
      state: 'VIC',
      country: 'AU',
      timezone: 'Australia/Melbourne',
      version: '1',
      generated_at: '2026-11-22T00:00:00Z',
      notes: 'Example release. Little Bourke Street 20055 comes from CivicMAPS kerbside parking assets v1; Bourke Street 20567 is illustrative.',
    }),
  );
  const src = b.source({ name: 'CivicMAPS kerbside parking assets v1', issuer: 'CivicMAPS', dataset: 'kerbside-parking-assets/v1', url: null, format: 'JSON', licence: null, reference_date: null, data_used: ['road segment ID', 'parking area', 'EasyPark area', 'bays and positions', 'parking rules'], limitations: ['bay positions inferred from coordinate sequence'] });
  const seg = b.segment({ asset_id: '20055', road_name: 'Little Bourke Street', from_label: 'Swanston Street', to_label: 'Elizabeth Street', locality: 'Melbourne', source_id: src, verification: 'unverified' });
  b.sourceRef(seg, src, '20055', 'road_segment_asset_id');
  const north = b.extent({ segment_id: seg, side: 'north', restrictions_status: 'supplied', notes: 'No stopping end to end.' });
  b.zone(north, 'patrol', 'Chinatown', 'Chinatown');
  b.rule(north, { type: 'no_stopping', days: [...weekdays, 'sat', 'sun'], all_day: true }, { source_id: src });
  const noSpaces = b.extent({ segment_id: seg, side: 'south', from_label: 'Swanston Street', from_type: 'intersection', to_label: 'Bay 58', to_type: 'bay', restrictions_status: 'no_parking_spaces' });
  b.zone(noSpaces, 'parking_area', '645');
  const bays = b.extent({ segment_id: seg, side: 'south', from_label: 'Bay 58', from_type: 'bay', to_label: 'Bay 72', to_type: 'bay', restrictions_status: 'supplied' });
  b.zone(bays, 'patrol', 'Chinatown', 'Chinatown');
  b.zone(bays, 'parking_area', '645');
  b.providerArea(bays, 'easypark', '7514');
  b.rule(bays, { type: 'loading_zone', sign_code: 'LZ 30', max_stay_minutes: 30, days: [...weekdays], start: '07:00', end: '16:00', exceptions: ['Commercial vehicles only'] }, { source_id: src });
  b.rule(bays, { type: 'metered', sign_code: '2P', max_stay_minutes: 120, days: ['sat', 'sun'], start: '07:00', end: '22:00' }, { source_id: src });
  for (const bay of bayPart.bays) b.bay(bays, { bay_number: bay.bay, lat: Number(bay.location.latitude.toFixed(7)), lng: Number(bay.location.longitude.toFixed(7)), kind: 'standard', verification: 'inferred' });
  b.extent({ segment_id: seg, side: 'south', from_label: 'Bay 72', from_type: 'bay', to_label: 'Elizabeth Street', to_type: 'intersection' });
  const bourke = b.segment({ asset_id: '20567', road_name: 'Bourke Street', from_label: 'Russell Street', to_label: 'Swanston Street', locality: 'Melbourne', verification: 'pending_field_capture', notes: 'Illustrative asset ID.' });
  const bourkeSouth = b.extent({ segment_id: bourke, side: 'south' });
  b.zone(bourkeSouth, 'rpa', '7');
  b.extent({ segment_id: bourke, side: 'centre', notes: 'Centre parking: illustrative.' });
  return b.r;
}

const example = comExample();
const area10Source = readJson('tests/fixtures/copp-area-10-source.json');
const area10 = areaDatasetToRelease(area10Source);

describe('identifiers', () => {
  it('asset ID keys the segment; users see the council code; the asset name is separate', () => {
    expect(assetName('Bourke Street', 'Russell Street', 'Swanston Street')).toBe('bourke-street-from-russell-to-swanston');
    const bourke = example.segments.find((s) => s.asset_id === '20567')!;
    expect(bourke).toMatchObject({ segment_id: 'com-20567', display_id: 'com-20567', asset_id: '20567', asset_name: 'bourke-street-from-russell-to-swanston' });
  });
  it('the linking ID replaces the council code in every key once the council is onboarded; display stays com-20567', () => {
    const linked = relinkRelease(example, '482771930');
    valid(linked);
    const bourke = linked.segments.find((s) => s.asset_id === '20567')!;
    expect(bourke).toMatchObject({ segment_id: '482771930-20567', display_id: 'com-20567', asset_id: '20567' });
    expect(linked.release[0]).toMatchObject({ council_code: 'com', linking_id: '482771930', release_id: '482771930-cbd-example-v1' });
    expect(linked.extents.every((e) => e.extent_id.startsWith('482771930-') && e.segment_id.startsWith('482771930-'))).toBe(true);
    expect(linked.zone_assignments[0]!.assignment_id).toMatch(/^482771930-.*>482771930-/);
    // Council values are untouched.
    expect(linked.segment_source_refs[0]!.external_id).toBe('20055');
    // No trace of the development prefix in any key.
    expect(JSON.stringify(linked.extents)).not.toMatch(/(^|[":>])com-/);
  });
  it('a residential permit area is qualified by its council (com-rpa-7 vs copp-rpa-7)', () => {
    expect(ids.zone('com', 'rpa', '7')).toBe('com-rpa-7');
    expect(ids.zone('copp', 'rpa', '7')).toBe('copp-rpa-7');
    expect(example.zones.find((z) => z.code === '7')!.zone_id).toBe('com-rpa-7');
  });
  it('council codes', () => {
    expect(councilCode('City of Melbourne')).toBe('com');
    expect(councilCode('City of Port Phillip')).toBe('copp');
  });
});

describe('fixed structure', () => {
  it('every record in every table has exactly the standard keys, in order', () => {
    for (const r of [example, area10.release]) for (const t of TABLE_NAMES) for (const row of r[t] as object[]) expect(Object.keys(row)).toEqual(TABLES[t]);
  });
  it('the example and Area 10 pass the JSON Schema and the release checks', () => {
    valid(example);
    valid(area10.release);
  });
  it('a rule is defined once and assigned to every extent it applies to', () => {
    const b = new ReleaseBuilder(structuredClone(example));
    const other = b.extent({ segment_id: 'com-20567', side: 'north', restrictions_status: 'supplied' });
    b.rule(other, { type: 'metered', sign_code: '2P', max_stay_minutes: 120, days: ['sat', 'sun'], start: '07:00', end: '22:00' });
    expect(b.r.rules.filter((r) => r.sign_code === '2P')).toHaveLength(1);
    expect(b.r.rule_assignments.filter((a) => a.rule_id === b.r.rules.find((r) => r.sign_code === '2P')!.rule_id)).toHaveLength(2);
  });
  it('rejects a missing key, a key outside the standard, a dangling reference, a wrong prefix and a stay-less time limit', () => {
    const bad = structuredClone(example) as unknown as Record<string, Record<string, unknown>[]>;
    delete bad.segments![0]!.locality;
    bad.extents![0]!.council_kerb_code = 'K1';
    bad.zone_assignments![0]!.zone_id = 'com-patrol-nowhere';
    bad.bays![0]!.bay_id = 'cop-20055:south:bay-58';
    bad.rules!.find((r) => r.type === 'metered')!.max_stay_minutes = null;
    expect(schemaErrors(bad).length).toBeGreaterThan(0);
    expect(validateRelease(bad).map((e) => `${e.path}: ${e.message}`)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^segments\[0\]: is missing locality/),
        expect.stringMatching(/^extents\[0\]: has keys outside the standard: council_kerb_code/),
        expect.stringMatching(/^zone_assignments\[0\]\.zone_id: "com-patrol-nowhere" is not in zones/),
        expect.stringMatching(/^bays\[0\]\.bay_id: .* does not start with the owner prefix "com-"/),
        expect.stringMatching(/max_stay_minutes: is required for metered/),
      ]),
    );
  });
  it('matches the example file in datasets/', () => {
    matchesFile('datasets/examples/com-cbd-example.release.json', JSON.stringify(example, null, 2) + '\n');
  });
});

describe('Area 10 → candidate release', () => {
  const r = area10.release;
  it('adapts all 55 segments: keyed by asset name until asset IDs are acquired, patrol zone copp-patrol-10, sources kept', () => {
    expect(area10.warnings).toEqual([]);
    expect(r.release[0]).toMatchObject({ release_id: 'copp-patrol-area-10-v1', council_code: 'copp', linking_id: null, municipality_name: 'City of Port Phillip', status: 'candidate' });
    expect(r.segments).toHaveLength(55);
    expect(r.segments[0]).toEqual({
      segment_id: 'copp-normanby-road-from-boundary-to-montague',
      display_id: 'copp-normanby-road-from-boundary-to-montague',
      asset_id: null,
      asset_name: 'normanby-road-from-boundary-to-montague',
      road_name: 'Normanby Road',
      locality: null,
      from_label: 'Boundary Street',
      from_type: 'intersection',
      to_label: 'Montague Street',
      to_type: 'intersection',
      geometry: null,
      status: 'candidate',
      verification: 'pending_field_capture',
      source_id: 'copp-src-user-supplied-parking-enforcement-patrol-area-10-map',
      notes: 'interpreted_from visible map intersections; requires GIS validation; not shown and not inferred from map symbology',
    });
    expect(r.extents[0]).toMatchObject({ extent_id: 'copp-normanby-road-from-boundary-to-montague:both:all', side: 'both', restrictions_status: 'pending_field_capture' });
    expect(r.zones).toEqual([{ zone_id: 'copp-patrol-10', scheme_id: 'copp-patrol', code: '10', name: null }]);
    expect(r.zone_assignments).toHaveLength(55);
    expect(r.segment_source_refs[0]).toMatchObject({ external_id: 'normanby-rd-boundary-st-montague-st', id_scheme: 'source_row_id' });
    expect(r.sources.map((s) => s.name)).toContain('City of Port Phillip Parking Machines');
    expect(r.rules).toEqual([]);
  });
  it('matches datasets/copp-patrol-area-10.release.json and its per-table CSV files', () => {
    matchesFile('datasets/copp-patrol-area-10.release.json', JSON.stringify(r, null, 2) + '\n');
    for (const [t, csv] of Object.entries(releaseToCsv(r))) matchesFile(`datasets/copp-patrol-area-10.csv/${t}.csv`, csv);
    expect(releaseToCsv(r).segments.split('\n')[0]).toBe(TABLES.segments.join(','));
  });
  it('keys a segment by its asset ID once the council supplies one, and PlateWatch updates the list rather than duplicating it', () => {
    const before = planImport(parseImportFile(JSON.stringify(r), 'a.json').drafts, [], { updateExisting: true }).created;
    const withId = structuredClone(area10Source);
    withId.street_segments[0].road_segment_asset_id = '31001';
    const next = areaDatasetToRelease(withId).release;
    expect(next.segments[0]).toMatchObject({ segment_id: 'copp-31001', display_id: 'copp-31001', asset_id: '31001', asset_name: 'normanby-road-from-boundary-to-montague', status: 'active' });
    expect(next.segment_source_refs.filter((x) => x.segment_id === 'copp-31001').map((x) => x.id_scheme)).toEqual(['source_row_id', 'road_segment_asset_id']);
    const after = planImport(parseImportFile(JSON.stringify(next), 'b.json').drafts, before, { updateExisting: true });
    expect(after.created).toEqual([]);
    const list = after.updated.find((l) => l.type === 'timed' && l.segment.toStreet === 'Montague Street' && l.segment.street === 'Normanby Road') as TimedList;
    expect(list).toMatchObject({ externalId: 'copp-31001:both:all', displayId: 'copp-31001', roadSegmentId: '31001' });
  });
  it('maps restrictions once they are supplied', () => {
    const withSigns = structuredClone(area10Source);
    withSigns.street_segments[0].parking_restrictions = [
      { applicable_days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], applicable_times: { start: '08:00', end: '18:00' }, restriction_applied: '2P', permit_or_vehicle_exceptions: ['Permit Zone 7 excepted'], source_sign_or_asset_id: 'S-1001', verification_status: 'verified' },
      { applicable_days: [], applicable_times: { start: null, end: null }, restriction_applied: 'No Stopping', verification_status: 'verified' },
    ];
    const rr = areaDatasetToRelease(withSigns).release;
    valid(rr);
    expect(rr.extents[0]!.restrictions_status).toBe('supplied');
    expect(rr.rules.map((x) => [x.type, x.sign_code, x.max_stay_minutes, x.days.length, x.all_day])).toEqual([
      ['time_limit', '2P', 120, 5, false],
      ['no_stopping', 'No Stopping', null, 7, true],
    ]);
    expect(rr.rule_assignments[0]).toMatchObject({ source_sign_id: 'S-1001', verification: 'verified' });
  });
});

describe('release → PlateWatch lists', () => {
  const { drafts, skipped } = releaseToDrafts(example);
  const byExtent = (id: string) => drafts.find((d) => d.list.externalId === id)!.list;
  it('one list per extent with zones, payment, bays and positions; display ID for screens', () => {
    const l = byExtent('com-20055:south:bay-58-bay-72');
    expect(l).toMatchObject({
      displayId: 'com-20055',
      roadSegmentId: '20055',
      patrolZone: 'Chinatown',
      patrolZoneName: 'Chinatown',
      segment: { street: 'Little Bourke Street', side: 'south', subFrom: 'Bay 58', subTo: 'Bay 72' },
      payment: { parkingArea: '645', easyPark: ['7514'], payStay: [] },
    });
    expect(l.restrictions.map((x) => [x.code, x.limitMinutes, x.description])).toEqual([
      ['LZ 30', 30, 'Commercial vehicles only'],
      ['2P', 120, 'Meter'],
    ]);
    expect(l.bayPoints![0]).toMatchObject({ bay: 58 });
  });
  it('centre side, RPA code, and what is left out', () => {
    expect(byExtent('com-20567:centre:all').segment.side).toBe('centre');
    expect(byExtent('com-20567:south:all').rpa).toBe('7');
    expect(skipped.join('\n')).toMatch(/no parking spaces/);
    expect(skipped.join('\n')).toMatch(/north side: no timed parking \(No stopping\)/);
  });
});

describe('PlateWatch lists → release (export)', () => {
  it('round-trips the example to a valid release with the same keys', () => {
    const exported = listsToRelease(toLists(example), { municipality: 'City of Melbourne', timezone: 'Australia/Melbourne', datasetId: 'cbd-example', generatedAt: '2026-11-22T00:00:00Z' });
    valid(exported);
    expect(exported.segments.map((s) => s.segment_id).sort()).toEqual(['com-20055', 'com-20567']);
    expect(exported.extents.map((e) => e.extent_id)).toEqual(expect.arrayContaining(['com-20055:south:bay-58-bay-72', 'com-20567:centre:all']));
    expect(exported.provider_areas).toEqual([{ provider_area_id: 'com-easypark-7514', provider: 'easypark', area_code: '7514', account: null, name: null }]);
    expect(toLists(exported).map((l) => [l.externalId, l.restrictions.length, l.bays?.length ?? 0]).sort()).toEqual(
      toLists(example).map((l) => [l.externalId, l.restrictions.length, l.bays?.length ?? 0]).sort(),
    );
  });
  it('exports with the linking ID when given; display IDs keep the council code', () => {
    const exported = listsToRelease(toLists(example), { municipality: 'City of Melbourne', linkingId: '482771930', timezone: 'Australia/Melbourne', generatedAt: '2026-11-22T00:00:00Z' });
    valid(exported);
    expect(exported.segments.find((s) => s.asset_id === '20567')).toMatchObject({ segment_id: '482771930-20567', display_id: 'com-20567' });
  });
});

describe('CSV tables in a zip', () => {
  it('writes a zip that standard tools read, with one CSV per table', async () => {
    const zip = zipStore(Object.entries(releaseToCsv(example)).map(([t, csv]) => ({ name: `rel/${t}.csv`, data: csv })));
    const dir = mkdtempSync(join(tmpdir(), 'pw-zip-'));
    const file = join(dir, 'r.zip');
    writeFileSync(file, Buffer.from(await zip.arrayBuffer()));
    const listing = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist())); print(z.read("rel/segments.csv").decode().splitlines()[0])', file], { encoding: 'utf8' });
    expect(listing.trim().split('\n')).toEqual([...TABLE_NAMES.map((t) => `rel/${t}.csv`), TABLES.segments.join(',')]);
  });
});

describe('Zones 9 and 9A → one release per zone', () => {
  const source = readJson('tests/fixtures/copp-area-9-9a-source.json');
  const { release: r, warnings } = areaDatasetToRelease(source);

  it('defines both zones but assigns no segment while the source only lists candidates', () => {
    valid(r);
    expect(r.release[0]).toMatchObject({ release_id: 'copp-patrol-area-9-9a-v1', dataset_id: 'patrol-area-9-9a' });
    expect(r.zones.map((z) => [z.zone_id, z.code])).toEqual([['copp-patrol-9', '9'], ['copp-patrol-9a', '9A']]);
    expect(r.segments).toHaveLength(14);
    expect(r.zone_assignments).toEqual([]);
    expect(r.extents.every((e) => e.notes === 'Patrol zone not yet assigned (candidates: 9, 9A)')).toBe(true);
    expect(warnings).toEqual(['14 segment(s) have no patrol zone yet (only candidates: 9, 9A). They import under "No patrol zone" until each is assigned.']);
  });

  it('keeps a map edge as a boundary, not a cross street, and notes unconfirmed names', () => {
    const market = r.segments.find((s) => s.segment_id === 'copp-market-street-from-western-map-boundary-to-clarendon')!;
    expect(market).toMatchObject({ from_label: 'Western map boundary', from_type: 'boundary', to_type: 'intersection' });
    expect(r.segments.find((s) => s.road_name === 'Clarke Street')!.notes).toMatch(/^street name not visually confirmed/);
    expect(r.sources[1]!.url).toBe('https://opendata.portphillip.vic.gov.au/explore/');
  });

  it('puts unassigned extents in no file rather than guessing a zone', () => {
    const { releases, unassigned } = splitByZone(r);
    expect(releases).toEqual([]);
    expect(unassigned).toHaveLength(14);
  });

  it('splits into one complete release per zone once segments are assigned', () => {
    // Illustrative split for the test only; the real 9 / 9A assignment comes from the council.
    const assignedSource = structuredClone(source);
    assignedSource.street_segments.forEach((s: Record<string, unknown>, i: number) => (s.enforcement_zone = i < 5 ? '9' : '9A'));
    const { release, warnings: w } = areaDatasetToRelease(assignedSource);
    expect(w).toEqual([]);
    const { releases, unassigned } = splitByZone(release);
    expect(unassigned).toEqual([]);
    expect(releases.map((x) => [x.release[0]!.release_id, x.extents.length])).toEqual([
      ['copp-patrol-area-9-v1', 5],
      ['copp-patrol-area-9a-v1', 9],
    ]);
    for (const x of releases) {
      valid(x);
      expect(x.zones).toHaveLength(1);
      expect(x.segments.map((s) => s.segment_id).sort()).toEqual([...new Set(x.extents.map((e) => e.segment_id))].sort());
    }
    expect(releases[1]!.zones[0]).toMatchObject({ zone_id: 'copp-patrol-9a', code: '9A' });
    // Imported on a device, each zone's lists carry their own patrol zone.
    expect(releaseToDrafts(releases[1]!).drafts.every((d) => d.list.patrolZone === '9A')).toBe(true);
  });

  it('a single-zone release splits into itself (Area 10)', () => {
    const { releases, unassigned } = splitByZone(area10.release);
    expect(unassigned).toEqual([]);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.release[0]!.release_id).toBe('copp-patrol-area-10-v1');
    expect(releases[0]).toEqual(area10.release);
  });
});
