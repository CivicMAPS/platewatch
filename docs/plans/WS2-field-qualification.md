# WS2 — Field qualification, battery and camera hardening

Status: planned. Prepared 20 November 2026 by Claude Code (agent). Base: `main` @ `b68d73f` (PR #2 merged).

PR #2 fixed the location stamped at capture and added quick zoom with plate-area focus.
This workstream turns the Galaxy S26 Ultra field test into measured evidence, then makes the battery
and camera changes from [the integration assessment](../EMAPS-INTEGRATION-ASSESSMENT.md#4-battery-life-and-gps-accuracy).
The constraint is unchanged: no loss of recognition speed or functionality.

## Goals

Each goal is a separate commit with its own checks. Goals marked **gated** start only when field data
justifies them.

| Goal | What | Why | Gate |
|---|---|---|---|
| G1 | **Field diagnostics (opt-in).** Settings toggle that records per-session battery level, thermal status, GPS fix accuracy and age at each capture, "location unavailable" count, zoom used, OCR reads/sightings per minute and patrol mode. Exported as a JSON/CSV file from Settings. On-device only, nothing uploaded. | The assessment's pass thresholds need numbers. Today a field test can only report impressions. | None |
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
