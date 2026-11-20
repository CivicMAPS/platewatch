---
title: PlateWatch security notes
version: 1.0.0
---

# Security notes

## Content Security Policy

Applied to the production build as a `<meta>` tag (web + APK) and emitted to `dist/_headers`
with header-only directives for static hosts.

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self' blob:;
connect-src 'self' blob: data:;
img-src 'self' blob: data:;
media-src 'self' blob: mediastream:;
style-src 'self';
font-src 'self';
manifest-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none'   (header only)
```

- **No `'unsafe-inline'`, no nonces.** The app emits no inline script or style: Tailwind is
  compiled locally to a static stylesheet, lit-html binds events with `addEventListener`, and
  runtime styling uses classes only. The app is static with no per-request server render, so
  there is nothing to mint a nonce for; a nonce would add no protection here.
- **`'wasm-unsafe-eval'`** is required by the Tesseract WebAssembly core. It permits WebAssembly
  compilation only; `eval()` and `new Function()` stay blocked.
- **No third-party origins.** OCR worker, cores and language model are copied from
  `node_modules` into `/ocr` at build time (`scripts/copy-ocr-assets.mjs`); nothing loads from
  a CDN.
- The E2E smoke test fails on any `securitypolicyviolation` event or console error.

Dev server (`npm run dev`) runs without the meta CSP because Vite injects `<style>` tags for HMR.

## Rendering untrusted data

All user/backup-supplied strings are rendered through lit-html text bindings (auto-escaped).
There is no `innerHTML`/`unsafeHTML` anywhere in the codebase. Backup import validates the
schema, drops malformed records (including malformed paid-parking data and scan metadata), accepts only `data:image/*` evidence, and re-derives every
plate matching key so a crafted file cannot cause false exemptions.

## Storage & permissions

| Item | Detail |
|---|---|
| Storage | IndexedDB only; `navigator.storage.persist()` requested to prevent eviction. |
| Android backup | `allowBackup=false`, `data_extraction_rules.xml` excludes all domains from cloud backup and device transfer. |
| Android permissions | `CAMERA`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `VIBRATE`, `INTERNET` (Capacitor bridge + "open in Maps" link). |
| Web permissions policy | `camera=(self), geolocation=(self)`, microphone/payment/usb disabled (`_headers`). |
| Native patrol plugin | `PatrolCamera` (CameraX + bundled ML Kit text recognition). Rejects `start` unless CAMERA is granted; frames are written only to the app cache as `patrol-*.jpg`, and `release` deletes only files matching that name in the cache directory. ML Kit may send usage metrics to Google (no image or text content). |
| WebView debugging | `webContentsDebuggingEnabled: false` in `capacitor.config.ts`. |

## Evidence integrity

Each evidence JPEG's SHA-256 is computed immediately after EXIF embedding and stored with the
record. *Record → Verify image integrity & EXIF* recomputes the hash and reads back
DateTimeOriginal/OffsetTimeOriginal and GPS from the stored file.

This is tamper-*evidence* on the device, not a signature: anyone with device access could
replace both the image and the stored hash. If evidence must stand up to challenge, sync the
hashes to a server (or sign them with a device-bound key) at capture time.
