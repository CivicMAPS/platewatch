# civicmaps.kerbside_release v1

The interchange package for the **CivicMAPS road segment and kerbside data standard**, lean
pilot core. CivicMAPS publishes releases, PlateWatch reads them offline, and council source
data in any format is adapted to them.

- **JSON Schema:** [`schemas/civicmaps-kerbside-release.v1.schema.json`](../schemas/civicmaps-kerbside-release.v1.schema.json)
- **Code:**
  - [`src/lib/kerbsideRelease.ts`](../src/lib/kerbsideRelease.ts): tables, identifiers, builder, validation, linking ID, CSV.
  - [`src/lib/releaseAdapters.ts`](../src/lib/releaseAdapters.ts): release ↔ PlateWatch, and council area datasets → release.
- **Releases:**
  - [`datasets/copp-patrol-area-10.release.json`](../datasets/copp-patrol-area-10.release.json), with the same release as CSV tables in [`datasets/copp-patrol-area-10.csv/`](../datasets/copp-patrol-area-10.csv): City of Port Phillip Patrol Area 10, 55 candidate segments.
  - [`datasets/examples/com-cbd-example.release.json`](../datasets/examples/com-cbd-example.release.json): City of Melbourne. Little Bourke St `20055` is from CivicMAPS kerbside data; Bourke St `20567` is illustrative.

## Principles

1. **Flat tables of identical records.** A release is 13 tables. Every record in a table has
   exactly the same keys, in the same order, with `null` (or `[]`) where a value is unknown or
   not yet acquired. Records link to each other by ID; nothing is nested or repeated inline.
2. **Council data is adapted to the tables, never the reverse.** Each council's export goes
   through an adapter. Its own identifiers are kept as source references.
3. **A rule is defined once and assigned many times.** The same zone, provider area or rule
   appears once and is linked to every stretch of kerb it applies to.
4. **Nothing guessed.** Unsurveyed kerb is `restrictions_status: pending_field_capture`, and
   the absence of a rule never means unrestricted parking.
5. **Provenance.** Sources (with limitations), source references and per-record
   `verification` say how far each value can be relied on.

## Identifiers

Each council has three identifiers:

| Identifier | Example | Where it is used |
|---|---|---|
| CivicMAPS ID | (not shown) | **Secret.** CivicMAPS backend and the service provider's admin only. Never in a release, export or device. |
| Linking ID | `482771930` (illustrative) | Links the CivicMAPS ID to the council. Used in every key of a release, on the backend and on devices. Unique, so councils with the same display code never see each other's data. |
| Council code | `com`, `copp` | What users see. May repeat between councils (Melbourne and Maribyrnong would both be `com`). |

Keys start with the **owner prefix**: the linking ID, or the council code during development,
until the council is onboarded and the linking ID is swapped in (see *Linking ID* below).

| Record | Key | Example (development → onboarded) |
|---|---|---|
| Segment | `<owner>-<asset_id>` | `com-20567` → `<linking ID>-20567` |
| Segment, no asset ID yet | `<owner>-<asset_name>` | `copp-normanby-road-from-boundary-to-montague` |
| Shown to users | `display_id` = `<council_code>-<asset_id or asset_name>` | `com-20567` (never changes on onboarding) |
| Extent | `<segment_id>:<side>:<part>` | `com-20055:south:bay-58-bay-72`, `com-20567:centre:all` |
| Bay | `<segment_id>:<side>:bay-<n>` | `com-20055:south:bay-58` |
| Zone | `<owner>-<scheme>-<code>` | `com-rpa-7` and `copp-rpa-7` stay distinct; `copp-patrol-10`; `com-parking-area-645` |
| Provider area | `<owner>-<provider>-<code>` | `com-easypark-7514`, `copp-paystay-338831065001` |
| Rule | `<owner>-rule-<content hash>` | identical rules share one record |
| Assignment | `<extent_id>><target_id>` | `com-20055:south:bay-58-bay-72>com-easypark-7514` |

The **asset ID and asset name are separate fields** and are not interchangeable:

- The asset ID (`20567`) is the council's identifier for the road segment asset, and is what
  makes it unique.
- The asset name (`bourke-street-from-russell-to-swanston`) is what the segment is known as.

Until a council supplies the asset ID, the key uses the asset name. When the asset ID arrives,
the key becomes `<owner>-<asset_id>`. PlateWatch then matches the list it already has by street,
cross streets and side, and updates it rather than duplicating it.

## Tables

| Table | One record per | Keys (all present on every record) |
|---|---|---|
| `release` (one record) | release | `release_id`, `dataset_id`, `council_code`, `linking_id`, `municipality_name`, `state`, `country`, `timezone`, `version`, `kind` (snapshot, delta), `status` (candidate, approved, superseded), `effective_from`, `generated_at`, `notes` |
| `sources` | source dataset or document | `source_id`, `name`, `issuer`, `dataset`, `url`, `format`, `licence`, `reference_date`, `data_used[]`, `limitations[]` |
| `segments` | road between two boundaries | `segment_id`, `display_id`, `asset_id`, `asset_name`, `road_name`, `locality`, `from_label`, `from_type`, `to_label`, `to_type`, `geometry`, `status` (candidate, active, retired), `verification`, `source_id`, `notes` |
| `segment_source_refs` | council identifier for a segment | `ref_id`, `segment_id`, `source_id`, `external_id` (as issued, as text), `id_scheme` (road_segment_asset_id, source_row_id), `notes` |
| `extents` | stretch of kerb | `extent_id`, `segment_id`, `side`, `start_m`, `end_m`, `from_label`, `from_type`, `to_label`, `to_type`, `restrictions_status`, `verification`, `notes` |
| `bays` | numbered bay | `bay_id`, `extent_id`, `bay_number`, `plate_number`, `lat`, `lng`, `kind`, `status`, `verification`, `notes` |
| `zone_schemes` | council scheme | `scheme_id`, `kind` (rpa, patrol, parking_area, operational), `name` |
| `zones` | zone in a scheme | `zone_id`, `scheme_id`, `code` (exactly as issued: `9`, `9a`, `009`), `name` (e.g. "Flagstaff") |
| `zone_assignments` | zone on an extent | `assignment_id`, `zone_id`, `extent_id`, `valid_from`, `valid_to`, `source_id`, `verification` |
| `provider_areas` | payment provider area | `provider_area_id`, `provider` (easypark, paystay, other), `area_code` (as text), `account`, `name` |
| `provider_area_assignments` | provider area on an extent | `assignment_id`, `provider_area_id`, `extent_id`, `meter_id`, `valid_from`, `valid_to`, `source_id`, `verification` |
| `rules` | signed rule | `rule_id`, `type`, `sign_code`, `max_stay_minutes`, `days[]`, `all_day`, `start`, `end`, `public_holidays`, `exempt_zone_ids[]`, `exceptions[]`, `description` |
| `rule_assignments` | rule on an extent | `assignment_id`, `rule_id`, `extent_id`, `grace_minutes`, `valid_from`, `valid_to`, `source_id`, `source_sign_id`, `verification` |

- **Extents and sides:** `side` is `north`, `south`, `east`, `west`, `centre`, `both`, `odd`
  or `even`. A whole side has null bounds and part `all`. Where signs change part way along,
  the stretch is bounded by labels (a bay, an address, a cross street), by measured
  `start_m`/`end_m` (metres from the segment's from-boundary, half-open), or both.
- **Rules:** `type` is one of `time_limit`, `metered`, `ticket`, `loading_zone`,
  `permit_zone`, `no_stopping`, `no_parking`, `clearway`, `bus_zone`, `taxi_zone`,
  `accessible`, `works_zone`, `other`.
  - `max_stay_minutes` is required for `time_limit`, `metered` and `ticket`, and makes a
    `loading_zone` timed.
  - `days` are `mon`…`sun`. Times are local to `release.timezone`; `all_day: true` has null
    `start`/`end`; an end before the start runs overnight.
  - `exempt_zone_ids` links exceptions to zones (e.g. `copp-rpa-7`).
- **Zones:** City of Melbourne parking area numbers are zones in the council's `parking_area`
  scheme. EasyPark and PayStay areas are provider areas.
- **Validity:** `valid_from`/`valid_to` (exclusive) on assignments date when they apply.

## Deferred from the full standard

These are deliberately left out of the pilot. They are not needed for PlateWatch or eMAPS to
work, and can be added in a later 1.x version without breaking anything:

- faces;
- segment lineage and segment versions;
- nodes and street runs (boundaries are labels and types on the segment);
- localities and postcodes;
- a separate meter register (a meter ID sits on the provider area assignment);
- separate schedule and evidence tables (windows sit in the rule; evidence is the source, sign
  ID and verification on each assignment);
- reviewed segment–source matches.

## Linking ID

When a council is onboarded, swap its linking ID into every key:

```
npm run release:link -- datasets/copp-patrol-area-10.release.json <linking ID> out/copp-patrol-area-10.release.json
```

- **Changed:** every key (`copp-…` → `<linking ID>-…`), and `release.linking_id` is set.
- **Not changed:** `display_id` (users still see `copp-…`) and council values (`external_id`,
  `asset_id`, `meter_id`, `source_sign_id`).
- **Checks:** the release is validated before and after.

The secret CivicMAPS ID is never written to a release.

## Delivery

- **Devices:** one JSON file per release (`*.release.json`), loaded in PlateWatch with *Import
  from file*. It is validated first; a release with any problem is not imported, and each
  problem is listed with its path (e.g. `rules[3].days`).
- **Councils:** the same release as one CSV per table, columns in the order above. Null is an
  empty cell; lists and geometry are JSON text.
  - From a file: `npm run release:csv -- <release.json> <folder>`.
  - From PlateWatch: *Import → Export → Tables (CSV)*, which gives a zip.

## Council area datasets (Area 10)

`areaDatasetToRelease` adapts a `street_segments` + `record_defaults` dataset to a candidate
release, and PlateWatch also imports such a file directly.

| Area 10 | Release |
|---|---|
| `scope.municipality` | `release`: `municipality_name`, `council_code` `copp`, `state`, `country`, `timezone` |
| `dataset_title`, `scope`, `missing_authoritative_fields` | `release.notes` |
| `accessible_sources[]` | `sources[]` (name, issuer, URL, format, reference date, data used, limitations) |
| `record_defaults` | applied to every record during conversion |
| `road_segment_name`, `between_street_name`, `and_street_name` | `segments`: `road_name`, `from_label`, `to_label`; `asset_name` |
| road segment asset ID (when added: `road_segment_id`, `road_segment_asset_id` or `asset_id`) | `segments.asset_id` (key becomes `copp-<asset ID>`), plus a `road_segment_asset_id` source reference |
| `segment_id` (the source's own row ID) | `segment_source_refs` with `id_scheme: source_row_id` |
| `road_side` | `extents.side` |
| `enforcement_zone: "10"` | zone `copp-patrol-10` in scheme `copp-patrol`, assigned to the extent |
| `parking_restrictions[]` with `restriction_applied: null` | no rule; extent `pending_field_capture` |
| `parking_restrictions[]` with a control | `rules` + `rule_assignments` (sign ID, effective dates, verification) |

To complete Area 10:

1. Add the asset IDs.
2. Survey each side, splitting it into extents where signs change.
3. Add the rules, PayStay provider areas and meters.
4. Raise `verification` as records are field checked or verified.

## CivicMAPS-preview data

The kerbside v1 (`civicmaps.kerbside_parking_segment.v1`), road-segment, field-survey and
parking-area-zone files from CivicMAPS-preview are imported by PlateWatch directly. Exporting
from PlateWatch then writes them out as a candidate release, which is how existing CivicMAPS
data is brought into the tables.

## What PlateWatch keeps

PlateWatch turns each extent into a timed list:

| Release | PlateWatch timed list |
|---|---|
| `extent_id` | external ID |
| `display_id` | shown as *Segment* |
| `asset_id` | road segment ID |
| patrol zone | zone code and name |
| RPA zone | permit area |
| parking-area zone | payment parking area |
| EasyPark and PayStay provider areas (with meter ID) | payment |
| bays with positions | bays |
| timed rules (with grace) | restrictions |
| other rules | *Other signs* |

PlateWatch's export writes timed lists back out as a candidate release. Geometry, measured
ranges, validity dates and per-record verification are not kept on a device, so an export is a
working copy for review. The published release stays the source of truth.

## Versioning

`schema_version` follows semantic versioning. 1.x only adds tables or nullable keys, so every
1.x reader accepts every 1.x release. A breaking change becomes version 2.0.0.
