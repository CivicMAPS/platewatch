# civicmaps.parking_dataset v1

The normalised format for street segments and their parking data, used by PlateWatch and
EnforcementMAPS (eMAPS) in the CivicMAPS ecosystem.

- **JSON Schema:** [`schemas/civicmaps-parking-dataset.v1.schema.json`](../schemas/civicmaps-parking-dataset.v1.schema.json) (draft 2020-12)
- **Datasets:**
  - [`datasets/copp-patrol-area-10.parking.json`](../datasets/copp-patrol-area-10.parking.json): City of Port Phillip Patrol Area 10, 55 segments, asset IDs and restrictions not yet acquired.
  - [`datasets/examples/example-com-copp.parking.json`](../datasets/examples/example-com-copp.parking.json): a City of Melbourne segment (numbered bays with positions, parking area, EasyPark) beside a City of Port Phillip segment (PayStay, permit area), showing that the records are identical in structure. The Port Phillip segment `copp-31065` is illustrative.
- **In PlateWatch:** *Import from file* reads it (and council area datasets); *Import → Export* writes it.

## Principles

1. **One fixed structure for every council.** Every record carries every key, in the same shape,
   whichever council it describes. Where a value is unknown or not yet acquired it is `null`,
   or `[]` for a list. It is never left out, and never replaced by a council-specific field.
2. **Council data is adapted to the structure, never the reverse.** A council's own layout,
   identifiers, defaults and field names are translated on the way in. Their own identifiers
   are kept for reference under `road.external_ids`.
3. **One identifier rule for every council**, so records from different councils never
   collide and look the same:

   | Record | Identifier | Examples |
   |---|---|---|
   | Council | `dataset.municipality.code` | `com` (City of Melbourne), `copp` (City of Port Phillip) |
   | Dataset | `<code>-<area>` | `copp-patrol-area-10` |
   | Segment | `<code>-<road_segment_id>` | `com-20055`, `copp-31065` |
   | Segment, asset ID not yet acquired | `<code>-<road>-<from>-<to>` (provisional) | `copp-normanby-rd-boundary-st-montague-st` |
   | Patrol zone | `<code>-<number>`, or `<code>-<name>` without a number | `copp-10`, `com-chinatown` |
   | Permit area (RPA) | `<code>-rpa-<code>` | `com-rpa-7`, `copp-rpa-7` |
   | Part | `all` for the whole side, otherwise from its bounds | `all`, `bay-58-bay-72` |

   Permit area numbers repeat between councils. The council code keeps `com-rpa-7` and
   `copp-rpa-7` apart, while officers still see just "RPA 7".
4. **Nothing guessed.** A stretch whose signs are not yet surveyed has
   `restrictions_status: "pending_field_capture"` and no restrictions. It still exists, so
   officers can find it, and it is completed later.
5. **Provenance travels with the data.** Sources with their limitations, and a `data_quality`
   on every segment, part, restriction and bay, say how far each value can be relied on.

## Structure

Every key below is present on every record.

```
{
  schema: "civicmaps.parking_dataset", schema_version: "1.0.0",
  dataset:      { id, title, status, generated_at,
                  municipality: { name, code, state, country, timezone },
                  sources: [{ id, name, publisher, url, format, reference_date, data_used[], limitations[] }],
                  notes[] },
  conventions:  { bay_sign_format, paystay_zone_pattern, easypark_area_pattern, notes[] },
  patrol_zones: [{ id, number, name, kind, geometry }],
  permit_areas: [{ id, code, name }],
  segments: [{
    id, road_segment_id, patrol_zone,
    road: { name, locality, external_ids{} }, between: { from, to },
    geometry, data_quality, notes,
    sides: [{
      side,                                   both | north | south | east | west | odd | even
      parts: [{
        id, from, to,                         bounds: { kind, label, location } or null
        permit_area,                          permit_areas[].id or null
        payment: { parking_area, easypark_areas[], paystay_zones[{ zone, meter_id }], meters[{ id, location }] },
        restrictions_status,                  supplied | pending_field_capture | no_parking_spaces
        restrictions: [{ control, sign_code, limit_minutes, days[], all_day, start, end,
                         public_holidays, exceptions[], exempt_permit_areas[], grace_minutes,
                         source_sign_id, effective_from, effective_to, data_quality }],
        bays: [{ number, sign_number, location, kind, data_quality, notes }],
        data_quality, notes
      }]
    }]
  }]
}
data_quality = { status, source, confidence, last_verified, notes }
```

Records are written out in full; there is no `defaults` section. A council's defaults, such as
`record_defaults` in the Area 10 file, are applied to each record during conversion.

### Segments, sides and parts

- **Segment:** a road between two cross streets or boundaries (`between.from` / `between.to`,
  in either direction).
  - `road_segment_id` is the council's **road segment asset ID**, e.g. City of Melbourne road
    corridor `20055`. It is `null` until acquired; source files may call it
    `road_segment_asset_id` or `asset_id`.
  - Once it is known, the segment `id` becomes `<code>-<road_segment_id>`. PlateWatch matches
    lists imported under the provisional ID by street, cross streets and side, so they are
    updated rather than duplicated.
- **Side:** `both` when controls are the same on both sides, or not yet known (Area 10 until
  kerb data exists). Otherwise a compass side, or `odd` / `even`.
- **Part:** `from`/`to` are `null` when the part is the whole side (`id: "all"`). Where signs
  change part way along, each stretch is its own part, bounded by an `intersection`, a `bay`
  (`"Bay 58"`), an `address` (`"234 Little Bourke Street"`), a `point` (with `location`), a
  `boundary` or the `segment_end`. PlateWatch times vehicles per part.
- Names arriving all in lower or upper case are given consistent capitals ("coventry street"
  → "Coventry Street"); spelling is not changed.

### Payment

| Field | Use | Example |
|---|---|---|
| `parking_area` | Council parking area number, one per segment (e.g. City of Melbourne). Paid at the meter or in EasyPark; with a bay number it forms the kerb plate. | `"645"` |
| `easypark_areas` | EasyPark area numbers. Several when a side changes restriction during the day. | `["7514"]` |
| `paystay_zones` | PayStay zones, `meter_id` null when there is none. City of Port Phillip: `3388` + assigned segment number + four digits for the side. | `[{"zone": "338831065001", "meter_id": null}]` |
| `meters` | Ticket machines or meters (e.g. City of Port Phillip *SerNo*) with positions. | `[{"id": "SN-1043", "location": null}]` |

### Numbered bays

`bays[]` lists each numbered bay of a part: `number`, `location` (WGS84 lat/lng, or `null`),
`kind`, `data_quality` and `notes`. The kerb plate number comes from
`conventions.bay_sign_format`, e.g. `"{parking_area}{bay}"` for City of Melbourne, so area
645, bay 58 gives plate `64558`. Set `sign_number` only for a plate that does not follow the
convention, otherwise `null`. A part without numbered bays has `bays: []`.

### Restrictions

One restriction per signed combination of control, days and times.

| `control` | Timed in PlateWatch? | Notes |
|---|---|---|
| `time_limit` | yes | `sign_code` such as `2P`, `1/2P`, `P15`; `limit_minutes` required |
| `metered`, `ticket` | yes | paid parking with a time limit; `limit_minutes` required |
| `loading_zone` | when `limit_minutes` is given | e.g. `LZ 30` |
| `permit_zone`, `no_stopping`, `no_parking`, `clearway`, `bus_zone`, `taxi_zone`, `accessible`, `works_zone`, `other` | no | shown as *Other signs*; a part with only these has nothing to time |

- **Days:** `days` lists `mon`…`sun`.
- **Times:** `all_day: true` means at all times, with `start`/`end` `null`. Otherwise
  `start`/`end` are local 24-hour `HH:MM` in `dataset.municipality.timezone`; `end` may be
  `24:00`, and an end before the start runs overnight.
- **Exceptions:** `exceptions` records them as signed; `exempt_permit_areas` links them to
  `permit_areas` (e.g. `["copp-rpa-7"]`).

### Councils

Codes and conventions for known councils are built in: City of Melbourne (`com`, bay plates
`{parking_area}{bay}`) and City of Port Phillip (`copp`, PayStay `^3388\d+$`). Another
council's code is the initials of its name (City of Yarra → `coy`) unless set.

## From the Area 10 file to this format

| Area 10 | civicmaps.parking_dataset |
|---|---|
| `scope.municipality` | `dataset.municipality` (`name`, `code: "copp"`, `state`, `country`, `timezone`); `conventions` for City of Port Phillip |
| `dataset_title`, `scope`, `missing_authoritative_fields` | `dataset.title`, `dataset.status: draft`, `dataset.notes` |
| `accessible_sources[]` | `dataset.sources[]` |
| `record_defaults` | applied to every segment (there is no defaults section) |
| `enforcement_zone: "10"` | `patrol_zone: "copp-10"` → `patrol_zones[] { id: "copp-10", number: "10", name: null }` |
| `segment_id` | `road.external_ids.source_segment_id`; the segment `id` follows the rule |
| `road_segment_name`, `between_street_name`, `and_street_name` | `road.name`, `between.from`, `between.to` |
| road segment asset ID (when added) | `road_segment_id`, and `id` becomes `copp-<asset id>` |
| `road_side` | `sides[].side` |
| `parking_restrictions[]` with `restriction_applied: null` | part `all`, `restrictions_status: pending_field_capture`, `restrictions: []` |
| `parking_restrictions[]` with a control | `restrictions[]`: `control`, `sign_code`, `limit_minutes`, `days` (Monday → `mon`), `all_day` / `start` / `end`, `exceptions`, `source_sign_id`, `effective_from`/`to`, `data_quality.status` |
| `data_quality` | segment `data_quality` (`source`, `notes`) |

To complete Area 10:
1. Add each segment's road segment asset ID.
2. Survey each side, splitting it into parts where signs change.
3. Add the restrictions, PayStay zones and meters.
4. Set `restrictions_status` to `supplied` and `data_quality.status` to `field_checked` or
   `verified`.

## CivicMAPS-preview data

The kerbside v1 (`civicmaps.kerbside_parking_segment.v1`), road-segment, field-survey and
parking-area-zone files map onto this model, and PlateWatch imports them directly. Exporting
from PlateWatch writes them as a civicmaps.parking_dataset in the fixed structure, which is
how existing CivicMAPS data is brought into the normalised format.

## What PlateWatch keeps

PlateWatch stores what it needs to find a stretch of kerb and time vehicles on it:

- identifiers and names: external ID, road segment ID, road, between, side, part bounds;
- patrol zone number and name, and permit area code;
- parking area, EasyPark areas, PayStay zones and meter IDs;
- bay numbers with their positions and plate numbers;
- timed restrictions, with exceptions as their description;
- other signs, as *Other signs*;
- notes.

It does not store geometry, meter positions, sources, `data_quality`, `source_sign_id`,
`public_holidays` or effective dates. Its export writes those as `null` / `[]`. A PlateWatch
export is therefore a working copy for moving lists between devices or back to eMAPS, not the
master record. Keep the council's dataset as the source of truth and re-import it when it
changes; lists match on their external IDs.

## Spreadsheets

Office staff can prepare data in the CSV templates ([IMPORT-TEMPLATES.md](IMPORT-TEMPLATES.md)).
Their columns use this format's names (`segment_id`, `part_id`, `road`, `between_from`,
`control`, `sign_code`, `limit_minutes`…), with numbered bays and their positions in a separate
bays CSV. Importing the CSVs and exporting produces a civicmaps.parking_dataset.

## Versioning

`schema_version` follows semantic versioning. 1.x adds optional values only (as `null`-able
keys), so every 1.x reader accepts every 1.x file. A breaking change becomes
`civicmaps.parking_dataset` 2.0.0.
