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
  - "Hot-list acknowledge: date, time, location, officer number; soft Code 1 to dispatch and the compliance coordinator, amber, closed by the recipient's acknowledgement (23/11/2026, OQ29)"
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
| Hot-list sighting (S29) | Officer acknowledges → soft Code 1 sent; evidence image uploaded | `alerts`, `alert_acks` | Amber flashing banner for **dispatch** and the **compliance coordinator** only; each acknowledges; closes when both have; device is told who acknowledged |
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

### Field testing on phones

Handsets need to reach the server over **HTTPS** (camera and GPS need a secure context for the
PWA; the APK's CSP allows any `https:` backend). Put the container behind any TLS-terminating
host (a cloud VM with Caddy, Fly.io, Render, Railway, …) — the server is one Node process plus
PostgreSQL. For a LAN `http://` address, build the app with
`VITE_PLATEWATCH_CONNECT_SRC="http://192.168.1.20:8787" npm run build` (adds it to the CSP).

### Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | `postgres://user:pass@host:5432/db` |
| `PLATEWATCH_DEVICE_TOKEN` | yes (≥ 24 chars) | — | Bearer token handsets present |
| `PLATEWATCH_CONSOLE_TOKEN` | yes (≥ 24 chars, ≠ device token) | — | Bearer token for the console |
| `PLATEWATCH_COUNCIL` | no | `com` | Council code the I-N statements must name |
| `PLATEWATCH_CORS_ORIGINS` | no | `*` | Comma-separated origins (bearer tokens, no cookies) |
| `PLATEWATCH_APP_DIR` | no | `./dist` if present | Built PWA served at `/` |
| `PORT` | no | `8787` | Listen port |

### Connect a handset

1. **Settings → Officer number** (digits, up to 5: it becomes the I-N officer id).
2. **Settings → Backend**: server URL and the device token → **Test connection**. The device's
   signing key registers as **Awaiting approval**.
3. Console → **Devices** (supervisor) → **Approve**. Until then the device still issues offline;
   the server accepts the numbers once the key is approved.

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
| `alerts` / `alert_acks` | `id` / `(alert_id, recipient)` | Soft Code 1 and each recipient's acknowledgement |
| `paid_sessions` | `id` | Test payment provider |
| `audit_log` | `id` | Console actions |

Infringement status: `allocated → issued → (paid | void_requested → voided | issued) | voided (by reissue)`,
or `allocated → cancelled` (number consumed).

## 5. API

Device endpoints: `Authorization: Bearer <device token>` and `X-Device-Key: <key id>`.
Console endpoints: `Authorization: Bearer <console token>`, `X-Staff-Role`
(`dispatch` | `compliance_coordinator` | `supervisor`), `X-Staff-User`.
Errors: `{ error: <code>, message, details? }`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/health` | anyone | `{ ok, council, version, time }` |
| POST | `/api/devices/register` | device | `{ publicJwk, label, officerNumber }` → `{ keyId, status, council }` |
| GET | `/api/devices/me` | device | Key status |
| POST | `/api/sync` | device | `{ scans[], observations[], hotEvents[] }` (≤ 200 each) → `{ accepted, rejected }` |
| POST | `/api/hot-alerts` | device | `{ event: HotListEvent, entry? }` → `{ sentAt }` |
| POST | `/api/infringements/statements` | device | `{ keyId, scanId, allocation, closing?, record? }` → `{ number, status }` (idempotent) |
| POST | `/api/infringements/:number/void-request` | issuing device | `{ reason, note?, requestedAt, officerNumber }` |
| PUT | `/api/evidence/:scanId` | device | JPEG body, `X-Content-SHA256` |
| GET | `/api/updates?since=` | device | Infringement status and alert acknowledgements since the cursor |
| GET | `/api/payments/lookup?plate=&at=&ref=` | device | Test provider: covering paid session or `null` |
| GET | `/api/console/summary` · `/alerts` · `/alerts/:id` | staff | Live counts, banners, sighting detail + entry log |
| POST | `/api/console/alerts/:id/ack` | dispatch, coordinator | Acknowledge for your role |
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
approval, void + reissue, the hot-list banner and both acknowledgements, a paid-session lookup and
the analytics (11 checks, production CSP, no console errors).

## 7. Security and privacy

- Two separate bearer tokens, compared in constant time; the server refuses to start without
  them. Staff identity in the console is **self-declared** — this is a development stand-in;
  production identity comes from CivicMAPS sign-in (owner decisions Q1–Q4).
- Scan records carry plates, locations and thumbnails; evidence images are uploaded only for
  issued infringements and acknowledged hot-list sightings. Hot-list notes are never sent.
- The console has its own strict CSP (no inline script or style) and renders device data with
  `textContent` only.
- Use a dedicated database per council and test cycle; there is no retention job yet
  (hot-list log retention is an open question, OQ29).

## 8. Open questions and deviations (log as OQ / DECISION REQUIRED)

| # | Item | As built |
|---|---|---|
| BE-1 | Hosting for field tests | **DECISION REQUIRED**: no host was chosen; Dockerfile + compose provided |
| BE-2 | Each recipient acknowledges separately vs first closes for both (OQ29) | Separately; closes when both have (proposed) |
| BE-3 | Officer told when dispatch acknowledges (OQ29) | Yes: shown on the acknowledgement panel after sync (proposed) |
| BE-4 | Unacknowledged after N minutes (OQ29) | Not escalated (open) |
| BE-5 | Device key approval | One supervisor (production: attestation + two-person approval) |
| BE-6 | Customer payment status | Simulated from the console (no council infringement system) |
| BE-7 | Recipients of the soft Code 1 | Dispatch + compliance coordinator, as built from S29 (the 23/11 handoff text says "team supervisor"): **OWNER VALIDATION REQUIRED** |
| BE-8 | Grace after paid to | 5 minutes (as built; OQ30 open) |
