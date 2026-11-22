/**
 * Adapters between civicmaps.kerbside_release and PlateWatch, and from council source formats to
 * a release (the interim, candidate conversion until the CivicMAPS backend owns it).
 *
 *   releaseToDrafts      release → PlateWatch timed lists (one per extent)
 *   listsToRelease       PlateWatch timed lists → release (export)
 *   areaDatasetToRelease council "street_segments + record_defaults" dataset (e.g. City of Port
 *                        Phillip Patrol Area 10) → release
 */
import { uid } from './db';
import {
  DAYS,
  emptyRelease,
  ReleaseBuilder,
  SIDES,
  STAY_REQUIRED,
  type BoundType,
  type Day,
  type KerbsideRelease,
  type RuleRow,
  type RuleType,
  type Side,
} from './kerbsideRelease';
import { minutesFromCode } from './restriction';
import type { PaymentAreas, StreetSide, TimedList, TimedRestriction, UntimedControl, Weekday } from './types';

/* ───────────────────────────── Councils ───────────────────────────── */

/** Council codes and display conventions known to the pilot. Others: initials of the name. */
export const COUNCILS: Record<string, { code: string; state: string }> = {
  'city of melbourne': { code: 'com', state: 'VIC' },
  'city of port phillip': { code: 'copp', state: 'VIC' },
};

export function councilCode(name: string): string {
  const known = COUNCILS[name.trim().toLowerCase()];
  if (known) return known.code;
  return (
    name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w[0]!.toLowerCase())
      .join('') || 'council'
  );
}

/* ───────────────────────────── Release → PlateWatch ───────────────────────────── */

export interface ReleaseDraft {
  list: Omit<TimedList, 'id' | 'createdAt' | 'updatedAt'>;
  pending: boolean;
}

const WEEKDAY: Record<Day, Weekday> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_OF: Day[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIMED = new Set<RuleType>(['time_limit', 'metered', 'ticket', 'loading_zone']);
const RULE_LABEL: Record<RuleType, string> = {
  time_limit: 'Time limit',
  metered: 'Meter',
  ticket: 'Ticket',
  loading_zone: 'Loading zone',
  permit_zone: 'Permit zone',
  no_stopping: 'No stopping',
  no_parking: 'No parking',
  clearway: 'Clearway',
  bus_zone: 'Bus zone',
  taxi_zone: 'Taxi zone',
  accessible: 'Accessible parking',
  works_zone: 'Works zone',
  other: 'Other',
};
const SHORT: Record<string, string> = { Street: 'St', Road: 'Rd', Avenue: 'Ave', Parade: 'Pde', Place: 'Pl', Highway: 'Hwy', Crescent: 'Cres', Court: 'Ct', Drive: 'Dr', Terrace: 'Tce', Boulevard: 'Bvd' };
const short = (n: string) => n.replace(/\b(Street|Road|Avenue|Parade|Place|Highway|Crescent|Court|Drive|Terrace|Boulevard)$/, (w) => SHORT[w] ?? w);
const SIDE_LETTER: Record<Side, string> = { north: 'N', south: 'S', east: 'E', west: 'W', centre: 'C', both: '', odd: 'odd', even: 'even' };

const timesOf = (r: RuleRow) => (r.all_day || (r.start === '00:00' && r.end === '24:00') ? { allDay: true, startTime: '00:00', endTime: '24:00' } : { allDay: false, startTime: r.start!, endTime: r.end! });

/** One timed list per extent; the list's external ID is the extent ID. */
export function releaseToDrafts(r: KerbsideRelease): { drafts: ReleaseDraft[]; skipped: string[] } {
  const segments = new Map(r.segments.map((s) => [s.segment_id, s]));
  const zones = new Map(r.zones.map((z) => [z.zone_id, z]));
  const schemes = new Map(r.zone_schemes.map((s) => [s.scheme_id, s]));
  const providers = new Map(r.provider_areas.map((p) => [p.provider_area_id, p]));
  const rules = new Map(r.rules.map((x) => [x.rule_id, x]));
  const by = <T extends { extent_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of rows) m.set(x.extent_id, [...(m.get(x.extent_id) ?? []), x]);
    return m;
  };
  const zoneAs = by(r.zone_assignments);
  const provAs = by(r.provider_area_assignments);
  const ruleAs = by(r.rule_assignments);
  const bays = by(r.bays);
  const drafts: ReleaseDraft[] = [];
  const skipped: string[] = [];

  for (const e of r.extents) {
    const s = segments.get(e.segment_id)!;
    const part = e.from_label || e.to_label ? `, ${e.from_label ?? '…'} – ${e.to_label ?? '…'}` : '';
    const where = `${s.display_id} ${s.road_name} ${s.from_label} – ${s.to_label}, ${e.side === 'both' ? 'both sides' : `${e.side} side`}${part}`;
    if (e.restrictions_status === 'no_parking_spaces') {
      skipped.push(`${where}: no parking spaces`);
      continue;
    }
    const restrictions: TimedRestriction[] = [];
    const untimed: UntimedControl[] = [];
    for (const a of ruleAs.get(e.extent_id) ?? []) {
      const rule = rules.get(a.rule_id)!;
      const days = rule.days.map((d) => WEEKDAY[d]).sort((x, y) => x - y);
      const description = [rule.type === 'metered' || rule.type === 'ticket' ? RULE_LABEL[rule.type] : '', ...rule.exceptions].filter(Boolean).join(' · ');
      const minutes = rule.max_stay_minutes ?? (rule.sign_code ? minutesFromCode(rule.sign_code) : null);
      if (TIMED.has(rule.type) && minutes) {
        const code = rule.sign_code || (rule.type === 'loading_zone' ? `LZ${minutes}` : `${minutes} min`);
        restrictions.push({ id: uid(), code, limitMinutes: minutes, graceMinutes: a.grace_minutes ?? 0, days, ...timesOf(rule), description });
      } else untimed.push({ control: rule.type, label: rule.sign_code || RULE_LABEL[rule.type], days, ...timesOf(rule), description });
    }
    if (e.restrictions_status === 'supplied' && !restrictions.length) {
      skipped.push(`${where}: no timed parking (${[...new Set(untimed.map((u) => u.label))].join('; ') || 'no rules'})`);
      continue;
    }
    let patrolZone: string | undefined;
    let patrolZoneName: string | undefined;
    let rpa: string | undefined;
    const payment: PaymentAreas = { easyPark: [], payStay: [] };
    for (const a of zoneAs.get(e.extent_id) ?? []) {
      const z = zones.get(a.zone_id)!;
      const kind = schemes.get(z.scheme_id)!.kind;
      if (kind === 'patrol') {
        patrolZone ??= z.code;
        if (z.name) patrolZoneName ??= z.name;
      } else if (kind === 'rpa') rpa ??= z.code;
      else if (kind === 'parking_area') payment.parkingArea ??= z.code;
    }
    for (const a of provAs.get(e.extent_id) ?? []) {
      const p = providers.get(a.provider_area_id)!;
      if (p.provider === 'easypark' && !payment.easyPark.includes(p.area_code)) payment.easyPark.push(p.area_code);
      if (p.provider === 'paystay' && !payment.payStay.some((x) => x.zone === p.area_code)) payment.payStay.push({ zone: p.area_code, meter: a.meter_id ?? '' });
    }
    const extentBays = (bays.get(e.extent_id) ?? []).filter((b) => b.status === 'active');
    const located = extentBays.filter((b) => b.lat !== null && b.lng !== null);
    const sideLetter = SIDE_LETTER[e.side] ? ` (${SIDE_LETTER[e.side]})` : '';
    const sub = e.from_label || e.to_label ? ` · ${short(e.from_label ?? '…')} – ${short(e.to_label ?? '…')}` : '';
    drafts.push({
      pending: !restrictions.length,
      list: {
        type: 'timed',
        name: `${short(s.road_name)}, ${short(s.from_label)} – ${short(s.to_label)}${sideLetter}${sub}`,
        notes: [e.notes, s.notes].filter(Boolean).join('\n'),
        segment: {
          street: s.road_name,
          fromStreet: s.from_label,
          toStreet: s.to_label,
          side: e.side as StreetSide,
          suburb: s.locality ?? '',
          ...(e.from_label ? { subFrom: e.from_label } : {}),
          ...(e.to_label ? { subTo: e.to_label } : {}),
        },
        restrictions,
        allowListIds: [],
        externalId: e.extent_id,
        displayId: s.display_id,
        ...(patrolZone ? { patrolZone } : {}),
        ...(patrolZoneName ? { patrolZoneName } : {}),
        ...(rpa ? { rpa } : {}),
        ...(s.asset_id ? { roadSegmentId: s.asset_id } : {}),
        ...(payment.parkingArea || payment.easyPark.length || payment.payStay.length ? { payment } : {}),
        ...(extentBays.length ? { bays: [...new Set(extentBays.map((b) => b.bay_number))].sort((x, y) => x - y) } : {}),
        ...(located.length ? { bayPoints: located.map((b) => ({ bay: b.bay_number, lat: b.lat!, lng: b.lng!, ...(b.plate_number ? { sign: b.plate_number } : {}) })) } : {}),
        ...(untimed.length ? { untimedControls: untimed } : {}),
      },
    });
  }
  return { drafts, skipped };
}

/* ───────────────────────────── PlateWatch → release ───────────────────────────── */

const boundType = (label: string): BoundType =>
  /^bay\s*\d+/i.test(label) ? 'bay' : /^point\s+-?\d/i.test(label) ? 'point' : /^\d/.test(label) || /\b(outside|opposite)\b/i.test(label) ? 'address' : 'intersection';

/**
 * Export timed lists as a candidate release. Segments are keyed by the owner prefix and asset ID
 * (or asset name); a list's extent is its side and, where set, its part bounds.
 */
export function listsToRelease(
  lists: readonly TimedList[],
  meta: { municipality: string; councilCode?: string; linkingId?: string | null; timezone: string; datasetId?: string; version?: string; generatedAt?: string },
): KerbsideRelease {
  const code = meta.councilCode ?? councilCode(meta.municipality);
  const generatedAt = meta.generatedAt ?? new Date().toISOString();
  const known = COUNCILS[meta.municipality.trim().toLowerCase()];
  const b = new ReleaseBuilder(
    emptyRelease({
      dataset_id: meta.datasetId ?? `platewatch-export-${generatedAt.slice(0, 10)}`,
      council_code: code,
      linking_id: meta.linkingId ?? null,
      municipality_name: meta.municipality,
      state: known?.state ?? null,
      country: known ? 'AU' : null,
      timezone: meta.timezone,
      version: meta.version ?? '1',
      generated_at: generatedAt,
      notes: 'Exported from PlateWatch: a working copy for review, not an approved release.',
    }),
  );
  const src = b.source({ name: 'PlateWatch device lists', issuer: 'PlateWatch', dataset: null, url: null, format: 'PlateWatch export', licence: null, reference_date: generatedAt.slice(0, 10), data_used: [], limitations: ['Entered or imported on a device; not verified by the council.'] });
  for (const l of lists) {
    const segmentId = b.segment({ asset_id: l.roadSegmentId ?? null, road_name: l.segment.street, from_label: l.segment.fromStreet, to_label: l.segment.toStreet, locality: l.segment.suburb || null, source_id: src });
    if (l.roadSegmentId) b.sourceRef(segmentId, src, l.roadSegmentId, 'road_segment_asset_id');
    const hasRules = l.restrictions.length > 0 || (l.untimedControls?.length ?? 0) > 0;
    const extentId = b.extent({
      segment_id: segmentId,
      side: (SIDES as readonly string[]).includes(l.segment.side) ? (l.segment.side as Side) : 'both',
      from_label: l.segment.subFrom ?? null,
      from_type: l.segment.subFrom ? boundType(l.segment.subFrom) : null,
      to_label: l.segment.subTo ?? null,
      to_type: l.segment.subTo ? boundType(l.segment.subTo) : null,
      restrictions_status: hasRules ? 'supplied' : 'pending_field_capture',
      notes: l.notes || null,
    });
    if (l.patrolZone || l.patrolZoneName) b.zone(extentId, 'patrol', l.patrolZone || l.patrolZoneName!, l.patrolZoneName ?? null, { source_id: src });
    const rpaZone = l.rpa ? b.zone(extentId, 'rpa', l.rpa, null, { source_id: src }) : null;
    if (l.payment?.parkingArea) b.zone(extentId, 'parking_area', l.payment.parkingArea, null, { source_id: src });
    for (const a of l.payment?.easyPark ?? []) b.providerArea(extentId, 'easypark', a, { source_id: src });
    for (const p of l.payment?.payStay ?? []) b.providerArea(extentId, 'paystay', p.zone, { meter_id: p.meter || null, source_id: src });
    const points = new Map((l.bayPoints ?? []).map((p) => [p.bay, p]));
    for (const n of l.bays ?? []) {
      const p = points.get(n);
      b.bay(extentId, { bay_number: n, lat: p?.lat ?? null, lng: p?.lng ?? null, plate_number: p?.sign ?? null });
    }
    for (const r of l.restrictions) {
      const metered = /\bmeter\b/i.test(r.description);
      const ticket = /\bticket\b/i.test(r.description);
      const exceptions = r.description.split(' · ').map((x) => x.trim()).filter((x) => x && !/^(meter|ticket)$/i.test(x));
      b.rule(
        extentId,
        {
          type: /^LZ/i.test(r.code) ? 'loading_zone' : metered ? 'metered' : ticket ? 'ticket' : 'time_limit',
          sign_code: r.code,
          max_stay_minutes: r.limitMinutes,
          days: r.days.map((d) => DAY_OF[d]!),
          all_day: r.allDay,
          start: r.startTime,
          end: r.endTime,
          exceptions,
          exempt_zone_ids: rpaZone && exceptions.some((x) => /permit/i.test(x)) ? [rpaZone] : [],
        },
        { grace_minutes: r.graceMinutes || null, source_id: src },
      );
    }
    for (const u of l.untimedControls ?? []) {
      b.rule(extentId, { type: u.control, sign_code: u.label !== RULE_LABEL[u.control] ? u.label : null, days: u.days.map((d) => DAY_OF[d]!), all_day: u.allDay, start: u.startTime, end: u.endTime, exceptions: u.description ? [u.description] : [] }, { source_id: src });
    }
  }
  return b.r;
}

/* ───────────────────────────── Council area datasets → release ───────────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** "street_segments" area datasets (e.g. City of Port Phillip Patrol Area 10, with record_defaults). */
export function isAreaDataset(v: unknown): boolean {
  return isObj(v) && Array.isArray(v.street_segments) && (isObj(v.record_defaults) || 'dataset_title' in v);
}

const AREA_RULE: [RegExp, RuleType][] = [
  [/no\s*stopping/i, 'no_stopping'],
  [/no\s*parking/i, 'no_parking'],
  [/clearway/i, 'clearway'],
  [/loading/i, 'loading_zone'],
  [/permit/i, 'permit_zone'],
  [/bus/i, 'bus_zone'],
  [/taxi/i, 'taxi_zone'],
  [/disab|accessible/i, 'accessible'],
  [/meter/i, 'metered'],
  [/ticket/i, 'ticket'],
];

/**
 * Adapt an area dataset to a candidate release. record_defaults are applied to each record; the
 * council's own segment_id is kept as a source reference (id_scheme source_row_id); a road
 * segment asset ID, when present (road_segment_id, road_segment_asset_id or asset_id), keys the
 * segment and is kept as a road_segment_asset_id reference; a placeholder restriction
 * (restriction_applied null) leaves the extent pending.
 */
export function areaDatasetToRelease(src: Record<string, unknown>, opts: { linkingId?: string | null; timezone?: string } = {}): { release: KerbsideRelease; warnings: string[] } {
  const warnings: string[] = [];
  const defaults = isObj(src.record_defaults) ? src.record_defaults : {};
  const scope = isObj(src.scope) ? src.scope : {};
  const municipality = str(scope.municipality) || 'Unknown council';
  const code = councilCode(municipality);
  const known = COUNCILS[municipality.toLowerCase()];
  const area = str(defaults.enforcement_zone) || (Array.isArray(scope.requested_enforcement_zones) ? str(scope.requested_enforcement_zones[0]) : '');
  const notes = [str(scope.area_depicted), str(scope.important_distinction), ...(Array.isArray(src.missing_authoritative_fields) ? [`Missing authoritative fields: ${src.missing_authoritative_fields.map(str).join(', ')}`] : [])].filter(Boolean);
  const b = new ReleaseBuilder(
    emptyRelease({
      dataset_id: area ? `patrol-area-${area}` : 'street-segments',
      council_code: code,
      linking_id: opts.linkingId ?? null,
      municipality_name: municipality,
      state: known?.state ?? null,
      country: known ? 'AU' : null,
      timezone: opts.timezone ?? 'Australia/Melbourne',
      version: '1',
      notes: [str(src.dataset_title), ...notes].filter(Boolean).join('\n') || null,
    }),
  );
  const sources = (Array.isArray(src.accessible_sources) ? src.accessible_sources : []).filter(isObj).map((s) =>
    b.source({
      name: str(s.name),
      issuer: str(s.publisher) || null,
      dataset: str(s.reference) || str(s.map_reference) || null,
      url: str(s.resource_url) || str(s.catalogue_url) || str(s.wfs_url) || null,
      format: str(s.format) || null,
      licence: null,
      reference_date: str(s.reference_period) || str(s.document_date) || null,
      data_used: (Array.isArray(s.data_used) ? s.data_used : []).map(str).filter(Boolean),
      limitations: (Array.isArray(s.limitations) ? s.limitations : []).map(str).filter(Boolean),
    }),
  );
  const mapSource = sources[0] ?? null;
  for (const raw of (src.street_segments as unknown[]).filter(isObj)) {
    const r = { ...defaults, ...raw } as Record<string, unknown>;
    const assetId = str(r.road_segment_id) || str(r.road_segment_asset_id) || str(r.asset_id) || null;
    const dq = isObj(r.data_quality) ? r.data_quality : {};
    const restrictions = (Array.isArray(r.parking_restrictions) ? r.parking_restrictions : []).filter(isObj).filter((pr) => pr.restriction_applied);
    const segmentId = b.segment({
      asset_id: assetId,
      road_name: str(r.road_segment_name),
      from_label: str(r.between_street_name),
      to_label: str(r.and_street_name),
      locality: str(r.locality) || null,
      geometry: isObj(r.geometry) ? (r.geometry as never) : null,
      verification: restrictions.length ? 'unverified' : 'pending_field_capture',
      source_id: mapSource,
      notes: [str(dq.endpoints_status), str(dq.restriction_status)].filter(Boolean).join('; ') || null,
    });
    if (mapSource && str(r.segment_id)) b.sourceRef(segmentId, mapSource, str(r.segment_id), 'source_row_id');
    if (mapSource && assetId) b.sourceRef(segmentId, mapSource, assetId, 'road_segment_asset_id');
    const side = (SIDES as readonly string[]).includes(str(r.road_side)) ? (str(r.road_side) as Side) : 'both';
    const extentId = b.extent({ segment_id: segmentId, side, restrictions_status: restrictions.length ? 'supplied' : 'pending_field_capture' });
    if (str(r.enforcement_zone)) b.zone(extentId, 'patrol', str(r.enforcement_zone), null, { source_id: mapSource });
    for (const pr of restrictions) {
      const text = str(pr.restriction_applied);
      const signCode = /(\d+\/\d+P|\d+P|P\d+)/i.exec(text)?.[1]?.toUpperCase() ?? null;
      const type = AREA_RULE.find(([re]) => re.test(text))?.[1] ?? (signCode ? 'time_limit' : null);
      if (!type) {
        warnings.push(`${str(r.segment_id)}: restriction "${text}" could not be mapped and was left out.`);
        continue;
      }
      const days = (Array.isArray(pr.applicable_days) ? pr.applicable_days : []).map((d) => str(d).slice(0, 3).toLowerCase()).filter((d): d is Day => (DAYS as readonly string[]).includes(d));
      const t = isObj(pr.applicable_times) ? pr.applicable_times : {};
      const start = str(t.start);
      const end = str(t.end);
      const stay = signCode ? minutesFromCode(signCode) : null;
      if (STAY_REQUIRED.includes(type) && !stay) {
        warnings.push(`${str(r.segment_id)}: "${text}" has no readable time limit and was left out.`);
        continue;
      }
      b.rule(
        extentId,
        { type, sign_code: signCode ?? text, max_stay_minutes: stay, days: days.length ? days : [...DAYS], all_day: !(start && end), start: start || null, end: end || null, exceptions: (Array.isArray(pr.permit_or_vehicle_exceptions) ? pr.permit_or_vehicle_exceptions : []).map(str).filter(Boolean) },
        {
          source_id: mapSource,
          source_sign_id: str(pr.source_sign_or_asset_id) || null,
          valid_from: str(pr.effective_from) || null,
          valid_to: str(pr.effective_to) || null,
          verification: str(pr.verification_status) === 'verified' ? 'verified' : 'unverified',
        },
      );
    }
  }
  return { release: b.r, warnings };
}
