# platewatch

---
title: PlateWatch
version: 1.0.0
platforms: [Android APK (Capacitor 8), PWA (Chrome/Android, any HTTPS host)]
stack: [TypeScript, Vite 8, lit-html, Tailwind CSS 4 (local build), Tesseract.js 7 (on-device WASM), IndexedDB, piexifjs]
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
| Allow list | Plates (+ label, permit no., optional validity dates), bulk paste import. Exact matches on a linked timed list show a green "Permit valid": the sighting is recorded as evidence, no allowance clock starts, so the vehicle is never an overstay while the permit is valid. A permit typed but not yet added is saved with the list. |
| Timed list | Patrol zone (enforcement area) and residential permit area (RPA); street segment, between streets, side, suburb; one or more restrictions (sign code → auto allowance, days, hours incl. overnight / all-times, grace); link any saved allow lists. |
| Finding lists | Home groups timed lists by patrol zone, then road segment name, as compact rows with a scan button, live restriction status and overdue counts. Zone chips show one patrol zone (remembered). Fuzzy search matches patrol zone, RPA, road segment and cross streets (prefix, any word, one typo), EasyPark area, PayStay zone and meter ID, and shows which field matched; a leading `rpa`, `meter`, `zone`, `easypark` or `paystay` searches only that field (`rpa 12`). |
| Hot list | Plate, risks (aggressive, previous assault, spitting, verbal abuse, threats, weapon sighted, flees/evades, other), risk level, make, model, body type, colour, notes. |
| Camera zoom and focus | One zoom button on every camera: each tap steps 1× → 1.75× → 3.5× → 5× → 1× (steps beyond the lens range are skipped); long-press for a slider up to 10×. The last zoom is remembered. Autofocus and exposure stay continuous but measure only inside the plate guide, so the lens does not refocus onto passing objects. |
| Plate reading | Android app: Google ML Kit (on-device) reads the plate guide plus a margin and picks the plate from the recognised lines. Browser build, or if ML Kit fails: Tesseract on the guide crop. Readings are cleaned up with Australian plate formats (VIC first): letters at digit positions become digits (`IUR6YF` → `1UR6YF`), and a reading that fits no format is retried without the VIC triangle (`1URX6YF` → `1UR6YF`) or a plate-frame edge (`EDTS512` → `DTS512`). Letter positions are never changed, and the raw reading is always shown for the officer to confirm. |
| Walking / vehicle patrol | Native camera screen with Exit (and Android Back), a capture counter and Single/Multi capture modes. Multi reads continuously and captures a plate seen in two frames close together, but only plate-like text (letters *and* digits, 4–8 characters) on screen, inside the guide in walking patrol; a second reading of the same plate (`1UP6YF` after `1UR6YF`) is offered as a choice at review instead of a new capture. Single reads only on the shutter, which also takes all-letter personalised plates. The shutter works in both. Every capture flashes the screen and vibrates. |
| Field diagnostics | On by default during the development stage (Settings → Field diagnostics). Records camera resolution and zoom range, each capture's OCR engine, reading and time, the plate the officer confirmed, GPS accuracy and fix age, and every minute battery, battery temperature and Android thermal status; patrol adds frame and read rates every 30 s. On-device only; export as JSON from Settings. |
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
          valid permit on a linked allow list ..... PERMIT VALID (sighting recorded, no time limit)
          match with an active observation ........ show SCAN 1 vs SCAN N + time elapsed
               elapsed ≥ allowance + grace ........ OVERSTAY
               otherwise .......................... WITHIN ALLOWANCE (time remaining)
          no restriction in force now ............. NOT IN FORCE (nothing saved)
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
- **Paid parking:** a timed list can carry EasyPark area numbers and PayStay zone / meter IDs.
  They are snapshotted into each capture, burned into the evidence data bar and shown as
  *Check payment before enforcing* on first sightings and re-sightings.
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
  ui/             lit-html views (home, list form, list detail, scan, record, text reader, settings)
tests/            vitest suites
scripts/          OCR asset copy, icon generation, E2E smoke test
android/          Capacitor project (permissions, signing, backup exclusions, PatrolCamera plugin)
docs/SECURITY.md  CSP, data handling, permissions
docs/EMAPS-INTEGRATION-ASSESSMENT.md  EnforcementMAPS integration gaps, battery/GPS plan
```

## Data & privacy

All data (lists, plates, evidence images, locations) stays in IndexedDB on the device; there
is no server and the app makes no network requests of its own other than loading itself. In
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
