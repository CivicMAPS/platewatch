# PlateWatch — wireframes S28–S31: build status

Source: `CivicMAPS_wireframes_PlateWatch_S26-S31.zip` (23/11/2026). Everything PlateWatch owns in
S28–S31 is built; CommandMAPS screens and the EnforcementMAPS wizard live in other codebases.

| Sequence | In PlateWatch (this repo) | Code |
|---|---|---|
| **S28** Look-alike plates | Classes R·P (owner), A·4, F·E, N·M (proposed) in TS and Java with shared vectors; routing hot → permit → timed; 28a confirm-screen hint; 28b/28c "Possible earlier sighting" side by side; 28e hot-list verify interrupt; 28f permit look-alike; every choice logged on the records; link shown on the result (28d) and both records (28h); Next scan disabled while open; same routing in patrol review (hint skipped) | `plate.ts`, `PlateRules.java`, `lookalike.ts`, `scan.ts`, `record.ts`, `tests/fixtures/plate-lookalikes.tsv` |
| **S29** Hot-list acknowledge | Officer number (Settings, development build); Acknowledge required before Next scan / Back; time, GPS (fresh ≤ 10 s else scan fix), officer, device saved first, soft Code 1 queued and sent through the EnforcementMAPS host when present (29a–29c); hot-list entry log `#/hotlog/:entryId` (29d); events in backups | `hotlist.ts`, `host.ts`, `hotLog.ts`, `db.ts` (v4 `hotEvents`) |
| **S30** Payment check, 701 / 702 | `offence.ts` decision table (5-minute grace after paid to, not found = 702 at once, first reached offered + secondary, disability never 702, OQ30-2 handling); payment check form on a first sighting in a paid space (Next scan disabled until saved); offer card with code chip and locked time from; top-up with history; record payment block (30a–30e, 30g) | `offence.ts`, `scan.ts`, `record.ts` |
| **S31** Issue infringement | Hand-off payload validated against `schemas/platewatch-infringement-handoff.v1.schema.json` (from the requirements doc), note templates (§5); "Issue infringement" + 31a sheet only with an EnforcementMAPS host (hidden in the development build, IR-3); store-back of the I-N, timing closed `issued` (31f); issued records locked: no plate edit, delete or purge (31h, IR-23) | `infringement.ts`, `host.ts`, `scan.ts`, `record.ts`, `db.ts` |

## Not built here (other systems or open decisions)

- **CommandMAPS:** soft Code 1 banners, radio OK / escalate to Code 1 (29e–29k), void-only approvals (31l).
- **EnforcementMAPS:** the four-step wizard, I-N allocation and signing, print, void and reissue (31b–31m). PlateWatch calls `window.EnforcementMAPS.startInfringement(handoff)` and `sendHotListAlert(event)`; the contract is `src/lib/host.ts`.
- **All-day paid parking (30f):** needs a paid-only restriction model (OQ30-10): `limitMinutes` is required and the release schema requires a maximum stay for metered / ticket rules.
- **Open owner questions** carried as drawn: OQ28-3 (no auto-resolution), OQ29-1/3/5/7–10, OQ30-1/5/6/9 (payment check mandatory as drawn), OQ31-2/4/5/6/12/13.
