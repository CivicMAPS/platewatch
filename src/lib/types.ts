/** Domain model for PlateWatch. All timestamps are epoch milliseconds (UTC). */

export type ListType = 'allow' | 'timed' | 'hot';

/**
 * Where a list came from (WF-S26 OQ26-5, owner decision 23/11/2026).
 * - `system`: applied to the device from outside — imported from a file today; in EnforcementMAPS,
 *   published from the CommandMAPS dashboard by a team leader or parking services management.
 * - `officer`: created on the device by the officer for their patrol (a daily digital chalking list).
 * Lists saved before this field existed have none and are treated as `officer` lists with no day.
 */
export type ListOrigin = 'system' | 'officer';

export interface ListSource {
  origin: ListOrigin;
  /** File name(s) a system list was imported from, joined with ", ". */
  importedFrom?: string;
  /** When a system list was last imported or updated by an import. */
  importedAt?: number;
  /** Officer lists: the local day ("YYYY-MM-DD") the list was created for. */
  serviceDay?: string;
}

export interface BaseList {
  id: string;
  type: ListType;
  name: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
  /** Provenance; absent on lists saved before it existed. See `lib/listPolicy.ts`. */
  source?: ListSource;
}

/* ───────────────────────────── Allow list ───────────────────────────── */

export interface AllowEntry {
  id: string;
  /** Plate as entered/displayed (uppercase, spacing removed). */
  plate: string;
  /** Strict canonical matching key — see plate.ts. */
  key: string;
  /** Free label, e.g. resident name or "Visitor permit". */
  label: string;
  /** Permit / authority reference number. */
  permitNo: string;
  /** Optional validity window, local date "YYYY-MM-DD" (inclusive). */
  validFrom: string;
  validTo: string;
  addedAt: number;
}

export interface AllowList extends BaseList {
  type: 'allow';
  entries: AllowEntry[];
}

/* ───────────────────────────── Timed list ───────────────────────────── */

export type StreetSide = 'both' | 'north' | 'south' | 'east' | 'west' | 'centre' | 'odd' | 'even';

export interface StreetSegment {
  /** Street the segment is on, e.g. "Smith Street". */
  street: string;
  /** Cross street at one end. */
  fromStreet: string;
  /** Cross street at the other end. */
  toStreet: string;
  side: StreetSide;
  suburb: string;
  /**
   * Part of the side, where signs change part way along: from and to a bay ("Bay 58"), an
   * address ("234 Little Bourke Street") or a cross street. Absent when the list covers the side.
   */
  subFrom?: string;
  subTo?: string;
}

/** 0 = Sunday … 6 = Saturday (matches Date#getDay). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface TimedRestriction {
  id: string;
  /** Signage code, e.g. "2P", "1/2P", "P15". */
  code: string;
  /** Time allowance in minutes. */
  limitMinutes: number;
  /** Extra tolerance before a re-sighting is treated as an overstay. */
  graceMinutes: number;
  days: Weekday[];
  /** Local "HH:MM". If end <= start the period crosses midnight. */
  startTime: string;
  /** Local "HH:MM" or "24:00". */
  endTime: string;
  /** True = restriction applies at all times on the selected days. */
  allDay: boolean;
  /** Free description, e.g. "Permit zone 12 excepted". */
  description: string;
  /**
   * The segment's EasyPark areas and PayStay zones that pay for this restriction (values from the
   * list's payment). Absent or empty: not tied to a payment number.
   */
  paidBy?: PaidBy;
}

/** Payment numbers tied to a restriction or a meter. */
export interface PaidBy {
  easyPark: string[];
  payStay: string[];
}

/**
 * A parking meter. It pays for the whole segment (and its parking area) when it lists no numbers,
 * otherwise for the EasyPark areas and PayStay zones it lists; one meter can serve several.
 */
export interface Meter extends PaidBy {
  /** As printed on the meter, e.g. "GLP1". */
  id: string;
}

export interface PaymentAreas {
  /**
   * Parking area number (e.g. City of Melbourne): one per road segment, used to pay at the meter
   * or in EasyPark. A bay's kerb sign is this number followed by the bay number (637 + 58 = 63758).
   */
  parkingArea?: string;
  /** EasyPark area numbers; a segment can have several (e.g. one side changes restriction mid-day). */
  easyPark: string[];
  /**
   * PayStay zones; City of Port Phillip numbers are 3388 + segment number + four digits for the side.
   * `meter` is only on lists saved before meters were separate (one meter per zone entry);
   * normalisePayment moves it into `meters`.
   */
  payStay: { zone: string; meter?: string }[];
  /** Meters on this segment and what each pays for. */
  meters?: Meter[];
}

export interface BayPoint {
  bay: number;
  lat: number;
  lng: number;
  /** Kerb plate number, when the council does not number plates as parking area + bay. */
  sign?: string;
}

/** A signed control without a time allowance; kept for reference and export, not timed. */
export interface UntimedControl {
  /** civicmaps.kerbside_release rule type: no_stopping, no_parking, permit_zone, loading_zone… */
  control: 'time_limit' | 'metered' | 'ticket' | 'loading_zone' | 'permit_zone' | 'no_stopping' | 'no_parking' | 'clearway' | 'bus_zone' | 'taxi_zone' | 'accessible' | 'works_zone' | 'other';
  /** As shown, e.g. "No stopping", "Loading zone (no time limit given)". */
  label: string;
  days: Weekday[];
  allDay: boolean;
  startTime: string;
  endTime: string;
  description: string;
}

export interface TimedList extends BaseList {
  payment?: PaymentAreas;
  type: 'timed';
  /** Internal patrol zone / enforcement area number, e.g. "9". Home groups and filters lists by it. */
  patrolZone?: string;
  /** Operational name of the patrol zone used day to day, e.g. "Flagstaff". */
  patrolZoneName?: string;
  /** Residential permit area, e.g. "12". */
  rpa?: string;
  /** Council road segment ID (e.g. City of Melbourne road corridor 20055). */
  roadSegmentId?: string;
  /** Bay numbers in this list; with the parking area they make each bay's kerb sign (645 + 58). */
  bays?: number[];
  /** Bay positions (WGS84) where known, with the kerb plate number when it is not area + bay. */
  bayPoints?: BayPoint[];
  /** Signs on this stretch with no time allowance (No Stopping, No Parking, Permit Zone…). */
  untimedControls?: UntimedControl[];
  /**
   * The extent this list came from in a civicmaps.kerbside_release: "<segment_id>:<side>:<part>".
   * Re-imports match on it before street names; exports keep it.
   */
  externalId?: string;
  /** What users see for the segment: council code + asset ID (com-20567), or + asset name until it has one. */
  displayId?: string;
  segment: StreetSegment;
  restrictions: TimedRestriction[];
  /** Linked allow lists (e.g. residential permits) exempt on this segment. */
  allowListIds: string[];
}

/* ────────────────────────────── Hot list ────────────────────────────── */

export const RISK_TAGS = [
  'aggressive',
  'previous_assault',
  'spitting',
  'verbal_abuse',
  'threats',
  'weapon_sighted',
  'flees_evades',
  'other',
] as const;
export type RiskTag = (typeof RISK_TAGS)[number];

export const RISK_TAG_LABELS: Record<RiskTag, string> = {
  aggressive: 'Aggressive',
  previous_assault: 'Previous assault',
  spitting: 'Spitting',
  verbal_abuse: 'Verbal abuse',
  threats: 'Threats / intimidation',
  weapon_sighted: 'Weapon sighted',
  flees_evades: 'Flees / evades',
  other: 'Other',
};

export type RiskLevel = 'caution' | 'high' | 'extreme';

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  caution: 'Caution',
  high: 'High risk',
  extreme: 'Extreme risk',
};

export interface HotEntry {
  id: string;
  plate: string;
  key: string;
  risks: RiskTag[];
  riskLevel: RiskLevel;
  make: string;
  model: string;
  bodyType: string;
  colour: string;
  notes: string;
  addedAt: number;
}

export interface HotList extends BaseList {
  type: 'hot';
  entries: HotEntry[];
}

export type PlateList = AllowList | TimedList | HotList;

/* ─────────────────────────── Capture metadata ─────────────────────────── */

export interface GeoFix {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy radius in metres (95% confidence per W3C spec). */
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  heading: number | null;
  speed: number | null;
  /** When the fix was produced (epoch ms). */
  timestamp: number;
}

export interface CaptureMeta {
  payment?: PaymentAreas;
  /** Device clock at shutter (epoch ms). */
  capturedAt: number;
  /** Device local time with UTC offset, ISO 8601, e.g. 2026-11-20T09:14:03.120+11:00 */
  capturedAtLocal: string;
  /** IANA zone, e.g. Australia/Melbourne. */
  timeZone: string;
  location: GeoFix | null;
  /** Age of the fix relative to capture, ms. */
  locationAgeMs: number | null;
  userAgent: string;
}

/* ─────────────────────────────── Records ─────────────────────────────── */

export type ScanOutcome =
  | "reviewed"
  | 'recorded' // first sighting in segment — allowance clock started
  | 'within_allowance' // re-sighting, still inside allowance
  | 'overstay' // re-sighting, allowance (+grace) exceeded
  | 'hot_sighting' // hot list match evidence
  | 'permit_valid'; // on a linked allow list, valid at capture — sighting recorded, no allowance clock

export interface ScanRecord {
  revisions?: {at:number; plate:string; outcome:ScanOutcome}[];
  amendmentResult?: string;
  amendmentMatches?: string[];
  id: string;
  listId: string;
  /** Observation this scan belongs to (timed lists only). */
  observationId: string | null;
  plate: string;
  key: string;
  /** Raw OCR text before officer correction. */
  ocrText: string;
  /** Tesseract mean confidence 0–100 (null for ML Kit and patrol readings, and manual entry). */
  ocrConfidence: number | null;
  /** Engine that read the plate; null when typed. Absent on records saved before 21 Nov 2026. */
  ocrEngine?: 'tesseract' | 'mlkit' | 'patrol' | null;
  /** True when the officer changed the OCR result before checking. */
  corrected: boolean;
  outcome: ScanOutcome;
  meta: CaptureMeta;
  /** JPEG with EXIF GPS + DateTimeOriginal embedded. */
  image: Blob;
  thumb: Blob;
  /** Hex SHA-256 of `image` bytes, computed at capture. */
  sha256: string;
  createdAt: number;
}

/**
 * A patrol capture the officer dismissed at review (sign text, a misread, a vehicle not of
 * interest). Kept in one global list, apart from every plate list: it starts no timing and
 * matches nothing, but the frame and its metadata stay available until deleted or purged.
 */
export interface DismissedCapture {
  id: string;
  /** Plate field as it stood when dismissed (the reading, or the officer's edit). */
  plate: string;
  ocrText: string;
  ocrEngine: ScanRecord['ocrEngine'];
  /** List the capture was being reviewed for; the list may since have been deleted. */
  intendedListId: string;
  intendedListName: string;
  meta: CaptureMeta;
  image: Blob;
  thumb: Blob;
  sha256: string;
  /** When it was dismissed. */
  createdAt: number;
}

export type ObservationStatus = 'active' | 'expired' | 'reset';

/**
 * An observation is the "chalk" for one vehicle in one timed segment: it
 * starts at the first sighting and lasts until the restriction period that
 * was in force at that moment ends (or the officer resets it).
 */
export interface Observation {
  id: string;
  listId: string;
  plate: string;
  key: string;
  firstScanId: string;
  lastScanId: string;
  startedAt: number;
  restrictionId: string;
  restrictionCode: string;
  limitMinutes: number;
  graceMinutes: number;
  /** startedAt + limit. */
  allowanceEndsAt: number;
  /** End of the restriction period instance the observation started in. */
  windowEndsAt: number;
  status: ObservationStatus;
  overstayFlaggedAt: number | null;
  closedAt: number | null;
  scanCount: number;
}

export interface Settings {
  /** Auto-delete scan records older than N days (0 = never). */
  retentionDays: number;
  /** Require a GPS fix before a scan can be checked. */
  requireLocation: boolean;
  /** Warn when the GPS accuracy radius exceeds this many metres. */
  accuracyWarnMetres: number;
  vibrate: boolean;
  sound: boolean;
  /** Last camera zoom the officer chose; reused by the scan and patrol cameras. */
  cameraZoom: number;
  /** Record field diagnostics on this device (see src/lib/diagnostics.ts). */
  diagnostics: boolean;
  /** Home: patrol zone shown (null = all zones, '' = lists without a zone). */
  listZoneFilter: string | null;
  /** CivicMAPS display theme: light civic surfaces, or the design system's low-light dark theme. */
  theme: 'light' | 'dark';
}

export const DEFAULT_SETTINGS: Settings = {
  retentionDays: 0,
  requireLocation: false,
  accuracyWarnMetres: 25,
  vibrate: true,
  sound: true,
  cameraZoom: 1,
  // On during the development field-test stage; turn the default off before production.
  diagnostics: true,
  listZoneFilter: null,
  theme: 'light',
};
