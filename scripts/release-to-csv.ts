/**
 * Write a civicmaps.kerbside_release as one CSV per table, for councils to inspect.
 *
 *   npm run release:csv -- datasets/copp-patrol-area-10.release.json out/copp-patrol-area-10.csv
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseToCsv, validateRelease, type KerbsideRelease } from '../src/lib/kerbsideRelease.ts';

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('Usage: npm run release:csv -- <release.json> <output folder>');
  process.exit(2);
}
const release = JSON.parse(readFileSync(input, 'utf8')) as KerbsideRelease;
const errors = validateRelease(release);
if (errors.length) {
  for (const e of errors.slice(0, 20)) console.error(`✗ ${e.path}: ${e.message}`);
  console.error(`${errors.length} problem(s): not a valid civicmaps.kerbside_release.`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
for (const [table, csv] of Object.entries(releaseToCsv(release))) writeFileSync(join(outDir, `${table}.csv`), csv);
console.log(`Wrote ${Object.keys(releaseToCsv(release)).length} tables to ${outDir}`);
