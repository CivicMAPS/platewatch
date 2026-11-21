# civicmaps.parking_dataset v1

The normalised format for street segments and their parking data, used across councils by
PlateWatch and EnforcementMAPS (eMAPS) in the CivicMAPS ecosystem.

- **JSON Schema:** [`schemas/civicmaps-parking-dataset.v1.schema.json`](../schemas/civicmaps-parking-dataset.v1.schema.json) (draft 2020-12)
- **Worked examples:**
  - [`datasets/copp-patrol-area-10.parking.json`](../datasets/copp-patrol-area-10.parking.json): City of Port Phillip Patrol Area 10, 55 segments, restrictions not yet surveyed.
  - [`datasets/examples/example-two-councils.parking.json`](../datasets/examples/example-two-councils.parking.json): City of Melbourne numbered bays with positions, parking area and EasyPark; City of Port Phillip PayStay and permit area.
- **In PlateWatch:** *Import from file* reads it (and the older area datasets); *Import → Export* writes it.

## Design rules

1. **One model for every council.** Patrol zone numbers and names, permit areas, parking area
   numbers, EasyPark areas, PayStay zones, meters and numbered bays all fit the same structure.
   A council fills in the parts it uses and leaves the rest out.
2. **Nothing guessed.** Unknown values are `null` or absent. A stretch whose signs are not yet
   surveyed has `restrictions_status: "pending_field_capture"` and no restrictions. It still
   exists, so officers can find it, and it is completed later.
3. **Stable identifiers.** `dataset.id` + `segment.id` + side + `part.id` identify every stretch
   of kerb. Re-importing an updated dataset updates the same records, even if a street name was
   corrected.
4. **Provenance travels with the data.** Sources, their limitations and per-record
   `data_quality` (verified / field checked / unverified / inferred / pending) say how far each
   value can be relied on for enforcement.
5. **Defaults keep files small.** Values shared by every segment go in `defaults` once, as
   `record_defaults` did in the Area 10 file.

## Structure

```
dataset ─┬─ dataset        id, title, status, municipality (name, timezone…), sources, notes
         ├─ conventions    bay_sign_format, paystay_zone_pattern, easypark_area_pattern
         ├─ patrol_zones   id, number ("10"), name ("Flagstaff"), kind
         ├─ permit_areas   id, code ("7"), name
         ├─ defaults       any segment value, applied unless a segment overrides it
         └─ segments[]     one road between two cross streets or boundaries
              ├─ id, road_segment_id, patrol_zone, road {name, locality, external_ids}, between {from, to}
              ├─ geometry (GeoJSON LineString | MultiLineString), data_quality, notes
              └─ sides[]   side: both | north | south | east | west | odd | even
                   └─ parts[]   the whole side, or the stretch between two bounds where signs change
                        ├─ id (required when a side has more than one part), from, to (bounds)
                        ├─ permit_area, payment {parking_area, easypark_areas[], paystay_zones[], meters[]}
                        ├─ restrictions_status: supplied | pending_field_capture | no_parking_spaces
                        ├─ restrictions[]  control, sign_code, limit_minutes, days, start/end or all_day,
                        │                  public_holidays, exceptions, exempt_permit_areas, grace_minutes,
                        │                  source_sign_id, effective_from/to, data_quality
                        └─ bays[]        number, sign_number, location {lat, lng}, kind, data_quality
```

### Segments, sides and parts

- **Segment:** a road between two cross streets or boundaries (`between.from` / `between.to`,
  in either direction). It has two identifiers:
  - `id` is the dataset's own stable identifier (e.g. `coventry-st-montague-st-ferrars-st`).
    Re-imports match on it, so it must not change.
  - `road_segment_id` is the council's **road segment asset ID**, e.g. City of Melbourne road
    corridor `20055`. It is `null` until the council supplies it; Area 10 has it in `defaults`
    as `null`, ready to fill in per segment. PlateWatch shows it on the list (*Segment ID*) and
    search finds it. Source files may call it `road_segment_asset_id` or `asset_id`.

  `road.external_ids` holds other references, such as `vicmap_ufi`.
- **Side:** `both` when controls are the same on both sides, or not yet known (Area 10 uses
  this until kerb data exists). Otherwise a compass side, or `odd` / `even` for numbered sides.
- **Part:** with no `from`/`to`, a part is the whole side. Where signs change part way along,
  each stretch is its own part, bounded by an `intersection`, a `bay` (`"Bay 58"`), an `address`
  (`"234 Little Bourke Street"`), a `point` (with `location`), a `boundary` or the `segment_end`.
  PlateWatch times vehicles per part.

### Payment

| Field | Use | Example |
|---|---|---|
| `parking_area` | Council parking area number, one per segment (e.g. City of Melbourne). Paid at the meter or in EasyPark; with a bay number it forms the kerb plate. | `"645"` |
| `easypark_areas` | EasyPark area numbers. Several when a side changes restriction during the day. | `["7514"]` |
| `paystay_zones` | PayStay zones, with an optional `meter_id`. City of Port Phillip: `3388` + assigned segment number + four digits for the side. | `[{"zone": "338851200001"}]` |
| `meters` | Ticket machines or meters, e.g. City of Port Phillip *SerNo*, with a position. | `[{"id": "SN-1043", "location": {…}}]` |

### Numbered bays

`bays[]` lists each numbered bay of a part: `number`, `location` (WGS84 lat/lng where surveyed),
`kind` (`standard`, `accessible`, `loading`, `motorcycle`, `ev`, `other`) and `data_quality`.
The kerb plate number comes from `conventions.bay_sign_format`, for example
`"{parking_area}{bay}"` for City of Melbourne, so area 645, bay 58 gives plate `64558`. Use
`sign_number` only for a plate that does not follow the convention. A council without numbered
bays sets `bay_sign_format` to `null` and leaves `bays` out.

### Restrictions

One restriction per signed combination of control, days and times.

| `control` | Timed in PlateWatch? | Notes |
|---|---|---|
| `time_limit` | yes | `sign_code` such as `2P`, `1/2P`, `P15`; `limit_minutes` required |
| `metered`, `ticket` | yes | paid parking with a time limit; `limit_minutes` required |
| `loading_zone` | when `limit_minutes` is given | e.g. `LZ 30` |
| `permit_zone`, `no_stopping`, `no_parking`, `clearway`, `bus_zone`, `taxi_zone`, `accessible`, `works_zone`, `other` | no | kept and shown as *Other signs*; a part with only these has nothing to time |

- **Days:** `days` lists `mon`…`sun` explicitly.
- **Times:** `start`/`end` are local 24-hour `HH:MM` in `dataset.municipality.timezone`. `end`
  may be `24:00`, an end before the start runs overnight, and `all_day: true` means at all times.
- **Exceptions:** `exceptions` records them as signed (`"Permit Zone 7 excepted"`), and
  `exempt_permit_areas` links them to `permit_areas`.
- **Provenance:** `source_sign_id`, `effective_from`/`effective_to` and `data_quality` record
  where the sign came from and how far it has been verified.

## From the Area 10 file to this format

The Area 10 *Working Street Segment and Restriction Dataset* converts without loss
(`convertAreaDataset`; PlateWatch also imports it as it is):

| Area 10 | civicmaps.parking_dataset |
|---|---|
| `dataset_title`, `dataset_status`, `scope` | `dataset.title`, `dataset.status: draft`, `dataset.notes` |
| `accessible_sources[]` | `dataset.sources[]`: name, publisher, url, format, reference date, data used, limitations |
| `record_defaults` | `defaults`: `patrol_zone`, `sides`, `data_quality`, `geometry` |
| `enforcement_zone` | `patrol_zone` → `patrol_zones[] {id: "10", number: "10"}` |
| `segment_id`, `road_segment_name`, `between_street_name`, `and_street_name` | `id`, `road.name`, `between.from`, `between.to` |
| `road_segment_id` / `road_segment_asset_id` / `asset_id` (when added) | `road_segment_id` (`null` until then) |
| `road_side` | `sides[].side` |
| `parking_restrictions[]` with `restriction_applied: null` | a part with `restrictions_status: pending_field_capture`, `restrictions: []` |
| `parking_restrictions[]` with a control | `restrictions[]`: `control`, `sign_code`, `limit_minutes`, `days` (Monday → `mon`), `start`/`end`, `exceptions`, `source_sign_id`, `effective_from`/`to`, `data_quality.status` |
| `missing_authoritative_fields`, `important_distinction` | `dataset.notes` |
| *(PayStay rule)* | `conventions.paystay_zone_pattern: "^3388\\d+$"` |

To complete Area 10, survey each segment side, split it into parts where signs change, and add
the restrictions, PayStay zones and (where applicable) meters. Then set `restrictions_status`
to `supplied` and `data_quality.status` to `field_checked` or `verified`.

## CivicMAPS-preview data

The kerbside v1 (`civicmaps.kerbside_parking_segment.v1`), road-segment, field-survey and
parking-area-zone files map onto this model, and PlateWatch imports them directly. Their
patrol zones, road segment IDs, parking areas, EasyPark areas, bays with coordinates and parking
rules all carry over. Exporting from PlateWatch writes them as a civicmaps.parking_dataset,
which is how existing CivicMAPS data is brought into the normalised format.

## What PlateWatch keeps

PlateWatch stores what it needs to find a stretch of kerb and time vehicles on it:

- identifiers and names: external ID, road segment ID, road, between, side, part bounds;
- patrol zone number and name, and permit area;
- parking area, EasyPark areas, PayStay zones and meter IDs;
- bay numbers with their positions and plate numbers;
- timed restrictions, with exceptions as their description;
- other signs, as *Other signs*;
- notes.

It does not store geometry, meter positions, sources, `data_quality`, `source_sign_id`,
`public_holidays` or effective dates. A PlateWatch export is therefore a working copy for
moving lists between devices or back to eMAPS, not the master record. Keep the council's
dataset file as the source of truth, and re-import it when it changes; lists match on their
external IDs.

## Spreadsheets

Office staff can prepare data in the CSV templates ([IMPORT-TEMPLATES.md](IMPORT-TEMPLATES.md)).
Their columns use the same names as this format (`segment_id`, `part_id`, `road`,
`between_from`, `control`, `sign_code`, `limit_minutes`…), with numbered bays and their
positions in a separate bays CSV. Importing the CSVs and exporting produces a
civicmaps.parking_dataset.

## Versioning

`schema_version` follows semantic versioning. 1.x adds optional fields only, so every 1.x
reader accepts every 1.x file. A breaking change becomes `civicmaps.parking_dataset` 2.0.0.
