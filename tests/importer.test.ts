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
  type TimedDraft,
} from '../src/lib/importer';
import type { AllowList, HotList, TimedList } from '../src/lib/types';
import { timed } from './fixtures';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/civicmaps-preview/${name}`, import.meta.url), 'utf8');
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
    expect(parseSign('no_stopping')).toEqual({ note: 'No stopping' });
    expect(parseSign('No Parking')).toEqual({ note: 'No parking' });
    expect(parseSign('loading_zone')).toEqual({ note: 'Loading zone (no time limit given)' });
  });
});

describe('timed CSV template', () => {
  it('groups rows into one list per side (or sub-segment) with one restriction per row', () => {
    const csv = [
      CSV_TEMPLATES.timed.header,
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
    expect(coventry!.payment).toEqual({ easyPark: [], payStay: [{ zone: '338851200002', meter: '' }] });
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
      CSV_TEMPLATES.timed.header,
      ',,Bay Street,Graham Street,Ross Street,north,,,,,,,,,2P,,Someday,08:00,18:00,,,',
      ',,,Graham Street,Ross Street,north,,,,,,,,,2P,,Mon-Fri,08:00,18:00,,,',
    ].join('\n');
    const r = parseImportFile(csv, 'bad.csv');
    expect(r.issues.map((i) => i.row)).toEqual([2, 3]);
    expect(r.issues[0]!.message).toMatch(/days/i);
    expect(r.issues[1]!.message).toMatch(/street/i);
  });

  it('treats 00:00–24:00 and blank times as all day', () => {
    const csv = [CSV_TEMPLATES.timed.header, ',,Bay Street,Graham Street,Ross Street,both,,,,,,,,,P15,,Mon-Sun,00:00,24:00,,,'].join('\n');
    const [d] = timedDrafts(csv, 'x.csv');
    expect(d!.list.restrictions[0]).toMatchObject({ allDay: true, days: [0, 1, 2, 3, 4, 5, 6] });
  });

  it('ships templates whose example rows import cleanly', () => {
    for (const kind of ['timed', 'allow', 'hot'] as const) {
      const r = parseImportFile(CSV_TEMPLATES[kind].header + '\n' + CSV_TEMPLATES[kind].example, `${kind}.csv`);
      expect(r.issues, kind).toEqual([]);
      expect(r.drafts.length, kind).toBeGreaterThan(0);
    }
  });
});

describe('allow and hot list CSV templates', () => {
  it('builds allow lists by name with permits and Australian or ISO dates', () => {
    const csv = [CSV_TEMPLATES.allow.header, 'RPA 12 residents,1ab 2cd,Resident,P-1001,01/07/2026,30/06/2027', 'RPA 12 residents,XYZ789,Visitor,,2026-07-01,'].join('\n');
    const r = parseImportFile(csv, 'permits.csv');
    expect(r.kind).toBe('allow-csv');
    const [d] = r.drafts;
    expect(d!.kind === 'allow' && d!.list.name).toBe('RPA 12 residents');
    const entries = (d!.list as AllowList).entries;
    expect(entries.map((e) => [e.plate, e.key, e.permitNo, e.validFrom, e.validTo])).toEqual([
      ['1AB2CD', '1AB2CD', 'P-1001', '2026-07-01', '2027-06-30'],
      ['XYZ789', 'XYZ789', '', '2026-07-01', ''],
    ]);
  });

  it('builds hot lists with risk level and risk labels or keys', () => {
    const csv = [CSV_TEMPLATES.hot.header, 'Officer safety,ABC123,high,Aggressive; weapon_sighted,Toyota,Hilux,Ute,White,Seen near market'].join('\n');
    const r = parseImportFile(csv, 'hot.csv');
    expect(r.kind).toBe('hot-csv');
    const e = (r.drafts[0]!.list as HotList).entries[0]!;
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
    expect(bays.list.notes).toMatch(/Loading zone \(no time limit given\) Mon–Fri 07:00–16:00/);
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
  it('creates new lists and updates the matching segment, keeping its id, linked allow lists and restrictions when the import has none', () => {
    const existing: TimedList = timed({
      id: 'keep-me',
      allowListIds: ['allow-1'],
      segment: { street: 'Smith Street', fromStreet: 'Johnston St', toStreet: 'Gertrude St', side: 'both', suburb: 'Fitzroy' },
    });
    const csv = [
      CSV_TEMPLATES.timed.header,
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
