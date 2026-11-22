# PlateWatch — permits, dismissed alerts and known vehicles

How a scan on a timed list deals with resident permits, disability permits and emergency
services vehicles. Owner direction 22/11/2026; aligned with
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
   confirmed today → recorded, no timer; otherwise the *check vehicle* pop-up.
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
| Disability permit displayed | Scan kept with the reason; timing closed as *dismissed*; plate tagged *disability* |
| Emergency services vehicle | Same; plate tagged *emergency* |
| Permit displayed | Same, no tag (a physically displayed resident permit; not all are digital yet) |

The scan stays in history as *Overstay* with a grey *Dismissed · <reason>* pill. Further scans of
the plate on that list in the same restriction period are recorded as exempt, without a new alert.

**Statutory restrictions** (loading, bus and taxi zones, no stopping / parking, clearways, works
zones): a disability permit or a displayed resident permit does not exempt, so only *Emergency
services vehicle* is offered, and neither tags nor permits are applied there.

## Known vehicles — the check-vehicle pop-up

A disability permit and an emergency vehicle are not tied to a plate, so the tag only prompts a
look at the vehicle. From the day after the dismissal, every scan of the plate on a timed list
shows:

- *Known emergency services vehicle — check vehicle*, or
- *Previous disability permit vehicle — check vehicle for displayed permit*

with two options:

- **Confirmed** — tag kept, scan recorded (*Vehicle confirmed*), no timer. Later scans that day
  need no check.
- **Dismiss** — the authorised vehicle or a valid permit was not confirmed at the check: tag
  removed, scan recorded, timer applied (and a permit pop-up follows if the plate holds one).

Tags are stored on the device (IndexedDB `flags`, keyed by plate) and travel with the
*lists + scan records* backup.

## Not done / to decide

- **Double time for disability permits.** As directed, a dismissed or confirmed disability vehicle
  is recorded with no timer. A vehicle staying beyond twice the allowance is therefore not timed.
  If that should be enforced, the next step is timing it against 2 × the allowance instead.
- **Payment.** "No payment required" for disability permits in paid spaces is covered by the
  officer's dismissal; there is still no payment provider, so payment remains an officer check.
- **Statutory list.** Recognised from the restriction code (`LZ…`, `BZ`, `TZ`, `NS`, `NP`,
  `Clearway`, `Works`…). Per-council policy data would replace this once CommandMAPS publishes it.
- **Who can remove a tag** other than through *Dismiss* at a vehicle check (e.g. a team leader in
  CommandMAPS) is not decided; there is no tag list screen yet.
