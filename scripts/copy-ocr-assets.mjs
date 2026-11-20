#!/usr/bin/env node
/**
 * Copies the Tesseract OCR runtime (worker, LSTM-only WASM cores, English
 * traineddata) from node_modules into public/ocr so the app runs fully
 * offline, never touches a CDN, and stays compatible with a strict CSP.
 *
 * Output layout (served from /ocr/):
 *   ocr/worker.min.js
 *   ocr/core/tesseract-core-{lstm,simd-lstm,relaxedsimd-lstm}.wasm.js
 *   ocr/lang/eng.traineddata
 *
 * The model is stored decompressed on purpose: Android's asset packager (aapt)
 * silently strips ".gz" assets to their decompressed name, which would break a
 * gzip langPath inside the APK. One uncompressed file works for web and APK.
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'ocr');

const tesseractDir = dirname(require.resolve('tesseract.js/package.json'));
const coreDir = dirname(require.resolve('tesseract.js-core/package.json'));
const langDir = dirname(require.resolve('@tesseract.js-data/eng/package.json'));

const files = [
  [join(tesseractDir, 'dist', 'worker.min.js'), join(out, 'worker.min.js')],
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map(
    (f) => [join(coreDir, f), join(out, 'core', f)],
  ),
];

// best_int = integerised "best" LSTM model: high accuracy, compact.
const modelSrc = join(langDir, '4.0.0_best_int', 'eng.traineddata.gz');
const modelDest = join(out, 'lang', 'eng.traineddata');

async function sameFile(a, b) {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.size === sb.size && sb.mtimeMs >= sa.mtimeMs;
  } catch {
    return false;
  }
}

let copied = 0;
for (const [src, dest] of files) {
  await mkdir(dirname(dest), { recursive: true });
  if (await sameFile(src, dest)) continue;
  await copyFile(src, dest);
  copied += 1;
}

await mkdir(dirname(modelDest), { recursive: true });
await rm(join(out, 'lang', 'eng.traineddata.gz'), { force: true });
const modelStat = await stat(modelDest).catch(() => null);
if (!modelStat || modelStat.mtimeMs < (await stat(modelSrc)).mtimeMs) {
  await writeFile(modelDest, gunzipSync(await readFile(modelSrc)));
  copied += 1;
}

const tesseractVersion = require('tesseract.js/package.json').version;
const coreVersion = require('tesseract.js-core/package.json').version;
await writeFile(
  join(out, 'VERSION.json'),
  JSON.stringify({ tesseract: tesseractVersion, core: coreVersion, lang: 'eng 4.0.0_best_int' }, null, 2) + '\n',
);

console.log(`[ocr:assets] ${copied} file(s) copied → public/ocr (tesseract.js ${tesseractVersion}, core ${coreVersion})`);
