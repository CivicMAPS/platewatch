#!/usr/bin/env node
/**
 * End-to-end test of the whole life cycle against the real backend and PostgreSQL, in headless
 * Chrome: the handset app and the CommandMAPS console side by side, served by the backend itself
 * (one origin, production CSP).
 *
 *   npm run build && npm run server:build
 *   PLATEWATCH_TEST_DATABASE_URL=postgres://… npm run smoke:backend   (CHROME_PATH overrides browser)
 *
 * Flow: register the device key (pending) → supervisor approves it in the console → import the
 * field-test pack → 702 with no payment → issue through the four-step wizard (I-N signed on the
 * device) → server accepts → console shows 702 / internal no_payment with the evidence image →
 * void requested on the device → supervisor approves → device shows Voided → second 702 → reissue
 * (no approval; original voided) → hot-list sighting acknowledged → amber banner in the console,
 * dispatch and coordinator acknowledge → device sees both → paid session from the test provider
 * looked up on the device → no offence.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp as mkdtempP, writeFile as writeFileP, access as accessP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.PLATEWATCH_TEST_DATABASE_URL;
if (!DB) {
  console.error('PLATEWATCH_TEST_DATABASE_URL is required (docs/BACKEND.md, Testing).');
  process.exit(1);
}
const PORT = 4189;
const ORIGIN = `http://localhost:${PORT}`;
const DEVICE_TOKEN = randomBytes(24).toString('base64url');
const CONSOLE_TOKEN = randomBytes(24).toString('base64url');
const GPS = { latitude: -37.8327, longitude: 144.9537, accuracy: 4 };
const shots = process.env.SMOKE_SCREENSHOTS ?? join(root, 'smoke-screenshots', 'backend');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const log = (msg) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${msg}`);

async function findChrome() {
  for (const c of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try {
      await accessP(c);
      return c;
    } catch {
      /* next */
    }
  }
  throw new Error('Chrome not found (set CHROME_PATH)');
}

/** A Y4M fake camera showing a white plate (the plate is typed on the confirm screen). */
async function fakeCamera(dir) {
  const w = 720, hgt = 1280;
  const y = Buffer.alloc(w * hgt, 60);
  for (let r = 560; r < 720; r++) y.fill(235, r * w + 140, r * w + 580);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, Buffer.alloc((w * hgt) / 2, 128)]);
  const file = join(dir, 'cam.y4m');
  await writeFileP(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${hgt} F10:1 Ip A1:1 C420jpeg\n`), ...Array(10).fill(frame)]));
  return file;
}

/** Console API as a roster member (S1 team supervisor A, S2 team supervisor B, D1 dispatch, CL1 compliance lead). */
async function consoleApi(method, path, staffId, body) {
  const res = await fetch(ORIGIN + path, { method, headers: { Authorization: `Bearer ${CONSOLE_TOKEN}`, ...(staffId ? { 'X-Staff-Id': staffId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
}

async function until(what, fn, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

async function main() {
  const dir = await mkdtempP(join(tmpdir(), 'platewatch-backend-smoke-'));
  const server = spawn(process.execPath, [join(root, 'dist-server', 'server.mjs')], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: DB, PLATEWATCH_DEVICE_TOKEN: DEVICE_TOKEN, PLATEWATCH_CONSOLE_TOKEN: CONSOLE_TOKEN, PORT: String(PORT), PLATEWATCH_COUNCIL: 'com', PLATEWATCH_HOT_ACK_SECONDS: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  process.on('exit', () => server.kill('SIGTERM'));
  await until('the backend', async () => (await fetch(`${ORIGIN}/api/health`)).ok, 20000).catch((e) => {
    console.error(serverLog);
    throw e;
  });

  // Roster: the first manager bootstraps with the console token; then the rest; shifts for today.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const roster = [
    { id: 'S1', name: 'Sgt Lee', role: 'team_supervisor', team: 'A' },
    { id: 'S2', name: 'Sgt Ng', role: 'team_supervisor', team: 'B' },
    { id: 'D1', name: 'Dispatcher Kim', role: 'dispatch' },
    { id: 'CL1', name: 'Compliance Lead Rao', role: 'compliance_lead' },
    { id: 'O4471', name: 'Officer Patel', role: 'officer', officerNumber: '4471', team: 'A' },
    { id: 'O5123', name: 'Officer Chen', role: 'officer', officerNumber: '5123', team: 'B' },
  ];
  for (const [i, st] of roster.entries()) await consoleApi('POST', '/api/console/staff', i ? 'S1' : null, st);
  for (const id of ['S1', 'S2', 'D1']) await consoleApi('POST', `/api/console/staff/${id}/shift`, 'S1', { day, on: true });

  const executablePath = await findChrome();
  const browser = await puppeteer.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${await fakeCamera(dir)}`, '--autoplay-policy=no-user-gesture-required'],
  });
  await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['geolocation', 'camera']);
  const problems = [];
  const watch = (p, name) => {
    p.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(t)) problems.push(`[${name} console.${m.type()}] ${t}`);
    });
    p.on('pageerror', (e) => problems.push(`[${name} pageerror] ${e.message}`));
  };
  const app = await browser.newPage();
  await app.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await app.setGeolocation(GPS);
  await app.emulateTimezone('Australia/Melbourne');
  watch(app, 'app');
  const cons = await browser.newPage();
  await cons.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
  await cons.emulateTimezone('Australia/Melbourne');
  watch(cons, 'console');
  for (const p of [app, cons]) await p.evaluateOnNewDocument(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  // The wizard asks before consuming a number on Cancel.
  app.on('dialog', (d) => void d.accept());

  mkdirSync(shots, { recursive: true });
  const shot = (p, name) => p.screenshot({ path: join(shots, `${String(step).padStart(2, '0')}-${name}.png`) });
  const trace = (...a) => process.env.SMOKE_TRACE && console.log('    ·', ...a);
  // Headless Chrome stalls pages that are not in front: front the page before driving it.
  let front = null;
  const focus = async (p) => {
    if (front !== p) {
      await p.bringToFront();
      front = p;
    }
  };
  const type = async (p, sel, value) => {
    trace('type', sel);
    await focus(p);
    await p.waitForSelector(sel, { visible: true });
    await p.click(sel, { count: 3 });
    await p.type(sel, value);
  };
  const change = async (p, sel, value) => (trace('change', sel), await focus(p), p.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value));
  const text = async (p, t, timeout = 30000) => (await focus(p), p.waitForSelector(`::-p-text(${t})`, { visible: true, timeout }));
  const tap = async (p, sel) => {
    trace('tap', sel);
    await focus(p);
    await p.waitForSelector(sel, { visible: true, timeout: 30000 });
    await p.click(sel);
    await sleep(120);
  };
  /** Console pages redraw every few seconds: find and click in one step, retrying. */
  const clickText = async (p, t, tags = 'button') => {
    trace('clickText', t);
    await focus(p);
    await until(`"${t}" in the console`, () => p.evaluate((txt, sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === txt) ?? [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(txt));
      if (!el || el.disabled) return false;
      el.click();
      return true;
    }, t, tags), 20000);
    await sleep(300);
  };
  const consoleLogin = async (p, staffId) => {
    p.on('dialog', (d) => void d.accept(d.type() === 'prompt' ? (/Outcome/.test(d.message()) ? 'Units attended, officer safe' : 'Officer answered') : undefined));
    await p.goto(`${ORIGIN}/console/`);
    await type(p, 'input[type=password]', CONSOLE_TOKEN);
    await p.click('button[type=submit]');
    await p.waitForSelector('select', { visible: true });
    await p.select('select', staffId);
    await p.click('button[type=submit]');
    await p.waitForSelector('nav.tabs', { visible: true });
  };
  const deviceSync = async () => {
    await app.goto(`${ORIGIN}/#/settings`);
    await tap(app, '[data-testid=backend-sync]');
    await until('device outbox to drain', async () => (await app.$eval('[data-testid=backend-pending]', (e) => e.textContent?.trim())) === '0' && !(await app.$('[data-testid=backend-error]')));
  };

  console.log('PlateWatch backend smoke test');

  // 1. Device: officer number, backend URL and token; the key registers as pending.
  await app.goto(ORIGIN, { waitUntil: 'networkidle0' });
  await app.goto(`${ORIGIN}/#/settings`);
  await type(app, '[data-testid=officer-number]', '4471');
  await app.$eval('[data-testid=officer-number]', (el) => el.dispatchEvent(new Event('change')));
  await change(app, '[data-testid=backend-url]', ORIGIN);
  await change(app, '[data-testid=backend-token]', DEVICE_TOKEN);
  await tap(app, '[data-testid=backend-test]');
  await app.waitForSelector('[data-testid=backend-test-result]', { visible: true });
  if (!/pending/.test(await app.$eval('[data-testid=backend-test-result]', (e) => e.textContent))) throw new Error('device key should be pending');
  await text(app, 'Device key awaiting approval');
  await shot(app, 'device-pending');
  log('device signing key registered with the backend: awaiting approval');

  // 2. Console: supervisor approves the key.
  await consoleLogin(cons, 'S1');
  await clickText(cons, 'Devices');
  await clickText(cons, 'Approve');
  await text(cons, 'Approved');
  await shot(cons, 'console-device-approved');
  await deviceSync();
  await text(app, 'Approved');
  log('supervisor approved the key in the console; the device sees Approved');

  // 3. Field-test pack: timed lists and the hot list.
  await app.goto(`${ORIGIN}/#/import`);
  await text(app, 'Choose files');
  await (await app.$('[data-testid=import-file]')).uploadFile(join(root, 'datasets/field-test/01-timed-segments.csv'), join(root, 'datasets/field-test/03-hot-list.csv'));
  await app.waitForSelector('[data-testid=import-save]', { visible: true });
  await app.click('[data-testid=import-save]');
  await text(app, 'Imported');
  log('field-test pack imported (9 timed lists, hot list)');

  const scanOn = async (listPrefix, plate) => {
    await app.goto(`${ORIGIN}/#/`);
    await type(app, '[data-testid=list-search]', listPrefix.split(' ').slice(1, 3).join(' '));
    await tap(app, `[aria-label^="Scan ${listPrefix}"]`);
    await app.waitForSelector('[data-testid=shutter]:not([disabled])', { timeout: 30000 });
    // Emulated GPS reports once and then goes quiet; a phone keeps reporting. Re-emit, so the
    // capture has a fix no older than 15 s (the app never uses a stale fix as evidence).
    await app.setGeolocation(GPS);
    await app.waitForSelector('[data-gps=good]', { timeout: 30000 });
    await app.click('[data-testid=shutter]');
    await app.waitForSelector('[data-testid=plate-input]', { visible: true, timeout: 60000 });
    await type(app, '[data-testid=plate-input]', plate);
    await app.click('[data-testid=check]');
  };
  const handoffAndWizard = async (plate) => {
    await tap(app, '[data-testid=issue-infringement]');
    await app.waitForSelector('[data-testid=handoff-sheet]', { visible: true });
    await app.select('#handoff-registrationType', 'private');
    await type(app, '#handoff-make', 'Holden');
    await app.select('#handoff-bodyType', 'hatchback');
    await app.select('#handoff-colour', 'White');
    await type(app, '[data-testid=handoff-plate-again]', plate);
    await app.waitForSelector('[data-testid=handoff-plate-match]', { visible: true });
    await tap(app, '[data-testid=handoff-start]');
    await app.waitForSelector('[data-testid=infringement-wizard]', { visible: true });
  };
  const wizardIssue = async (name) => {
    await shot(app, `${name}-step1`);
    await tap(app, '[data-testid=wiz-next]');
    await tap(app, '[data-testid=wiz-override]');
    await type(app, '[data-testid=wiz-override-reason]', 'Driver returned and left after the first photo');
    await tap(app, '[data-testid=wiz-next]');
    await app.waitForSelector('[data-testid=wiz-time-from]', { visible: true });
    await shot(app, `${name}-step3`);
    await tap(app, '[data-testid=wiz-next]');
    await app.waitForSelector('[data-testid=wiz-review]', { visible: true });
    if (!(await app.$eval('[data-testid=wiz-issue]', (b) => b.disabled))) throw new Error('Issue enabled before the confirmation');
    await tap(app, '[data-testid=wiz-confirm]');
    await shot(app, `${name}-review`);
    const number = (await app.$eval('[data-testid=wiz-number]', (e) => e.textContent)).replace(/\s/g, '');
    await tap(app, '[data-testid=wiz-issue]');
    await app.waitForSelector('[data-testid=pin-issued]', { visible: true });
    return number;
  };

  // 4. 702 with no payment at the first scan → issue through the wizard.
  await scanOn('FT Buckhurst St S P5', 'PWT702');
  await app.waitForSelector('[data-testid=payment-check-form]', { visible: true, timeout: 20000 });
  await tap(app, '[data-testid=pay-not-found]');
  await tap(app, '::-p-text(PayStay 338800002001)');
  await tap(app, '[data-testid=pay-save]');
  await app.waitForSelector('[data-testid=offence-offer][data-code="702"]', { visible: true });
  const chip = await app.$eval('[data-testid=offence-chip]', (e) => e.textContent);
  if (chip !== '702 · No valid payment' || /702e/i.test(await app.evaluate(() => document.body.innerText))) throw new Error(`officer must only see 702: ${chip}`);
  await shot(app, '702-offer');
  await handoffAndWizard('PWT702');
  const n1 = await wizardIssue('wizard');
  if (!/^\d{20}$/.test(n1) || !n1.startsWith('04471')) throw new Error(`unexpected I-N ${n1}`);
  await shot(app, '702-pin-issued');
  log(`702 (no valid payment) issued through the four-step wizard: I-N ${n1} allocated and signed on the device`);

  // 5. The server verified and accepted it; console shows 702 / internal no_payment with evidence.
  const i1 = await until('server to accept the infringement', async () => {
    const d = await consoleApi('GET', `/api/console/infringements/${n1}`, 'S1');
    return d.infringement.status === 'issued' && d.evidence.every((e) => e.uploaded) ? d : null;
  });
  if (i1.infringement.offenceCode !== '702' || i1.infringement.internalVariant !== 'no_payment' || i1.infringement.variantSource !== 'derived') throw new Error(`server record ${JSON.stringify(i1.infringement)}`);
  if (i1.statements.map((s) => s.type).join() !== 'allocation,issue') throw new Error('statements missing');
  await clickText(cons, 'Infringements');
  await clickText(cons, `${n1.slice(0, 5)} ${n1.slice(5, 11)} ${n1.slice(11, 14)} ${n1.slice(14, 18)} ${n1.slice(18)}`, 'td');
  await text(cons, 'No valid payment');
  await focus(cons);
  await cons.waitForFunction(() => [...document.querySelectorAll('.thumbs img')].some((i) => i.complete && i.naturalWidth > 0), { timeout: 20000 });
  await shot(cons, 'console-infringement');
  log('backend verified the signed statements; console shows 702 · internal no_payment (derived) with the evidence image');

  // 6. Void without reissue: requested on the device, approved by the supervisor.
  await app.goto(`${ORIGIN}/#/record/${i1.infringement.scanId}`);
  await tap(app, '[data-testid=record-void]');
  await app.select('[data-testid=record-lifecycle-reason]', 'permit_displayed');
  await type(app, '[data-testid=record-lifecycle-note]', 'RPA permit found on the dashboard');
  await tap(app, '[data-testid=record-lifecycle-go]');
  await text(app, 'Void requested');
  await until('void request at the server', async () => (await consoleApi('GET', `/api/console/infringements/${n1}`, 'S1')).infringement.status === 'void_requested');
  await cons.reload();
  await cons.waitForSelector('nav.tabs', { visible: true });
  await clickText(cons, 'Infringements');
  await clickText(cons, `${n1.slice(0, 5)} ${n1.slice(5, 11)} ${n1.slice(11, 14)} ${n1.slice(14, 18)} ${n1.slice(18)}`, 'td');
  await clickText(cons, 'Approve void');
  await until('void approved', async () => (await consoleApi('GET', `/api/console/infringements/${n1}`, 'S1')).infringement.status === 'voided');
  await deviceSync();
  await app.goto(`${ORIGIN}/#/record/${i1.infringement.scanId}`);
  await app.waitForSelector('[data-testid=record-infringement][data-status=voided]', { visible: true });
  await text(app, 'approved');
  await shot(app, 'record-voided');
  log('void without reissue: requested on the device → approved by the supervisor → device shows Voided');

  // 7. Second 702, then void + reissue (no approval).
  await scanOn('FT Buckhurst St S P5', 'PWT703');
  await app.waitForSelector('[data-testid=payment-check-form]', { visible: true, timeout: 20000 });
  await tap(app, '[data-testid=pay-not-found]');
  await tap(app, '::-p-text(PayStay 338800002001)');
  await tap(app, '[data-testid=pay-save]');
  await handoffAndWizard('PWT703');
  const n2 = await wizardIssue('wizard2');
  const i2 = await until('second infringement accepted', async () => {
    const d = await consoleApi('GET', `/api/console/infringements/${n2}`, 'S1');
    return d.infringement.status === 'issued' ? d : null;
  });
  await app.goto(`${ORIGIN}/#/record/${i2.infringement.scanId}`);
  await tap(app, '[data-testid=record-reissue]');
  await app.select('[data-testid=record-lifecycle-reason]', 'incorrect_vehicle_details');
  await tap(app, '[data-testid=record-lifecycle-go]');
  await app.waitForSelector('[data-testid=infringement-wizard]', { visible: true });
  await change(app, '[data-testid=wiz-colour]', 'Silver');
  await tap(app, '[data-testid=wiz-next]');
  await tap(app, '[data-testid=wiz-next]');
  await tap(app, '[data-testid=wiz-next]');
  await tap(app, '[data-testid=wiz-confirm]');
  const n3 = (await app.$eval('[data-testid=wiz-number]', (e) => e.textContent)).replace(/\s/g, '');
  await tap(app, '[data-testid=wiz-issue]');
  await until('reissue accepted and original voided', async () => {
    const o = await consoleApi('GET', `/api/console/infringements/${n2}`, 'S1');
    const r = await consoleApi('GET', `/api/console/infringements/${n3}`, 'S1');
    return o.infringement.status === 'voided' && o.infringement.reissuedBy === n3 && r.infringement.status === 'issued' && r.infringement.vehicle.colour === 'Silver';
  });
  await app.goto(`${ORIGIN}/#/record/${i2.infringement.scanId}`);
  await text(app, 'Earlier numbers on this sighting');
  await shot(app, 'record-reissued');
  log(`void + reissue without approval: ${n3} replaces ${n2}, which the backend voided`);

  // 8a. Hot-list hit → blocking pop-up → SAFE & CLEAR with a note → logged for every officer.
  await scanOn('FT Munro St P10', 'PWH801');
  await app.waitForSelector('[data-testid=hot-popup]', { visible: true, timeout: 20000 });
  await text(app, 'Do not approach');
  await tap(app, '[data-testid=hot-more]');
  await text(app, 'FIELD TEST: male, 30s, shaved head');
  await shot(app, 'hot-popup');
  await type(app, '[data-testid=hot-note]', 'Driver sat in the car, I left the segment');
  await tap(app, '[data-testid=hot-safe-clear]');
  await app.waitForSelector('[data-testid=hot-acked][data-response=safe_clear]', { visible: true, timeout: 20000 });
  await until('hit and answer at the server', async () => {
    const h = (await consoleApi('GET', '/api/console/hits', 'D1')).hits.find((x) => x.plate === 'PWH801' && x.response === 'safe_clear');
    return h?.note === 'Driver sat in the car, I left the segment' && h.officerNumber === '4471';
  });
  log('hot-list hit: blocking pop-up with alert message and owner description → SAFE & CLEAR with a note → logged at the server with officer and location');

  // 8b. A second officer (team B) on another handset, to receive a branch Code 1.
  const ctx2 = await browser.createBrowserContext();
  await ctx2.overridePermissions(ORIGIN, ['geolocation', 'camera']);
  const field2 = await ctx2.newPage();
  await field2.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await field2.setGeolocation({ latitude: -37.8330, longitude: 144.9540, accuracy: 6 });
  watch(field2, 'officer-5123');
  await field2.goto(`${ORIGIN}/#/settings`, { waitUntil: 'networkidle0' });
  await type(field2, '[data-testid=officer-number]', '5123');
  await field2.$eval('[data-testid=officer-number]', (el) => el.dispatchEvent(new Event('change')));
  await change(field2, '[data-testid=backend-url]', ORIGIN);
  await change(field2, '[data-testid=backend-token]', DEVICE_TOKEN);

  // 8c. No answer: the handset raises the soft Code 1 at the deadline (10 s in this test).
  await scanOn('FT Munro St P10', 'PWH801');
  await app.waitForSelector('[data-testid=hot-popup]', { visible: true, timeout: 20000 });
  await focus(app);
  await app.waitForSelector('[data-testid=hot-soft-status][data-status=sent]', { timeout: 30000 }).catch(async (e) => {
    console.error('soft Code 1 state:', await app.$eval('[data-testid=hot-soft-status]', (el) => `${el.dataset.status}: ${el.textContent}`).catch(() => 'no pop-up'), problems.join('\n'));
    throw e;
  });
  await shot(app, 'hot-popup-soft-code1-sent');
  const disp = await browser.newPage();
  await disp.setViewport({ width: 1366, height: 900 });
  watch(disp, 'dispatch');
  await consoleLogin(disp, 'D1');
  await disp.waitForSelector('.hot-banner[data-kind=soft_code1]', { visible: true, timeout: 20000 });
  const soft = (await consoleApi('GET', '/api/console/alerts', 'D1')).alerts.find((x) => x.kind === 'soft_code1' && x.status === 'active');
  if (soft.recipients.staffIds.join() !== 'S1' || soft.recipients.fallback) throw new Error(`soft Code 1 should go to dispatch + team A supervisor S1: ${JSON.stringify(soft.recipients)}`);
  if ((await consoleApi('GET', '/api/console/alerts', 'S2')).alerts.find((x) => x.id === soft.id).forMe) throw new Error('team B supervisor should not get the banner');
  await shot(disp, 'console-soft-code1');
  log('no answer in time: handset raised the soft Code 1 → amber banner for dispatch and the team A supervisor on shift only');

  // 8d. Dispatch requests a radio response; none → Code 1 for the whole branch.
  await clickText(disp, 'ACKNOWLEDGE — REQUEST RADIO');
  await disp.waitForSelector('.hot-banner[data-status=radio_requested]', { visible: true, timeout: 10000 });
  await clickText(disp, 'NO RESPONSE — CODE 1');
  await disp.waitForSelector('.hot-banner[data-kind=code1]', { visible: true, timeout: 10000 });
  await shot(disp, 'console-code1');
  await focus(field2);
  await field2.waitForSelector('[data-testid=code1-alarm]', { visible: true, timeout: 20000 });
  await text(field2, 'Officer Patel');
  await shot(field2, 'branch-code1-alarm');
  // The location pin: the officer's handset shares its location every 10 s while the Code 1 is open.
  await focus(app); // geolocation runs only in the foreground page (as on a phone: see docs/BACKEND.md)
  const pinned = await until('Code 1 location pin', async () => {
    await app.setGeolocation(GPS);
    const a = (await consoleApi('GET', '/api/console/alerts', 'D1')).alerts.find((x) => x.kind === 'code1');
    return a?.location ? a : null;
  }, 40000);
  if (Math.abs(pinned.location.lat - GPS.latitude) > 0.001) throw new Error(`unexpected pin ${JSON.stringify(pinned.location)}`);
  await focus(field2);
  await field2.waitForSelector('[data-testid=code1-alarm] a', { visible: true, timeout: 15000 });
  await shot(field2, 'branch-code1-alarm-pin');
  await tap(field2, '[data-testid=code1-received]');
  await field2.waitForSelector('[data-testid=code1-branch-banner]', { visible: true, timeout: 10000 });
  await focus(app);
  await app.waitForSelector('[data-testid=hot-soft-status][data-status=code1]', { timeout: 20000 });
  log('dispatch requested a radio response; none → Code 1: alarm with location on officer 5123 (team B) → received; officer 4471 told help is coming');

  // 8e. The officer answers late; Code 1 acknowledged by dispatch and cleared with an outcome.
  await tap(app, '[data-testid=hot-safe-clear]');
  await app.waitForSelector('[data-testid=code1-own-escalated]', { visible: true, timeout: 10000 });
  await shot(app, 'own-code1-banner');
  await clickText(disp, 'ACKNOWLEDGE');
  await until('Code 1 acknowledged', async () => (await consoleApi('GET', '/api/console/alerts', 'D1')).alerts.some((x) => x.kind === 'code1' && x.status === 'acknowledged'));
  await clickText(cons, 'Live');
  await clickText(cons, 'CLEAR');
  const c1 = await until('Code 1 cleared', async () => (await consoleApi('GET', '/api/console/alerts?scope=all', 'D1')).alerts.find((x) => x.kind === 'code1' && x.status === 'cleared'));
  if (c1.outcome !== 'Units attended, officer safe') throw new Error(`outcome ${c1.outcome}`);
  await focus(field2);
  await field2.waitForFunction(() => !document.querySelector('[data-testid=code1-branch-banner]'), { timeout: 20000 });
  await focus(app);
  await app.waitForFunction(() => !document.querySelector('[data-testid=code1-own-escalated]'), { timeout: 20000 });
  const detail = await consoleApi('GET', `/api/console/alerts/${c1.id}`, 'CL1');
  const actions = detail.events.map((e) => e.action);
  for (const want of ['code1_raised', 'alarm_received', 'code1_acknowledged', 'code1_cleared']) if (!actions.includes(want)) throw new Error(`Code 1 life cycle missing ${want}: ${actions}`);
  if (!detail.receipts.some((r) => r.officerNumber === '5123')) throw new Error('receipt by officer 5123 not recorded');
  await clickText(cons, 'Roster');
  await text(cons, 'Officer Chen');
  await shot(cons, 'console-roster');
  log('officer answered late; Code 1 acknowledged by dispatch, cleared by the supervisor with an outcome; both handsets updated');

  // 9. Paid session from the test provider: looked up on the device, saved, no offence.
  const now = Date.now();
  await consoleApi('POST', '/api/console/paid-sessions', 'D1', { plate: 'PWT704', source: 'easypark', sourceRef: '7001', paidFrom: now - 600_000, paidTo: now + 3_600_000 });
  await scanOn('FT Buckhurst St N 1P', 'PWT704');
  await app.waitForSelector('[data-testid=payment-check-form]', { visible: true, timeout: 20000 });
  await tap(app, '[data-testid=pay-lookup]');
  await app.waitForFunction(() => document.querySelector('[data-testid=pay-found]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-testid=pay-to]')?.value, { timeout: 10000 });
  await tap(app, '[data-testid=pay-save]');
  await app.waitForSelector('[data-testid=payment-saved]', { visible: true });
  if (await app.$('[data-testid=offence-offer]')) throw new Error('no offence expected with a current paid session');
  await shot(app, 'paid-session-lookup');
  log('test payment provider: paid session found by lookup, saved by the officer, no offence');

  // 10. Analytics: 702 split by the derived internal classification.
  const a = await consoleApi('GET', '/api/console/analytics/offences', 'S1');
  if (!a.byCode.some((x) => x.offence_code === '702' && x.variant === 'no_payment')) throw new Error('analytics missing the 702 split');
  await clickText(cons, '701 / 702');
  await text(cons, 'Offences issued');
  await shot(cons, 'console-analytics');
  log('702 analytics split by the derived internal classification');

  if (problems.length) throw new Error(`console errors / CSP violations:\n${problems.join('\n')}`);
  log('no CSP violations or console errors in the app or the console');
  await browser.close();
  server.kill('SIGTERM');
  console.log(`Backend smoke test passed (${step} checks). Screenshots: ${shots}`);
}

main().catch((e) => {
  console.error(`✗ ${e.stack ?? e}`);
  process.exit(1);
});
