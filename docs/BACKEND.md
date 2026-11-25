---
document_id: PW-BACKEND-01
title: PlateWatch backend — development and field-testing server
version: 1.0.0
status: Built and tested (development / field testing; not a production release)
date: 25/11/2026
owner_decisions_applied:
  - "Offence rules 701 / 702, 702e derived and internal only (25/11/2026)"
  - "I-N generated and signed on the handset; the server verifies and accepts, never creates (17/11/2026)"
  - "Void with reissue: no approval; void without reissue: supervisor approval in CommandMAPS; offline issuing queues and never blocks (23/11/2026)"
  - "Hot-list officer safety: blocking pop-up, CODE 1 or SAFE & CLEAR, soft Code 1 on no answer to dispatch + the officer's team supervisor (fallback: every team supervisor on shift + the compliance lead), radio response, Code 1 for the whole branch (25/11/2026, supersedes 23/11)"
  - "Officer identity: one handset per officer; council account sign-in at the start of shift, then a 6-digit PIN; the officer number from sign-in is used everywhere (25/11/2026; EnforcementMAPS supplies it, the development build uses Settings)"
stack: [Node.js 22, PostgreSQL 16, pg 8, ajv 8, rolldown (bundle), vanilla JS console]
source: [server/, src/lib/backend.ts, src/lib/signer.ts, src/lib/inNumber.ts, src/lib/issuance.ts, src/ui/infringementWizard.ts]
---

# PlateWatch backend

PlateWatch is offline-first: everything is saved on the device first. Inside EnforcementMAPS the
host supplies the officer identity, the CommandMAPS alert transport and the Issue Infringement
wizard (`src/lib/host.ts`). This backend **stands in for those hosts** so that field testing sees
the whole workflow and life cycle with a real, persistent database:

| Life cycle | Device (PlateWatch) | Backend (PostgreSQL) | Console (CommandMAPS stand-in) |
|---|---|---|---|
| Sightings | Every scan, timing and hot-list event is queued in an outbox in the same transaction as the change, then synced | `scans`, `observations`, `hot_events` | **Sightings** feed with thumbnails and payment checks |
| Hot-list hit (owner 25/11) | Blocking pop-up: plate, make, type, colour, alert message, More information (history, interactions, known locations, owner description); **CODE 1** or **SAFE & CLEAR** + optional note; no answer by the deadline → handset raises a **soft Code 1** | `hot_hits`, `alerts`, `alert_events` | Amber soft Code 1 banner for dispatch and the officer's team supervisor (or the fallback); acknowledge = radio requested → **radio OK** or **no response → Code 1** |
| Code 1 | Officer: red banner, location every 10 s, cancel if raised in error. Every other handset in the branch: **red alarm with sound** and the location pin until RECEIVED, then a banner until cleared | `alerts`, `alert_locations`, `alert_receipts` | Red banner (always above), siren until acknowledged, location trail, **clear with an outcome** |
| Roster | — | `staff`, `shifts` | **Roster**: staff, roles, teams, branch, officer numbers, who is on shift today (routes the soft Code 1) |
| Payment check (S30) | "Look up paid session (test provider)" fills the form; the officer still saves | `paid_sessions` | **Paid sessions (test)**: create sessions as EasyPark / PayStay would |
| Issue infringement (S31) | 4-step wizard (8d-i–8d-iv) on the device; I-N allocated and signed on the device at start; works offline | `statements` (hash chain), `pools`, `infringements`, `infringement_events` | **Infringements** with evidence, notes, signed statements and the life-cycle timeline |
| Void without reissue | Record → *Request void* (reason) | `void_requested` | Supervisor **Approve void** / **Reject** |
| Void + reissue | Record → *Reissue* (reason) → wizard → new I-N | Original `voided` when the reissue is accepted — no approval | Both numbers linked |
| Payment by the customer | Shown on the record (Paid) | `paid` | *Record payment (simulated)* |
| 702 / 702e analytics | Officer only ever sees **702** | `internal_variant` derived and re-derived server-side | **701 / 702**: split by zone, segment, hour, payment source; shortfall minutes |

Nothing here changes the standalone build: with no backend configured the app behaves exactly as
before (no network requests, Issue infringement hidden, alerts queued).

## 1. Run it

### Local (Node + PostgreSQL)

```bash
createdb platewatch                     # or any PostgreSQL 14+ database
cp .env.example .env                    # set DATABASE_URL and the two tokens
npm run build                           # the PWA (served by the backend at /)
npm run server                          # bundles server/ → dist-server/server.mjs and starts it
```

- App: `http://localhost:8787/` — Console: `http://localhost:8787/console/`
- Migrations run automatically at start (`server/migrations/`, tracked in `schema_migrations`).

### Docker (single host)

```bash
cp .env.example .env                    # set the two tokens
docker compose up --build               # PostgreSQL 16 + the server on :8787
```

### AWS (field testing): `platewatch.civicmaps.com.au`

`deploy/aws` is a CDK app: a Route 53 zone for the delegated subdomain, RDS PostgreSQL, the server
on ECS Fargate behind an HTTPS load balancer, tokens in Secrets Manager. Runbook and costs:
[deploy/aws/README.md](../deploy/aws/README.md). The image is `server/Dockerfile` (verified to build
and serve here); the server verifies the RDS TLS certificate (`PLATEWATCH_DB_CA_FILE`).

### Field testing on phones

Handsets need to reach the server over **HTTPS** (camera and GPS need a secure context for the
PWA; the APK's CSP allows any `https:` backend). Put the container behind any TLS-terminating
host (a cloud VM with Caddy, Fly.io, Render, Railway, …) — the server is one Node process plus
PostgreSQL. For a LAN `http://` address, build the app with
`VITE_PLATEWATCH_CONNECT_SRC="http://192.168.1.20:8787" npm run build` (adds it to the CSP).

### Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes (or `PG*`) | — | `postgres://user:pass@host:5432/db`, or `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` |
| `PLATEWATCH_DB_CA_FILE` | no | — | Verify the database's TLS certificate against this CA bundle (`/app/rds-ca.pem` in the image) |
| `PLATEWATCH_DEVICE_TOKEN` | yes (≥ 24 chars) | — | Bearer token handsets present |
| `PLATEWATCH_CONSOLE_TOKEN` | yes (≥ 24 chars, ≠ device token) | — | Bearer token for the console |
| `PLATEWATCH_COUNCIL` | no | `com` | Council code the I-N statements must name |
| `PLATEWATCH_CORS_ORIGINS` | no | `*` | Comma-separated origins (bearer tokens, no cookies) |
| `PLATEWATCH_APP_DIR` | no | `./dist` if present | Built PWA served at `/` |
| `PLATEWATCH_TIMEZONE` | no | `Australia/Melbourne` | Council day for shifts |
| `PLATEWATCH_DEFAULT_BRANCH` | no | `parking` | Branch for an officer not in the roster |
| `PLATEWATCH_HOT_ACK_SECONDS` | no | `60` | Time to answer the hot-list pop-up before the soft Code 1 (min 10) |
| `PLATEWATCH_WATCHDOG_GRACE_SECONDS` | no | `20` | Extra wait before the server raises a soft Code 1 the handset did not |
| `PLATEWATCH_RADIO_ESCALATE_SECONDS` | no | `0` | Auto-escalate a soft Code 1 with no radio response (0 = manual) |
| `PORT` | no | `8787` | Listen port |

### Connect a handset

1. **Settings → Officer number** (digits, up to 5: it becomes the I-N officer id).
2. **Settings → Backend**: server URL and the device token → **Test connection**. The device's
   signing key registers as **Awaiting approval**.
3. Console → **Roster**: add the officer (staff number, name, officer number, team) and mark the
   team supervisor and dispatch on shift today. Then **Devices** (team supervisor or compliance
   lead) → **Approve**. Until then the device still issues offline;
   the server accepts the numbers once the key is approved.

## 1a. Hot-list officer safety (owner direction 25/11/2026)

```text
hit (scanned or typed plate) ─▶ pop-up blocks the handset (survives a reload)
   ├─ CODE 1 ────────────▶ Code 1 (red) for the whole branch
   ├─ SAFE & CLEAR (+note) ▶ logged on the plate's history (time, location, officer)
   └─ no answer by the deadline (PLATEWATCH_HOT_ACK_SECONDS, default 60)
        ─▶ soft Code 1 (amber): dispatch + the officer's team supervisor on shift
           (not on shift → every team supervisor on shift + the compliance lead)
           ─ acknowledge = radio response requested ─▶ RADIO OK (resolved)
                                                    └─ NO RESPONSE ─▶ Code 1 (red)
Code 1: every officer handset and console in the branch: alarm + location pin; dispatch
acknowledges; cleared with an outcome (or cancelled as raised in error).
```

- The handset raises the soft Code 1 at the deadline. If it cannot (no signal, damaged), the
  server's watchdog raises it after `PLATEWATCH_WATCHDOG_GRACE_SECONDS` (default 20).
- A late SAFE & CLEAR is shown on the open soft Code 1; dispatch still confirms by radio.
- `PLATEWATCH_RADIO_ESCALATE_SECONDS` (default 0 = manual) escalates automatically when no radio
  response is recorded in that time.
- **CODE 1 is never blocked** on the handset or refused by the server.
- Location: the handset shares its position every 10 s while a Code 1 about its officer is open.
  **A PWA in the background (screen locked, phone in a pocket) stops receiving GPS**: reliable
  tracking needs the native app's background location (Android foreground service) — see BE-9.
- The officer number on every surface comes from the EnforcementMAPS sign-in (council account +
  password at the start of shift, then a 6-digit PIN; one handset per officer). The development
  build uses the number in Settings as a stand-in.

## 2. Infringement numbers (I-N)

`OOOOO YYMMDD SSS TTTT CC` — officer id, allocation date (council local), daily sequence
001–999, signature tag, ISO 7064 MOD 97-10 check digits (`src/lib/inNumber.ts`).

```text
allocation statement (signed, ECDSA P-256, IEEE P1363, canonical JSON)
{ v: 1, type: "allocation", council, officer: "04471", keyId, date: "261125",
  sequence: 1, timestamp: "2026-11-25T19:16:56.000+11:00", prevHash }
tag   = first 8 bytes of SHA-256(signature) mod 10000
check = 98 − (first 18 digits × 100 mod 97)

issue / cancel statement (signed)
{ v: 1, type: "issue" | "cancel", number, keyId, allocationHash, recordHash?, timestamp, prevHash }
recordHash = SHA-256(canonical(issued record))
```

- The device key is generated with WebCrypto, **non-extractable**, kept in IndexedDB
  (`src/lib/signer.ts`). Production uses the managed handset's hardware keystore with attestation
  and two-person approval; this backend takes one supervisor's approval.
- Every statement chains to the previous one signed by the same key (`prevHash`). Allocation is
  queued for the server the moment it is signed, so the chain never has a gap; a number left open
  (app closed mid-wizard) is closed with a signed **cancel** on the next sync.
- The server (`server/verify.ts`) checks, in one transaction: key approved · signature · chain
  head · next sequence in the officer's daily pool · date plausible against receipt · number =
  what the statement commits to · uniqueness · record hash · hand-off validates against
  `schemas/platewatch-infringement-handoff.v1.schema.json` · locked time from and the internal 702
  classification **re-derived** (a client that sends a different one is refused).

## 3. Offence rules on the device (25/11/2026)

Time first, then payment (`src/lib/offence.ts`):

| Space | Payment state | Within allowance? | Offered | Internal (analytics only) |
|---|---|---|---|---|
| `nP Meter` / `nP Ticket` | Paid session current | Yes | — (timing, blue) | — |
| same | Paid to + 5 min grace passed | Yes | **702** · Paid session expired | `expired_session` (702e) |
| same | No payment found | Yes | **702** · No valid payment | `no_payment` |
| same | Paid session found but already ended at the first scan (OQ30-2) | Yes | **702** · Paid session expired | `expired_session` |
| same | Any | **No** | **701** | — |
| Timed, not paid | — | No | **701** | — |
| Disability permit displayed / FS permit in a foreshore space | No payment required | No (2 × allowance for disability) | **701**; never 702 | — |

701 and 702 are never offered together; a 702 at one scan can be followed by a 701 at a later
scan. The officer is never offered or shown "702e"; the wizard's offence chips read
`702 · No valid payment` / `702 · Paid session expired`. The notice code is `702` either way.

## 4. Data model (PostgreSQL)

`server/migrations/001_init.sql`. Main tables:

| Table | Key | Holds |
|---|---|---|
| `devices` | `key_id` | Public JWK, label, officer, `pending` / `approved` / `revoked`, who decided |
| `statements` | `hash` | Every signed statement, unique per `(key_id, prev_hash)` (no forks) |
| `chain_heads` | `key_id` | Last accepted statement per key |
| `pools` | `(officer, day)` | Last accepted sequence |
| `infringements` | `number` | Status, offence, `internal_variant`, `variant_source`, shortfall, times, location, full issued record, reissue links, void request, `change_no` |
| `infringement_events` | `id` | Life-cycle audit: allocated, issued, cancelled, void_requested, void_approved / rejected, voided_by_reissue, payment_recorded |
| `scans` / `evidence` | `id` / `scan_id` | Scan metadata (+ thumbnail) / evidence JPEG, SHA-256 checked against the capture hash |
| `observations`, `hot_events` | `id` | Timings and hot-list entry-log events |
| `staff` / `shifts` | `id` / `(staff_id, day)` | Roster: role (officer, dispatch, team supervisor, compliance lead), team, branch, officer number; who is on shift each council day |
| `hot_hits` | `id` | Each hot-list hit: plate, entry details shown on the pop-up, officer, location, deadline, answer, note |
| `alerts` | `id` | Soft Code 1 and Code 1: recipients, status life cycle, who acknowledged / closed, outcome, escalation links |
| `alert_locations` / `alert_receipts` / `alert_events` | — | Location trail; handsets that silenced a branch alarm; the alert's audit trail |
| `paid_sessions` | `id` | Test payment provider |
| `audit_log` | `id` | Console actions |

Infringement status: `allocated → issued → (paid | void_requested → voided | issued) | voided (by reissue)`,
or `allocated → cancelled` (number consumed).

## 5. API

Device endpoints: `Authorization: Bearer <device token>` and `X-Device-Key: <key id>`.
Device endpoints also send `X-Officer-Number`.
Console endpoints: `Authorization: Bearer <console token>` and `X-Staff-Id` (a roster member:
dispatch, team supervisor or compliance lead). With an empty roster the first manager is created
with the token alone.
Errors: `{ error: <code>, message, details? }`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/health` | anyone | `{ ok, council, version, time }` |
| POST | `/api/devices/register` | device | `{ publicJwk, label, officerNumber }` → `{ keyId, status, council }` |
| GET | `/api/devices/me` | device | Key status |
| POST | `/api/sync` | device | `{ scans[], observations[], hotEvents[] }` (≤ 200 each) → `{ accepted, rejected }` |
| POST | `/api/hot-hits` · `/api/hot-hits/:id/response` | device | Report a hit at once; answer it (`safe_clear` / `code1`, note). Hits and answers also arrive through `/api/sync` |
| POST | `/api/alerts/soft-code1` | device | `{ hit, at, location }` at the deadline (idempotent per hit) |
| POST | `/api/code1` · `/:id/location` · `/:id/cancel` | device | Raise a Code 1; share the location; cancel one raised in error (own only) |
| GET | `/api/alerts/live` | device | This officer's open alerts and the branch's Code 1s (`received` per handset) |
| POST | `/api/alerts/:id/receipt` | device | Alarm received (silenced) |
| GET | `/api/hot-profile?plate=&entryId=` | device / console | Match history, interactions, known locations |
| POST | `/api/infringements/statements` | device | `{ keyId, scanId, allocation, closing?, record? }` → `{ number, status }` (idempotent) |
| POST | `/api/infringements/:number/void-request` | issuing device | `{ reason, note?, requestedAt, officerNumber }` |
| PUT | `/api/evidence/:scanId` | device | JPEG body, `X-Content-SHA256` |
| GET | `/api/updates?since=` | device | Infringement status and alert acknowledgements since the cursor |
| GET | `/api/payments/lookup?plate=&at=&ref=` | device | Test provider: covering paid session or `null` |
| GET | `/api/console/directory` | token | Who can sign in (bootstrap flag when the roster is empty) |
| GET/POST | `/api/console/staff` · `/staff/:id/shift` | staff / managers | Roster and today's shifts |
| GET | `/api/console/summary` · `/alerts` · `/alerts/:id` · `/hits` | staff | Live counts, banners (`forMe`), alert detail with trail, receipts, profile; hits feed |
| POST | `/api/console/alerts/:id/acknowledge` · `/radio-ok` · `/escalate` · `/clear` · `/cancel` | dispatch / recipients / staff | Soft Code 1: request radio, resolve, escalate. Code 1: acknowledge, clear with an outcome, cancel as raised in error |
| GET | `/api/console/infringements` · `/:number` | staff | List; detail with events, statements, evidence |
| POST | `/api/console/infringements/:number/void-decision` | supervisor | `{ approve, note? }` |
| POST | `/api/console/infringements/:number/payment` | staff | Simulated customer payment |
| GET/POST | `/api/console/devices` · `/:keyId/decision` | staff / supervisor | Key approval |
| GET | `/api/console/scans` · `/scans/:id/thumb` · `/evidence/:scanId` | staff | Sightings and images |
| GET/POST | `/api/console/paid-sessions` | staff | Test provider |
| GET | `/api/console/analytics/offences` | staff | 701 / 702 with the derived split |
| GET | `/api/console/audit` | supervisor | Console audit log |

## 6. Testing

```bash
npm test                                           # unit tests (Postgres tests skip without a database)
PLATEWATCH_TEST_DATABASE_URL=postgres://… npm run test:server     # API against a real database (wipes it)
npm run build && npm run server:build
PLATEWATCH_TEST_DATABASE_URL=postgres://… npm run smoke:backend   # browser E2E: handset + console
```

`smoke:backend` drives the whole life cycle in headless Chrome against the real server: key
approval, a 702 issued through the wizard, server verification, evidence upload, void request and
approval, void + reissue, the hot-list pop-up (SAFE & CLEAR with a note), a missed deadline →
soft Code 1 to dispatch and the right supervisor → no radio response → Code 1 alarm with the
location pin on a second officer's handset → cleared with an outcome, a paid-session lookup and
the analytics (14 checks, two officer handsets, production CSP, no console errors).

## 7. Security and privacy

- Two separate bearer tokens, compared in constant time; the server refuses to start without
  them. Console staff choose who they are from the roster after presenting the console token —
  a development stand-in; production identity comes from CivicMAPS sign-in (owner decisions Q1–Q4).
- Scan records carry plates, locations and thumbnails; evidence images are uploaded only for
  issued infringements and hot-list hits. A hit carries what the pop-up shows, including the
  registered owner description (personal information); the entry's free-text notes stay on the device.
- The console has its own strict CSP (no inline script or style) and renders device data with
  `textContent` only.
- Use a dedicated database per council and test cycle; there is no retention job yet
  (hot-list log retention is an open question, OQ29).

## 8. Open questions and deviations (log as OQ / DECISION REQUIRED)

| # | Item | As built |
|---|---|---|
| BE-1 | Hosting for field tests | AWS (owner suggestion): `deploy/aws` CDK, `platewatch.civicmaps.com.au` |
| BE-2 | Who closes a soft Code 1 | **Resolved 25/11**: either dispatch or the designated supervisor acknowledges (one is enough) |
| BE-3 | Officer told about the escalation | Yes: the pop-up and a red banner show "Code 1 raised for you" |
| BE-4 | Deadline before the soft Code 1 | **DECISION REQUIRED**: 60 s default (`PLATEWATCH_HOT_ACK_SECONDS`) |
| BE-5 | Device key approval | One manager (production: attestation + two-person approval) |
| BE-6 | Customer payment status | Simulated from the console (no council infringement system) |
| BE-7 | Soft Code 1 recipients | **Resolved 25/11**: dispatch + the officer's team supervisor on shift; otherwise every team supervisor on shift + the compliance lead |
| BE-8 | Grace after paid to | 5 minutes (as built; OQ30 open) |
| BE-9 | Background location for Code 1 | PWA stops GPS in the background: native background location needed (**DECISION REQUIRED** for the APK) |
| BE-10 | Name of the safe answer | **OWNER VALIDATION REQUIRED**: "SAFE & CLEAR" (alternatives: "Code 4", "OSC — officer safe & clear") |
| BE-11 | Radio response wait | Manual by default; optional auto-escalation (`PLATEWATCH_RADIO_ESCALATE_SECONDS`) — **DECISION REQUIRED** |
| BE-12 | Officer cancels own Code 1 | Allowed from the handset as "raised in error" (logged); **OWNER VALIDATION REQUIRED** |
| BE-13 | Hot-list hit retention (personal data) | No retention job yet (OQ29-5) |
| BE-14 | Handset swapped mid-shift | The new handset continues the officer's daily I-N sequence from the backend on its first sync; one that issues **before** that sync (offline) can collide with the old handset's numbers and is refused (`sequence`) |
