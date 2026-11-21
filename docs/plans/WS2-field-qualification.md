# WS2 — Field qualification, battery and camera hardening

Status: in progress. Prepared 20 November 2026 by Claude Code (agent). Base: `main` @ `b68d73f` (PR #2 merged).

## First field test of the PR #2 build (Galaxy S26 Ultra), and what changed

| Finding | Root cause | Change |
|---|---|---|
| No way to exit walking or vehicle patrol; no zoom there | Capacitor 8 draws edge to edge and only pads the web page (`viewport-fit=cover`). The native patrol overlay had no inset handling, so its bottom controls sat under the navigation bar. | Patrol screen pads for system bars and cutouts; Exit button at the top; Android Back exits. |
| Zoom took four buttons | Design | One zoom button: tap steps 1× → 1.75× → 3.5× → 5× → 1×; long-press opens the slider. All cameras. |
| No manual capture in patrol; Multi capture "not present" | Patrol was continuous-only, with no feedback until Finish (which was hidden) | Single/Multi switch and a shutter on the patrol screen; every capture flashes the screen, vibrates and counts. |
| Plate text read as 0–2 characters | Default camera used Tesseract, a document engine, on the whole guide crop (bumper, frame, slogan) | Android app reads with ML Kit and ranks the lines for the plate; Tesseract is the browser fallback. |
| Diagnostics needed during development | — | G1 implemented, on by default. |

Still to confirm on the device: the patrol screen's controls are now visible and reachable, the camera
reports a usable zoom range (logged as `patrol_camera`), and ML Kit's readings (`capture` vs `record` events).

## Second field test (21 Nov 2026, Coventry St and York St), and what changed

Source: diagnostics export (13:13) plus screenshots (13:18–13:22). The diagnostics confirm that the patrol
screen, zoom (0.6–10×) and ML Kit work on the device. They also measured what went wrong:

| Finding (evidence) | Root cause | Change |
|---|---|---|
| Walking patrol at a parking sign: 20 auto captures in two sessions, 14 of them sign words (`CITYOFP`, `LAWS`, `AUTHORIS`, `WHOSEPHO`, `TOCERTI` …); the officer discarded all of them | Analysis frame is 2736×2736 (1:1), the preview 9:16, with no shared `ViewPort`: ML Kit read the full square frame, well past the screen edges. Any 2–8 character line was a "plate". | Preview and analysis bound in one `UseCaseGroup` with the preview's `ViewPort`; text off screen is ignored, walking patrol needs the plate inside the guide. Auto capture needs letters and digits. |
| One car (1UR 6YF) captured five times as `IUR6YF`, `IUP6YF`, `1UP6YF`, `IUDGYF`, `1URX6YF` | Duplicate check was exact string match | Readings cleaned up by plate format (1→I, 6→G at digit positions, VIC triangle read as X). A reading within one character of a recent capture is attached to it as an alternative (candidate chip at review), not captured again. |
| Officer corrected `EDTS512` → `DTS512` and `EDA8899` → `DA8899` | Plate frame edge read as a leading E | Dropped when the rest fits a format exactly (`DTS512`). `DA8899` matches no format, so that one stays for the officer. |
| Record shows "OCR: Manual entry" for a patrol reading | Record screen only described Tesseract readings | Engine stored on new records (`ocrEngine`) and shown with the raw text; older records with OCR text show "OCR". |
| Record shows "Status: active · allowance ends 09:52:08" at 13:22 while the list says OVERDUE | Record screen printed the observation status only | Shows "overdue · allowance ended 09:52 (3h 30m ago). Re-scan the vehicle to record an overstay." |
| Times on the York St list (first seen 08:52, 4h 28m overdue at 13:20) | Not a bug: the captures were at 08:52–08:54 and the vehicles were not re-scanned | — |

New in the diagnostics: `sighting.raw`, `variant` events, and in `patrol_stats` the visible crop size
(`cropWidth`/`cropHeight`) and the lines ignored (`outsideGuide`, `notPlate`) or merged (`variants`).

Still to confirm on the device: (1) patrol frames saved for review are cropped to what was on screen and the
review crop lands on the plate; (2) a plate held at the guide's edge is still captured in walking patrol
(margin: 5% of the guide's width, 50% of its height); (3) vehicle patrol, which recorded 0 captures in two
sessions of under 5 s each: that is too short to judge, so it needs a real drive.

PR #2 fixed the location stamped at capture and added quick zoom with plate-area focus.
This workstream turns the Galaxy S26 Ultra field test into measured evidence, then makes the battery
and camera changes from [the integration assessment](../EMAPS-INTEGRATION-ASSESSMENT.md#4-battery-life-and-gps-accuracy).
The constraint is unchanged: no loss of recognition speed or functionality.

## Goals

Each goal is a separate commit with its own checks. Goals marked **gated** start only when field data
justifies them.

| Goal | What | Why | Gate |
|---|---|---|---|
| G1 ✅ | **Field diagnostics (on by default in development).** Settings toggle that records per-session battery level, thermal status, GPS fix accuracy and age at each capture, "location unavailable" count, zoom used, OCR reads/sightings per minute and patrol mode. Exported as a JSON file from Settings. On-device only, nothing uploaded. | The assessment's pass thresholds need numbers. Today a field test can only report impressions. | None |
| G2 | **Patrol OCR off the main thread.** Move ML Kit analysis and frame encoding to a background executor; make sighting state thread-safe. | Main-thread analysis causes UI jank under load (zoom buttons and slider included). No behaviour change. | None |
| G3 | **Release camera and GPS when backgrounded.** Stop the web camera stream and GNSS watch on `visibilitychange` (hidden) and restart them on return; confirm the patrol camera does the same. | Battery: the app must not keep the camera or GNSS running with the screen off. | None |
| G4 | **Thermal- and mode-aware OCR rate.** Cap patrol analysis rate (vehicle ~10 fps, walking ~6 fps) and step it down at thermal status MODERATE and above. | Largest continuous power draw; throttling otherwise slows recognition late in a shift. | **Gated:** G1 data shows detection at 0/10/20 km/h unchanged with the cap |
| G5 | **Fused location provider.** Native plugin using Google Play fused location, compared with WebView geolocation against surveyed points. | Possible accuracy gain in the CBD canyon at equal or lower power. | **Gated:** G1 comparison shows a gain |
| G6 | **Manual capture on the native camera.** Single-shot mode in `PatrolCamera` for the default scan surface. | Only if the WebView still exposes no zoom on the S26 Ultra after PR #2. | **Gated:** field report item 1 below |

Out of scope: EnforcementMAPS integration work (host prerequisites first, see the assessment §5), and the
host repository's repeat-plate bug (`MarkUps.jsx:419`, read-only from here).

## Field report template (PR #2 build)

Copy into a reply or an issue. "n/a" is fine.

1. **Default scan zoom:** do the 1× / 1.75× / 3.5× / 5× buttons appear? Does long-press open the slider?
2. **Patrol zoom (walking and vehicle):** buttons, slider and plate box shown? Zoom changes the image?
3. **Telephoto:** at 3.5× and 5×, is the image sharp (telephoto lens) or soft (main-sensor crop)?
4. **Read distance:** furthest plate distance read reliably at each preset, walking and at ~20 km/h.
5. **Focus:** does focus stay on the plate when cars or people pass behind it?
6. **Location:** how often did a capture show "LOCATION UNAVAILABLE"? Any position visibly wrong on the map?
7. **Battery and heat:** start/end battery %, minutes per mode, and whether the phone got hot or slowed down.
8. **Anything else** that slowed you down or felt unsafe.

## Verification per goal

- `npm run typecheck`, `npm test`, and `npm run smoke` for every goal. New logic gets a failing test first.
- Native changes are compiled by the CI `apk` job and are not accepted without an on-device check.
- G4 and G5 need before/after numbers from G1 on the S26 Ultra; desktop or emulator results do not count.
