# platewatch

---
title: PlateWatch
version: 1.0.0
platforms: [Android APK (Capacitor 8), PWA (Chrome/Android, any HTTPS host)]
stack: [TypeScript, Vite 8, lit-html, Tailwind CSS 4 (local build) on CivicMAPS Design System 2.0.0-rc tokens, Lucide icons, Tesseract.js 7 (on-device WASM), IndexedDB, piexifjs]
---

# PlateWatch

Offline-first number plate scanning for timed parking enforcement, permit allow lists and
officer-safety hot lists. Runs as an installable PWA or as a native Android APK.

## Features

| Requirement | Implementation |
|---|---|
| Precise location metadata | High-accuracy GNSS watch kept warm while the camera is open; the fix closest to the true position *at the shutter* is attached: produced at or before the shutter, within 15 s, ranked by accuracy plus distance moved since the fix (a later fix is never used; none qualifying = `LOCATION UNAVAILABLE`) (lat/lng, ±accuracy, altitude, heading, speed, fix age). Embedded as **EXIF GPS** (≈3 mm rational precision, `GPSHPositioningError`) and burned into a data bar on the image. |
| Device date/time | Clock read *at the shutter* (before location is awaited): epoch ms, ISO 8601 local with offset, IANA zone. Embedded as **EXIF DateTimeOriginal + OffsetTimeOriginal + SubSecTime**, plus GPS UTC stamp. |
| Image text → editable text | On-device Tesseract LSTM (no network). Plate mode: guide-box crop, contrast stretch + Otsu binarisation, 3-pass consensus; result is an editable field with alternative candidates. **Text reader** screen converts any photo (signs, permits) to editable text. |
| Allow list (permits) | Plates (+ holder label, permit no., validity dates, vehicle description, permit area and/or streets), bulk paste and CSV import. On a timed list, a plate holding a permit on any allow list raises the **permit pop-up** with the permit's details and status (applies here / another area or street / expired / not yet valid); the officer chooses *Exempt here* (green "Permit valid", recorded, no clock) or *Not exempt here — continue* (timed as usual). A permit typed but not yet added is saved with the list. |
| Overstay dismissal and known vehicles | *Dismiss offence alert* on an overstay: Disability permit displayed (re-times the vehicle against **2 × the allowance** in timed and paid + timed spaces; prescribed time in disability-only spaces), Emergency services vehicle, or Permit displayed (physical resident permit). The scan stays in history with the reason. Disability and emergency dismissals tag the plate: from the next day every scan asks the officer to check the vehicle (*Confirmed*: tag kept — emergency no timer, disability timed at 2 ×; *Dismiss*: tag removed, timed as signed). Never applied in statutory (red sign) restrictions. Tags can be removed in Settings → Tagged vehicles (development; CommandMAPS once integrated). See [docs/PERMITS-AND-EXEMPTIONS.md](docs/PERMITS-AND-EXEMPTIONS.md). |
| Non-timed permit zone | In **Create list**, select **Non-timed permit zone** and enter the street, cross streets, side, council code and residential parking area. Scans check permits on the device. Confirm a current matching area (RPA) or street (RSP) permit, or record the sighting as permit unconfirmed. Neither outcome starts a timer. |
| Timed list | Patrol zone: the internal enforcement area number (e.g. 9) and its operational name (e.g. Flagstaff); residential permit area (RPA); street segment, between streets, side, suburb; one or more restrictions (sign code → auto allowance, days, hours incl. overnight / all-times, grace); link any saved allow lists. |
| Finding lists | Home groups timed lists by patrol zone, then road segment name, as compact rows with a scan button, live restriction status and overdue counts. Zone chips show one patrol zone (remembered). Fuzzy search matches patrol zone number or name, RPA, road segment and cross streets (prefix, any word, one typo), parking area number, EasyPark area, PayStay zone (any part, e.g. the assigned segment number inside a Port Phillip `3388…` number) and meter ID, and shows which field matched. A bay's kerb sign number finds its segment: `63758` → parking area 637, bay 58. A leading `rpa`, `meter`, `zone`, `area`, `bay`, `easypark` or `paystay` searches only that field (`rpa 12`). |
| Hot list | Plate, risks (aggressive, previous assault, spitting, verbal abuse, threats, weapon sighted, flees/evades, other), risk level, make, model, body type, colour, notes. |
| Camera zoom and focus | One zoom button on every camera: each tap steps 1× → 1.75× → 3.5× → 5× → 1× (steps beyond the lens range are skipped); long-press for a slider up to 10×. The last zoom is remembered. Autofocus and exposure stay continuous but measure only inside the plate guide, so the lens does not refocus onto passing objects. |
| Plate reading | Android app: Google ML Kit (on-device) reads the plate guide plus a margin and picks the plate from the recognised lines. Browser build, or if ML Kit fails: Tesseract on the guide crop. Readings are cleaned up with Australian plate formats (VIC first): letters at digit positions become digits (`IUR6YF` → `1UR6YF`), and a reading that fits no format is retried without the VIC triangle (`1URX6YF` → `1UR6YF`) or a plate-frame edge (`EDTS512` → `DTS512`). Letter positions are never changed, and the raw reading is always shown for the officer to confirm. |
| Walking / vehicle patrol | Native camera screen with Exit (and Android Back), a capture counter and Single/Multi capture modes. Multi reads continuously and captures a plate seen in two frames close together, but only plate-like text (letters *and* digits, 4–8 characters) on screen, inside the guide in walking patrol; a second reading of the same plate (`1UP6YF` after `1UR6YF`) is offered as a choice at review instead of a new capture. Single reads only on the shutter, which also takes all-letter personalised plates. The shutter works in both. Every capture flashes the screen and vibrates. |
| Field diagnostics | On by default during the development stage (Settings → Field diagnostics). Records camera resolution and zoom range, each capture's OCR engine, reading and time, the plate the officer confirmed, GPS accuracy and fix age, and every minute battery, battery temperature and Android thermal status; patrol adds frame and read rates every 30 s. On-device only; export as JSON from Settings. |
| Street segment data | **[civicmaps.kerbside_release](docs/KERBSIDE-RELEASE.md)** is the CivicMAPS road and kerbside data standard (lean pilot core), shared with EnforcementMAPS: 15 flat tables (segments, extents, bays, zones, provider areas, meters, rules and their assignments, sources; each rule tied to the EasyPark or PayStay numbers that pay for it) in which every record has the same keys, with null where unknown. Every council's data is adapted to it. Keys use the council's linking ID (or its council code until onboarded) and the road segment asset ID; users see `com-20567`. Delivered as one JSON for devices and one CSV per table for councils, with a JSON Schema ([schemas/](schemas)), scripts to make the CSV and swap in the linking ID, and releases in [datasets/](datasets), including City of Port Phillip Patrol Area 10. |
| Bulk import / export | *Home → Import* (header ⇧), *New list → Import from file*, Settings, or the empty Home screen. Reads civicmaps.kerbside_release files (validated first), area datasets (`street_segments` + `record_defaults`), the CSV templates (timed segments, numbered bays with positions, allow and hot lists; [docs/IMPORT-TEMPLATES.md](docs/IMPORT-TEMPLATES.md), [templates/](templates)) and CivicMAPS-preview data files. Shows what will be created, updated and left out, and why, before saving. Re-imports match on extent IDs, then street and side, and update lists in place; segments not yet surveyed import as placeholders. Exports all timed lists as a candidate release (JSON, or a zip of CSV tables). |
| List ownership | Imported lists are **system** lists (`SYSTEM` tag, "Imported from …"); lists made on the device are the officer's own. In this development build every list can be imported, created, edited and deleted. In an EnforcementMAPS build (`VITE_PLATEWATCH_MODE=enforcementmaps`) import moves to CommandMAPS (team leaders and parking services management, with authorisation), system lists are read-only, and officers create timed lists without paid parking that last for the day. See [docs/LIST-RULES.md](docs/LIST-RULES.md). |
| Look-alike plates (WF-S28) | OCR look-alikes (0·O·Q·D, 1·I·L, 8·B, 5·S, 2·Z, 6·G, 7·T, V·U, R·P, A·4, F·E, N·M) are routed by source: a hot-list look-alike gets a verify interrupt (never dropped), a permit look-alike asks for the displayed permit (never exempts), a timed look-alike goes to *Possible earlier sighting* with both scans side by side. Every choice is logged on the records. |
| Hot-list acknowledge (WF-S29) | A hot-list match must be acknowledged (officer number from Settings in this build) before Next scan: time, GPS and officer are saved on the plate's entry log and a soft Code 1 to dispatch and the compliance coordinator is queued (sent only inside EnforcementMAPS). |
| Payment check, 701 / 702 (WF-S30) | First sighting in a paid space: record Paid session found (paid from / to) or No payment found before Next scan. **Time first, then payment** (owner, 25/11/2026): past the allowance it is **701** whatever the payment state; within it, **702** when no valid payment was found or paid to + 5 min grace has passed. The officer only ever sees 702; the internal 702 / 702e split (`no_payment` / `expired_session`) is derived from the payment check and travels in internal data only. |
| Issue infringement (WF-S31) | Inside EnforcementMAPS: hands a validated pre-fill (`schemas/platewatch-infringement-handoff.v1.schema.json`) to the wizard and stores the infringement number back; issued records are locked. With the PlateWatch backend configured (development / field testing): the four-step wizard runs on the device, the I-N is allocated and signed on the device (works offline), the backend verifies and accepts it; void (supervisor approval) and void + reissue (no approval) from the record. Hidden in the standalone build. See [docs/BACKEND.md](docs/BACKEND.md). |
| Backend and console (field testing) | Optional Node + PostgreSQL server ([docs/BACKEND.md](docs/BACKEND.md)) serving the app, a CommandMAPS stand-in console and the API: sync of scans, timings and hot-list events; soft Code 1 banners (amber, dispatch + compliance coordinator, acknowledged per recipient); infringement verification and life cycle; a test payment provider; 702 / 702e analytics. Configure in *Settings → Backend*. |
| Backup | Export lists, or lists + scan records, as JSON; *Include dismissed captures* (off by default) adds the Dismissed list with its evidence images. Import merges or replaces; a backup without dismissed captures leaves the device's Dismissed list untouched. |
| Evidence integrity | SHA-256 recorded at capture; in-app re-verification and EXIF read-back. File names are ISO-8601-UTC-prefixed. |

## Scan workflow (as implemented)

```
No lists → Create list → choose type → required fields → Save
List present → Select list → camera opens → align plate → capture
  → image captured; precise location + device date/time embedded
  → plate read (editable) → Check
     ├─ Hot lists are ALWAYS checked (officer safety) → full-screen alert
     └─ Timed list:
          no restriction in force now ............. NOT IN FORCE (nothing saved)
          alert dismissed earlier this period ..... EXEMPT (recorded, no time limit)
          tagged disability / emergency vehicle ... new day: CHECK VEHICLE pop-up
                                                      Confirmed → emergency: no time limit
                                                                  disability: timed at 2 × allowance
                                                      Dismiss   → tag removed, timed below
          permit held for the plate ............... PERMIT pop-up (details + status)
                                                      Exempt here → PERMIT VALID
                                                      continue    → timed below
          match with an active observation ........ show SCAN 1 vs SCAN N + time elapsed
               elapsed ≥ allowance + grace ........ OVERSTAY → Dismiss offence alert (reason;
                                                    disability re-times at 2 × allowance)
               otherwise .......................... WITHIN ALLOWANCE (time remaining)
          otherwise ............................... create scan record for the segment
                                                    and start the time allowance
```

Interpretation notes:

- **"Last scan within list time applied"** is modelled as an *observation* (the chalk mark):
  it lasts until the restriction period it started in ends (e.g. 18:00), then expires.
  A re-sighting inside that window always shows the scan 1 / scan 2 comparison with elapsed
  time; it is flagged **Overstay** once allowance + grace is exceeded.
- **Vehicle moved — restart timing** closes the observation and starts a new allowance from
  the current scan (valve-stem / position changed).
- Exact matching compares the plate characters as read (`O` and `0` are different). OCR
  look-alikes (`O/Q/D↔0`, `I/L↔1`, `B↔8`, `S↔5`, `Z↔2`, `G↔6`, `T↔7`, `U↔V`) produce a
  **possible match**: a *Near match* dialog shows the capture beside the candidate(s) and the
  officer edits or dismisses it. A possible match never exempts a vehicle automatically.
- Checks are evaluated against the shutter time, not the time "Check" was pressed.
- **Paid parking:** a timed list can carry:
  - a parking area number (one per segment, e.g. City of Melbourne);
  - EasyPark area numbers (several when a side changes restriction during the day);
  - PayStay zones (City of Port Phillip: `3388` + segment number + four digits for the side);
  - meters, each covering the whole segment and its parking area, or the EasyPark areas and PayStay zones chosen. One meter can serve several numbers.

  Each restriction is tied to the numbers that pay for it (*Paid with*). The numbers for the
  restriction in force, with their meters, are snapshotted into each capture, burned into the
  evidence data bar and shown as *Check payment before enforcing* on first sightings and
  re-sightings. A restriction with no *Paid with* numbers shows all of the segment's numbers.
- **Correcting a saved record:** *Record → Edit plate* re-runs the check for the corrected
  plate at the original shutter time, moves the record to the right observation (or none),
  repairs both observations' scan 1 / overstay outcomes, and keeps a revision history. The
  evidence image and its SHA-256 are never altered.

### Patrol mode (Android APK only)

On the APK the scan screen also offers **Walking patrol** / **Vehicle patrol**. A native
CameraX + ML Kit text-recognition overlay (`PatrolCamera.java`, bridged by
`src/lib/patrol.ts`) reads plates continuously; a plate must be seen in two frames within
1.5 s (walking) / 0.9 s (vehicle) to count. Preview and analysis share one CameraX `ViewPort`, so
only text visible on screen is read; walking patrol also requires the plate inside the guide.
Readings go through `PlateRules.java` (the native twin of `canonicalPlate` / `isAutoCapturePlate`
/ `isPlateVariant` in `src/lib/plate.ts`; both run `tests/fixtures/plate-readings.tsv`). A reading
within one character of a plate captured in the last 8 s (walking) / 4 s (vehicle) is not captured
again; it is attached to that capture as an alternative reading. Each sighting saves a frame to the app cache and
beeps if the plate is on a hot list, a linked allow list or already being timed. *Finish patrol
and review* then walks the officer through every sighting in the normal Confirm → Check flow,
using the frame time and the best GPS fix at or before it; cached frames are deleted once
reviewed. A patrol capture can be **checked** or **dismissed** (there is no retake: the vehicle
is usually gone by review). The plate stays editable either way. A dismissed capture is saved
with its evidence frame and metadata to the global **Dismissed** list (Home → Dismissed captures),
apart from every plate list: it starts no timing and matches nothing. A plate on a hot list
asks for confirmation before it can be dismissed. Dismissed captures follow the retention setting. Patrol mode is not available in the PWA.

## Install

**APK (sideload):** copy the APK to the device → open → allow "Install unknown apps" →
grant Camera and Location (Precise) on first scan.

**PWA:** host `dist/` on any HTTPS origin (camera and GPS require a secure context) and open
in Chrome on Android → ⋮ → *Install app*. `dist/_headers` carries the CSP and security
headers for Cloudflare Pages / Netlify; replicate them on other hosts.

## Develop

```bash
npm ci
npm run dev          # http://localhost:5173 (copies OCR assets first)
npm test             # unit tests: engine, restrictions, plates, storage, backup, corrections
npm run build        # typecheck + production build (CSP applied)
npm run smoke        # E2E in headless Chrome: fake camera + GPS, production CSP

# Backend (docs/BACKEND.md): PostgreSQL + Node
cp .env.example .env && npm run server                 # app at :8787/, console at :8787/console/
docker compose up --build                              # same, with PostgreSQL in a container
PLATEWATCH_TEST_DATABASE_URL=postgres://… npm run test:server    # API tests against a real database
PLATEWATCH_TEST_DATABASE_URL=postgres://… npm run smoke:backend  # browser E2E: handset + console
```

### Android APK

Requirements: JDK 21, Android SDK (platform 36, build-tools 36), `ANDROID_HOME` set.

```bash
npm run android:apk        # → android/app/build/outputs/apk/debug/app-debug.apk
npm run android:release    # signed when android/keystore.properties or ANDROID_KEYSTORE_* env is set
npx cap open android       # Android Studio
```

CI: `.github/workflows/android-apk.yml` runs typecheck, unit tests, build and the smoke test,
then builds the debug APK (and a signed release APK when the `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` secrets exist) and
uploads them as artifacts.

## Project layout

```
src/
  lib/            framework-free domain + device code
    patrol.ts       bridge to the native PatrolCamera plugin (APK only)
    corrections.ts  amend a saved record's plate and repair observations
    payment.ts      EasyPark / PayStay display lines
    engine.ts       pure decision engine (permit valid / not in force / new / re-sighting / overstay / hot)
    restriction.ts  restriction periods (days, hours, overnight, all-times), sign-code parsing
    plate.ts        normalisation, strict + loose matching keys, OCR candidate extraction
    db.ts           IndexedDB (lists, scans, observations, settings), cascades, retention
    capture.ts      shutter metadata → evidence JPEG (data bar + EXIF) → thumb → SHA-256
    exif.ts         EXIF GPS / DateTimeOriginal / OffsetTime / UserComment writer + reader
    geo.ts          high-accuracy GNSS tracker, best-fix selection
    camera.ts       rear camera, torch, zoom, continuous AF, wake lock
    ocr.ts / image.ts  Tesseract worker, ROI mapping, preprocessing
    backup.ts / files.ts  JSON export/import, share/save on web + Android
  styles/civicmaps/  vendored CivicMAPS design-system tokens + DM Sans (see docs/DESIGN-SYSTEM.md)
  ui/             lit-html views (home, list form, list detail, scan, record, text reader, settings)
tests/            vitest suites
scripts/          OCR asset copy, icon generation, E2E smoke test
android/          Capacitor project (permissions, signing, backup exclusions, PatrolCamera plugin)
docs/SECURITY.md  CSP, data handling, permissions
docs/EMAPS-INTEGRATION-ASSESSMENT.md  EnforcementMAPS integration gaps, battery/GPS plan
docs/DESIGN-SYSTEM.md  CivicMAPS design system wiring and conformance (D1–D16)
docs/BACKEND.md   backend, console, I-N verification, API and data model
server/           backend (Node + PostgreSQL): API, I-N verifier, migrations, console (static)
```

## Data & privacy

All data (lists, plates, evidence images, locations) is saved in IndexedDB on the device first.
Standalone, there is no server and the app makes no network requests of its own other than
loading itself. When a PlateWatch backend is configured (*Settings → Backend*, field testing),
scan records, timings and hot-list events are synced to it, and evidence images are uploaded for
issued infringements and acknowledged hot-list sightings ([docs/BACKEND.md](docs/BACKEND.md)). In
the APK, Google ML Kit (patrol mode) runs on-device with a bundled model, but per Google's
ML Kit terms it may contact Google to send API usage/performance metrics; no images or plate
text are sent. Android cloud backup and
device-transfer are disabled for app data. Configure auto-deletion under *Settings → Data
retention*; exports containing scan records are personal information.

## Known limitations

- OCR is general-purpose Tesseract, not a trained ALPR model: best results come from filling
  the guide box with the plate, square-on, in reasonable light. The plate is always editable
  before checking, and the officer's correction is recorded (`corrected: true`).
- Validity dates and restriction times use the device clock and time zone.
- The APK was built and its manifest/assets verified, but has not been exercised on a physical
  device in this delivery — run a field check (camera permission, precise location, OCR
  speed) on the target handsets before rollout.
