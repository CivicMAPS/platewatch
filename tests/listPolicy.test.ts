import { describe, expect, it } from 'vitest';
import {
  allowsPaidParking,
  canImportInCommandMaps,
  canImportOnDevice,
  creatableListTypes,
  deploymentMode,
  isActiveList,
  listPermissions,
  officerSource,
  systemSource,
  type PolicyContext,
} from '../src/lib/listPolicy';
import { localDateString } from '../src/lib/time';
import type { ListSource } from '../src/lib/types';

const DEV: PolicyContext = { mode: 'development' };
const EMAPS: PolicyContext = { mode: 'enforcementmaps', role: 'officer' };
const NOW = new Date(2026, 10, 22, 14, 30).getTime(); // 22/11/2026 14:30 local
const YESTERDAY = new Date(2026, 10, 21, 23, 59).getTime();

const system = { source: systemSource('zone-3.csv', NOW) };
const officerToday = { source: officerSource(NOW) };
const officerYesterday = { source: officerSource(YESTERDAY) };
const legacy = { source: undefined as ListSource | undefined };

describe('deploymentMode', () => {
  it('is development unless the build asks for EnforcementMAPS exactly', () => {
    expect(deploymentMode({})).toBe('development');
    expect(deploymentMode({ VITE_PLATEWATCH_MODE: 'enforcementmaps' })).toBe('enforcementmaps');
    expect(deploymentMode({ VITE_PLATEWATCH_MODE: 'EnforcementMAPS' })).toBe('development');
  });
});

describe('development build: every list can be imported and edited in PlateWatch', () => {
  it('imports on the device and creates every list type, with paid parking', () => {
    expect(canImportOnDevice(DEV)).toBe(true);
    expect(creatableListTypes(DEV)).toEqual(['timed', 'permit_zone', 'hot', 'allow']);
    expect(allowsPaidParking(null, DEV)).toBe(true);
  });

  it('edits and deletes system, officer, expired and legacy lists, flagging the system-list override', () => {
    for (const l of [system, officerToday, officerYesterday, legacy]) {
      const p = listPermissions(l, DEV, NOW);
      expect(p).toMatchObject({ edit: true, delete: true, locked: null });
      expect(isActiveList(l, DEV, NOW)).toBe(true);
    }
    expect(listPermissions(system, DEV, NOW).devOverride).toBe(true);
    expect(listPermissions(officerToday, DEV, NOW).devOverride).toBe(false);
  });
});

describe('EnforcementMAPS: imports in CommandMAPS, system lists read-only, officer lists for the day', () => {
  it('never imports on the device', () => {
    expect(canImportOnDevice(EMAPS)).toBe(false);
    expect(canImportOnDevice({ mode: 'enforcementmaps', role: 'team_leader' })).toBe(false);
  });

  it('imports in CommandMAPS only for authorised team leaders and parking services management', () => {
    expect(canImportInCommandMaps('team_leader', true)).toBe(true);
    expect(canImportInCommandMaps('parking_services_manager', true)).toBe(true);
    expect(canImportInCommandMaps('team_leader', false)).toBe(false);
    expect(canImportInCommandMaps('officer', true)).toBe(false);
    expect(canImportInCommandMaps(undefined, true)).toBe(false);
  });

  it('lets officers create timed chalking lists only, without paid parking', () => {
    expect(creatableListTypes(EMAPS)).toEqual(['timed']);
    expect(allowsPaidParking(null, EMAPS)).toBe(false);
    expect(allowsPaidParking(officerToday, EMAPS)).toBe(false);
    expect(allowsPaidParking(system, EMAPS)).toBe(true);
  });

  it('locks system lists', () => {
    expect(listPermissions(system, EMAPS, NOW)).toEqual({ origin: 'system', edit: false, delete: false, locked: 'system', devOverride: false });
  });

  it("lets the officer edit today's own list, and expires it at local midnight", () => {
    expect(listPermissions(officerToday, EMAPS, NOW)).toMatchObject({ origin: 'officer', edit: true, delete: true, locked: null });
    expect(listPermissions(officerYesterday, EMAPS, NOW)).toMatchObject({ edit: false, delete: false, locked: 'expired' });
    expect(isActiveList(officerYesterday, EMAPS, NOW)).toBe(false);
    expect(isActiveList(officerToday, EMAPS, NOW)).toBe(true);
    expect(isActiveList(system, EMAPS, NOW)).toBe(true);
  });

  it('treats a list saved before provenance existed as an undated officer list', () => {
    expect(listPermissions(legacy, EMAPS, NOW)).toMatchObject({ origin: 'officer', edit: true, locked: null });
    expect(isActiveList(legacy, EMAPS, NOW)).toBe(true);
  });
});

describe('provenance stamps', () => {
  it('records the service day for officer lists and the file for system lists', () => {
    expect(officerSource(NOW)).toEqual({ origin: 'officer', serviceDay: localDateString(NOW) });
    expect(systemSource('a.csv, b.json', NOW)).toEqual({ origin: 'system', importedFrom: 'a.csv, b.json', importedAt: NOW });
  });
});

describe('removing known-vehicle tags', () => {
  it('is possible on the device in development only', async () => {
    const { canRemoveTagsOnDevice } = await import('../src/lib/listPolicy');
    expect(canRemoveTagsOnDevice(DEV)).toBe(true);
    expect(canRemoveTagsOnDevice(EMAPS)).toBe(false);
    expect(canRemoveTagsOnDevice({ mode: 'enforcementmaps', role: 'supervisor' })).toBe(false);
  });

  it('in CommandMAPS needs a supervisor or above with parking services branch authority', async () => {
    const { canRemoveTagsInCommandMaps } = await import('../src/lib/listPolicy');
    for (const role of ['supervisor', 'team_leader', 'parking_services_manager'] as const) {
      expect(canRemoveTagsInCommandMaps(role, true)).toBe(true);
      expect(canRemoveTagsInCommandMaps(role, false)).toBe(false);
    }
    expect(canRemoveTagsInCommandMaps('officer', true)).toBe(false);
    expect(canRemoveTagsInCommandMaps(undefined, true)).toBe(false);
  });
});
