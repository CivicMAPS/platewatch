# Bulk import

Bulk import loads street segments, numbered bays, permit (allow) lists and hot lists from files,
so that segments are not entered one by one in the field. Open it from **Home → New list → Import
from file**, **Settings → Backup → Import lists from CSV / CivicMAPS files**, or the empty Home
screen.

The CivicMAPS format is **[civicmaps.kerbside_release](KERBSIDE-RELEASE.md)** (JSON, or one CSV
per table). The CSV templates below are a simpler, spreadsheet-friendly way for office staff to
enter segments, one row per sign, using the release's identifiers. The Import screen reads:

| File | Kind |
|---|---|
| `*.release.json` with `"schema": "civicmaps.kerbside_release"` | A CivicMAPS release. It is validated first; a release with any problem is not imported, and each problem is listed by path (e.g. `rules[3].days`). |
| Area datasets with `street_segments` and `record_defaults` (e.g. City of Port Phillip *Patrol Area 10*) | Converted to a candidate release on the way in. |
| `platewatch-timed-segments-template.csv` | Street segments and their signs. |
| `platewatch-bays-template.csv` | Numbered bays with positions, for segments in the same import or already on the device. |
| `platewatch-allow-list-template.csv`, `platewatch-hot-list-template.csv` | Permits and hot-list plates. |
| CivicMAPS-preview kerbside, road-segment, field-survey and parking-area-zone JSON | See [KERBSIDE-RELEASE.md](KERBSIDE-RELEASE.md#civicmaps-preview-data). |

To import:

1. Choose one or more files; kinds can be mixed.
2. Check the plan: lists created, lists updated, placeholders, rows not imported (with row
   numbers or paths), stretches left out, and bays without a matching segment.
3. Press **Import**. Nothing is saved before then.

Importing the same data again is safe. Timed lists are matched by their extent ID
(`<segment_id>:<side>:<part_id>`), then by street, cross streets, side and part. Allow and
hot lists are matched by name. A matching list is updated in place and keeps its name, linked
allow lists and scan history. Restrictions already entered are kept when the import has none.

The Import screen also **exports** all timed lists as a candidate civicmaps.kerbside_release:
*Release (JSON)* for EnforcementMAPS or another device, or *Tables (CSV)* (a zip of one CSV per
table) for council staff. Enter the council name; the council code is derived from it (`com`,
`copp`), and a linking ID can be given once the council is onboarded.

## Timed segments: `platewatch-timed-segments-template.csv`

**One row per signed control.** Rows for the same part form one timed list, with one restriction
per row. A part is identified by `segment_id` + `side` + `part_id` (its extent ID) when
`segment_id` is given, otherwise by road, cross streets, side and part bounds. A part with no
signs yet gets one row with `restrictions_status` = `pending_field_capture`. It is imported as a
placeholder: officers can find it and scan against it, and it shows *Restrictions to enter*.

| Column | Required | Example | Notes |
|---|---|---|---|
| `segment_id` | | `copp-31065` | `<council code>-<road segment asset ID>`, or `<council code>-<asset name>` (`copp-normanby-road-from-boundary-to-montague`) until the asset ID is known. Use the linking ID instead of the council code once the council is onboarded. Ties rows to the release. |
| `part_id` | where a side has several parts | `bay-58-bay-72` | `all` (or blank) for the whole side. |
| `road_segment_id` | | `20055` | The council's road segment asset ID (the column may also be named `road_segment_asset_id`). Not the same as `segment_id`, and not the asset name. |
| `patrol_zone` | | `10` | Internal patrol zone / enforcement area number (exported as zone `copp-patrol-10`). Home groups lists by it. |
| `patrol_zone_name` | | `Flagstaff` | Day-to-day name of the zone. |
| `road` | ✔ | `Coventry Street` | `St`, `Rd`, `Ave`… are matched to `Street`, `Road`, `Avenue`. |
| `locality` | | `South Melbourne` | |
| `between_from`, `between_to` | ✔ | `Montague Street`, `Ferrars Street` | Cross streets or boundaries, in either order. |
| `side` | | `north` | `both` (default), `north`, `south`, `east`, `west`, `centre` (median), `odd`, `even`. |
| `part_from`, `part_to` | | `Bay 58`, `Bay 72` | Where signs change part way along: a bay, an address or a cross street. |
| `permit_area` | | `7` | Residential permit area code (exported as `copp-rpa-7`, so the same number in another council stays distinct). |
| `parking_area` | | `645` | Parking area number (one per segment). Kerb plate = area + bay (`64558`). |
| `easypark_areas` | | `7514;7515` | Separated by `;`. |
| `paystay_zones` | | `338851200001` or `33883296:GLP1` | Separated by `;`. Add `:meter` to tie a meter to the zone (repeat the zone for each meter: `33883296:GLP1;33883296:GLP4`). |
| `meter_ids` | | `GLP9` | Meters for the whole segment and its parking area, separated by `;`. |
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
  part's rows is used. EasyPark areas, PayStay zones and meters from all of a part's rows are
  combined on the list.
- **Payment is tied to the sign on its row.** The `easypark_areas` and `paystay_zones` on a
  sign's row are the numbers that pay for that restriction (*Paid with* in the app). Leave them
  blank on rows for unpaid signs, such as No Stopping or a free loading zone.

Older files that use the first template's columns (`street`, `from_street`, `to_street`,
`sub_from`, `sub_to`, `rpa`, `sign`, `minutes`, `grace`, `bays`) still import.

## Numbered bays: `platewatch-bays-template.csv`

**One row per bay.** Rows are matched to the part they belong to: in the same import, or a timed
list already on the device. They never create a list on their own; bays whose part cannot be
found are listed on the Import screen.

| Column | Required | Example | Notes |
|---|---|---|---|
| `segment_id`, `part_id` | | `com-20055`, `bay-58-bay-72` | As in the timed template; preferred for matching. |
| `road`, `between_from`, `between_to` | ✔ | `Little Bourke Street`, `Swanston Street`, `Elizabeth Street` | |
| `side`, `part_from`, `part_to` | | `south`, `Bay 58`, `Bay 72` | |
| `bay` | ✔ | `58` | Bay number. |
| `lat`, `lng` | | `-37.8127332`, `144.9645599` | WGS84 decimal degrees. |
| `sign_number` | | | Only when the kerb plate is not parking area + bay. |

## Allow list: `platewatch-allow-list-template.csv`

| Column | Required | Example | Notes |
|---|---|---|---|
| `list_name` | ✔ | `RPA 7 residents` | Rows with the same name (any case) form one list; an existing list of that name is added to. |
| `plate` | ✔ | `1AB2CD` | Up to 10 characters; spaces and dashes are removed. A plate already on the list is updated. |
| `permit_no` | | `RPA-2026-0789`, `RSP-2026-0790/1`, `RPA/COMB/FS-2026-0791` | Authoritative: types (RPA, RSP, RP, FS; COMB for combinations), issue year, sequential ID, amendment. A number in another format is kept as text with no types. |
| `council`, `linking_id` | | `com`, `919379201` | Issuing council code and its CivicMAPS linking ID (optional until onboarded). |
| `valid_from`, `valid_to` | | `2026-07-01` or `01/07/2026` | Valid from 00:00 on `valid_from` to midnight at the end of `valid_to`. |
| `parking_area` | RPA | `7`, `4B`, `com-rpa7` | Residential parking area (`rpa` also read). |
| `street_number`, `street` | | `12`, `Gladstone Street` | Registered address. RSP / RP permits apply on this street. |
| `registration_state` | | `VIC` | VIC, NSW, QLD, SA, WA, TAS, ACT, NT (blank = VIC). |
| `registration_type` | | `private` | private, commercial, company, lease, diplomatic, other. |
| `type` | | `sedan` | sedan, hatchback, suv, wagon, coupe, convertible, ute, van, people_mover, light_truck, truck, bus, motorcycle, scooter, other (`body_type` also read). |
| `make`, `colour` | | `Toyota`, `White` | An older `vehicle` column is read into `make`. |
| `label` | | `Resident` | |
| `streets` | | `Smith St;Clarendon St` | Optional extra streets for permits held without types. |

A code not on its list is reported as an import issue. Permits can also be imported as JSON in
the CivicMAPS permit schema (`schemas/civicmaps-parking-permit.v1.schema.json`): a single permit,
an array, or `{ "permits": [...] }`; each council's permits form a list named `Permits · <council>`.

Link an allow list to timed lists from each timed list's *Edit* screen.

## Hot list: `platewatch-hot-list-template.csv`

| Column | Required | Example | Notes |
|---|---|---|---|
| `list_name` | ✔ | `Officer safety` | |
| `plate` | ✔ | `ABC123` | |
| `risk_level` | | `caution` (default), `high`, `extreme` | |
| `risks` | | `Aggressive;Threats / intimidation` | Separated by `;`: Aggressive, Previous assault, Spitting, Verbal abuse, Threats / intimidation, Weapon sighted, Flees / evades, Other. |
| `registration_state`, `registration_type`, `type`, `make`, `colour` | | `VIC`, `private`, `ute`, `Toyota`, `White` | Vehicle details in the infringement-issuance structure; codes as for the allow list. Older files: `body_type` is read as `type`; `model` (not part of the structure) is added to the notes. |
| `notes` | | | |

The example rows in each template are illustrations to overwrite. Restrictions marked
*Example – replace* are not surveyed signs.
