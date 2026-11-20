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
| Precise location metadata | High-accuracy GNSS watch kept warm while the camera is open; best fix within 15 s is attached at the shutter (lat/lng, ±accuracy, altitude, heading, speed, fix age). Embedded as **EXIF GPS** (≈3 mm rational precision, `GPSHPositioningError`) and burned into a data bar on the image. |
| Device date/time | Clock read *at the shutter* (before location is awaited): epoch ms, ISO 8601 local with offset, IANA zone. Embedded as **EXIF DateTimeOriginal + OffsetTimeOriginal + SubSecTime**, plus GPS UTC stamp. |
| Image text → editable text | On-device Tesseract LSTM (no network). Plate mode: guide-box crop, contrast stretch + Otsu binarisation, 3-pass consensus; result is an editable field with alternative candidates. **Text reader** screen converts any photo (signs, permits) to editable text. |
| Allow list | Plates (+ label, permit no., optional validity dates), bulk paste import. Exact matches are ignored on linked timed lists — no alert, no record. |
| Timed list | Street segment, between streets, side, suburb; one or more restrictions (sign code → auto allowance, days, hours incl. overnight / all-times, grace); link any saved allow lists. |
| Hot list | Plate, risks (aggressive, previous assault, spitting, verbal abuse, threats, weapon sighted, flees/evades, other), risk level, make, model, body type, colour, notes. |
| Evidence integrity | SHA-256 recorded at capture; in-app re-verification and EXIF read-back. File names are ISO-8601-UTC-prefixed. |

## Scan workflow (as implemented)

```
No lists → Create list → choose type → required fields → Save
List present → Select list → camera opens → align plate → capture
  → image captured; precise location + device date/time embedded
  → plate read (editable) → Check
     ├─ Hot lists are ALWAYS checked (officer safety) → full-screen alert
     └─ Timed list:
          plate on a linked allow list ............ EXEMPT (ignored, nothing saved)
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
- Matching tolerates OCR ambiguity: `O/Q↔0` and `I↔1` are treated as identical; other
  look-alikes (`B/8`, `S/5`, `Z/2`, `G/6`, `D/0`…) produce a **possible match** the officer
  must confirm. A possible match never exempts a vehicle automatically.
- Checks are evaluated against the shutter time, not the time "Check" was pressed.

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
npm test             # 40 unit tests: engine, restrictions, plates, storage
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
    engine.ts       pure decision engine (exempt / not in force / new / re-sighting / overstay / hot)
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
android/          Capacitor project (permissions, signing, backup exclusions)
docs/SECURITY.md  CSP, data handling, permissions
```

## Data & privacy

All data (lists, plates, evidence images, locations) stays in IndexedDB on the device; there
is no server and no network use other than loading the app itself. Android cloud backup and
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
