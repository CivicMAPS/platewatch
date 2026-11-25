/**
 * civicmaps.kerbside_release v1: the CivicMAPS road segment and kerbside data standard (lean
 * pilot core) as an interchange package. A release is a set of flat tables; every record in a
 * table has exactly the same keys, with null (or []) where a value is unknown or not yet
 * acquired. Records link to each other by ID. Council data in any source format is adapted to
 * these tables; the tables never adapt to a council.
 *
 * Specified in docs/KERBSIDE-RELEASE.md; JSON Schema in
 * schemas/civicmaps-kerbside-release.v1.schema.json.
 *
 * Identifiers. Each council has a secret CivicMAPS ID (backend and CivicMAPS admin only, never in
 * a release), a unique linking ID that links it to the council, and a council code shown to
 * users (com, copp). Record keys start with the owner prefix: the linking ID, or the council code
 * during development until the council is onboarded (relinkRelease swaps it in). Segments are
 * keyed by the council's asset ID, or by the asset name until the asset ID is acquired:
 *   segment_id   <owner>-<asset_id | asset_name>     482771930-20567 · copp-normanby-road-from-boundary-to-montague
 *   display_id   <council_code>-<asset_id | asset_name>   com-20567 (what users see)
 *   extent_id    <segment_id>:<side>:<part>         …:south:all · …:south:bay-58-bay-72
 *   zone_id      <owner>-<scheme>-<code>            copp-rpa-7 · copp-patrol-10 · com-parking-area-645
 *
 * This module has no imports, so command-line scripts can load it directly
 * (node --experimental-strip-types scripts/…).
 */

export const RELEASE_SCHEMA = 'civicmaps.kerbside_release';
export const RELEASE_VERSION = '1.0.0';

/* ───────────────────────────── Vocabularies ───────────────────────────── */

export const SIDES = ['north', 'south', 'east', 'west', 'centre', 'both', 'odd', 'even'] as const;
export type Side = (typeof SIDES)[number];

export const BOUND_TYPES = ['intersection', 'segment_end', 'dead_end', 'boundary', 'bay', 'address', 'point'] as const;
export type BoundType = (typeof BOUND_TYPES)[number];

export const VERIFICATION = ['verified', 'field_checked', 'unverified', 'inferred', 'pending_field_capture'] as const;
export type Verification = (typeof VERIFICATION)[number];

export const RULE_TYPES = [
  'time_limit',
  'metered',
  'ticket',
  'loading_zone',
  'permit_zone',
  'no_stopping',
  'no_parking',
  'clearway',
  'bus_zone',
  'taxi_zone',
  'accessible',
  'works_zone',
  'other',
] as const;
export type RuleType = (typeof RULE_TYPES)[number];
/** Rule types that need max_stay_minutes. */
export const STAY_REQUIRED: readonly RuleType[] = ['time_limit', 'metered', 'ticket'];

export const ZONE_KINDS = ['rpa', 'patrol', 'parking_area', 'operational'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

export const PROVIDERS = ['easypark', 'paystay', 'other'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];

export const RESTRICTIONS_STATUS = ['supplied', 'pending_field_capture', 'no_parking_spaces'] as const;
export type RestrictionsStatus = (typeof RESTRICTIONS_STATUS)[number];

/* ───────────────────────────── Records (one interface per table) ───────────────────────────── */

export interface ReleaseRow {
  release_id: string;
  dataset_id: string;
  council_code: string;
  /** Unique linking ID for the council; null during development (council code used as owner prefix). */
  linking_id: string | null;
  municipality_name: string;
  state: string | null;
  country: string | null;
  timezone: string;
  version: string;
  kind: 'snapshot' | 'delta';
  status: 'candidate' | 'approved' | 'superseded';
  effective_from: string | null;
  generated_at: string | null;
  notes: string | null;
}

export interface SourceRow {
  source_id: string;
  name: string;
  issuer: string | null;
  dataset: string | null;
  url: string | null;
  format: string | null;
  licence: string | null;
  reference_date: string | null;
  data_used: string[];
  limitations: string[];
}

export interface GeoLine {
  type: 'LineString' | 'MultiLineString';
  coordinates: unknown[];
}

export interface SegmentRow {
  segment_id: string;
  display_id: string;
  /** The council's road segment asset ID; null until acquired. */
  asset_id: string | null;
  /** What the segment is known as: bourke-street-from-russell-to-swanston. */
  asset_name: string;
  road_name: string;
  locality: string | null;
  from_label: string;
  from_type: BoundType;
  to_label: string;
  to_type: BoundType;
  geometry: GeoLine | null;
  status: 'candidate' | 'active' | 'retired';
  verification: Verification;
  source_id: string | null;
  notes: string | null;
}

export interface SegmentSourceRefRow {
  ref_id: string;
  segment_id: string;
  source_id: string;
  /** Identifier as issued, kept as text (leading zeroes preserved). */
  external_id: string;
  id_scheme: 'road_segment_asset_id' | 'source_row_id';
  notes: string | null;
}

export interface ExtentRow {
  extent_id: string;
  segment_id: string;
  side: Side;
  /** Metres along the segment from its from-boundary, half-open [start, end); null when not measured. */
  start_m: number | null;
  end_m: number | null;
  /** Bounds of a part of the side (a bay, an address, a cross street); null for the whole side. */
  from_label: string | null;
  from_type: BoundType | null;
  to_label: string | null;
  to_type: BoundType | null;
  restrictions_status: RestrictionsStatus;
  verification: Verification;
  notes: string | null;
}

export interface BayRow {
  bay_id: string;
  extent_id: string;
  bay_number: number;
  /** Kerb plate number when it does not follow the council's convention; otherwise null. */
  plate_number: string | null;
  lat: number | null;
  lng: number | null;
  kind: 'standard' | 'accessible' | 'loading' | 'motorcycle' | 'ev' | 'other' | null;
  status: 'active' | 'retired';
  verification: Verification;
  notes: string | null;
}

export interface ZoneSchemeRow {
  scheme_id: string;
  kind: ZoneKind;
  name: string;
}

export interface ZoneRow {
  zone_id: string;
  scheme_id: string;
  /** Exactly as the council issues it: "9", "9a", "009". */
  code: string;
  name: string | null;
}

export interface ZoneAssignmentRow {
  assignment_id: string;
  zone_id: string;
  extent_id: string;
  valid_from: string | null;
  valid_to: string | null;
  source_id: string | null;
  verification: Verification;
}

export interface ProviderAreaRow {
  provider_area_id: string;
  provider: Provider;
  area_code: string;
  account: string | null;
  name: string | null;
}

export interface ProviderAreaAssignmentRow {
  assignment_id: string;
  provider_area_id: string;
  extent_id: string;
  valid_from: string | null;
  valid_to: string | null;
  source_id: string | null;
  verification: Verification;
}

/** A parking meter, as printed on it (e.g. GLP1). */
export interface MeterRow {
  meter_id: string;
  code: string;
  lat: number | null;
  lng: number | null;
  notes: string | null;
}

/**
 * A meter serving an extent: the whole extent (and its parking area) when provider_area_id is
 * null, otherwise that EasyPark or PayStay area on the extent. One meter can serve several areas.
 */
export interface MeterAssignmentRow {
  assignment_id: string;
  meter_id: string;
  extent_id: string;
  provider_area_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  source_id: string | null;
  verification: Verification;
}

export interface RuleRow {
  rule_id: string;
  type: RuleType;
  sign_code: string | null;
  max_stay_minutes: number | null;
  days: Day[];
  all_day: boolean;
  start: string | null;
  end: string | null;
  public_holidays: 'applies' | 'excluded' | null;
  exempt_zone_ids: string[];
  exceptions: string[];
  description: string | null;
}

export interface RuleAssignmentRow {
  assignment_id: string;
  rule_id: string;
  extent_id: string;
  grace_minutes: number | null;
  /** The extent's provider areas (EasyPark, PayStay) that pay for this rule here; [] when not tied. */
  provider_area_ids: string[];
  valid_from: string | null;
  valid_to: string | null;
  source_id: string | null;
  source_sign_id: string | null;
  verification: Verification;
}

export interface KerbsideRelease {
  schema: typeof RELEASE_SCHEMA;
  schema_version: string;
  release: ReleaseRow[];
  sources: SourceRow[];
  segments: SegmentRow[];
  segment_source_refs: SegmentSourceRefRow[];
  extents: ExtentRow[];
  bays: BayRow[];
  zone_schemes: ZoneSchemeRow[];
  zones: ZoneRow[];
  zone_assignments: ZoneAssignmentRow[];
  provider_areas: ProviderAreaRow[];
  provider_area_assignments: ProviderAreaAssignmentRow[];
  meters: MeterRow[];
  meter_assignments: MeterAssignmentRow[];
  rules: RuleRow[];
  rule_assignments: RuleAssignmentRow[];
}

/** The tables, in dependency order, and the exact keys of each record. */
export const TABLES = {
  release: ['release_id', 'dataset_id', 'council_code', 'linking_id', 'municipality_name', 'state', 'country', 'timezone', 'version', 'kind', 'status', 'effective_from', 'generated_at', 'notes'],
  sources: ['source_id', 'name', 'issuer', 'dataset', 'url', 'format', 'licence', 'reference_date', 'data_used', 'limitations'],
  segments: ['segment_id', 'display_id', 'asset_id', 'asset_name', 'road_name', 'locality', 'from_label', 'from_type', 'to_label', 'to_type', 'geometry', 'status', 'verification', 'source_id', 'notes'],
  segment_source_refs: ['ref_id', 'segment_id', 'source_id', 'external_id', 'id_scheme', 'notes'],
  extents: ['extent_id', 'segment_id', 'side', 'start_m', 'end_m', 'from_label', 'from_type', 'to_label', 'to_type', 'restrictions_status', 'verification', 'notes'],
  bays: ['bay_id', 'extent_id', 'bay_number', 'plate_number', 'lat', 'lng', 'kind', 'status', 'verification', 'notes'],
  zone_schemes: ['scheme_id', 'kind', 'name'],
  zones: ['zone_id', 'scheme_id', 'code', 'name'],
  zone_assignments: ['assignment_id', 'zone_id', 'extent_id', 'valid_from', 'valid_to', 'source_id', 'verification'],
  provider_areas: ['provider_area_id', 'provider', 'area_code', 'account', 'name'],
  provider_area_assignments: ['assignment_id', 'provider_area_id', 'extent_id', 'valid_from', 'valid_to', 'source_id', 'verification'],
  meters: ['meter_id', 'code', 'lat', 'lng', 'notes'],
  meter_assignments: ['assignment_id', 'meter_id', 'extent_id', 'provider_area_id', 'valid_from', 'valid_to', 'source_id', 'verification'],
  rules: ['rule_id', 'type', 'sign_code', 'max_stay_minutes', 'days', 'all_day', 'start', 'end', 'public_holidays', 'exempt_zone_ids', 'exceptions', 'description'],
  rule_assignments: ['assignment_id', 'rule_id', 'extent_id', 'grace_minutes', 'provider_area_ids', 'valid_from', 'valid_to', 'source_id', 'source_sign_id', 'verification'],
} as const;
export type TableName = keyof typeof TABLES;
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

/* ───────────────────────────── Identifiers ───────────────────────────── */

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const ROAD_TYPES = new Set(['street', 'st', 'road', 'rd', 'avenue', 'ave', 'parade', 'pde', 'place', 'pl', 'highway', 'hwy', 'crescent', 'cres', 'court', 'ct', 'drive', 'dr', 'terrace', 'tce', 'boulevard', 'bvd', 'lane', 'way', 'close', 'grove', 'square']);

/** A cross street without its road type, for asset names: "Russell Street" → "russell". */
function crossName(s: string): string {
  const words = slug(s).split('-').filter(Boolean);
  if (words.length > 1 && ROAD_TYPES.has(words[words.length - 1]!)) words.pop();
  return words.join('-');
}

/** What a segment is known as: "Bourke Street", "Russell Street", "Swanston Street" → bourke-street-from-russell-to-swanston. */
export const assetName = (road: string, from: string, to: string) => `${slug(road)}-from-${crossName(from)}-to-${crossName(to)}`;

/** The owner prefix of every key: the linking ID once the council is onboarded, the council code until then. */
export const ownerOf = (r: Pick<ReleaseRow, 'linking_id' | 'council_code'>) => r.linking_id || r.council_code;

export const ids = {
  segment: (owner: string, assetId: string | null, name: string) => `${owner}-${assetId ? slug(assetId) : name}`,
  display: (councilCode: string, assetId: string | null, name: string) => `${councilCode}-${assetId ? slug(assetId) : name}`,
  part: (fromLabel: string | null, toLabel: string | null) => (fromLabel || toLabel ? slug(`${fromLabel ?? 'start'}-${toLabel ?? 'end'}`) : 'all'),
  extent: (segmentId: string, side: Side, part: string) => `${segmentId}:${side}:${part}`,
  bay: (segmentId: string, side: Side, n: number) => `${segmentId}:${side}:bay-${n}`,
  scheme: (owner: string, kind: ZoneKind) => `${owner}-${kind.replace('_', '-')}`,
  zone: (owner: string, kind: ZoneKind, code: string) => `${owner}-${kind.replace('_', '-')}-${slug(code) || code}`,
  providerArea: (owner: string, provider: Provider, code: string) => `${owner}-${provider}-${slug(code)}`,
  meter: (owner: string, code: string) => `${owner}-meter-${slug(code)}`,
  source: (owner: string, name: string) => `${owner}-src-${slug(name)}`,
  rule: (owner: string, r: Omit<RuleRow, 'rule_id'>) => `${owner}-rule-${hash(JSON.stringify(r))}`,
  assignment: (extentId: string, targetId: string) => `${extentId}>${targetId}`,
  sourceRef: (segmentId: string, sourceId: string, scheme: SegmentSourceRefRow['id_scheme']) => `${segmentId}<${sourceId}#${scheme}`,
};

/** FNV-1a, 8 hex digits: identical rules get the same ID, so a rule is defined once and assigned many times. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Consistent capitals for names that arrive all lower or all upper case ("montague street" → "Montague Street"). */
export function tidyName(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t !== t.toLowerCase() && t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s'(-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

/* ───────────────────────────── Building a release (complete records only) ───────────────────────────── */

export function emptyRelease(meta: Omit<ReleaseRow, 'release_id' | 'kind' | 'status' | 'effective_from' | 'generated_at' | 'notes' | 'state' | 'country'> & Partial<ReleaseRow>): KerbsideRelease {
  const row: ReleaseRow = {
    release_id: meta.release_id ?? `${ownerOf(meta)}-${meta.dataset_id}-v${meta.version}`,
    dataset_id: meta.dataset_id,
    council_code: meta.council_code,
    linking_id: meta.linking_id ?? null,
    municipality_name: meta.municipality_name,
    state: meta.state ?? null,
    country: meta.country ?? null,
    timezone: meta.timezone,
    version: meta.version,
    kind: meta.kind ?? 'snapshot',
    status: meta.status ?? 'candidate',
    effective_from: meta.effective_from ?? null,
    generated_at: meta.generated_at ?? null,
    notes: meta.notes ?? null,
  };
  return {
    schema: RELEASE_SCHEMA,
    schema_version: RELEASE_VERSION,
    release: [row],
    sources: [],
    segments: [],
    segment_source_refs: [],
    extents: [],
    bays: [],
    zone_schemes: [],
    zones: [],
    zone_assignments: [],
    provider_areas: [],
    provider_area_assignments: [],
    meters: [],
    meter_assignments: [],
    rules: [],
    rule_assignments: [],
  };
}

/**
 * Adds records to a release by meaning, creating each one complete and only once: the same zone,
 * provider area or rule is defined once and assigned to many extents.
 */
export class ReleaseBuilder {
  readonly r: KerbsideRelease;
  private seen = new Map<TableName, Set<string>>();
  constructor(r: KerbsideRelease) {
    this.r = r;
    for (const t of TABLE_NAMES) this.seen.set(t, new Set((r[t] as unknown as Record<string, unknown>[]).map((x) => String(x[TABLES[t][0]]))));
  }
  get owner() {
    return ownerOf(this.r.release[0]!);
  }
  get code() {
    return this.r.release[0]!.council_code;
  }
  /** Adds a record once (by key), with its keys in the standard's column order. */
  private add<T extends TableName>(table: T, row: KerbsideRelease[T][number]): string {
    const values = row as unknown as Record<string, unknown>;
    const id = String(values[TABLES[table][0]]);
    const seen = this.seen.get(table)!;
    if (!seen.has(id)) {
      seen.add(id);
      (this.r[table] as unknown[]).push(Object.fromEntries((TABLES[table] as readonly string[]).map((k) => [k, values[k]])));
    }
    return id;
  }

  source(s: Omit<SourceRow, 'source_id'> & { source_id?: string }): string {
    return this.add('sources', { ...s, source_id: s.source_id ?? ids.source(this.owner, s.name) });
  }

  segment(s: {
    asset_id: string | null;
    road_name: string;
    from_label: string;
    to_label: string;
    locality?: string | null;
    from_type?: BoundType;
    to_type?: BoundType;
    geometry?: GeoLine | null;
    status?: SegmentRow['status'];
    verification?: Verification;
    source_id?: string | null;
    notes?: string | null;
  }): string {
    const road = tidyName(s.road_name);
    const from = tidyName(s.from_label);
    const to = tidyName(s.to_label);
    const name = assetName(road, from, to);
    const assetId = s.asset_id ? s.asset_id.trim() : null;
    return this.add('segments', {
      segment_id: ids.segment(this.owner, assetId, name),
      display_id: ids.display(this.code, assetId, name),
      asset_id: assetId,
      asset_name: name,
      road_name: road,
      locality: s.locality ? tidyName(s.locality) : null,
      from_label: from,
      from_type: s.from_type ?? 'intersection',
      to_label: to,
      to_type: s.to_type ?? 'intersection',
      geometry: s.geometry ?? null,
      status: s.status ?? (assetId ? 'active' : 'candidate'),
      verification: s.verification ?? 'unverified',
      source_id: s.source_id ?? null,
      notes: s.notes ?? null,
    });
  }

  sourceRef(segmentId: string, sourceId: string, externalId: string, scheme: SegmentSourceRefRow['id_scheme'], notes: string | null = null): string {
    return this.add('segment_source_refs', { ref_id: ids.sourceRef(segmentId, sourceId, scheme), segment_id: segmentId, source_id: sourceId, external_id: externalId, id_scheme: scheme, notes });
  }

  extent(e: {
    segment_id: string;
    side: Side;
    from_label?: string | null;
    from_type?: BoundType | null;
    to_label?: string | null;
    to_type?: BoundType | null;
    start_m?: number | null;
    end_m?: number | null;
    restrictions_status?: RestrictionsStatus;
    verification?: Verification;
    notes?: string | null;
  }): string {
    const fromLabel = e.from_label ?? null;
    const toLabel = e.to_label ?? null;
    const status = e.restrictions_status ?? 'pending_field_capture';
    return this.add('extents', {
      extent_id: ids.extent(e.segment_id, e.side, ids.part(fromLabel, toLabel)),
      segment_id: e.segment_id,
      side: e.side,
      start_m: e.start_m ?? null,
      end_m: e.end_m ?? null,
      from_label: fromLabel,
      from_type: fromLabel ? e.from_type ?? 'intersection' : null,
      to_label: toLabel,
      to_type: toLabel ? e.to_type ?? 'intersection' : null,
      restrictions_status: status,
      verification: e.verification ?? (status === 'pending_field_capture' ? 'pending_field_capture' : 'unverified'),
      notes: e.notes ?? null,
    });
  }

  bay(extentId: string, b: { bay_number: number; plate_number?: string | null; lat?: number | null; lng?: number | null; kind?: BayRow['kind']; verification?: Verification; notes?: string | null }): string {
    const e = this.r.extents.find((x) => x.extent_id === extentId)!;
    return this.add('bays', {
      bay_id: ids.bay(e.segment_id, e.side, b.bay_number),
      extent_id: extentId,
      bay_number: b.bay_number,
      plate_number: b.plate_number ?? null,
      lat: b.lat ?? null,
      lng: b.lng ?? null,
      kind: b.kind ?? null,
      status: 'active',
      verification: b.verification ?? 'unverified',
      notes: b.notes ?? null,
    });
  }

  /** Define a zone (and its scheme) without assigning it, e.g. a council's zone not yet mapped to segments. */
  defineZone(kind: ZoneKind, code: string, name: string | null = null): string {
    const schemeId = this.add('zone_schemes', { scheme_id: ids.scheme(this.owner, kind), kind, name: SCHEME_NAMES[kind] });
    const zoneId = ids.zone(this.owner, kind, code);
    const existing = this.r.zones.find((z) => z.zone_id === zoneId);
    if (existing && !existing.name && name) existing.name = name;
    return this.add('zones', { zone_id: zoneId, scheme_id: schemeId, code, name });
  }

  /** Assign a zone (created with its scheme if new) to an extent. */
  zone(extentId: string, kind: ZoneKind, code: string, name: string | null = null, a: Partial<Pick<ZoneAssignmentRow, 'valid_from' | 'valid_to' | 'source_id' | 'verification'>> = {}): string {
    const zoneId = this.defineZone(kind, code, name);
    this.add('zone_assignments', { assignment_id: ids.assignment(extentId, zoneId), zone_id: zoneId, extent_id: extentId, valid_from: a.valid_from ?? null, valid_to: a.valid_to ?? null, source_id: a.source_id ?? null, verification: a.verification ?? 'unverified' });
    return zoneId;
  }

  providerArea(extentId: string, provider: Provider, code: string, a: Partial<Pick<ProviderAreaAssignmentRow, 'valid_from' | 'valid_to' | 'source_id' | 'verification'>> = {}): string {
    const id = this.add('provider_areas', { provider_area_id: ids.providerArea(this.owner, provider, code), provider, area_code: code, account: null, name: null });
    this.add('provider_area_assignments', {
      assignment_id: ids.assignment(extentId, id),
      provider_area_id: id,
      extent_id: extentId,
      valid_from: a.valid_from ?? null,
      valid_to: a.valid_to ?? null,
      source_id: a.source_id ?? null,
      verification: a.verification ?? 'unverified',
    });
    return id;
  }

  /**
   * A meter (defined once by its printed code) serving an extent: the whole extent when
   * providerAreaId is null, otherwise that provider area, which must be on the extent.
   */
  meter(
    extentId: string,
    code: string,
    providerAreaId: string | null = null,
    a: Partial<Pick<MeterRow, 'lat' | 'lng' | 'notes'> & Pick<MeterAssignmentRow, 'valid_from' | 'valid_to' | 'source_id' | 'verification'>> = {},
  ): string {
    const id = this.add('meters', { meter_id: ids.meter(this.owner, code), code: code.trim(), lat: a.lat ?? null, lng: a.lng ?? null, notes: a.notes ?? null });
    this.add('meter_assignments', {
      assignment_id: providerAreaId ? `${ids.assignment(extentId, id)}>${providerAreaId}` : ids.assignment(extentId, id),
      meter_id: id,
      extent_id: extentId,
      provider_area_id: providerAreaId,
      valid_from: a.valid_from ?? null,
      valid_to: a.valid_to ?? null,
      source_id: a.source_id ?? null,
      verification: a.verification ?? 'unverified',
    });
    return id;
  }

  /** Define a rule (once, by content) and assign it to an extent. */
  rule(
    extentId: string,
    rule: Pick<RuleRow, 'type' | 'days'> & Partial<Omit<RuleRow, 'rule_id' | 'type' | 'days'>>,
    a: Partial<Pick<RuleAssignmentRow, 'grace_minutes' | 'provider_area_ids' | 'valid_from' | 'valid_to' | 'source_id' | 'source_sign_id' | 'verification'>> = {},
  ): string {
    const allDay = rule.all_day ?? !(rule.start && rule.end);
    const content: Omit<RuleRow, 'rule_id'> = {
      type: rule.type,
      sign_code: rule.sign_code ?? null,
      max_stay_minutes: rule.max_stay_minutes ?? null,
      days: DAYS.filter((d) => rule.days.includes(d)),
      all_day: allDay,
      start: allDay ? null : rule.start!,
      end: allDay ? null : rule.end!,
      public_holidays: rule.public_holidays ?? null,
      exempt_zone_ids: rule.exempt_zone_ids ?? [],
      exceptions: rule.exceptions ?? [],
      description: rule.description ?? null,
    };
    const id = this.add('rules', { rule_id: ids.rule(this.owner, content), ...content });
    this.add('rule_assignments', {
      assignment_id: ids.assignment(extentId, id),
      rule_id: id,
      extent_id: extentId,
      grace_minutes: a.grace_minutes ?? null,
      provider_area_ids: [...new Set(a.provider_area_ids ?? [])],
      valid_from: a.valid_from ?? null,
      valid_to: a.valid_to ?? null,
      source_id: a.source_id ?? null,
      source_sign_id: a.source_sign_id ?? null,
      verification: a.verification ?? 'unverified',
    });
    return id;
  }
}

const SCHEME_NAMES: Record<ZoneKind, string> = { rpa: 'Residential permit areas', patrol: 'Patrol zones', parking_area: 'Parking areas', operational: 'Operational areas' };

/* ───────────────────────────── Validation ───────────────────────────── */

export interface ReleaseError {
  path: string;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Keys holding a council's own values, never rewritten by relinking and not owner-prefixed. */
const NOT_OWNED = new Set(['display_id', 'external_id', 'asset_id', 'source_sign_id', 'linking_id', 'dataset_id']);

/**
 * Checks the fixed structure (exact keys on every record), vocabularies, references between
 * tables, unique keys and the owner prefix. The JSON Schema checks the record shapes; this also
 * checks what a schema cannot (references, uniqueness, prefixes) and gives readable paths.
 */
export function validateRelease(input: unknown): ReleaseError[] {
  const errors: ReleaseError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  if (!isObj(input)) return [{ path: '(root)', message: 'must be a JSON object' }];
  const rootKeys = ['schema', 'schema_version', ...TABLE_NAMES];
  const missingRoot = rootKeys.filter((k) => !(k in input));
  const extraRoot = Object.keys(input).filter((k) => !rootKeys.includes(k));
  if (missingRoot.length) err('(root)', `is missing ${missingRoot.join(', ')}`);
  if (extraRoot.length) err('(root)', `has keys outside the standard: ${extraRoot.join(', ')}`);
  if (input.schema !== RELEASE_SCHEMA) err('schema', `must be "${RELEASE_SCHEMA}"`);
  if (typeof input.schema_version !== 'string' || !/^1\.\d+\.\d+$/.test(input.schema_version)) err('schema_version', 'must be a 1.x.y version');

  const keyIndex = new Map<TableName, Set<string>>();
  for (const t of TABLE_NAMES) {
    const rows = input[t];
    const keySet = new Set<string>();
    keyIndex.set(t, keySet);
    if (!Array.isArray(rows)) {
      err(t, 'must be an array of records');
      continue;
    }
    const expected = TABLES[t] as readonly string[];
    rows.forEach((row, i) => {
      const p = `${t}[${i}]`;
      if (!isObj(row)) return err(p, 'must be an object');
      const missing = expected.filter((k) => !(k in row));
      const extra = Object.keys(row).filter((k) => !expected.includes(k));
      if (missing.length) err(p, `is missing ${missing.join(', ')} (use null or [] when unknown)`);
      if (extra.length) err(p, `has keys outside the standard: ${extra.join(', ')}`);
      const key = row[expected[0]!];
      if (typeof key !== 'string' || !key) err(`${p}.${expected[0]}`, 'is required');
      else if (keySet.has(key)) err(`${p}.${expected[0]}`, `"${key}" is used twice`);
      else keySet.add(key);
    });
  }
  const release = Array.isArray(input.release) ? (input.release as Record<string, unknown>[]) : [];
  if (release.length !== 1) {
    err('release', 'must hold exactly one record');
    return errors;
  }
  const rel = release[0]!;
  if (typeof rel.council_code !== 'string' || !/^[a-z0-9]+$/.test(rel.council_code)) err('release[0].council_code', 'must be the council code in lower case, e.g. "copp"');
  if (rel.linking_id !== null && (typeof rel.linking_id !== 'string' || !/^[A-Za-z0-9]+$/.test(rel.linking_id))) err('release[0].linking_id', 'must be null (development) or the linking ID (letters and digits)');
  if (typeof rel.timezone !== 'string' || !rel.timezone) err('release[0].timezone', 'is required');
  if (!['snapshot', 'delta'].includes(rel.kind as string)) err('release[0].kind', 'must be snapshot or delta');
  if (!['candidate', 'approved', 'superseded'].includes(rel.status as string)) err('release[0].status', 'must be candidate, approved or superseded');
  const owner = (rel.linking_id as string | null) || (rel.council_code as string);
  const code = rel.council_code as string;

  const rows = (t: TableName) => (Array.isArray(input[t]) ? (input[t] as Record<string, unknown>[]) : []).map((r, i) => [r, `${t}[${i}]`] as const);
  const ref = (p: string, field: string, value: unknown, table: TableName, nullable = false) => {
    if (value === null && nullable) return;
    if (typeof value !== 'string' || !keyIndex.get(table)!.has(value)) err(`${p}.${field}`, `"${String(value)}" is not in ${table}`);
  };
  const oneOf = (p: string, field: string, value: unknown, allowed: readonly unknown[]) => {
    if (!allowed.includes(value)) err(`${p}.${field}`, `must be one of ${allowed.map(String).join(', ')}`);
  };
  const date = (p: string, field: string, value: unknown) => {
    if (value !== null && (typeof value !== 'string' || !DATE.test(value))) err(`${p}.${field}`, 'must be null or YYYY-MM-DD');
  };

  // Every owned key starts with the owner prefix (linking ID, or the council code in development).
  for (const t of TABLE_NAMES) {
    for (const [r, p] of rows(t)) {
      for (const [k, v] of Object.entries(r)) {
        if (NOT_OWNED.has(k) || !(k.endsWith('_id') || k.endsWith('_ids'))) continue;
        for (const value of Array.isArray(v) ? v : [v]) if (typeof value === 'string' && !value.startsWith(`${owner}-`)) err(`${p}.${k}`, `"${value}" does not start with the owner prefix "${owner}-"`);
      }
    }
  }

  for (const [r, p] of rows('segments')) {
    if (typeof r.display_id !== 'string' || !r.display_id.startsWith(`${code}-`)) err(`${p}.display_id`, `must start with the council code "${code}-"`);
    if (typeof r.asset_name !== 'string' || !r.asset_name) err(`${p}.asset_name`, 'is required');
    const key = r.asset_id ? String(r.asset_id) : String(r.asset_name);
    if (r.segment_id !== `${owner}-${r.asset_id ? slug(String(r.asset_id)) : key}`) err(`${p}.segment_id`, `must be "${owner}-" + asset_id (or asset_name until the asset ID is acquired)`);
    if (!r.road_name || !r.from_label || !r.to_label) err(p, 'needs road_name, from_label and to_label');
    oneOf(p, 'from_type', r.from_type, BOUND_TYPES);
    oneOf(p, 'to_type', r.to_type, BOUND_TYPES);
    oneOf(p, 'status', r.status, ['candidate', 'active', 'retired']);
    oneOf(p, 'verification', r.verification, VERIFICATION);
    ref(p, 'source_id', r.source_id, 'sources', true);
  }
  for (const [r, p] of rows('segment_source_refs')) {
    ref(p, 'segment_id', r.segment_id, 'segments');
    ref(p, 'source_id', r.source_id, 'sources');
    if (typeof r.external_id !== 'string' || !r.external_id) err(`${p}.external_id`, 'must be the identifier as issued, as text');
    oneOf(p, 'id_scheme', r.id_scheme, ['road_segment_asset_id', 'source_row_id']);
  }
  for (const [r, p] of rows('extents')) {
    ref(p, 'segment_id', r.segment_id, 'segments');
    oneOf(p, 'side', r.side, SIDES);
    oneOf(p, 'restrictions_status', r.restrictions_status, RESTRICTIONS_STATUS);
    oneOf(p, 'verification', r.verification, VERIFICATION);
    for (const end of ['from', 'to'] as const) {
      if (r[`${end}_label`] === null && r[`${end}_type`] !== null) err(`${p}.${end}_type`, `must be null when ${end}_label is null`);
      if (r[`${end}_label`] !== null) oneOf(p, `${end}_type`, r[`${end}_type`], BOUND_TYPES);
    }
    const s = r.start_m;
    const e = r.end_m;
    if ((s === null) !== (e === null) || (typeof s === 'number' && typeof e === 'number' && !(s >= 0 && e > s))) err(p, 'start_m and end_m must both be null, or 0 ≤ start_m < end_m');
  }
  for (const [r, p] of rows('bays')) {
    ref(p, 'extent_id', r.extent_id, 'extents');
    if (!Number.isInteger(r.bay_number) || (r.bay_number as number) < 0) err(`${p}.bay_number`, 'must be a whole number');
    if ((r.lat === null) !== (r.lng === null) || (typeof r.lat === 'number' && (Math.abs(r.lat) > 90 || Math.abs(r.lng as number) > 180))) err(p, 'lat/lng must both be null or WGS84 degrees');
    oneOf(p, 'kind', r.kind, ['standard', 'accessible', 'loading', 'motorcycle', 'ev', 'other', null]);
    oneOf(p, 'status', r.status, ['active', 'retired']);
    oneOf(p, 'verification', r.verification, VERIFICATION);
  }
  for (const [r, p] of rows('zone_schemes')) oneOf(p, 'kind', r.kind, ZONE_KINDS);
  for (const [r, p] of rows('zones')) {
    ref(p, 'scheme_id', r.scheme_id, 'zone_schemes');
    if (typeof r.code !== 'string' || !r.code) err(`${p}.code`, 'is required, exactly as issued');
  }
  for (const [r, p] of rows('zone_assignments')) {
    ref(p, 'zone_id', r.zone_id, 'zones');
    ref(p, 'extent_id', r.extent_id, 'extents');
    ref(p, 'source_id', r.source_id, 'sources', true);
    date(p, 'valid_from', r.valid_from);
    date(p, 'valid_to', r.valid_to);
    oneOf(p, 'verification', r.verification, VERIFICATION);
  }
  for (const [r, p] of rows('provider_areas')) {
    oneOf(p, 'provider', r.provider, PROVIDERS);
    if (typeof r.area_code !== 'string' || !r.area_code) err(`${p}.area_code`, 'is required, as text');
  }
  for (const [r, p] of rows('provider_area_assignments')) {
    ref(p, 'provider_area_id', r.provider_area_id, 'provider_areas');
    ref(p, 'extent_id', r.extent_id, 'extents');
    ref(p, 'source_id', r.source_id, 'sources', true);
    date(p, 'valid_from', r.valid_from);
    date(p, 'valid_to', r.valid_to);
    oneOf(p, 'verification', r.verification, VERIFICATION);
  }
  // Which provider areas each extent has: a meter or rule may only be tied to those.
  const areasOn = new Map<string, Set<string>>();
  for (const [r] of rows('provider_area_assignments')) {
    const set = areasOn.get(String(r.extent_id)) ?? new Set<string>();
    set.add(String(r.provider_area_id));
    areasOn.set(String(r.extent_id), set);
  }
  const onExtent = (p: string, field: string, extentId: unknown, areaId: unknown) => {
    if (typeof areaId === 'string' && keyIndex.get('provider_areas')!.has(areaId) && !areasOn.get(String(extentId))?.has(areaId))
      err(`${p}.${field}`, `"${areaId}" is not assigned to extent "${String(extentId)}" in provider_area_assignments`);
  };
  for (const [r, p] of rows('meters')) {
    if (typeof r.code !== 'string' || !r.code) err(`${p}.code`, 'is required, as printed on the meter');
    if ((r.lat === null) !== (r.lng === null) || (typeof r.lat === 'number' && (Math.abs(r.lat) > 90 || Math.abs(r.lng as number) > 180))) err(p, 'lat/lng must both be null or WGS84 degrees');
  }
  for (const [r, p] of rows('meter_assignments')) {
    ref(p, 'meter_id', r.meter_id, 'meters');
    ref(p, 'extent_id', r.extent_id, 'extents');
    ref(p, 'provider_area_id', r.provider_area_id, 'provider_areas', true);
    onExtent(p, 'provider_area_id', r.extent_id, r.provider_area_id);
    ref(p, 'source_id', r.source_id, 'sources', true);
    date(p, 'valid_from', r.valid_from);
    date(p, 'valid_to', r.valid_to);
    oneOf(p, 'verification', r.verification, VERIFICATION);
  }
  for (const [r, p] of rows('rules')) {
    oneOf(p, 'type', r.type, RULE_TYPES);
    if (!Array.isArray(r.days) || !r.days.length || r.days.some((d) => !DAYS.includes(d as Day))) err(`${p}.days`, 'must list days as mon…sun');
    if (r.all_day === true) {
      if (r.start !== null || r.end !== null) err(p, 'start and end must be null when all_day is true');
    } else if (r.all_day !== false || !HHMM.test(String(r.start)) || !HHMM.test(String(r.end)) || r.start === r.end) err(p, 'needs start and end (HH:MM), or all_day: true');
    if (STAY_REQUIRED.includes(r.type as RuleType) && !(Number.isInteger(r.max_stay_minutes) && (r.max_stay_minutes as number) > 0)) err(`${p}.max_stay_minutes`, `is required for ${String(r.type)}`);
    for (const z of Array.isArray(r.exempt_zone_ids) ? r.exempt_zone_ids : []) ref(p, 'exempt_zone_ids', z, 'zones');
  }
  for (const [r, p] of rows('rule_assignments')) {
    ref(p, 'rule_id', r.rule_id, 'rules');
    ref(p, 'extent_id', r.extent_id, 'extents');
    ref(p, 'source_id', r.source_id, 'sources', true);
    if (r.grace_minutes !== null && !(Number.isInteger(r.grace_minutes) && (r.grace_minutes as number) >= 0 && (r.grace_minutes as number) <= 120)) err(`${p}.grace_minutes`, 'must be null or 0–120');
    if (!Array.isArray(r.provider_area_ids)) err(`${p}.provider_area_ids`, 'must be a list ([] when not tied to a payment number)');
    else
      for (const a of r.provider_area_ids) {
        ref(p, 'provider_area_ids', a, 'provider_areas');
        onExtent(p, 'provider_area_ids', r.extent_id, a);
      }
    date(p, 'valid_from', r.valid_from);
    date(p, 'valid_to', r.valid_to);
    oneOf(p, 'verification', r.verification, VERIFICATION);
  }
  return errors;
}

/* ───────────────────────────── Linking ID ───────────────────────────── */

/**
 * Swap the owner prefix of every key from the council code (development) to the council's
 * linking ID once it is onboarded: com-20567 → 482771930-20567. display_id keeps the council
 * code (users still see com-20567); council values (asset, external and sign IDs, meter codes) are not
 * touched. Returns a new release.
 */
export function relinkRelease(r: KerbsideRelease, linkingId: string): KerbsideRelease {
  if (!/^[A-Za-z0-9]+$/.test(linkingId)) throw new Error('A linking ID is letters and digits only.');
  const from = ownerOf(r.release[0]!);
  const swap = (v: string) => v.replace(new RegExp(`(^|[:><])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-`, 'g'), `$1${linkingId}-`);
  const out = structuredClone(r);
  for (const t of TABLE_NAMES) {
    for (const row of out[t] as unknown as Record<string, unknown>[]) {
      for (const [k, v] of Object.entries(row)) {
        if (NOT_OWNED.has(k) || !(k.endsWith('_id') || k.endsWith('_ids'))) continue;
        row[k] = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? swap(x) : x)) : typeof v === 'string' ? swap(v) : v;
      }
    }
  }
  out.release[0]!.linking_id = linkingId;
  return out;
}

/* ───────────────────────────── CSV, one file per table ───────────────────────────── */

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * One release per patrol zone: each holds the extents assigned to that zone with everything they
 * reference (segments, source refs, bays, assignments, zones, provider areas, rules) and all sources.
 * An extent in two zones goes in both. Extents with no patrol zone are returned in `unassigned`,
 * not guessed into a zone.
 */
export function splitByZone(r: KerbsideRelease, kind: ZoneKind = 'patrol'): { releases: KerbsideRelease[]; unassigned: string[] } {
  const meta = r.release[0]!;
  const schemes = new Set(r.zone_schemes.filter((s) => s.kind === kind).map((s) => s.scheme_id));
  const zones = r.zones.filter((z) => schemes.has(z.scheme_id));
  const zoneIds = new Set(zones.map((z) => z.zone_id));
  const assigned = new Set(r.zone_assignments.filter((a) => zoneIds.has(a.zone_id)).map((a) => a.extent_id));
  const releases = zones.flatMap((zone) => {
    const ext = new Set(r.zone_assignments.filter((a) => a.zone_id === zone.zone_id).map((a) => a.extent_id));
    if (!ext.size) return [];
    const extents = r.extents.filter((e) => ext.has(e.extent_id));
    const segs = new Set(extents.map((e) => e.segment_id));
    const za = r.zone_assignments.filter((a) => ext.has(a.extent_id));
    const pa = r.provider_area_assignments.filter((a) => ext.has(a.extent_id));
    const ra = r.rule_assignments.filter((a) => ext.has(a.extent_id));
    const ma = r.meter_assignments.filter((a) => ext.has(a.extent_id));
    const rules = r.rules.filter((x) => ra.some((a) => a.rule_id === x.rule_id));
    const zoneRefs = new Set([...za.map((a) => a.zone_id), ...rules.flatMap((x) => x.exempt_zone_ids)]);
    const keptZones = r.zones.filter((z) => zoneRefs.has(z.zone_id));
    const segments = r.segments.filter((x) => segs.has(x.segment_id));
    const refs = r.segment_source_refs.filter((x) => segs.has(x.segment_id));
    const datasetId = `${kind === 'patrol' ? 'patrol-area' : kind.replace('_', '-')}-${slug(zone.code)}`;
    const release: ReleaseRow = { ...meta, dataset_id: datasetId, release_id: `${ownerOf(meta)}-${datasetId}-v${meta.version}` };
    return [
      {
        schema: r.schema,
        schema_version: r.schema_version,
        release: [release],
        // Sources are the dataset's provenance (what was checked and its limits): all are kept.
        sources: r.sources,
        segments,
        segment_source_refs: refs,
        extents,
        bays: r.bays.filter((x) => ext.has(x.extent_id)),
        zone_schemes: r.zone_schemes.filter((x) => keptZones.some((z) => z.scheme_id === x.scheme_id)),
        zones: keptZones,
        zone_assignments: za,
        provider_areas: r.provider_areas.filter((x) => pa.some((a) => a.provider_area_id === x.provider_area_id)),
        provider_area_assignments: pa,
        meters: r.meters.filter((x) => ma.some((a) => a.meter_id === x.meter_id)),
        meter_assignments: ma,
        rules,
        rule_assignments: ra,
      } as KerbsideRelease,
    ];
  });
  return { releases, unassigned: r.extents.filter((e) => !assigned.has(e.extent_id)).map((e) => e.extent_id) };
}

/**
 * Each table as CSV text, columns in the standard's order. Null is an empty cell; lists and
 * geometry are JSON text. For councils to inspect a release in a spreadsheet.
 */
export function releaseToCsv(r: KerbsideRelease): Record<TableName, string> {
  const out = {} as Record<TableName, string>;
  for (const t of TABLE_NAMES) {
    const cols = TABLES[t] as readonly string[];
    const lines = [cols.join(','), ...(r[t] as unknown as Record<string, unknown>[]).map((row) => cols.map((c) => csvCell(row[c])).join(','))];
    out[t] = lines.join('\n') + '\n';
  }
  return out;
}
