#!/usr/bin/env node
/**
 * Renders the app icon (public/icons/icon.svg) to the PNG sizes required by
 * the PWA manifest and the Android launcher, using a local Chrome/Chromium.
 *   CHROME_PATH=/path/to/chrome npm run icons
 */
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'public', 'icons');

const svg = (opts = {}) => {
  const { maskable = false, background = true } = opts;
  // Maskable/adaptive icons keep content inside the central 66% safe zone.
  const s = maskable ? 0.62 : 0.8;
  const o = (1 - s) / 2;
  const T = (v) => (o + v * s) * 512;
  const L = (v) => v * s * 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${background ? `<rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="#1B2A4A"/>` : ''}
  <g fill="none" stroke="#D4A843" stroke-width="${L(0.055)}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M${T(0.08)} ${T(0.3)} V${T(0.12)} H${T(0.26)}"/>
    <path d="M${T(0.74)} ${T(0.12)} H${T(0.92)} V${T(0.3)}"/>
    <path d="M${T(0.92)} ${T(0.7)} V${T(0.88)} H${T(0.74)}"/>
    <path d="M${T(0.26)} ${T(0.88)} H${T(0.08)} V${T(0.7)}"/>
  </g>
  <rect x="${T(0.16)}" y="${T(0.34)}" width="${L(0.68)}" height="${L(0.32)}" rx="${L(0.05)}" fill="#ffffff" stroke="#111827" stroke-width="${L(0.018)}"/>
  <text x="${T(0.5)}" y="${T(0.565)}" text-anchor="middle" font-family="JetBrains Mono, DejaVu Sans Mono, monospace" font-weight="700" font-size="${L(0.17)}" fill="#111827" letter-spacing="${L(0.01)}">ABC123</text>
</svg>`;
};

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch {
      /* next */
    }
  }
  throw new Error('Chrome/Chromium not found. Set CHROME_PATH.');
}

async function render(page, markup, size) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

await mkdir(iconsDir, { recursive: true });
await writeFile(join(iconsDir, 'icon.svg'), svg());

const browser = await puppeteer.launch({ executablePath: await findChrome(), args: ['--no-sandbox'] });
const page = await browser.newPage();
const outputs = [
  ['icon-192.png', svg(), 192],
  ['icon-512.png', svg(), 512],
  ['maskable-512.png', svg({ maskable: true }), 512],
];
for (const [name, markup, size] of outputs) await writeFile(join(iconsDir, name), await render(page, markup, size));

// Android launcher icons (only if the Capacitor project exists).
const res = join(root, 'android', 'app', 'src', 'main', 'res');
try {
  await access(res);
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(densities)) {
    const dir = join(res, `mipmap-${d}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'ic_launcher.png'), await render(page, svg(), Math.round(48 * k)));
    await writeFile(join(dir, 'ic_launcher_round.png'), await render(page, svg(), Math.round(48 * k)));
    await writeFile(
      join(dir, 'ic_launcher_foreground.png'),
      await render(page, svg({ maskable: true, background: false }), Math.round(108 * k)),
    );
  }
  const bg = join(res, 'values', 'ic_launcher_background.xml');
  try {
    const xml = await readFile(bg, 'utf8');
    await writeFile(bg, xml.replace(/<color name="ic_launcher_background">[^<]*<\/color>/, '<color name="ic_launcher_background">#1B2A4A</color>'));
  } catch {
    /* template without background colour resource */
  }
  console.log('[icons] Android launcher icons updated');
} catch {
  /* no android project yet */
}

await browser.close();
console.log('[icons] PWA icons written to public/icons');
