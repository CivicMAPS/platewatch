import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBackup } from '../src/lib/backup';
import { disabilityDoubles, findPermits, isDisabilityOnlyRestriction, isStatutoryRestriction } from '../src/lib/engine';
import { comparePlates } from '../src/lib/plate';
import { parseImportFile, planImport } from '../src/lib/importer';
import type { AllowList, HotList, TimedList } from '../src/lib/types';

const file = (p: string) => readFileSync(new URL(`../datasets/${p}`, import.meta.url), 'utf8');

/** The field-test pack imports cleanly and covers every feature (datasets/field-test/README.md). */
describe('field-test pack', () => {
  const area10 = parseImportFile(file('copp-patrol-area-10.release.json'), 'copp-patrol-area-10.release.json');
  const base = planImport(area10.drafts, [], { updateExisting: true }).created;
  const segs = parseImportFile(file('field-test/01-timed-segments.csv'), '01-timed-segments.csv');
  const plan = planImport(segs.drafts, base, { updateExisting: true });
  // The pack on its own (the usual way to test features): every list keeps its FT name.
  const alone = planImport(segs.drafts, [], { updateExisting: true }).created as TimedList[];
  const byName = (n: string) => alone.find((l) => l.name.startsWith(n))!;

  it('imports every sign row with no issues; after Area 10 it fills matching placeholders', () => {
    expect(area10.issues).toEqual([]);
    expect(segs.issues).toEqual([]);
    expect(alone).toHaveLength(8);
    // Rows for a whole segment (both sides) update the Area 10 placeholder; one-side rows add a list.
    expect(plan.updated.length).toBeGreaterThan(0);
    expect(plan.updated.length + plan.created.length).toBe(8);
    for (const l of alone) {
      expect(l.restrictions.length).toBeGreaterThan(0);
      for (const r of l.restrictions) expect(r.allDay).toBe(true); // testable at any time
    }
  });

  it('covers each kind of space', () => {
    const gN = byName('FT Gladstone St N');
    expect(gN.rpa).toBe('7');
    expect(gN.restrictions[0]).toMatchObject({ code: '2P', limitMinutes: 120 });
    expect(gN.payment?.payStay.length ?? 0).toBe(0); // timed, not paid
    expect(byName('FT Gladstone St S').payment?.payStay[0]?.zone).toBe('338800001001');
    expect(byName('FT Buckhurst St N').payment?.easyPark).toEqual(['7001']);
    expect(byName('FT Buckhurst St S').restrictions[0]).toMatchObject({ limitMinutes: 5 });
    expect(byName('FT Munro St').restrictions[0]).toMatchObject({ limitMinutes: 10 });
    const lz = byName('FT Woodgate St').restrictions[0]!;
    expect(isStatutoryRestriction(lz.code)).toBe(true);
    const dis = byName('FT Normanby Rd N').restrictions[0]!;
    expect(isDisabilityOnlyRestriction(dis.code, dis.description)).toBe(true);
    const police = byName('FT Normanby Rd S').restrictions[0]!;
    expect(isStatutoryRestriction(police.description)).toBe(true);
    expect(disabilityDoubles(gN.restrictions[0]!.code, gN.restrictions[0]!.description)).toBe(true);
  });

  it('imports the permits with area, street and validity cases', () => {
    const r = parseImportFile(file('field-test/02-permits.csv'), '02-permits.csv');
    expect(r.issues).toEqual([]);
    const lists = planImport(r.drafts, [], { updateExisting: true }).created as AllowList[];
    const entries = lists.flatMap((l) => l.entries);
    expect(entries).toHaveLength(6);
    expect(entries.find((e) => e.plate === 'PWP101')).toMatchObject({ rpa: '7', vehicle: 'White Toyota Corolla' });
    expect(entries.find((e) => e.plate === 'PWP606')?.streets).toEqual(['Gladstone St']);
    expect(entries.find((e) => e.plate === 'PWP303')?.validTo).toBe('2025-12-31');
  });

  it('imports the hot list', () => {
    const r = parseImportFile(file('field-test/03-hot-list.csv'), '03-hot-list.csv');
    expect(r.issues).toEqual([]);
    const [hot] = planImport(r.drafts, [], { updateExisting: true }).created as HotList[];
    expect(hot!.entries.map((e) => [e.plate, e.riskLevel])).toEqual([['PWH801', 'extreme'], ['PWH902', 'high'], ['PWH003', 'caution']]);
  });

  it('restores the tagged vehicles from the backup file', () => {
    const b = parseBackup(file('field-test/04-tagged-vehicles.backup.json'));
    expect(b.lists).toEqual([]);
    expect(b.flags?.map((f) => [f.plate, f.kind])).toEqual([['PWD111', 'disability'], ['PWE222', 'emergency']]);
  });

  it('gives the permit statuses and look-alikes the README promises', () => {
    const allow = planImport(parseImportFile(file('field-test/02-permits.csv'), '02-permits.csv').drafts, [], { updateExisting: true }).created as AllowList[];
    const gN = byName('FT Gladstone St N');
    const status = (plate: string) => findPermits(plate, gN, allow, Date.UTC(2026, 10, 23, 2))[0]?.status;
    expect(status('PWP101')).toBe('ACTIVE_IN_AREA');
    expect(status('PWP505')).toBe('ACTIVE_NOT_IN_AREA');
    expect(status('PWP606')).toBe('ACTIVE_IN_AREA');
    expect(status('PWP303')).toBe('NOT_ACTIVE_EXPIRED');
    expect(status('PWP404')).toBe('NOT_YET_ACTIVE');
    expect(comparePlates('PWP2F7', 'PWP2E7')).toBe('possible');
    expect(comparePlates('PWHB01', 'PWH801')).toBe('possible');
    expect(comparePlates('PWT1OO', 'PWT100')).toBe('possible');
  });
});
