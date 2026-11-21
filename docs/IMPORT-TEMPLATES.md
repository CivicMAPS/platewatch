# Bulk import templates

Bulk import loads street segments, permit (allow) lists and hot lists from files, so that
segments don't have to be entered one by one in the field. Open it from **Home → New list → Import
from file**, **Settings → Backup → Import lists from CSV / CivicMAPS files**, or the empty Home
screen.

1. Download a template from the Import screen, or copy it from [`templates/`](../templates).
2. Fill it in with Excel, Google Sheets or similar, then **save as CSV**. UTF-8 is preferred;
   Excel's "CSV UTF-8" works.
3. On the Import screen, choose one or more files. You can mix CSV templates and CivicMAPS-preview
   JSON files.
4. Check the plan: lists created, lists updated, placeholders, rows not imported (with row
   numbers) and stretches left out. Nothing is saved until you press **Import**.

Importing the same file again is safe. Timed lists are matched by street, cross streets, side and
sub-segment, and allow and hot lists by name. A matching list is updated in place. It keeps its
name, linked allow lists and scan history, and restrictions already entered are kept when the
import has none for it. To leave matching lists untouched, untick *Update lists already on this
device*.

## Timed segments: `platewatch-timed-segments-template.csv`

**One row per sign.** Rows with the same `street`, `from_street`/`to_street` (in either order),
`side` and `sub_from`/`sub_to` become one timed list, with one restriction per row. A segment with
no signs yet gets a single row with `sign` blank. It is imported as a placeholder: it can be found
and scanned against, and shows *Restrictions to enter* until its restrictions are added.

| Column | Required | Example | Notes |
|---|---|---|---|
| `patrol_zone` | | `9` | Internal patrol zone / enforcement area number. Home groups lists by it. |
| `patrol_zone_name` | | `South Melbourne Market` | Day-to-day name of the zone (e.g. `Flagstaff`). |
| `street` | ✔ | `Little Bourke Street` | Road segment name. `St`, `Rd`, `Ave`… are matched to `Street`, `Road`, `Avenue`. |
| `from_street` | ✔ | `Swanston Street` | Cross street at one end. |
| `to_street` | ✔ | `Elizabeth Street` | Cross street at the other end. |
| `side` | | `south` | `north`, `south`, `east`, `west`, `both` (default), `odd` or `even`. `N`, `northern`, `North side` also work. |
| `suburb` | | `Melbourne` | |
| `sub_from`, `sub_to` | | `Bay 58`, `Bay 72` | Only where signs change part way along a side: a bay, an address (`234 Little Bourke Street`) or a cross street. Each part becomes its own list. |
| `rpa` | | `7` | Residential permit area. |
| `parking_area` | | `645` | Parking area number (one per segment, e.g. City of Melbourne). Shown under *Check payment*. With a bay number it forms the kerb sign (645 + 58 = `64558`), which search finds. |
| `easypark_areas` | | `7514;7515` | EasyPark area numbers, separated by `;`. |
| `paystay_zones` | | `338851200002` or `00042:4521` | PayStay zones separated by `;`; add `:meter` for a meter ID. Port Phillip uses the zone number only (3388 + segment number + four digits for the side). |
| `bays` | | `58-59;61-65;67-72` | Bay numbers and ranges. Search then sends a kerb sign only to the part that holds that bay. |
| `sign` | | `2P`, `1/2P`, `P15`, `LZ30`, `2P Meter`, `No Stopping` | See *Signs* below. Blank = placeholder. |
| `minutes` | | `90` | Overrides the allowance read from `sign`, or gives one for a sign PlateWatch does not know. |
| `days` | with a sign | `Mon-Fri`, `Sat-Sun`, `Sat`, `Mon,Wed,Fri`, `Every day` | Blank = every day. |
| `start`, `end` | | `08:00`, `18:00` | 24-hour time. Both blank, or `00:00`–`24:00`, means all times. An end before the start runs overnight. |
| `grace` | | `5` | Minutes of tolerance before an overstay (0–120). |
| `road_segment_id` | | `20055` | Council road segment ID; searchable. |
| `list_name` | | | Optional. Default: `Little Bourke St, Swanston St – Elizabeth St (S) · Bay 58 – Bay 72`. |
| `notes` | | | Free text, added to the list's notes. |

For single-valued columns (zone, RPA, parking area…), the first value given in a list's rows is
used. EasyPark areas, PayStay zones and bays from all of a list's rows are combined.

### Signs

| Written as | Becomes |
|---|---|
| `2P`, `1P`, `4P`, `2P Meter`, `2P Ticket` | 2P = 120 min (the word after the code is kept as the description) |
| `1/2P`, `1/4P` | 30 min, 15 min |
| `P5`, `P15`, `15 min` | 5 min, 15 min |
| `LZ30`, `Loading Zone 30 min` | Loading zone, 30 min |
| `No Stopping`, `No Parking`, `Clearway`, `Bus Zone`, `Loading Zone` with no time, … | No time allowance: **kept as a note** on the list, not timed |

A list whose rows are all untimed signs (a No Stopping side, for example) has nothing to time. It
is left out and listed under *Left out* on the Import screen.

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

## CivicMAPS-preview data files (JSON)

The files collected in the CivicMAPS-preview repository import as they are. Select them on the
Import screen; a file can hold one record or an array of records.

| File (CivicMAPS-preview `civicmaps/data/…`) | Becomes |
|---|---|
| `location/kerbside-parking-assets/v1/…` (`civicmaps.kerbside_parking_segment.v1`) | One list per side sub-segment. Patrol zone (e.g. `CHINATOWN` → *Chinatown*), road segment ID, parking area, EasyPark area, bays and `parking_rules`. A `no_parking_spaces` stretch is left out. A sub-segment with `parking_rules_status: pending_field_capture` is a placeholder that keeps its identifiers and bays. |
| `road-segments/<street>/<from>-to-<to>.json` | One list per segment side, or per `sub_segments` entry, with its own EasyPark area and `signs`. |
| Field surveys (`civicmaps.parking_segment`, e.g. `spencer/…`) | Restrictions at the same place (`location_reference` and `bay_numbers`) form one sub-segment list. Laneways and No Stopping / No Parking-only places are left out. |
| `parking-area-zones/<area>.json` | Placeholder lists per segment with parking area, EasyPark number, road segment ID and meter count; the area (e.g. *West Melbourne*) becomes the zone name. Records not yet linked to a street are counted and left out. |

Sign types (`2p_meter`, `loading_zone` with `limit: "30_min"`, `loading_zone_30_min`,
`no_stopping` …) and rule times (`07:00-16:00`, `00:00-24:00`, `all_times`; days `Mon-Fri`,
`all_days` …) map as in the CSV table above. A rule PlateWatch cannot read (`all_other_times` on
a timed sign, say) is reported and left out, and the rest of the segment is still imported.
