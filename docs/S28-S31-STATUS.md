# PlateWatch — wireframes S28–S31: build status

Source: `CivicMAPS_wireframes_PlateWatch_S26-S31.zip` (23/11/2026). Session closed at a logical point
on request; this file is the handoff for the next session.

## Done in this commit

**S28 Look-alike plates**
- Look-alike classes extended (OQ28-1): R·P (owner), A·4, F·E, N·M (proposed) in `src/lib/plate.ts`
  and `PlateRules.java`; shared vectors `tests/fixtures/plate-lookalikes.tsv` (TS + Java agree, 47 vectors).
- Routing by source in `check()` (`src/ui/views/scan.ts`), order hot → permit → timed (`src/lib/lookalike.ts`):
  - 28a amber hint on the confirm screen while the plate is a look-alike (hot list named only as "a hot-list plate"); not shown in patrol review.
  - 28e hot-list look-alike in verify form: "Same vehicle — hot list sighting" (recorded as a hot sighting) / "Not the hot-list vehicle" (logged on the hot-list entry log). Never dropped.
  - 28f permit look-alike: "Permit plate confirmed — edit plate" (re-checks as the permit plate) / "Not a match — check as read". Never exempts.
  - 28b/28c "Possible earlier sighting" now reachable: this scan beside each candidate's scan 1, "Same vehicle — link to this timing", "Different vehicle — record new", "Edit plate". The near-match sheet remains only for a selected allow list.
- Every candidate shown and the choice are stored on each record (`ScanRecord.lookalikes`); a linked scan joins the timing (`Observation.linkedScanIds`), keeps the plate as read, and shows "⇄ Linked look-alike" on the result. Record screen shows the look-alike card (on the linked scan and the timing's first scan) and a ⇄ chip in the timeline.
- Next scan is disabled while a look-alike decision is open.

**S29 Hot-list acknowledge (handset, partial)**
- Settings → Officer → Officer number (development build; EnforcementMAPS supplies it via `window.EnforcementMAPS`, `src/lib/host.ts`).
- Acknowledge required before Next scan (and Back) on an exact hot-list match; captures time, GPS (fresh fix ≤ 10 s, else the scan's), officer number, device; saved in IndexedDB `hotEvents` (DB v4) with a queued soft Code 1 (`src/lib/hotlist.ts`). Acknowledged / Queued card with Retry now and the radio instruction. In the development build the alert stays queued (no CommandMAPS connection).

## Next session (in this order)

1. **S29 remainder:** hot-list entry log screen `#/hotlog/:entryId` (29d: sightings from `hot_sighting` scans + `hotEvents`, newest first, retention line) and its "View entry log" link (removed from the ack card until the screen exists); include `hotEvents` in backups; unit tests for `hotlist.ts`.
2. **S30 payment check and 701/702:** pure `paymentOffence()` in the engine (5-minute grace after paid to, not found → 702 at the first scan, secondary code when both reached, disability → never 702); payment form on a first sighting in a paid space (Next disabled until saved, OQ30-9); `ScanRecord.payment`, `Observation.paidTo`; offence pills and code chips on results; top-up with history; record payment block. All-day paid (30f) needs the model change in OQ30-10.
3. **S31 hand-off (PlateWatch side):** build the payload in `src/lib/infringement.ts` against the requirements' JSON Schema (validate with ajv); 31a sheet; "Issue infringement" shown only with an EnforcementMAPS host (`startInfringement`), hidden in the development build (IR-3); store back `ScanRecord.infringement`, observation status `issued`; lock issued records (no delete, edit plate or purge).
4. Smoke steps for look-alike routing (28b/28e/28f), docs, PR body, APK link.

Out of this repository: CommandMAPS soft Code 1 banners (29e–29k), the EnforcementMAPS wizard and
infringement-number generation (31b–31m), CommandMAPS void approvals (31l).
