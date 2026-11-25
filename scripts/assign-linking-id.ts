/**
 * Swap the council code for the council's linking ID in every key of a release, once the council
 * is onboarded with CivicMAPS (copp-31001 → <linking ID>-31001). Display IDs keep the council
 * code; council values (asset, source, meter and sign IDs) are not changed. The secret CivicMAPS
 * ID is never written to a release.
 *
 *   npm run release:link -- datasets/copp-patrol-area-10.release.json 482771930 out/copp-patrol-area-10.release.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relinkRelease, validateRelease, type KerbsideRelease } from '../src/lib/kerbsideRelease.ts';

const [input, linkingId, output] = process.argv.slice(2);
if (!input || !linkingId || !output) {
  console.error('Usage: npm run release:link -- <release.json> <linking ID> <output.json>');
  process.exit(2);
}
const release = JSON.parse(readFileSync(input, 'utf8')) as KerbsideRelease;
const before = validateRelease(release);
if (before.length) {
  for (const e of before.slice(0, 20)) console.error(`✗ ${e.path}: ${e.message}`);
  process.exit(1);
}
let linked: KerbsideRelease;
try {
  linked = relinkRelease(release, linkingId);
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}
const after = validateRelease(linked);
if (after.length) {
  for (const e of after.slice(0, 20)) console.error(`✗ ${e.path}: ${e.message}`);
  process.exit(1);
}
writeFileSync(output, JSON.stringify(linked, null, 2) + '\n');
console.log(`Linked ${linked.release[0]!.council_code} → ${linkingId}: ${linked.segments.length} segments, ${linked.extents.length} extents → ${output}`);
