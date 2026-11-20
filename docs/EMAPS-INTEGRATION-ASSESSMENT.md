# PlateWatch → EnforcementMAPS integration assessment

Status: assessment only. Prepared 20 November 2026 by Claude Code (agent) for owner review.

PlateWatch stays a standalone app until full in-field and on-device testing is complete. After that it
becomes the EnforcementMAPS (eMAPS) **digital chalking** module, and also does the **payment check** and
**permit check**. This document lists what that integration needs, what each side has today, and the
gaps. Live integration stays gated on field testing.

Sources inspected (read-only):

- PlateWatch `CivicMAPS/platewatch`, branch `ccr-9ea16369-1ukvqa` (from `main` @ `ae9d203`).
- Host `TechCorp25/CivicMaps-rebuild` `main` @ `5c61486`: `apps/enforcementmaps-web`,
  `apps/enforcementmaps-mobile`, `services/api`, WF-S9 (Mark-Up / digital chalking) and WF-S18 (permits)
  annotations, the F08 parking baseline and the WS09 field-delivery plan.

Nothing in the host repository was changed. This session can only read it.

## 1. Codex findings: status

| # | Finding | Status |
|---|---|---|
| C1 | PlateWatch can attach a GPS fix obtained **after** a manual shutter press | **Fixed on this branch.** `GeoTracker.fixForCapture` used to fall back to `getCurrentPosition` and wait up to 8 s, which returns where the officer has moved to by then. Now only fixes produced at or before the shutter are accepted. The fallback reads the platform's cached position only (`timeout: 0`), and only if that position is no older than 15 s. If no fix qualifies, the evidence says `LOCATION UNAVAILABLE` and does not record a wrong position. The same cutoff also applies to watch fixes that arrive just after the shutter. Tests: `tests/geo.test.ts`. |
| C1b | (Found during this review) Fix ranking ignored the fix's age | **Fixed on this branch.** `bestRecent` used to pick the smallest accuracy radius in the 15 s window. At the 20 km/h vehicle target, a ±3 m fix from 12 s earlier is about 67 m behind the car. Ranking now uses *accuracy + current speed × fix age*. When the receiver reports no speed, walking pace (1.5 m/s) is assumed. This applies to both manual capture and native patrol sightings. |
| C2 | The eMAPS web preview flags a repeat plate as offending without checking elapsed time | **Confirmed. Not fixed here (host repo).** `apps/enforcementmaps-web/src/field/MarkUps.jsx:419` sets `offending: scans.some((s) => s.plate === plate)`. Any second sighting is marked offending, even one minute later. The screen is a manual-entry placeholder ("recognition simulated"). The fix belongs in the host: compare the elapsed time from the first sighting against the Mark-Up period plus grace, as PlateWatch's `engine.ts` `resighting()` already does. |

## 2. What the host has today

- **eMAPS mobile** (Expo SDK 58 / React Native 0.88, Android) does only handset-signed infringement-number
  activation and allocation. It has no camera, Mark-Up, chalking, GPS capture or offline queue.
- **eMAPS web** has Mark-Up screens (create, active list with timers, completion, archive, digital capture
  review). Their state comes from local fixtures (`src/field/data.js`). Plate recognition has no provider.
  Captured photos keep only a name, timestamp and location result, not the image bytes.
- **API**: Mark-Ups exist as generic council records (`markups`, `fieldMarkups` → projected into the
  office registry). The records API trusts client-authored JSON bodies (the HIGH finding in the 16 Nov
  host assessment). There is no server-side scan/sighting collection, overstay decision or chalking
  config. F08 says outright that scanning, chalking, ANPR and infringement workflows are *not implemented*
  and are later slices.
- **Permits** are a general council-records collection (busking, road closure, …) with an Active →
  Expired job. Permits have **no vehicle/plate field** and no zone or segment link.
- **Payment**: the host has no EasyPark/PayStay integration. WF-S8 notes that the EP/PS numbering scheme is
  municipality-specific and still undecided.
- **Evidence custody, upload and offline sync** exist only as the WS09 plan (planning status, no
  implementation).

So the host offers a Mark-Up record shape, identity/context/entitlements and infringement numbering.
Chalking, ANPR, payment check and plate-level permit check would all come from PlateWatch.

## 3. Capability map

| Capability needed in eMAPS | PlateWatch today | Host today | Integration work |
|---|---|---|---|
| Mark-Up create: street, between streets, side, GPS, period | Timed list = street segment (street, from/to, side, suburb) + restrictions by day/time | Mark-Up record and screens; WF-S9 requires between-streets auto-fill from GPS | Map a PlateWatch timed list onto a host Mark-Up. Adopt the host's between-streets resolver; PlateWatch has none. |
| Chalking decision: first sighting starts clock, resighting judged on elapsed time vs allowance + grace, only while restriction is in force | `engine.ts` `evaluate` / `resighting`, observations per segment, grace, restriction-in-force by local time; unit-tested | Placeholder; flags any repeat (C2) | Make PlateWatch's engine the decision source. It is pure TypeScript with no DOM dependency (`engine`, `restriction`, `plate`, `time`), so it can move into a shared package. |
| Plate recognition | Native: CameraX + ML Kit continuous OCR, walking/vehicle modes, two-read confirmation within 1.5 s / 0.9 s. Web: Tesseract on manual capture | None; WF-S9 specifies a server-configured `FrameAggregator` (confirmFrames, minConfidence, sampleInterval) | Port `PatrolCamera.java` to an Expo module, following the `emaps-signing-key` pattern. Decide whether confirmation thresholds become server-configured as WF-S9 specifies. |
| Evidence: JPEG, EXIF GPS/time, data bar, SHA-256 at capture | Implemented; image never leaves the device | No custody; WS09-G1 planned | Upload contract: hash verified server-side, attributable custody, retention/legal hold, context binding. Blocked on WS09-G1. |
| **Payment check** | Records the EasyPark area / PayStay zone + meter **on the evidence only**. It does **not** query whether the vehicle has paid. | None | New: provider integration (EasyPark, PayStay) through the host server, never handset-held provider credentials. Needs a provider/contract decision, offline behaviour (e.g. "unverified — check online") and a payment-status record on the sighting. |
| **Permit check** | Allow lists: plate, permit number, validity window; linked to timed lists as exemptions; offline lookup | Permits have no plate/vehicle or zone fields | New host data: vehicle permits (plates, zone/segment eligibility, validity). Sync to the handset for offline lookup. PlateWatch's allow-list matching (strict plate keys, validity dates) can be reused. |
| Hot list with risk tags | Implemented locally | None | Personal and safety data: needs a host privacy/retention decision and role scoping before it syncs. Keep it out of the first integration slice unless the owner approves. |
| Infringement on overstay | Records overstay only; issues nothing | Handset-signed infringement numbers; WF-S9 shows auto-PIN on offending digital catches | Hand overstay to the eMAPS infringement flow **with officer confirmation**. Given OCR misread pairs (0/O, 1/I, 8/B, WF-S9 OQ9-6), auto-issue on an OCR read is not recommended. |
| Identity, council/branch context, entitlements | None (single-user device) | Sessions, operating context, Parking Services pack entitlements | All server writes go through host identity and are enforced server-side. Chalking must be entitled per branch (F08). |
| Offline operation | Fully offline (IndexedDB) | None; WS09-G2 planned | Queue with "captured" vs "server accepted" kept distinct, version checks, purge on revocation (WS09-G2 criteria). |
| Platform | Capacitor 8 + TypeScript + lit-html | Expo / React Native | Recommended: move the pure libraries (`engine`, `restriction`, `plate`, `time`, `geo` ranking, `exif`, `hash`) into a shared package, and rebuild the UI and native camera in eMAPS. Embedding the PlateWatch WebView inside eMAPS is not recommended: two camera stacks, two stores, two permission flows. |

## 4. Battery life and GPS accuracy

### Done on this branch

- C1 and C1b above. The location stamped on evidence is now the best estimate *at the shutter or frame*,
  and is no longer a tight fix taken somewhere else.
- No speed or functionality change: ranking is a single pass over at most 20 cached fixes, and
  manual capture no longer waits up to 8 s for a new fix.

### Current power profile (from code; not yet measured on device)

| Area | Observation | Effect |
|---|---|---|
| GPS | High-accuracy `watchPosition` runs only while the scan screen is open and stops on unmount | Good: GNSS is not left running between scans |
| Native patrol OCR | ML Kit runs on **every** 1920×1080 frame, back to back (`STRATEGY_KEEP_ONLY_LATEST`, no rate cap) | Largest continuous power draw; sustained load also leads to thermal throttling, which *reduces* recognition speed over a shift |
| Native patrol threading | The analyzer and its result handling (bitmap rotate + JPEG encode) run on the **main thread** (`setAnalyzer(main, …)`) | UI jank under load; no energy saving by itself |
| Web camera path | Screen wake lock while the camera is open; no `visibilitychange` handling | Needs a device check that camera and GPS are released when the app is backgrounded or the screen is off |
| Location source | WebView geolocation (Android `LocationManager`), not Google Play fused location | Fused location may give better urban-canyon accuracy at equal or lower power; unverified |

### Recommendations, each gated on device measurement

These were deliberately **not** changed blind, because the constraint is no loss of speed or
functionality and that can only be shown on the target handset (Galaxy S26 Ultra):

1. **Move analysis off the main thread** (single background executor; thread-safe sighting state). No
   behaviour change; improves responsiveness.
2. **Cap OCR frame rate per mode** (e.g. vehicle ~10 fps, walking ~6 fps). Each mode's two-read window still
   allows several frames. Adopt only if the field detection rate at 0/10/20 km/h matches the uncapped
   build.
3. **Thermal-aware rate** using Android `PowerManager` thermal status: step the rate down at MODERATE
   and above, so recognition degrades gradually instead of being throttled hard.
4. **Fused location provider** through a small native plugin. Compare it with the WebView geolocation
   against surveyed points.
5. **Background release**: confirm camera, OCR and GNSS all stop when the app is backgrounded or the screen
   locks.

### Field and device test protocol (inputs to the integration gate)

Measure each mode (manual walking, walking patrol, vehicle patrol at 10 and 20 km/h):

- Battery drain in % per hour over a 2-hour run, screen on, from a full charge, with thermal status logged.
- Plate detection rate and false reads against a known plate set.
- Location error against surveyed reference points, in open streets and in the CBD canyon. Record the
  fix age at capture (already stored as `locationAgeMs`) and how often capture shows "LOCATION
  UNAVAILABLE".
- Time to first fix, cold and warm, after opening the scan screen.

Pass thresholds (minimum shift length on one charge, maximum location error, minimum detection rate)
are **owner decisions** and are not set here.

## 5. Suggested integration sequence

1. **Field and device qualification of standalone PlateWatch** with the protocol above, including C1/C1b.
2. **Host prerequisites**: fix C2. Add server-side authority for Mark-Up and sighting writes (the client-JSON
   records finding). Add WS09-G1 evidence custody, vehicle-permit data, and the payment-provider decision.
3. **Shared chalking package** extracted from PlateWatch (engine, restriction, plate, time, geo ranking),
   consumed by eMAPS. PlateWatch keeps using it, so the standalone app does not drift.
4. **eMAPS mobile chalking module**: Expo port of the patrol camera, Mark-Up ↔ timed-list mapping,
   offline queue (WS09-G2).
5. **Payment check and permit check** against host services, with defined offline fallbacks.
6. **Infringement hand-off** with officer confirmation.

Each step keeps the host's lifecycle: independent assessment, owner review before merge, and physical
device evidence for native acceptance (WS09).

## 6. Open decisions for the owner

- Payment providers to integrate, and who holds the provider contract or credentials (server-side only).
- Vehicle-permit data model and source of truth (host permits registry or council system of record).
- Whether hot lists migrate into eMAPS, and under what privacy, retention and role controls.
- Server-configured vs fixed recognition thresholds (WF-S9 specifies server-configured).
- Battery, accuracy and detection pass thresholds for the field gate.
