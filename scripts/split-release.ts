/**
 * Split a release into one release per patrol zone (e.g. City of Port Phillip zones 9 and 9A),
 * so a device can load only the zone it patrols. Extents without a patrol zone are listed, not
 * guessed into a zone.
 *
 *   npm run release:split -- <release.json> <output folder> [file prefix]
 *   → <folder>/<prefix>-patrol-area-9.release.json, <prefix>-patrol-area-9a.release.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitByZone, validateRelease, type KerbsideRelease } from '../src/lib/kerbsideRelease.ts';

const [input, folder, prefixArg] = process.argv.slice(2);
if (!input || !folder) {
  console.error('Usage: npm run release:split -- <release.json> <output folder> [file prefix]');
  process.exit(2);
}
const release = JSON.parse(readFileSync(input, 'utf8')) as KerbsideRelease;
const problems = validateRelease(release);
if (problems.length) {
  for (const e of problems.slice(0, 20)) console.error(`✗ ${e.path}: ${e.message}`);
  process.exit(1);
}
const prefix = prefixArg ?? release.release[0]!.council_code;
const { releases, unassigned } = splitByZone(release);
mkdirSync(folder, { recursive: true });
for (const r of releases) {
  const bad = validateRelease(r);
  if (bad.length) {
    for (const e of bad.slice(0, 20)) console.error(`✗ ${r.release[0]!.dataset_id} ${e.path}: ${e.message}`);
    process.exit(1);
  }
  const file = join(folder, `${prefix}-${r.release[0]!.dataset_id}.release.json`);
  writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
  console.log(`${r.release[0]!.release_id}: ${r.segments.length} segments, ${r.extents.length} extents → ${file}`);
}
if (unassigned.length) {
  console.warn(`${unassigned.length} extent(s) have no patrol zone and are in no file:`);
  for (const id of unassigned) console.warn(`  ${id}`);
}
