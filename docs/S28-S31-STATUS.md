# PlateWatch — wireframes S28–S31: build status

Source: `CivicMAPS_wireframes_PlateWatch_S26-S31.zip` (23/11/2026). Everything PlateWatch owns in
S28–S31 is built; CommandMAPS screens and the EnforcementMAPS wizard live in other codebases.

| Sequence | In PlateWatch (this repo) | Code |
|---|---|---|
| **S28** Look-alike plates | Classes R·P (owner), A·4, F·E, N·M (proposed) in TS and Java with shared vectors; routing hot → permit → timed; 28a confirm-screen hint; 28b/28c "Possible earlier sighting" side by side; 28e hot-list verify interrupt; 28f permit look-alike; every choice logged on the records; link shown on the result (28d) and both records (28h); Next scan disabled while open; same routing in patrol review (hint skipped) | `plate.ts`, `PlateRules.java`, `lookalike.ts`, `scan.ts`, `record.ts`, `tests/fixtures/plate-lookalikes.tsv` |
| **S29** Hot-list acknowledge | Officer number (Settings, development build); Acknowledge required before Next scan / Back; time, GPS (fresh ≤ 10 s else scan fix), officer, device saved first, soft Code 1 queued and sent through the EnforcementMAPS host when present (29a–29c); hot-list entry log `#/hotlog/:entryId` (29d); events in backups | `hotlist.ts`, `host.ts`, `hotLog.ts`, `db.ts` (v4 `hotEvents`) |
| **S30** Payment check, 701 / 702 | `offence.ts` decision table — **time first, then payment** (owner 25/11/2026): allowance exceeded → 701 whatever the payment state; within it, no payment found → 702 at once, paid to + 5-minute grace passed → 702; 701 and 702 never offered together (the earlier "first reached + secondary" offer is removed); disability never 702. **702e** (CoM's internal "paid session expired" split) is derived, never offered: `internalVariant` `no_payment` / `expired_session` (`unknown` with no payment check), `variantSource: 'derived'`, `variantBasis` (paid from / to, checked at, shortfall minutes) in the hand-off; chip `702 · No valid payment` / `702 · Paid session expired`; OQ30-2 (paid session already ended at the first scan) → `expired_session`. Payment check form, offer card, top-up with history, record payment block (30a–30e, 30g) | `offence.ts`, `issuance.ts`, `scan.ts`, `record.ts` |
| **S31** Issue infringement | Hand-off payload validated against `schemas/platewatch-infringement-handoff.v1.schema.json` (from the requirements doc), note templates (§5); "Issue infringement" + 31a sheet only with an EnforcementMAPS host (hidden in the development build, IR-3); store-back of the I-N, timing closed `issued` (31f); issued records locked: no plate edit, delete or purge (31h, IR-23) | `infringement.ts`, `host.ts`, `scan.ts`, `record.ts`, `db.ts` |
| **Backend** (field testing) | Development host for `window.EnforcementMAPS` when a backend is configured: 4-step wizard on the device (8d-i–8d-iv), I-N allocated and signed on the device, verified by the server; void (supervisor) and void + reissue (no approval); soft Code 1 to the console; sync, evidence upload, test payment provider, 702 analytics | `server/`, `backend.ts`, `signer.ts`, `inNumber.ts`, `infringementWizard.ts` — [BACKEND.md](BACKEND.md) |

## Vehicle details (owner direction 23/11/2026)

Wherever PlateWatch holds a vehicle it uses the infringement-issuance structure: **Licence plate,
Registration type, Make, Type, Colour** (`VehicleDetails`, `src/lib/vehicle.ts`) — hot-list and
permit entries, their forms and CSV columns, and the hand-off payload (`vehicle.registration`,
`registrationType`, `make`, `type`, `colour`, all required). Model is no longer held: older entries
and files move it into the notes (DB v5 migration, backups, CSV import).

**Second licence plate entry at issue:** the 31a hand-off asks for the vehicle details (pre-filled
only from an exact hot-list or permit entry), then the licence plate again. The second entry is
checked exactly against the first (no look-alike tolerance); a mismatch is flagged and Start stays
disabled until they match. The payload records `vehicle.plateReentry { second, matched: true, at }`,
and `buildHandoff` refuses a mismatch. The EnforcementMAPS wizard should apply the same rule if
the officer edits the vehicle details or registration in step 1.

Registration type is free text with suggestions (Standard, Custom / personalised, Commercial,
Heavy vehicle, Motorcycle, Trailer, Interstate, Overseas, Unregistered) until the council's list of
accepted values is confirmed.

## Not built here (other systems or open decisions)

- **CommandMAPS:** soft Code 1 banners, radio OK / escalate to Code 1 (29e–29k), void-only approvals (31l). The backend console (`/console/`) stands in for the banners, acknowledgements and void approvals during field testing; radio OK / escalation is not built.
- **EnforcementMAPS:** the four-step wizard, I-N allocation and signing, print, void and reissue (31b–31m). PlateWatch calls `window.EnforcementMAPS.startInfringement(handoff)` and `sendHotListAlert(event)`; the contract is `src/lib/host.ts`.
- **All-day paid parking (30f):** needs a paid-only restriction model (OQ30-10): `limitMinutes` is required and the release schema requires a maximum stay for metered / ticket rules.
- **Open owner questions** carried as drawn: OQ28-3 (no auto-resolution), OQ29-1/3/5/7–10, OQ30-1/5/6/9 (payment check mandatory as drawn), OQ31-2/4/5/6/12/13.

## Permit schema (owner decisions 23/11/2026)

- `schemas/civicmaps-parking-permit.v1.schema.json`: no vehicle model; colour required;
  `validFrom` / `validTo` (expiry midnight at the end of `validTo`); street number and street
  required; the permit number is authoritative (types RPA / RSP / RP / FS, COMB combinations);
  plates up to 10 characters; fixed registration-type and vehicle-type lists; council code plus
  CivicMAPS linking ID (`com-rpa7` on screen, `919379201-com-rpa7` operationally).
- Permit pop-up: only valid / expired, same details either way; solid green / red blinking border.
  Scope by type (`docs/PERMITS-AND-EXEMPTIONS.md`); FS waives payment in foreshore spaces only.
- Imports: permit JSON (schema), allow-list CSV with the new columns; the add-permit form enforces
  the same required fields. IndexedDB v6 migrates stored vehicle details to the codes.
- Hand-off payload adds `vehicle.registrationState`.

## Handoff WF-PW-HANDOFF-03 (offence rules updated 25/11/2026) — applied 25/11/2026

| Item | Status |
|---|---|
| Time first: 701 whatever the payment state once the allowance is exceeded | Done (`offenceFor`); tests follow the handoff's decision table row by row |
| 702e derived, internal only, never chosen or shown as a code | Done: device, hand-off schema (`internalVariant`, `variantSource`, `variantBasis`), server re-derives and refuses a client-chosen value, console analytics |
| Notice / customer / Fines Victoria carry 702 only | The hand-off's `suggestedCode` and the issued `offenceCode` are `701`/`702` only; `noticeOffenceCode()` |
| Infringement issued outside PlateWatch without a payment check → `unknown` | `variantFor()` returns `unknown` when a 702 has no payment check |
| All-day paid parking (30f) | Still not built: needs a paid-only restriction model (OQ30-10) |
| Soft Code 1 recipients | Code and S29 say dispatch + compliance coordinator; the 23/11 handoff text says "team supervisor" — **OWNER VALIDATION REQUIRED** (BE-7) |
| Wireframe deliverables (S28–S31 `.dc.html`, annotations, parity) | Not part of this code change; the S26–S27 pack was used as reference only |
