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

- Shows plate, **vehicle description**, **area** (RPA) and/or **streets**, permit number, holder,
  validity and the list it is on.
- Status, as in the architecture's permit states:

  | Status | Meaning |
  |---|---|
  | `ACTIVE_IN_AREA` | Valid today; its area or one of its streets is this segment's, or it has neither and its list is linked to this segment |
  | `ACTIVE_NOT_IN_AREA` | Valid today, for another area or street |
  | `ACTIVE_SCOPE_UNKNOWN` | Valid today, no area or street held, list not linked here — check where it applies |
  | `NOT_ACTIVE_EXPIRED` / `NOT_YET_ACTIVE` | Outside its validity dates; no *Exempt* button |

- **Exempt here** (any active permit) → green *Permit valid*, recorded with the permit, no timer.
- **Not exempt here — continue** → timed as usual (new sighting or the running timing).
- Area codes compare without council prefixes or the word "RPA" (`com-rpa-12` = `RPA 12` = `12`);
  streets compare without the street type (`Smith St` = `smith street`).

Permit details come from allow lists: the add-permit form, or the CSV template columns
`vehicle`, `rpa`, `streets` (`docs/IMPORT-TEMPLATES.md`).

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
