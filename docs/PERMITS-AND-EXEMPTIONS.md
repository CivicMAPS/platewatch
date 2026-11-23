# PlateWatch — permits, dismissed alerts and known vehicles

How a scan on a timed list deals with resident permits, disability permits and emergency
services vehicles. Owner direction 22/11/2026, open questions answered 23/11/2026; aligned with
`CIVICMAPS-PARK-ARCH-001` (Parking Enforcement Architecture) §5 and §16. The engine decides
nothing on the officer's behalf: it shows what is held and the officer chooses.

Code: `src/lib/engine.ts` (`decideTimed`, `findPermits`, `isStatutoryRestriction`),
`src/lib/dismissal.ts`, `src/ui/views/scan.ts`. Tests: `tests/engine.test.ts`,
`tests/dismissal.test.ts`, `tests/db.test.ts`, smoke steps 12–15.

## Order of checks on a timed list

1. **No restriction in force** and no running timing → *Not in force*; nothing recorded.
2. **Alert dismissed earlier in this restriction period** (same list, same plate) → recorded
   as exempt ("Exempt · <reason>"), no timer.
3. **Tagged plate** (disability / emergency, see below), not in a statutory restriction:
   confirmed today → emergency: recorded, no timer; disability: timed against 2 × the allowance.
   Otherwise the *check vehicle* pop-up.
4. **Permit held** for the plate on any allow list, not in a statutory restriction → the
   *permit* pop-up.
5. Timing as before: re-sighting (within allowance / overstay) or new sighting.

## Resident permits — the permit pop-up

Officers today enter a plate and, if a permit is linked, a pop-up shows its details. PlateWatch
does the same on every scan of a timed list:

- Every permit held for the plate is shown with the **same details whatever its status**, so the
  officer checks them against the vehicle: plate, vehicle (colour, make, type, registration type,
  state), permit number and types, area (`com-rpa7`), registered address, valid from / to, council,
  holder and list.
- **Status is only `valid` or `expired`.** Valid from 00:00 on *valid from* until midnight at the
  end of *valid to*; a permit not yet started shows as expired ("not yet valid"). A **valid**
  permit has a **solid green border**; an **expired** one a **red blinking border** (steady when
  the device asks for reduced motion — an owner-approved exception to the Code 1-only red rule,
  `docs/DESIGN-SYSTEM.md`).
- Where it applies here, from the permit types in the permit number:

  | Type | Applies | Here |
  |---|---|---|
  | `RPA` residential parking area | Any time or paid space in its area (same council) | *Applies here* when the segment's area matches |
  | `RSP` residential street permit | Anywhere on the street segment of the registered address | *Applies here* when the segment's street is the address street |
  | `RP` resident permit | Directly in front of the registered address | *Applies here* on the address street — the officer checks the house number |
  | `FS` foreshore | Paid foreshore spaces in its own municipality; time limits still apply | *No payment required here (foreshore)* in a foreshore space (restriction description contains "Foreshore") |
  | `COMB` combination, e.g. `RPA/COMB/FS` | Each listed type | The widest that applies (RPA area first, else FS in a foreshore space) |

  Otherwise *For another area, street or council*. Permits without types (older lists) use their
  area / streets, or the linked list: *No area or street held — check where it applies*.
- Buttons: valid and applies → **Exempt here** (recorded with validity, scope and type, no timer);
  valid FS in a foreshore space → **No payment (foreshore) — time limits apply** (timing runs, the
  payment check and 702 are skipped, 701 still applies); expired → no exempt button.
  **Not exempt here — continue** is always offered.
- Councils: each council has a user-facing code (`com`, `copp`) and a CivicMAPS linking ID used
  operationally: area 7 is `com-rpa7` on screen and `919379201-com-rpa7` in data. Area codes
  compare across these forms (`7`, `RPA 7`, `com-rpa-7`, `919379201-com-rpa7`), but never across
  councils. Streets compare without the street type (`Smith St` = `smith street`).

Permit data follows `schemas/civicmaps-parking-permit.v1.schema.json` (the permit number is
authoritative; issue year, sequential ID and amendment are derived from it). Load it as JSON, the
allow-list CSV template, or the add-permit form (`docs/IMPORT-TEMPLATES.md`).

## Dismissing an overstay alert

On an overstay result, **Dismiss offence alert** opens the reasons:

| Reason | Effect |
|---|---|
| Disability permit displayed | Scan kept with the reason; the timing **continues against 2 × the allowance** (e.g. 2P → 4P from the first sighting); plate tagged *disability*. Not offered when the vehicle is over even 2 ×, in a disability-only space, or in a statutory restriction. |
| Emergency services vehicle | Scan kept with the reason; timing closed as *dismissed*; plate tagged *emergency* |
| Permit displayed | Same, no tag (a physically displayed resident permit; not all are digital yet) |

The scan stays in history as *Overstay* with a grey *Dismissed · <reason>* pill. After an
emergency or permit dismissal, further scans of the plate on that list in the same restriction
period are recorded as exempt. After a disability dismissal they are re-sightings timed against
the doubled allowance, so a vehicle staying beyond 2 × is an overstay again (and the disability
reason is no longer offered).

### Disability permits: twice the allowance

| Space | Allowance with a displayed disability permit |
|---|---|
| Timed (e.g. 2P) | 2 × the signed time |
| Paid + timed (e.g. 2P Meter, 2P Ticket) | 2 × the signed time; no payment required while the permit is displayed |
| Disability permit only | The prescribed time — no extension |
| Statutory (red signs) | No exemption |

Disability-only spaces are recognised from the restriction code or description (`DIS`, `DPP`,
"disabled", "accessible").

**Statutory restrictions** (red signs): loading, bus and taxi zones, no stopping / parking,
clearways, works zones, **police vehicles only**, **except authorised vehicles**, **NSEGCV** (no
stopping except goods carrying vehicles, usually 5–15 min). A disability permit or a displayed
resident permit does not exempt, so only *Emergency services vehicle* is offered, and neither tags
nor permits are applied there. Recognised from the restriction code or its description.

## Known vehicles — the check-vehicle pop-up

A disability permit and an emergency vehicle are not tied to a plate, so the tag only prompts a
look at the vehicle. From the day after the dismissal, every scan of the plate on a timed list
shows:

- *Known emergency services vehicle — check vehicle*, or
- *Previous disability permit vehicle — check vehicle for displayed permit*

with two options:

- **Confirmed** — tag kept. Emergency: scan recorded (*Vehicle confirmed*), no timer. Disability:
  timed against 2 × the allowance (prescribed time in disability-only spaces). Later scans that
  day need no check.
- **Dismiss** — the authorised vehicle or a valid permit was not confirmed at the check: tag
  removed, scan recorded, timer applied (and a permit pop-up follows if the plate holds one).

Tags are stored on the device (IndexedDB `flags`, keyed by plate) and travel with the
*lists + scan records* backup.

### Removing a tag

- At a vehicle check: **Dismiss** on the check-vehicle pop-up.
- **Development build:** Settings → *Tagged vehicles* lists every tag and removes one.
- **EnforcementMAPS:** not on the officer's device. Supervisors and above who hold assigned
  authority within the parking services branch remove tags from the CommandMAPS operational
  dashboard (`canRemoveTagsInCommandMaps`).

## Not done / to decide

- **Payment.** There is still no payment provider; payment remains an officer check (and is not
  required for a displayed disability permit).
- **Sign recognition.** Statutory and disability-only spaces are recognised from restriction codes
  and descriptions. Per-council policy data would replace this once CommandMAPS publishes it.
- **Role order.** "Supervisors and above" is taken as supervisor, team leader and parking services
  manager; CommandMAPS supplies the role and branch authority.
