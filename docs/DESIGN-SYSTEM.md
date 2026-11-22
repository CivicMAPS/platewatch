# PlateWatch — CivicMAPS design system conformance

PlateWatch's interface follows the **CivicMAPS Design System 2.0.0-rc** so that it can be lifted
into EnforcementMAPS as the digital-chalking module with no restyling. This file records how the
design system is wired in and where each finding in the design-system assessment
(`PlateWatch Design-System Assessment - 2026-11-22`, D1–D16, wireframe sequences S26/S27) stands.

## How it is wired

| Piece | Where | Notes |
|---|---|---|
| Tokens + base element rules | `src/styles/civicmaps/colors_and_type.css` | The design-system file, vendored. Two edits, listed in its header: Google Fonts `@import` removed (offline-first, CSP `font-src 'self'`), DM Sans italic not shipped. To upgrade, drop in the new release and re-apply those two edits. |
| Tailwind bridge | `src/styles.css` | `@theme inline` maps every colour utility to a token (`bg-primary` → `--civic-primary`, `text-pending-strong` → `--status-pending-strong`, …). Tailwind's default palette is removed (`--color-*: initial`), so a stray `bg-red-500` compiles to nothing. Radius, shadow and type scale equal the token values. |
| Fonts | DM Sans (vendored TTF), JetBrains Mono (`@fontsource-variable/jetbrains-mono`, Latin subset) | Both local and precached by the service worker. Plus Jakarta Sans (admin headers only) is not shipped. |
| Icons | `lucide` package, barrel in `src/ui/components.ts` (`icon()`) | Same glyph set as `lucide-react-native` in EnforcementMAPS. No unicode or emoji icons. |
| Status | `STATUS`, `statusPill()`, `banner()` in `src/ui/components.ts` | Every status is colour + icon + text. One table maps PlateWatch outcomes to design-system status tokens. |
| Low-light theme | Settings → Display | Sets `data-theme="dark"`, the design system's dark overrides. The camera is always dark. |

Component code carries no raw hex. The only literal colours are the camera overlay (black/white)
and the number plate itself (white plate, black characters).

## Status mapping (assessment §3, as drawn in S27)

| Outcome | Token | Icon | Pill |
|---|---|---|---|
| First sighting / timing | `--status-pending` | clock | TIMING / FIRST SIGHTING |
| Within allowance | `--status-pending` | clock | WITHIN ALLOWANCE |
| Overstay, overdue | `--status-alert` | triangle | OVERSTAY / OVERDUE |
| Permit valid, restriction in force | `--status-active` | check / clock | PERMIT VALID / IN FORCE |
| Not in force | `--status-inactive` | dash | NOT IN FORCE |
| Possible match | `--status-alert` | question | VERIFY / NEAR MATCH |
| Hot-list match | `--status-alert`, persistent interrupt | shield | OFFICER SAFETY (**OQ27-1**) |

Red (`--status-emergency`) is never used: it is reserved for Code 1. Destructive actions use a
red outline only inside confirmation dialogs (OQ26-3).

## Assessment findings

| # | Finding | Status |
|---|---|---|
| D1 | Dark theme throughout | **Done.** Light civic surfaces; camera stays dark; optional low-light theme from the design system. |
| D2 | Teal primary buttons | **Done.** Civic Navy primary actions and header chrome. |
| D3 | Red for non-Code-1 states | **Done.** Overstay, overdue, poor GPS and field errors are amber + icon + text. Hot list is amber pending OQ27-1. |
| D4 | Amber for passive states | **Done.** Within allowance is Pending blue. |
| D5 | Colour-only status | **Done.** `statusPill()` everywhere (outcomes, GPS, permissions, restriction in force, risk level). |
| D6 | Toasts for blocking errors | **Done.** Invalid plate, GPS required, check failed, dismiss failed and plate-correction failures are persistent banners. Toasts remain for non-blocking confirmations only. |
| D7 | Plate / code font | **Done.** JetBrains Mono for plates, IDs, times, coordinates, hashes. |
| D8 | UI font | **Done.** DM Sans. |
| D9 | 40 px chips | **Done.** Interactive chips are 44 px (`chip-button`). |
| D10 | ISO dates on screen | **Done.** `DD/MM/YYYY HH:MM:SS AEDT` on screen (`formatStamp`); ISO 8601 kept in evidence metadata and shown as a secondary row on the record. |
| D11 | Unstyled near-match dialog | **Done.** Bottom sheet with the capture beside the similar plates (`nearMatchSheet()`), used on scan and record. |
| D12 | "Dismiss" with two meanings | **Done.** Near-match action is "Not a match — check as read". |
| D13 | No Authority Context | **Open (OQ26-1).** Content needs owner validation; belongs to the eMAPS shell. |
| D14 | No Code 1 control on camera | **Open (OQ26-4).** Proposed; needs the eMAPS duress service. |
| D15 | Caps headings | **Done.** Section headings sentence case; caps only on status pills. |
| D16 | Product naming | **Open (OQ26-2).** Standalone build keeps "PlateWatch"; app icon recoloured to Civic Navy / Patrol Gold. |

Also applied from the design system: 8 px radius on cards and buttons, 4 px on form cells, `shadow-sm`
cards, flat surfaces (no backdrop blur), modal backdrop `rgba(0,0,0,.40)`, press scale 0.96,
gold focus ring, CAPS display of typed text (placeholders exempt), reduced-motion support.

Not implemented because they are proposals awaiting decisions, not design-system rules: hot-list
Acknowledge gate (27g.5, OQ27-2), manual payment-check confirmation (27c.4, OQ27-4), Issue
infringement hand-off (27c.5, OQ27-6), routing tracked-plate look-alikes to the
"Possible earlier sighting" panel (OQ27-3).
