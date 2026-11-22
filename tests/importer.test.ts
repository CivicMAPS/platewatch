import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CSV_TEMPLATES,
  formatBays,
  parseBays,
  parseCsv,
  parseImportFile,
  parseSign,
  planImport,
  segmentKey,
  type AllowDraft,
  type HotDraft,
  type TimedDraft,
} from '../src/lib/importer';
import type { AllowList, TimedList } from '../src/lib/types';
import { timed } from './fixtures';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/civicmaps-preview/${name}`, import.meta.url), 'utf8');
/** The first template's columns: older CSV files must keep importing. */
const LEGACY_TIMED_HEADER =
  'patrol_zone,patrol_zone_name,street,from_street,to_street,side,suburb,sub_from,sub_to,rpa,parking_area,easypark_areas,paystay_zones,bays,sign,minutes,days,start,end,grace,road_segment_id,list_name,notes';
const timedDrafts = (text: string, name: string) => parseImportFile(text, name).drafts.filter((d): d is TimedDraft => d.kind === 'timed');

describe('parseCsv', () => {
  it('handles quotes, embedded commas and newlines, CRLF and an Excel BOM', () => {
    const text = '﻿a,b,c\r\n1,"two, 2","line\nbreak"\r\n"say ""hi""",,x\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'two, 2', 'line\nbreak'],
      ['say "hi"', '', 'x'],
    ]);
  });
  it('drops blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n,\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('bays', () => {
  it('formats bay numbers as ranges, for display and back into the CSV form', () => {
    expect(formatBays([58, 59, 61, 62, 63, 64, 65, 67, 72])).toBe('58–59, 61–65, 67, 72');
    expect(formatBays([58, 59, 61], true)).toBe('58-59;61');
    expect(parseBays(formatBays([58, 59, 61, 62, 63, 64, 65, 67, 72], true))).toEqual([58, 59, 61, 62, 63, 64, 65, 67, 72]);
  });
});

describe('parseSign', () => {
  it('reads timed signs from the template and from CivicMAPS-preview types', () => {
    expect(parseSign('2P')).toMatchObject({ code: '2P', minutes: 120 });
    expect(parseSign('2p_meter')).toMatchObject({ code: '2P', minutes: 120, description: 'Meter' });
    expect(parseSign('1/2P')).toMatchObject({ code: '1/2P', minutes: 30 });
    expect(parseSign('P15')).toMatchObject({ code: 'P15', minutes: 15 });
    expect(parseSign('LZ30')).toMatchObject({ code: 'LZ30', minutes: 30 });
    expect(parseSign('loading_zone_30_min')).toMatchObject({ code: 'LZ30', minutes: 30 });
    expect(parseSign('loading_zone', '30_min')).toMatchObject({ code: 'LZ30', minutes: 30 });
    expect(parseSign('Loading Zone 15 min')).toMatchObject({ code: 'LZ15', minutes: 15 });
  });
  it('keeps signs without a time allowance as notes', () => {
    expect(parseSign('no_stopping')).toEqual({ note: 'No stopping', control: 'no_stopping' });
    expect(parseSign('No Parking')).toEqual({ note: 'No parking', control: 'no_parking' });
    expect(parseSign('loading_zone')).toEqual({ note: 'Loading zone (no time limit given)', control: 'loading_zone' });
    expect(parseSign('Permit Zone')).toEqual({ note: 'Permit zone', control: 'permit_zone' });
  });
});

describe('timed CSV template', () => {
  it('groups rows into one list per side (or sub-segment) with one restriction per row', () => {
    const csv = [
      LEGACY_TIMED_HEADER,
      '9,South Melbourne Market,Coventry Street,Cecil Street,Market Street,south,South Melbourne,,,,,,338851200002,,2P,,Mon-Fri,08:00,18:00,,,',
      '9,South Melbourne Market,Coventry Street,Cecil Street,Market Street,south,South Melbourne,,,,,,338851200002,,2P,,Sat,08:00,12:30,,,',
      '9,South Melbourne Market,Coventry Street,Cecil Street,Market Street,north,South Melbourne,,,,,,338851200001,,No Stopping,,Mon-Sun,,,,,',
      '14,Flagstaff,Little Bourke Street,Swanston Street,Elizabeth Street,south,Melbourne,Bay 58,Bay 72,,645,7514,,58-59;61-65;67-72,LZ30,,Mon-Fri,07:00,16:00,,,',
      '14,Flagstaff,Little Bourke Street,Swanston Street,Elizabeth Street,south,Melbourne,Bay 58,Bay 72,,645,7514,,58-59;61-65;67-72,2P Meter,,Sat-Sun,07:00,22:00,,,',
    ].join('\n');
    const r = parseImportFile(csv, 'segments.csv');
    expect(r.kind).toBe('timed-csv');
    const lists = r.drafts.filter((d): d is TimedDraft => d.kind === 'timed').map((d) => d.list);
    expect(lists).toHaveLength(2);
    const [coventry, bourke] = lists;
    expect(coventry).toMatchObject({ patrolZone: '9', patrolZoneName: 'South Melbourne Market', segment: { street: 'Coventry Street', side: 'south' } });
    expect(coventry!.payment).toEqual({ easyPark: [], payStay: [{ zone: '338851200002' }] });
    // The number on each sign's row pays for that row's restriction.
    expect(coventry!.restrictions.map((x) => x.paidBy)).toEqual([{ easyPark: [], payStay: ['338851200002'] }, { easyPark: [], payStay: ['338851200002'] }]);
    expect(coventry!.restrictions.map((x) => [x.code, x.days, x.startTime, x.endTime])).toEqual([
      ['2P', [1, 2, 3, 4, 5], '08:00', '18:00'],
      ['2P', [6], '08:00', '12:30'],
    ]);
    expect(bourke).toMatchObject({ segment: { subFrom: 'Bay 58', subTo: 'Bay 72', side: 'south' }, bays: [58, 59, 61, 62, 63, 64, 65, 67, 68, 69, 70, 71, 72] });
    expect(bourke!.payment).toEqual({ parkingArea: '645', easyPark: ['7514'], payStay: [] });
    expect(bourke!.restrictions.map((x) => [x.code, x.limitMinutes, x.description])).toEqual([
      ['LZ30', 30, ''],
      ['2P', 120, 'Meter'],
    ]);
    // The north side is No Stopping only: nothing to time, so it is reported and skipped.
    expect(r.skipped.some((s) => /Coventry Street.*north.*No stopping/i.test(s))).toBe(true);
  });

  it('reports rows with unreadable days or times and missing streets', () => {
    const csv = [
      LEGACY_TIMED_HEADER,
      ',,Bay Street,Graham Street,Ross Street,north,,,,,,,,,2P,,Someday,08:00,18:00,,,',
      ',,,Graham Street,Ross Street,north,,,,,,,,,2P,,Mon-Fri,08:00,18:00,,,',
    ].join('\n');
    const r = parseImportFile(csv, 'bad.csv');
    expect(r.issues.map((i) => i.row)).toEqual([2, 3]);
    expect(r.issues[0]!.message).toMatch(/days/i);
    expect(r.issues[1]!.message).toMatch(/road|street/i);
  });

  it('treats 00:00–24:00 and blank times as all day', () => {
    const csv = [LEGACY_TIMED_HEADER, ',,Bay Street,Graham Street,Ross Street,both,,,,,,,,,P15,,Mon-Sun,00:00,24:00,,,'].join('\n');
    const [d] = timedDrafts(csv, 'x.csv');
    expect(d!.list.restrictions[0]).toMatchObject({ allDay: true, days: [0, 1, 2, 3, 4, 5, 6] });
  });

  it('ships templates whose example rows import cleanly', () => {
    for (const kind of ['timed', 'bays', 'allow', 'hot'] as const) {
      const r = parseImportFile(CSV_TEMPLATES[kind].header + '\n' + CSV_TEMPLATES[kind].example, `${kind}.csv`);
      expect(r.issues, kind).toEqual([]);
      expect(r.drafts.length, kind).toBeGreaterThan(0);
    }
  });
});

describe('timed CSV with civicmaps.parking_dataset columns', () => {
  const row = (v: Record<string, string>) => CSV_TEMPLATES.timed.header.split(',').map((h) => v[h] ?? '').join(',');
  const base = { segment_id: 'copp-coventry-street-from-montague-to-ferrars', patrol_zone: '10', road: 'Coventry Street', locality: 'South Melbourne', between_from: 'Montague Street', between_to: 'Ferrars Street', side: 'north', restrictions_status: 'supplied' };

  it('reads control, sign code, allowance, exceptions and grace; keeps the dataset external ID', () => {
    const csv = [
      CSV_TEMPLATES.timed.header,
      row({ ...base, permit_area: '7', paystay_zones: '338851200001', control: 'ticket', sign_code: '2P', limit_minutes: '120', days: 'Mon-Fri', start: '08:00', end: '18:00', exceptions: 'Permit Zone 7 excepted', grace_minutes: '5' }),
      row({ ...base, control: 'no_stopping', days: 'Mon-Fri', start: '07:00', end: '09:00' }),
    ].join('\n');
    const [d] = timedDrafts(csv, 'x.csv');
    expect(d!.list).toMatchObject({ externalId: 'copp-coventry-street-from-montague-to-ferrars:north:all', patrolZone: '10', rpa: '7', payment: { payStay: [{ zone: '338851200001' }] } });
    expect(d!.list.restrictions[0]).toMatchObject({ code: '2P', limitMinutes: 120, graceMinutes: 5, description: 'Ticket · Permit Zone 7 excepted' });
    expect(d!.list.untimedControls).toEqual([{ control: 'no_stopping', label: 'No stopping', days: [1, 2, 3, 4, 5], allDay: false, startTime: '07:00', endTime: '09:00', description: '' }]);
  });

  it('ties the EasyPark and PayStay numbers on a row to that row\'s restriction; zone:meter and meter_ids add meters', () => {
    // Gladstone St (north): one PayStay zone per restriction, several meters per zone, one meter for the whole segment.
    const g = { ...base, road: 'Gladstone Street', between_from: 'Boundary Street', between_to: 'Montague Street', segment_id: 'copp-gladstone-street-from-boundary-to-montague' };
    const csv = [
      CSV_TEMPLATES.timed.header,
      row({ ...g, paystay_zones: '33883296:GLP1;33883296:GLP4', control: 'ticket', sign_code: '1P', days: 'Mon-Fri', start: '08:00', end: '18:00' }),
      row({ ...g, paystay_zones: '33883294:GLP2', meter_ids: 'GLP9', control: 'ticket', sign_code: '4P', days: 'Mon-Fri', start: '08:00', end: '18:00' }),
      row({ ...g, paystay_zones: '33883292:GLP6', sign_code: '2P', days: 'Mon-Fri', start: '08:00', end: '18:00' }),
      row({ ...g, control: 'no_stopping', days: 'Mon-Fri', start: '07:00', end: '09:00' }),
    ].join('\n');
    const [d] = timedDrafts(csv, 'x.csv');
    const l = d!.list;
    expect(l.payment).toEqual({
      easyPark: [],
      payStay: [{ zone: '33883296' }, { zone: '33883294' }, { zone: '33883292' }],
      meters: [
        { id: 'GLP1', easyPark: [], payStay: ['33883296'] },
        { id: 'GLP4', easyPark: [], payStay: ['33883296'] },
        { id: 'GLP2', easyPark: [], payStay: ['33883294'] },
        { id: 'GLP9', easyPark: [], payStay: [] },
        { id: 'GLP6', easyPark: [], payStay: ['33883292'] },
      ],
    });
    expect(l.restrictions.map((r) => [r.code, r.paidBy?.payStay])).toEqual([['1P', ['33883296']], ['4P', ['33883294']], ['2P', ['33883292']]]);
  });

  it('honours restrictions_status: pending is a placeholder, no_parking_spaces is left out', () => {
    const csv = [CSV_TEMPLATES.timed.header, row({ ...base, restrictions_status: 'pending_field_capture' }), row({ ...base, side: 'south', restrictions_status: 'no_parking_spaces' })].join('\n');
    const r = parseImportFile(csv, 'x.csv');
    expect(r.drafts).toHaveLength(1);
    expect((r.drafts[0] as TimedDraft).pending).toBe(true);
    expect(r.skipped[0]).toMatch(/south side: no parking spaces/);
  });

  it('accepts road_segment_asset_id as the column name for the road segment ID', () => {
    const header = CSV_TEMPLATES.timed.header.replace('road_segment_id', 'road_segment_asset_id');
    const [d] = timedDrafts([header, row({ ...base, road_segment_id: 'RS-10442', restrictions_status: 'pending_field_capture' })].join('\n'), 'x.csv');
    expect(d!.list.roadSegmentId).toBe('RS-10442');
  });

  it('rejects an unknown control or status, and a fractional allowance', () => {
    const csv = [CSV_TEMPLATES.timed.header, row({ ...base, control: 'parking_maybe', days: 'Mon' }), row({ ...base, restrictions_status: 'done' }), row({ ...base, control: 'time_limit', limit_minutes: '90.5', days: 'Mon' })].join('\n');
    expect(parseImportFile(csv, 'x.csv').issues.map((i) => i.row)).toEqual([2, 3, 4]);
  });
});

describe('bays CSV', () => {
  it('adds bay numbers, positions and plate numbers to the matching timed list (by segment ID or by street)', () => {
    const timedCsv = CSV_TEMPLATES.timed.header + '\n' + CSV_TEMPLATES.timed.example;
    const baysCsv = [CSV_TEMPLATES.bays.header, CSV_TEMPLATES.bays.example, ',,Little Bourke Street,Elizabeth Street,Swanston Street,south,Bay 58,Bay 72,62,-37.81282,144.96426,64562X'].join('\n');
    const drafts = [...parseImportFile(timedCsv, 't.csv').drafts, ...parseImportFile(baysCsv, 'b.csv').drafts];
    const plan = planImport(drafts, [], { updateExisting: true });
    expect(plan.unmatchedBays).toEqual([]);
    const part = plan.created.find((l) => l.type === 'timed' && l.segment.subFrom === 'Bay 58') as TimedList;
    expect(part.bays).toEqual([58, 59, 61, 62]);
    expect(part.bayPoints).toEqual([
      { bay: 58, lat: -37.8127332, lng: 144.9645599 },
      { bay: 59, lat: -37.8127544, lng: 144.9644881 },
      { bay: 61, lat: -37.8128019, lng: 144.9643276 },
      { bay: 62, lat: -37.81282, lng: 144.96426, sign: '64562X' },
    ]);
  });

  it('reports bays for a segment that has no timed list, and bad coordinates', () => {
    const csv = [CSV_TEMPLATES.bays.header, ',,Nowhere Street,A Street,B Street,north,,,1,-37.8,144.9,', ',,Nowhere Street,A Street,B Street,north,,,2,-137.8,144.9,'].join('\n');
    const r = parseImportFile(csv, 'b.csv');
    expect(r.issues.map((i) => i.row)).toEqual([3]);
    expect(planImport(r.drafts, [], { updateExisting: true }).unmatchedBays[0]).toMatch(/Nowhere Street.*bays 1/);
  });
});

describe('allow and hot list CSV templates', () => {
  it('builds allow lists by name with permits and Australian or ISO dates', () => {
    const csv = [CSV_TEMPLATES.allow.header, 'RPA 12 residents,1ab 2cd,Resident,P-1001,01/07/2026,30/06/2027', 'RPA 12 residents,XYZ789,Visitor,,2026-07-01,'].join('\n');
    const r = parseImportFile(csv, 'permits.csv');
    expect(r.kind).toBe('allow-csv');
    const [d] = r.drafts;
    expect(d!.kind === 'allow' && d!.list.name).toBe('RPA 12 residents');
    const entries = (d as AllowDraft).list.entries;
    expect(entries.map((e) => [e.plate, e.key, e.permitNo, e.validFrom, e.validTo])).toEqual([
      ['1AB2CD', '1AB2CD', 'P-1001', '2026-07-01', '2027-06-30'],
      ['XYZ789', 'XYZ789', '', '2026-07-01', ''],
    ]);
  });

  it('builds hot lists with risk level and risk labels or keys', () => {
    const csv = [CSV_TEMPLATES.hot.header, 'Officer safety,ABC123,high,Aggressive; weapon_sighted,Toyota,Hilux,Ute,White,Seen near market'].join('\n');
    const r = parseImportFile(csv, 'hot.csv');
    expect(r.kind).toBe('hot-csv');
    const e = (r.drafts[0] as HotDraft).list.entries[0]!;
    expect(e).toMatchObject({ plate: 'ABC123', riskLevel: 'high', risks: ['aggressive', 'weapon_sighted'], make: 'Toyota', colour: 'White' });
  });
});

describe('CivicMAPS-preview JSON', () => {
  it('kerbside v1: one list per side or sub-segment, bays and rules carried over, no-stopping and no-space stretches skipped', () => {
    const r = parseImportFile(fixture('kerbside-chinatown-20055.json'), 'chinatown.json');
    expect(r.kind).toBe('civicmaps-kerbside');
    const lists = r.drafts.filter((d): d is TimedDraft => d.kind === 'timed');
    const bays = lists.find((d) => d.list.segment.subFrom === 'Bay 58')!;
    expect(bays.list).toMatchObject({
      patrolZoneName: 'Chinatown',
      roadSegmentId: '20055',
      segment: { street: 'Little Bourke Street', fromStreet: 'Swanston Street', toStreet: 'Elizabeth Street', side: 'south', subTo: 'Bay 72' },
      payment: { parkingArea: '645', easyPark: ['7514'], payStay: [] },
    });
    expect(bays.list.bays).toContain(58);
    expect(bays.list.restrictions.map((x) => x.code)).toEqual(['2P']);
    expect(bays.list.untimedControls).toEqual([
      { control: 'loading_zone', label: 'Loading zone (no time limit given)', days: [1, 2, 3, 4, 5], allDay: false, startTime: '07:00', endTime: '16:00', description: '' },
    ]);
    expect(bays.list.bayPoints?.find((b) => b.bay === 58)).toMatchObject({ lat: expect.closeTo(-37.81, 1), lng: expect.closeTo(144.96, 1) });
    expect(bays.pending).toBe(false);
    // Bay 72 → Elizabeth St has no rules yet: imported as a placeholder.
    expect(lists.find((d) => d.list.segment.subFrom === 'Bay 72')!.pending).toBe(true);
    expect(r.skipped.join('\n')).toMatch(/north.*No stopping/);
    expect(r.skipped.join('\n')).toMatch(/no parking spaces/i);
  });

  it('kerbside v1 with rules pending: placeholders that keep identifiers and bays', () => {
    const lists = timedDrafts(fixture('kerbside-titles-21649.json'), 'titles.json');
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((d) => d.pending)).toBe(true);
    expect(lists[0]!.list).toMatchObject({ patrolZoneName: 'Titles', roadSegmentId: '21649', payment: { parkingArea: '678', easyPark: ['7306'] } });
    expect(lists[0]!.list.bays).toContain(54);
  });

  it('road-segment files: sub-segments with their own EasyPark areas', () => {
    const lists = timedDrafts(fixture('road-segment-little-bourke-swanston-russell.json'), 'lb.json');
    expect(lists.map((d) => [d.list.segment.subFrom, d.list.segment.subTo, d.list.payment?.easyPark, d.list.restrictions.map((x) => x.code)])).toEqual([
      // 2P meter Mon–Fri 16:00–22:00 and Sat–Sun 07:00–22:00: one restriction per period.
      ['Russell Street', '234 Little Bourke Street', ['7510'], ['2P', '2P']],
      ['234 Little Bourke Street', 'Swanston Street', ['7505'], ['2P']],
    ]);
    expect(lists[0]!.list.payment?.parkingArea).toBe('644');
  });

  it('road-segment files without sub-segments, including split EasyPark areas', () => {
    const lists = timedDrafts(fixture('road-segment-little-collins-swanston-elizabeth.json'), 'lc.json');
    expect(lists.length).toBeGreaterThan(0);
    for (const d of lists) expect(d.list.segment.street).toBe('Little Collins Street');
  });

  it('field survey files: one list per location/bay group with timed rules', () => {
    const r = parseImportFile(fixture('little-bourke-spencer-king.json'), 'spencer.json');
    const lists = r.drafts.filter((d): d is TimedDraft => d.kind === 'timed');
    const outside639 = lists.find((d) => d.list.segment.subFrom === 'Outside 639 Little Bourke Street')!;
    expect(outside639.list).toMatchObject({ bays: [49], payment: { parkingArea: '649', easyPark: ['7504'] } });
    expect(outside639.list.restrictions.map((x) => [x.code, x.limitMinutes])).toEqual([
      ['LZ30', 30],
      ['2P', 120],
      ['2P', 120],
    ]);
    // Bays 44/43 are No Parking only, the north side and the laneways are No Stopping: skipped.
    expect(lists.some((d) => d.list.bays?.includes(44))).toBe(false);
    expect(r.skipped.length).toBeGreaterThanOrEqual(3);
  });

  it('parking-area-zone files: segment placeholders with parking area, EasyPark and the area as zone name', () => {
    const lists = timedDrafts(fixture('parking-area-zones-west-melbourne.json'), 'wm.json');
    expect(lists.length).toBeGreaterThan(10);
    expect(lists[0]!).toMatchObject({ pending: true, list: { patrolZoneName: 'West Melbourne', roadSegmentId: '21490', payment: { parkingArea: '117' }, segment: { street: 'Rosslyn Street', side: 'both' } } });
  });

  it('rejects files it does not recognise', () => {
    expect(parseImportFile('{"hello":1}', 'x.json').issues[0]!.message).toMatch(/not a recognised/i);
    expect(parseImportFile('foo,bar\n1,2', 'x.csv').issues[0]!.message).toMatch(/header/i);
    // e.g. the Python script that generates a CivicMAPS file, saved without an extension
    expect(parseImportFile('import json\nfrom pathlib import Path', 'Little-Bourke-Street__20053').issues[0]!.message).toMatch(/not a recognised/i);
  });
});

describe('planImport', () => {
  it('marks every created or updated list as a system list from its file(s) (OQ26-5)', () => {
    const existing: TimedList = timed({
      id: 'officer-list',
      source: { origin: 'officer', serviceDay: '2026-11-21' },
      segment: { street: 'Smith Street', fromStreet: 'Johnston St', toStreet: 'Gertrude St', side: 'both', suburb: 'Fitzroy' },
    });
    const csv = [
      LEGACY_TIMED_HEADER,
      '3,North,Smith Street,Johnston St,Gertrude St,both,Fitzroy,,,,,,,,2P,,Mon-Fri,08:00,18:00,,,',
      '3,North,Brunswick Street,Johnston St,Gertrude St,both,Fitzroy,,,,,,,,1P,,Mon-Fri,09:00,17:00,,,',
    ].join('\n');
    const plan = planImport(parseImportFile(csv, 'zone-3.csv').drafts, [existing], { updateExisting: true }, 1_800_000_000_000);
    for (const l of [...plan.created, ...plan.updated]) expect(l.source).toEqual({ origin: 'system', importedFrom: 'zone-3.csv', importedAt: 1_800_000_000_000 });
    expect(plan.updated[0]!.id).toBe('officer-list');
  });

  it('creates new lists and updates the matching segment, keeping its id, linked allow lists and restrictions when the import has none', () => {
    const existing: TimedList = timed({
      id: 'keep-me',
      allowListIds: ['allow-1'],
      segment: { street: 'Smith Street', fromStreet: 'Johnston St', toStreet: 'Gertrude St', side: 'both', suburb: 'Fitzroy' },
    });
    const csv = [
      LEGACY_TIMED_HEADER,
      '3,North,smith street,Gertrude St,Johnston St,both,Fitzroy,,,,,,,,,,,,,,,',
      '3,North,Brunswick Street,Johnston St,Gertrude St,both,Fitzroy,,,,,,,,1P,,Mon-Fri,09:00,17:00,,,',
    ].join('\n');
    const plan = planImport(parseImportFile(csv, 'x.csv').drafts, [existing], { updateExisting: true });
    expect(plan.created.map((l) => l.name)).toEqual(['Brunswick St, Johnston St – Gertrude St']);
    expect(plan.updated).toHaveLength(1);
    const u = plan.updated[0] as TimedList;
    expect(u).toMatchObject({ id: 'keep-me', allowListIds: ['allow-1'], patrolZone: '3', patrolZoneName: 'North' });
    expect(u.restrictions).toEqual(existing.restrictions);
  });

  it('leaves matching lists alone when updating is off, and merges permits into an allow list of the same name', () => {
    const existingAllow: AllowList = {
      id: 'a1', type: 'allow', name: 'RPA 12 residents', notes: '', createdAt: 0, updatedAt: 0,
      entries: [{ id: 'e1', plate: 'XYZ789', key: 'XYZ789', label: 'Old', permitNo: '', validFrom: '', validTo: '', addedAt: 0 }],
    };
    const csv = [CSV_TEMPLATES.allow.header, 'rpa 12 residents,XYZ789,Visitor,V-9,,', 'RPA 12 residents,NEW111,Resident,,,'].join('\n');
    const plan = planImport(parseImportFile(csv, 'p.csv').drafts, [existingAllow], { updateExisting: true });
    const merged = plan.updated[0] as AllowList;
    expect(merged.id).toBe('a1');
    expect(merged.entries.map((e) => [e.plate, e.label, e.permitNo])).toEqual([
      ['XYZ789', 'Visitor', 'V-9'],
      ['NEW111', 'Resident', ''],
    ]);
    const skipped = planImport(parseImportFile(csv, 'p.csv').drafts, [existingAllow], { updateExisting: false });
    expect(skipped.updated).toEqual([]);
    expect(skipped.unchanged).toBe(1);
  });

  it('matches segments regardless of cross-street order and spelling of Street/St', () => {
    expect(segmentKey({ street: 'Smith Street', fromStreet: 'Johnston St', toStreet: 'Gertrude Street', side: 'both', suburb: '' })).toBe(
      segmentKey({ street: 'smith st', fromStreet: 'Gertrude St', toStreet: 'Johnston Street', side: 'both', suburb: 'Fitzroy' }),
    );
  });
});

describe('kerbside releases and area datasets through the importer', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

  it('imports a civicmaps.kerbside_release and reports an invalid one by path without importing it', () => {
    const r = parseImportFile(read('datasets/examples/com-cbd-example.release.json'), 'example.release.json');
    expect(r.kind).toBe('civicmaps-release');
    expect(r.issues).toEqual([]);
    // 6 extents: the north side (No Stopping only) and the stretch with no parking spaces are left out.
    expect(r.drafts.length).toBe(4);
    expect(r.skipped).toHaveLength(2);
    const bad = JSON.parse(read('datasets/examples/com-cbd-example.release.json'));
    bad.rules[0].days = ['funday'];
    const rb = parseImportFile(JSON.stringify(bad), 'bad.json');
    expect(rb.drafts).toEqual([]);
    expect(rb.issues[0]!.message).toMatch(/^rules\[0\]\.days/);
  });

  it('imports the Area 10 source file as it is (converted on the way in)', () => {
    const r = parseImportFile(read('tests/fixtures/copp-area-10-source.json'), 'Area 10.json');
    expect(r.kind).toBe('area-dataset');
    expect(r.issues).toEqual([]);
    expect(r.drafts).toHaveLength(55);
  });

  it('re-importing a dataset matches lists by external ID, even after the street was renamed on the device', () => {
    const text = read('datasets/copp-patrol-area-10.release.json');
    const first = planImport(parseImportFile(text, 'a.json').drafts, [], { updateExisting: true });
    const onDevice = first.created.map((l) => (l.type === 'timed' && l.segment.street === 'Normanby Road' ? { ...l, segment: { ...l.segment, street: 'Normanby Rd (renamed)' } } : l));
    const second = planImport(parseImportFile(text, 'a.json').drafts, onDevice, { updateExisting: true });
    expect(second.created).toEqual([]);
    expect(second.updated).toHaveLength(55);
  });
});
