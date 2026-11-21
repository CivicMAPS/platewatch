# Bulk import

Bulk import loads street segments, numbered bays, permit (allow) lists and hot lists from files,
so that segments are not entered one by one in the field. Open it from **Home → New list → Import
from file**, **Settings → Backup → Import lists from CSV / CivicMAPS files**, or the empty Home
screen.

The normalised format is **[civicmaps.parking_dataset](PARKING-DATA-SCHEMA.md)** (JSON). The CSV
templates below are a spreadsheet-friendly view of the same model, for office staff, with the
same column names. The Import screen reads:

| File | Kind |
|---|---|
| `*.parking.json` with `"schema": "civicmaps.parking_dataset"` | The normalised dataset. It is validated first; a dataset with errors is not imported, and each problem is listed by path (e.g. `segments[12].sides[0].parts[1].restrictions[0].days`). |
| Area datasets with `street_segments` and `record_defaults` (e.g. City of Port Phillip *Patrol Area 10*) | Converted to the normalised dataset on the way in. |
| `platewatch-timed-segments-template.csv` | Street segments and their signs. |
| `platewatch-bays-template.csv` | Numbered bays with positions, for segments in the same import or already on the device. |
| `platewatch-allow-list-template.csv`, `platewatch-hot-list-template.csv` | Permits and hot-list plates. |
| CivicMAPS-preview kerbside, road-segment, field-survey and parking-area-zone JSON | See [PARKING-DATA-SCHEMA.md](PARKING-DATA-SCHEMA.md#civicmaps-preview-data). |

To import:

1. Choose one or more files; kinds can be mixed.
2. Check the plan: lists created, lists updated, placeholders, rows not imported (with row
   numbers or paths), stretches left out, and bays without a matching segment.
3. Press **Import**. Nothing is saved before then.

Importing the same data again is safe. Timed lists are matched by their dataset ID
(`dataset_id/segment_id/side/part_id`), then by street, cross streets, side and part. Allow and
hot lists are matched by name. A matching list is updated in place and keeps its name, linked
allow lists and scan history. Restrictions already entered are kept when the import has none.

The Import screen also **exports** all timed lists as a civicmaps.parking_dataset, for
EnforcementMAPS or another device.

## Timed segments: `platewatch-timed-segments-template.csv`

**One row per signed control.** Rows for the same part form one timed list, with one restriction
per row. A part is identified by `dataset_id` + `segment_id` + `side` + `part_id` when
`segment_id` is given, otherwise by road, cross streets, side and part bounds. A part with no
signs yet gets one row with `restrictions_status` = `pending_field_capture`. It is imported as a
placeholder: officers can find it and scan against it, and it shows *Restrictions to enter*.

| Column | Required | Example | Notes |
|---|---|---|---|
| `dataset_id` | | `copp-patrol-area-10` | Same as `dataset.id` in the JSON: `<council code>-<area>`. |
| `segment_id` | | `copp-31065` | `<council code>-<road segment asset ID>`, or the provisional `copp-normanby-rd-boundary-st-montague-st` until the asset ID is known. With `dataset_id` it ties rows to the dataset. |
| `part_id` | where a side has several parts | `bay-58-bay-72` | `all` (or blank) for the whole side. |
| `road_segment_id` | | `20055` | The council's road segment asset ID (the column may also be named `road_segment_asset_id`). Not the same as `segment_id`. |
| `patrol_zone` | | `10` | Internal patrol zone / enforcement area number (exported as `copp-10`). Home groups lists by it. |
| `patrol_zone_name` | | `Flagstaff` | Day-to-day name of the zone. |
| `road` | ✔ | `Coventry Street` | `St`, `Rd`, `Ave`… are matched to `Street`, `Road`, `Avenue`. |
| `locality` | | `South Melbourne` | |
| `between_from`, `between_to` | ✔ | `Montague Street`, `Ferrars Street` | Cross streets or boundaries, in either order. |
| `side` | | `north` | `both` (default), `north`, `south`, `east`, `west`, `odd`, `even`. |
| `part_from`, `part_to` | | `Bay 58`, `Bay 72` | Where signs change part way along: a bay, an address or a cross street. |
| `permit_area` | | `7` | Residential permit area code (exported as `copp-rpa-7`, so the same number in another council stays distinct). |
| `parking_area` | | `645` | Parking area number (one per segment). Kerb plate = area + bay (`64558`). |
| `easypark_areas` | | `7514;7515` | Separated by `;`. |
| `paystay_zones` | | `338851200001` or `00042:4521` | Separated by `;`; add `:meter` for a meter ID. |
| `restrictions_status` | | `supplied` | `supplied`, `pending_field_capture` (placeholder) or `no_parking_spaces` (left out). |
| `control` | | `time_limit` | `time_limit`, `metered`, `ticket`, `loading_zone`, `permit_zone`, `no_stopping`, `no_parking`, `clearway`, `bus_zone`, `taxi_zone`, `accessible`, `works_zone`, `other`. Can be left blank when `sign_code` says it (`2P`, `No Stopping`). |
| `sign_code` | | `2P`, `1/2P`, `P15`, `LZ 30`, `No Stopping` | As printed on the sign. |
| `limit_minutes` | timed controls | `120` | Whole minutes. Read from `sign_code` when blank (2P = 120). |
| `days` | with a control | `Mon-Fri`, `Sat-Sun`, `Sat`, `Mon,Wed,Fri`, `Every day` | Blank = every day. |
| `start`, `end` | | `08:00`, `18:00` | 24-hour time. Both blank, or `00:00`–`24:00`, means all times. An end before the start runs overnight. |
| `exceptions` | | `Permit Zone 7 excepted` | Separated by `;`. |
| `grace_minutes` | | `5` | 0–120. |
| `list_name` | | | Optional. Default: `Little Bourke St, Swanston St – Elizabeth St (S) · Bay 58 – Bay 72`. |
| `notes` | | | Added to the list's notes. |

- Timed controls (`time_limit`, `metered`, `ticket`, and `loading_zone` with an allowance)
  become restrictions.
- Other controls are kept as *Other signs* on the list. A part with only those has nothing to
  time; it is left out and listed under *Left out*.
- For single-valued columns (zone, permit area, parking area…), the first value given in a
  part's rows is used. EasyPark areas and PayStay zones from all of a part's rows are combined.

Older files that use the first template's columns (`street`, `from_street`, `to_street`,
`sub_from`, `sub_to`, `rpa`, `sign`, `minutes`, `grace`, `bays`) still import.

## Numbered bays: `platewatch-bays-template.csv`

**One row per bay.** Rows are matched to the part they belong to: in the same import, or a timed
list already on the device. They never create a list on their own; bays whose part cannot be
found are listed on the Import screen.

| Column | Required | Example | Notes |
|---|---|---|---|
| `dataset_id`, `segment_id`, `part_id` | | `com-chinatown`, `com-20055`, `bay-58-72` | As in the timed template; preferred for matching. |
| `road`, `between_from`, `between_to` | ✔ | `Little Bourke Street`, `Swanston Street`, `Elizabeth Street` | |
| `side`, `part_from`, `part_to` | | `south`, `Bay 58`, `Bay 72` | |
| `bay` | ✔ | `58` | Bay number. |
| `lat`, `lng` | | `-37.8127332`, `144.9645599` | WGS84 decimal degrees. |
| `sign_number` | | | Only when the kerb plate is not parking area + bay. |

## Allow list: `platewatch-allow-list-template.csv`

| Column | Required | Example | Notes |
|---|---|---|---|
| `list_name` | ✔ | `RPA 7 residents` | Rows with the same name (any case) form one list; an existing list of that name is added to. |
| `plate` | ✔ | `1AB2CD` | Spaces and dashes are removed. A plate already on the list is updated. |
| `label` | | `Resident` | |
| `permit_no` | | `P-1001` | |
| `valid_from`, `valid_to` | | `2026-07-01` or `01/07/2026` | Inclusive; blank = no limit. |

Link an allow list to timed lists from each timed list's *Edit* screen.

## Hot list: `platewatch-hot-list-template.csv`

| Column | Required | Example | Notes |
|---|---|---|---|
| `list_name` | ✔ | `Officer safety` | |
| `plate` | ✔ | `ABC123` | |
| `risk_level` | | `caution` (default), `high`, `extreme` | |
| `risks` | | `Aggressive;Threats / intimidation` | Separated by `;`: Aggressive, Previous assault, Spitting, Verbal abuse, Threats / intimidation, Weapon sighted, Flees / evades, Other. |
| `make`, `model`, `body_type`, `colour` | | `Toyota`, `Hilux`, `Ute`, `White` | |
| `notes` | | | |

The example rows in each template are illustrations to overwrite. Restrictions marked
*Example – replace* are not surveyed signs.
