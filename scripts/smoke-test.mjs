#!/usr/bin/env node
/**
 * End-to-end smoke test against the production build in real headless Chrome:
 *   - fake rear camera streaming a synthetic number plate (ABC 123)
 *   - mocked high-accuracy GPS fix (Melbourne CBD)
 *   - production CSP active (any violation fails the run)
 *
 * Flow: create allow/hot/timed lists → scan (OCR) → first sighting →
 *       re-scan (within allowance) → time-shift → overstay with scan 1 vs 2 →
 *       hot-list alert → permit exemption → EXIF/integrity verification.
 *
 *   npm run build && npm run smoke        (CHROME_PATH overrides browser)
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4179;
const ORIGIN = `http://localhost:${PORT}`;
const GPS = { latitude: -37.8136276, longitude: 144.9630576, accuracy: 4 };
const shots = process.env.SMOKE_SCREENSHOTS ?? join(root, 'smoke-screenshots');

async function findChrome() {
  for (const c of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try {
      await access(c);
      return c;
    } catch {
      /* next */
    }
  }
  throw new Error('Chrome not found (set CHROME_PATH)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const log = (msg) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${msg}`);

async function makeFakeCamera(browser, dir) {
  const page = await browser.newPage();
  await page.setViewport({ width: 720, height: 1280 });
  await page.setContent(`<html><body style="margin:0;width:720px;height:1280px;background:linear-gradient(#3b4252,#20242c);display:flex;align-items:center;justify-content:center">
    <div style="width:440px;height:150px;background:#fff;border:6px solid #111;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'DejaVu Sans Mono',monospace">
      <div style="font-size:88px;font-weight:700;letter-spacing:4px;color:#111;line-height:1;white-space:nowrap">ABC 123</div>
    </div></body></html>`);
  const png = await page.screenshot({ encoding: 'base64' });
  const luminance = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + encoded;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const {data} = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const y = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < y.length; i++) {
      y[i] = Math.round(16 + 0.257 * data[4*i] + 0.504 * data[4*i+1] + 0.098 * data[4*i+2]);
    }
    return Array.from(y);
  }, png);
  await page.close();
  const y4m = join(dir, 'plate.y4m');
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Buffer.from(luminance), Buffer.alloc(720*1280/2, 128)]);
  await writeFile(y4m, Buffer.concat([Buffer.from('YUV4MPEG2 W720 H1280 F10:1 Ip A1:1 C420jpeg\n'), ...Array(20).fill(frame)]));
  return y4m;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'platewatch-smoke-'));
  const server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' });
  const cleanup = () => server.kill('SIGTERM');
  process.on('exit', cleanup);

  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(ORIGIN)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }

  const executablePath = await findChrome();
  const pre = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
  const y4m = await makeFakeCamera(pre, dir);
  await pre.close();

  const browser = await puppeteer.launch({
    executablePath,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${y4m}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(ORIGIN, ['geolocation', 'camera']);
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setGeolocation(GPS);
  await page.emulateTimezone('Australia/Melbourne');

  const problems = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(t)) problems.push(`[console.${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.evaluateOnNewDocument(() => {
    // The fake camera has no zoom. Simulate a 1×–8× lens so the zoom controls are exercised;
    // the zoom actually applied is recorded on window.__zoom.
    const caps = MediaStreamTrack.prototype.getCapabilities;
    const apply = MediaStreamTrack.prototype.applyConstraints;
    window.__zoom = 1;
    MediaStreamTrack.prototype.getCapabilities = function () {
      return { ...caps.call(this), zoom: { min: 1, max: 8, step: 0.1 } };
    };
    MediaStreamTrack.prototype.applyConstraints = function (c) {
      const z = c?.advanced?.find((set) => 'zoom' in set)?.zoom;
      if (z !== undefined) {
        window.__zoom = z;
        return Promise.resolve();
      }
      return apply.call(this, c);
    };
  });
  await page.evaluateOnNewDocument(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    );
  });

  const shot = async (name) => {
    await import('node:fs').then((fs) => fs.mkdirSync(shots, { recursive: true }));
    await page.screenshot({ path: join(shots, `${String(step).padStart(2, '0')}-${name}.png`) });
  };
  const click = async (text) => {
    const el = await page.waitForSelector(`::-p-text(${text})`, { visible: true, timeout: 15000 });
    await el.click();
    await sleep(150);
  };
  const type = async (selector, value) => {
    await page.waitForSelector(selector, { visible: true });
    await page.click(selector, { count: 3 });
    await page.type(selector, value);
  };
  const waitText = (text, timeout = 30000) => page.waitForSelector(`::-p-text(${text})`, { visible: true, timeout });

  console.log('PlateWatch smoke test');
  await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
  await waitText('No lists yet');
  log('empty state shown when no list exists');
  await shot('empty');

  // Allow list
  await click('Create list');
  await click('Allow list');
  await type('#name', 'Zone 12 residents');
  await type('#allow-plate', 'RES001');
  await type('#allow-label', '12 Smith St');
  await click('Add to list');
  // A permit typed but not yet added must still be saved with the list.
  await type('#allow-plate', 'RES002');
  await type('#allow-label', '14 Smith St');
  await click('Save list');
  await waitText('Allowed plates (2)');
  log('allow list saved, including a permit typed but not yet added');

  // Hot list
  await page.goto(`${ORIGIN}/#/new/hot`);
  await type('#name', 'Officer safety');
  await click('Add high-risk vehicle');
  await type('#hot-plate', 'BAD999');
  await click('Aggressive');
  await click('Spitting');
  await click('Extreme risk');
  await type('#hot-make', 'Toyota');
  await page.select('#hot-body', 'Wagon');
  await page.select('#hot-colour', 'Blue');
  await click('Add vehicle');
  await click('Save list');
  await waitText('High-risk vehicles (1)');
  log('hot list saved (risks, make, type, colour)');

  // Timed list: in force at all times so the test is time-of-day independent.
  await page.goto(`${ORIGIN}/#/new/timed`);
  await type('#name', 'Smith St 2P');
  await type('#patrolZone', '9');
  await type('#patrolZoneName', 'South Melbourne Market');
  await type('#street', 'Smith Street');
  await type('#from', 'Johnston Street');
  await type('#to', 'Gertrude Street');
  for (const d of ['Sat', 'Sun']) await click(d);
  await click('Applies at all times on these days');
  await click('Zone 12 residents');
  await type('#parkingArea', '637');
  await page.click('#payStay');
  await click('Save list');
  await page.waitForFunction(() => document.body.innerText.includes('PayStay ParkingZone is required.'));
  // Port Phillip PayStay zone, a meter that serves it, and the restriction tied to it.
  await type('#payStayzone-0', '338851200001');
  await page.click('[data-testid=add-meter]');
  await type('#meter-0', 'GLP1');
  await page.click('[data-testid=meter-0-338851200001]');
  await page.click('[data-testid^=paid-][data-testid$="-338851200001"]');
  await waitText('paid with PayStay 338851200001');
  await shot('timed-form');
  await click('Save list');
  await waitText('Tracked vehicles (0)');
  await waitText('PayStay 338851200001 (meter GLP1)');
  log('timed list saved (segment, between streets, restriction paid with PayStay + meter, linked allow list)');
  const timedUrl = page.url();

  // Home: grouped by patrol zone, found by a bay kerb sign (parking area 637 + bay 58) and by PayStay number.
  await page.goto(`${ORIGIN}/#/`);
  await waitText('Patrol zone 9 · South Melbourne Market');
  await type('[data-testid=list-search]', '63758');
  await waitText('63758 = area 637 · bay 58');
  await page.$eval('[data-testid=list-search]', (el) => { el.value = ''; });
  await type('[data-testid=list-search]', '5120');
  await waitText('PayStay zone 338851200001');
  await shot('home-search');
  log('home: zone grouping, bay-sign and PayStay search');
  await page.goto(timedUrl);
  await waitText('Tracked vehicles (0)');

  // Scan 1
  await click('Scan number plate');
  await page.waitForSelector('[data-testid=shutter]:not([disabled])', { timeout: 20000 }).catch(async (e) => { await shot('debug-camera'); console.log(await page.evaluate(() => document.body.innerText)); console.log(problems.join('\n')); throw e; });
  await page.waitForFunction(() => document.body.innerText.includes('±'), { timeout: 15000 });
  await sleep(800);
  if (!(await page.$('[data-testid=diag-indicator]'))) throw new Error('diagnostics indicator missing on the camera');
  // One zoom button: each tap steps 1× → 1.75× → 3.5× → 5× → 1×.
  const zoomLabel = () => page.$eval('[data-testid=zoom-button]', (b) => b.textContent.trim());
  const steps = [await zoomLabel()];
  for (const expected of [1.75, 3.5, 5, 1, 1.75, 3.5]) {
    await page.click('[data-testid=zoom-button]');
    // The label updates once the camera has applied the zoom.
    await page.waitForFunction(
      (z) => window.__zoom === z && document.querySelector('[data-testid=zoom-button]')?.textContent.trim() === `${z}×`,
      { timeout: 5000 },
      expected,
    );
    steps.push(await zoomLabel());
  }
  if (steps.join(' ') !== '1× 1.75× 3.5× 5× 1× 1.75× 3.5×') throw new Error(`zoom steps were "${steps.join(' ')}"`);
  // Long-press opens the slider and must not also step the zoom.
  const box = await (await page.$('[data-testid=zoom-button]')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.up();
  await page.waitForSelector('[data-testid=zoom-slider]', { visible: true, timeout: 5000 });
  if ((await page.evaluate(() => window.__zoom)) !== 3.5) throw new Error('long-press changed the zoom');
  log('zoom button steps 1×/1.75×/3.5×/5× and wraps; long-press opens the slider; DIAG shown');
  await shot('camera');
  await page.click('[data-testid=shutter]');
  await page.waitForSelector('[data-testid=plate-input]', { visible: true, timeout: 90000 });
  const ocrValue = await page.$eval('[data-testid=plate-input]', (el) => el.value);
  if (ocrValue !== 'ABC123') throw new Error(`OCR read "${ocrValue}", expected ABC123`);
  log(`camera capture + on-device OCR read plate "${ocrValue}"`);
  const metaText = await page.evaluate(() => document.body.innerText);
  if (!metaText.includes('-37.813628') || !metaText.includes('Australia/Melbourne')) throw new Error('capture metadata missing');
  log('precise location (±4 m) and device date/time captured');
  await shot('confirm');
  await page.click('[data-testid=check]');
  await page.waitForSelector('[data-testid=result-recorded]', { timeout: 20000 });
  // Payment to check is the restriction's own PayStay zone with its meter.
  await waitText('Check payment before enforcing · 2P');
  await waitText('PayStay ParkingZone 338851200001 · Meter ID GLP1');
  log('first sighting → scan record created with time allowance; payment check for the restriction in force');
  await shot('recorded');

  // Scan 2 (within allowance)
  await page.click('[data-testid=next-scan]');
  await page.waitForSelector('[data-testid=shutter]:not([disabled])');
  await page.click('[data-testid=shutter]');
  await page.waitForSelector('[data-testid=plate-input]', { visible: true, timeout: 60000 });
  await page.click('[data-testid=check]');
  await page.waitForSelector('[data-testid=comparison]', { timeout: 20000 });
  const within = await page.$eval('[data-testid=comparison]', (el) => el.innerText);
  if (!/within allowance/i.test(within)) throw new Error('expected within-allowance comparison');
  log('re-scan → scan 1 vs scan 2 with elapsed time (within allowance)');
  await shot('within');

  // Time-shift: move the observation start back 2h05m to simulate an overstay.
  await page.evaluate(
    () =>
      new Promise((res, rej) => {
        const req = indexedDB.open('platewatch');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('observations', 'readwrite');
          const store = tx.objectStore('observations');
          store.getAll().onsuccess = (e) => {
            for (const o of e.target.result) {
              const shift = 125 * 60_000;
              store.put({ ...o, startedAt: o.startedAt - shift, allowanceEndsAt: o.allowanceEndsAt - shift });
            }
          };
          tx.oncomplete = () => res(undefined);
          tx.onerror = () => rej(tx.error);
        };
      }),
  );

  await page.click('[data-testid=next-scan]');
  await page.waitForSelector('[data-testid=shutter]:not([disabled])');
  await page.click('[data-testid=shutter]');
  await page.waitForSelector('[data-testid=plate-input]', { visible: true, timeout: 60000 });
  await page.click('[data-testid=check]');
  await page.waitForSelector('[data-testid=comparison]', { timeout: 20000 });
  const over = await page.$eval('[data-testid=comparison]', (el) => el.innerText);
  if (!/overstay/i.test(over)) throw new Error('expected overstay');
  const elapsed = await page.$eval('[data-testid=elapsed]', (el) => el.textContent);
  log(`overstay alert with both evidence images, elapsed ${elapsed}`);
  await shot('overstay');

  // Dismiss the offence alert after checking the vehicle: disability permit displayed. The scan is
  // kept with the reason, the vehicle is re-timed against twice the allowance (2h05m of 4P: not an
  // overstay), and the plate is tagged for later days.
  await page.click('[data-testid=dismiss-alert]');
  await page.waitForSelector('[data-testid=dismiss-sheet]', { visible: true });
  await shot('dismiss-sheet');
  await page.click('[data-testid=dismiss-disability_permit]');
  await page.waitForSelector('[data-testid=alert-dismissed]', { visible: true });
  await page.waitForSelector('[data-testid=dismiss-sheet]', { hidden: true });
  await waitText('Allowance doubled to 4h');
  await page.waitForSelector('[data-testid=comparison][data-tone=pending]');
  await page.waitForSelector('[data-testid=disability-doubled]');
  await shot('disability-doubled');
  const rescan = async (plate) => {
    await page.click('[data-testid=next-scan]');
    await page.waitForSelector('[data-testid=shutter]:not([disabled])');
    await page.click('[data-testid=shutter]');
    await page.waitForSelector('[data-testid=plate-input]', { visible: true, timeout: 60000 });
    if (plate) await type('[data-testid=plate-input]', plate);
    await page.click('[data-testid=check]');
  };
  // A later day (no eval: the production CSP forbids it): the tag was last confirmed in the past
  // and the dismissed timing has ended.
  const newDay = () => page.evaluate(() => new Promise((res, rej) => {
    const req = indexedDB.open('platewatch');
    req.onsuccess = () => {
      const tx = req.result.transaction(['flags', 'observations'], 'readwrite');
      const f = tx.objectStore('flags');
      f.getAll().onsuccess = (e) => { for (const x of e.target.result) f.put({ ...x, confirmedDay: '2000-01-01' }); };
      const o = tx.objectStore('observations');
      // Yesterday's restriction periods have ended (running and dismissed timings alike).
      o.getAll().onsuccess = (e) => { for (const x of e.target.result) if (x.status === 'dismissed' || x.status === 'active') o.put({ ...x, windowEndsAt: 1 }); };
      tx.oncomplete = () => res(undefined);
      tx.onerror = () => rej(tx.error);
    };
  }));
  // Same day: re-sighting timed against 4P, still within allowance.
  await rescan();
  await page.waitForSelector('[data-testid=comparison][data-tone=pending]', { timeout: 20000 });
  await page.waitForSelector('[data-testid=disability-doubled]');
  log('overstay dismissed for a disability permit: scan kept with reason; re-timed against 2 × allowance (within 4P)');

  await newDay();
  await rescan();
  await page.waitForSelector('[data-testid=flag-sheet]', { visible: true, timeout: 20000 });
  await waitText('Previous disability permit vehicle — check vehicle for displayed permit');
  await shot('flag-sheet');
  await page.click('[data-testid=flag-confirm]');
  // Disability confirmed: a new sighting timed against twice the allowance.
  await page.waitForSelector('[data-testid=result-recorded] [data-testid=disability-doubled]', { timeout: 20000 });
  // End that timing so the next scan is a new sighting again.
  await page.evaluate(() => new Promise((res) => {
    indexedDB.open('platewatch').onsuccess = (e) => {
      const tx = e.target.result.transaction('observations', 'readwrite');
      const o = tx.objectStore('observations');
      o.getAll().onsuccess = (ev) => { for (const x of ev.target.result) if (x.status === 'active') o.put({ ...x, status: 'reset' }); };
      tx.oncomplete = () => res(undefined);
    };
  }));
  await newDay();
  await rescan();
  await page.waitForSelector('[data-testid=flag-sheet]', { visible: true, timeout: 20000 });
  await page.click('[data-testid=flag-dismiss]');
  await page.waitForSelector('[data-testid=result-recorded]', { timeout: 20000 });
  const tags = await page.evaluate(() => new Promise((res) => { indexedDB.open('platewatch').onsuccess = (e) => { e.target.result.transaction('flags').objectStore('flags').count().onsuccess = (c) => res(c.target.result); }; }));
  if (tags !== 0) throw new Error('tag not removed after Dismiss');
  log('next day: known-vehicle check — Confirmed (timed against 2 ×, tag kept), then Dismiss (tag removed, timed as signed)');

  // Hot list alert while working the timed list (manual correction of OCR text).
  await page.click('[data-testid=next-scan]');
  await page.waitForSelector('[data-testid=shutter]:not([disabled])');
  await page.click('[data-testid=shutter]');
  await page.waitForSelector('[data-testid=plate-input]', { visible: true, timeout: 60000 });
  await type('[data-testid=plate-input]', 'BAD999');
  await page.click('[data-testid=check]');
  await page.waitForSelector('[data-testid=hot-alert]', { timeout: 20000 });
  const hotText = await page.$eval('[data-testid=hot-alert]', (el) => el.innerText);
  if (!/Extreme risk/i.test(hotText) || !/Blue Toyota/i.test(hotText) || !/Spitting/i.test(hotText)) throw new Error('hot alert details missing');
  // WF-S29: Next scan stays disabled until the officer acknowledges; needs an officer number.
  await page.waitForSelector('[data-testid=hot-ack-officer-required]', { visible: true });
  if (!(await page.$eval('[data-testid=next-scan]', (b) => b.disabled))) throw new Error('Next scan enabled before acknowledging');
  // Set the officer number (development build), scan the plate again and acknowledge.
  await page.goto(`${ORIGIN}/#/settings`);
  await type('[data-testid=officer-number]', '4471');
  await page.$eval('[data-testid=officer-number]', (el) => el.dispatchEvent(new Event('change')));
  await sleep(300);
  await page.goto(timedUrl.replace('#/list/', '#/scan/'));
  await page.waitForSelector('[data-testid=shutter]:not([disabled])', { timeout: 20000 });
  await page.click('[data-testid=shutter]');
  await page.waitForSelector('[data-testid=plate-input]', { visible: true, timeout: 60000 });
  await type('[data-testid=plate-input]', 'BAD999');
  await page.click('[data-testid=check]');
  await page.waitForSelector('[data-testid=hot-acknowledge]', { visible: true, timeout: 20000 });
  await page.click('[data-testid=hot-acknowledge]');
  await page.waitForSelector('[data-testid=hot-ack-queued]', { visible: true });
  await waitText('4471');
  await shot('hot-acknowledged');
  if (await page.$eval('[data-testid=next-scan]', (b) => b.disabled)) throw new Error('Next scan still disabled after acknowledging');
  log('hot-list match raises officer-safety alert; Next scan blocked until acknowledged (time, GPS, officer 4471; soft Code 1 queued)');
  await shot('hot-alert');

  // Permit holder on a linked allow list: recorded, green "Permit valid", and still valid when
  // scanned again (no allowance clock, so never an overstay). RES002 was saved without "Add".
  for (const plate of ['RES001', 'RES001', 'RES002']) {
    await page.click('[data-testid=next-scan]');
    await page.waitForSelector('[data-testid=shutter]:not([disabled])');
    await page.click('[data-testid=shutter]');
    await page.waitForSelector('[data-testid=plate-input]', { visible: true, timeout: 60000 });
    await type('[data-testid=plate-input]', plate);
    await page.click('[data-testid=check]');
    // The permit pop-up shows the permit details; the officer decides it exempts here.
    await page.waitForSelector('[data-testid=permit-sheet]', { visible: true, timeout: 20000 });
    await page.waitForSelector('[data-testid=permit-hit][data-status=ACTIVE_IN_AREA]');
    if (plate === 'RES002') await shot('permit-sheet');
    await page.click('[data-testid=permit-exempt]');
    await page.waitForSelector('[data-testid=result-exempt]', { timeout: 20000 });
    const permitText = await page.$eval('[data-testid=result-exempt]', (el) => el.textContent);
    const permitClass = await page.$eval('[data-testid=result-exempt]', (el) => el.className);
    if (!/Permit valid/.test(permitText) || !/Sighting recorded/.test(permitText)) throw new Error(`permit result for ${plate} was "${permitText}"`);
    if (!/border-active\b/.test(permitClass)) throw new Error('permit result is not green (CivicMAPS --status-active)');
    await waitText('Saved · SHA-256');
  }
  await shot('permit-valid');
  log('linked permit plate: permit pop-up (applies here) → Exempt here → green "Permit valid", recorded; again on re-scan');

  // Tagged vehicles (development build): an emergency dismissal tags the plate; the tag is removed
  // from Settings → Tagged vehicles (CommandMAPS dashboard once integrated).
  await page.evaluate(() => new Promise((res) => {
    indexedDB.open('platewatch').onsuccess = (e) => {
      const tx = e.target.result.transaction('flags', 'readwrite');
      tx.objectStore('flags').put({ key: 'EMR001', plate: 'EMR001', kind: 'emergency', createdAt: Date.now(), sourceScanId: 'x', confirmedDay: '2000-01-01' });
      tx.oncomplete = () => res(undefined);
    };
  }));
  await page.goto(`${ORIGIN}/#/settings`);
  await page.click('[data-testid=settings-tags]');
  await page.waitForSelector('[data-testid=tag-row]', { visible: true });
  await shot('tags');
  await page.click('[data-testid=tag-remove]');
  await page.waitForSelector('[data-testid=confirm-ok]', { visible: true });
  await page.click('[data-testid=confirm-ok]');
  await waitText('No tagged vehicles');
  log('tagged vehicles: listed and removed in the development build');

  // Evidence record: EXIF + integrity.
  await page.goto(timedUrl);
  await waitText('Recent scan records');
  await page.click('main ul li button');
  // Thumbnails load after the record renders; wait so the layout is stable before clicking.
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  // No sideways scroll on a phone (a pill row overflowing the card once did this).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (overflow > 0) throw new Error(`record page scrolls sideways by ${overflow}px`);
  await click('Verify image integrity');
  await waitText('Image hash matches');
  const recText = await page.evaluate(() => document.body.innerText);
  if (!/GPS -37\.81362\d, 144\.96305\d/.test(recText)) throw new Error('EXIF GPS not embedded/readable');
  if (!/DateTimeOriginal \d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2} \+1[01]:00/.test(recText)) throw new Error('EXIF DateTimeOriginal/offset missing');
  log('evidence JPEG: SHA-256 verified, EXIF GPS + DateTimeOriginal (+offset) embedded');
  await shot('record');

  // Bulk import: the timed-segments template and a CivicMAPS-preview kerbside file together.
  await page.goto(`${ORIGIN}/#/import`);
  await waitText('Choose files');
  const picker = await page.$('[data-testid=import-file]');
  await picker.uploadFile(
    join(root, 'templates', 'platewatch-timed-segments-template.csv'),
    join(root, 'tests', 'fixtures', 'civicmaps-preview', 'kerbside-chinatown-20055.json'),
  );
  await waitText('CivicMAPS kerbside segment');
  // Coventry St (S), Little Bourke St Bay 58–72 (in both files), Lonsdale St (N) and Little Bourke St Bay 72 – Elizabeth St.
  await waitText('4 timed lists created');
  await waitText('2 without restrictions yet');
  await shot('import-plan');
  await page.click('[data-testid=import-save]');
  await waitText('Imported: 4 list(s) created');
  await type('[data-testid=list-search]', '64558');
  await waitText('64558 = area 645 · bay 58');
  await page.$eval('[data-testid=list-search]', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
  await waitText('Restrictions to enter');
  log('bulk import: CSV template + CivicMAPS kerbside JSON → 4 timed lists, found by bay sign');

  // Imported lists are system lists (OQ26-5). In the development build they stay editable and
  // deletable here, with a SYSTEM tag; import is reachable from the Home header.
  await page.waitForSelector('[data-testid=header-import]', { visible: true });
  await type('[data-testid=list-search]', '64558');
  await waitText('64558 = area 645 · bay 58');
  await page.click('[data-testid=timed-row] button');
  await page.waitForSelector('[data-testid=system-tag]', { visible: true });
  await waitText('Imported from');
  await page.waitForSelector('[data-testid=edit-list]', { visible: true });
  await page.waitForSelector('[data-testid=delete-list]', { visible: true });
  await shot('system-list');
  await page.click('[data-testid=edit-list]');
  await page.waitForSelector('[data-testid=dev-override]', { visible: true });
  await waitText('Paid parking (optional)');
  await shot('system-list-edit');
  await page.goto(`${ORIGIN}/#/`);
  await page.waitForSelector('[data-testid=list-search]', { visible: true });
  log('imported list: SYSTEM tag and provenance; editable and deletable in the development build');

  // The kerbside release for City of Port Phillip Patrol Area 10: 55 segments, signs not yet surveyed.
  await page.goto(`${ORIGIN}/#/import`);
  await waitText('Choose files');
  await (await page.$('[data-testid=import-file]')).uploadFile(join(root, 'datasets', 'copp-patrol-area-10.release.json'));
  await waitText('civicmaps.kerbside_release');
  // Normanby Rd Boundary–Montague is already on the device from the template: 54 created, 1 updated.
  await waitText('54 timed lists created');
  await waitText('1 timed list updated');
  await page.click('[data-testid=import-save]');
  await waitText('Imported: 54 list(s) created, 1 updated');
  await waitText('Zone 10');
  log('civicmaps.kerbside_release import: Patrol Area 10 → 54 new placeholders + 1 matched by extent ID');

  // Text reader route renders.
  await page.goto(`${ORIGIN}/#/text`);
  await waitText('Convert image text into editable text');
  log('text reader available');

  // Field diagnostics recorded the camera, captures and confirmed records, and can be exported.
  await page.goto(`${ORIGIN}/#/settings`);
  await waitText('Field diagnostics');
  const diag = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('platewatch-diagnostics');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('events').objectStore('events').getAll();
          all.onsuccess = () => resolve(all.result.map((e) => e.kind));
          all.onerror = () => reject(all.error);
        };
      }),
  );
  for (const kind of ['camera_start', 'capture', 'record', 'sample'])
    if (!diag.includes(kind)) throw new Error(`diagnostics missing "${kind}" (have ${[...new Set(diag)].join(', ')})`);
  const exportButton = await page.$$eval('[data-testid=diagnostics] button', (bs) => bs.map((b) => [b.textContent.trim(), b.disabled]));
  if (!exportButton.some(([t, disabled]) => t.includes('Export diagnostics') && !disabled)) throw new Error('diagnostics export unavailable');
  log(`field diagnostics recorded (${diag.length} events: ${[...new Set(diag)].join(', ')}) and exportable`);
  await shot('settings-diagnostics');

  const cspIssues = problems.filter((p) => /Content Security Policy|CSP violation|Refused to/i.test(p));
  const otherErrors = problems.filter((p) => !cspIssues.includes(p));
  if (cspIssues.length) throw new Error(`CSP violations:\n${cspIssues.join('\n')}`);
  if (otherErrors.length) throw new Error(`Console errors:\n${otherErrors.join('\n')}`);
  log('no CSP violations or console errors');

  await browser.close();
  cleanup();
  console.log(`\nAll ${step} checks passed. Screenshots: ${shots}`);
}

main().catch((e) => {
  console.error('\n✗ Smoke test failed:', e.message);
  process.exit(1);
});
