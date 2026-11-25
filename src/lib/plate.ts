/**
 * Number plate normalisation and matching keys.
 *
 * - `normalisePlate`: what we display/store — uppercase A–Z/0–9 only.
 * Exact keys preserve letters and digits. Shape substitutions are review-only.
 */

const STRICT_MAP: Record<string, string> = { O: '0', Q: '0', I: '1' };
/**
 * OCR look-alike classes (WF-S28 OQ28-1): every member of a class is a look-alike of every other.
 * 0·O·Q·D, 1·I·L, 8·B, 5·S, 2·Z, 6·G, 7·T, V·U; owner decision 23/11/2026 adds R·P (the field
 * misread 1UP6YF / 1UR6YF) and the proposed A·4, F·E, N·M. D stays in the 0 class, so P/R are not
 * look-alikes of 0/O/Q/D. Mirrored in PlateRules.java LOOSE; shared vectors in
 * tests/fixtures/plate-lookalikes.tsv.
 */
const LOOSE_MAP: Record<string, string> = {
  ...STRICT_MAP,
  D: '0',
  B: '8',
  S: '5',
  Z: '2',
  G: '6',
  L: '1',
  T: '7',
  U: 'V',
  P: 'R',
  '4': 'A',
  E: 'F',
  M: 'N',
};

export const PLATE_MIN = 1;
export const PLATE_MAX = 10;

export function normalisePlate(input: string): string {
  return input
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[^A-Z0-9]/g, '');
}

function mapChars(plate: string, map: Record<string, string>): string {
  let out = '';
  for (const ch of plate) out += map[ch] ?? ch;
  return out;
}

export function plateKey(input: string): string {
  return normalisePlate(input);
}

export function looseKey(input: string): string {
  return mapChars(normalisePlate(input), LOOSE_MAP);
}

export function isValidPlate(input: string): boolean {
  const p = normalisePlate(input);
  return p.length >= PLATE_MIN && p.length <= PLATE_MAX;
}

export type MatchStrength = 'exact' | 'possible' | 'none';

export function comparePlates(a: string, b: string): MatchStrength {
  if (plateKey(a) === plateKey(b)) return 'exact';
  if (looseKey(a) === looseKey(b)) return 'possible';
  return 'none';
}

/* ───────────── Plate formats and reading clean-up ─────────────
 * Mirrored in android/.../PlateRules.java (native patrol). Both run the shared vectors in
 * tests/fixtures/plate-readings.tsv, so keep the two implementations in step.
 */

/**
 * General-issue serial formats (D digit, L letter), in priority order: Victoria first, then
 * interstate plates often seen in Victoria (NSW, QLD, WA, SA).
 */
export const PLATE_FORMATS = ['DLLDLL', 'LLLDDD', 'LLDDLL', 'LLLDDL', 'DDDLLL', 'DLLLDDD', 'LDDDLLL'] as const;

/**
 * Letters text recognition returns for a digit (ML Kit reads a 1 as I and a 6 as G inside
 * a run of letters). Only applied at positions where the format needs a digit. Letter
 * positions are never changed, so O and 0 stay distinct as described in the README.
 */
const LETTER_AS_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8', T: '7' };
/** Glyphs read for the VIC triangle between the groups of a 1AB▼2CD plate. */
const EMBLEM_GLYPHS = new Set(['X', 'V', 'Y']);
/** Glyphs read for the plate's edge or a dealer frame beside the characters. */
const EDGE_GLYPHS = new Set(['E', 'I', 'L', 'J', '1']);
const MAX_FORMAT_FIXES = 2;

function fitFormat(p: string, maxFixes = MAX_FORMAT_FIXES): string | null {
  let best: { out: string; fixes: number } | null = null;
  for (const format of PLATE_FORMATS) {
    if (format.length !== p.length) continue;
    let out = '';
    let fixes = 0;
    for (let i = 0; i < p.length && out.length === i; i++) {
      const c = p[i]!;
      const digit = c >= '0' && c <= '9';
      if (format[i] === 'L') {
        if (!digit) out += c;
      } else if (digit) out += c;
      else if (LETTER_AS_DIGIT[c]) {
        out += LETTER_AS_DIGIT[c];
        fixes++;
      }
    }
    // Ties go to the earlier (local) format.
    if (out.length === p.length && fixes <= maxFixes && (!best || fixes < best.fixes)) best = { out, fixes };
  }
  return best?.out ?? null;
}

/**
 * Clean up a plate reading using Australian plate formats. A reading that fits a format is
 * kept, with letters at digit positions corrected (IUR6YF → 1UR6YF). A reading that fits
 * none is retried without the VIC triangle (1URX6YF → 1UR6YF) or without an edge character
 * picked up from the plate frame (EDTS512 → DTS512); the shortened reading must then fit a
 * format exactly, so sign words are not bent into plates. Anything else is returned as read:
 * personalised plates do not follow a format and the officer always confirms the reading.
 */
export function canonicalPlate(input: string): string {
  const p = normalisePlate(input);
  if (p.length < 5 || p.length > 8) return p;
  const direct = fitFormat(p);
  if (direct) return direct;
  if (p.length === 7 && EMBLEM_GLYPHS.has(p[3]!)) {
    const fit = fitFormat(p.slice(0, 3) + p.slice(4), 0);
    if (fit) return fit;
  }
  const trimmed = new Set<string>();
  if (EDGE_GLYPHS.has(p[0]!)) {
    const fit = fitFormat(p.slice(1), 0);
    if (fit) trimmed.add(fit);
  }
  if (EDGE_GLYPHS.has(p[p.length - 1]!)) {
    const fit = fitFormat(p.slice(0, -1), 0);
    if (fit) trimmed.add(fit);
  }
  return trimmed.size === 1 ? [...trimmed][0]! : p;
}

/**
 * Plate-like enough to capture without the shutter: 4–8 characters with at least one letter
 * and one digit. Sign words (LAWS, CITYOFP) and street numbers are rejected; an all-letter
 * personalised plate is captured with the shutter instead.
 */
/** True when the plate matches a general-issue format exactly, as read. */
export function fitsPlateFormat(plate: string): boolean {
  return fitFormat(normalisePlate(plate), 0) !== null;
}

export function isAutoCapturePlate(plate: string): boolean {
  return /^(?=.*\d)(?=.*[A-Z])[A-Z0-9]{4,8}$/.test(plate);
}

/**
 * True when two readings are most likely the same plate: identical after clean-up, the same
 * apart from look-alike glyphs, one character different, or one extra character.
 */
export function isPlateVariant(a: string, b: string): boolean {
  // Compare the readings as read and cleaned up: clean-up can move one reading of a pair
  // further from the other (EDAB899 → DAB899 against EDA8899).
  const xs = new Set([normalisePlate(a), canonicalPlate(a)]);
  const ys = new Set([normalisePlate(b), canonicalPlate(b)]);
  for (const x of xs) for (const y of ys) if (closeReadings(x, y)) return true;
  return false;
}

function closeReadings(x: string, y: string): boolean {
  if (x === y || looseKey(x) === looseKey(y)) return true;
  if (Math.min(x.length, y.length) < 5) return false;
  if (x.length === y.length) {
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
    return diff <= 1;
  }
  if (Math.abs(x.length - y.length) !== 1) return false;
  const [long, short] = x.length > y.length ? [x, y] : [y, x];
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

/**
 * Pick the most plausible plate from OCR text. Tesseract may return extra
 * tokens (state name, slogans, border noise); prefer the longest alphanumeric
 * token of 2–8 characters that contains at least one digit, else the longest.
 */
export function extractPlateCandidates(ocrText: string): string[] {
  const all: string[] = [];
  for (const line of ocrText.toUpperCase().split(/[\n\r|]+/)) {
    const tokens = line
      .split(/\s+/)
      .map((t) => t.replace(/[^A-Z0-9]/g, ''))
      .filter(Boolean);
    // Plates are often printed with a gap ("1AB 2CD"): consider single tokens,
    // adjacent pairs, and the whole line joined.
    all.push(...tokens);
    for (let i = 0; i + 1 < tokens.length; i++) all.push(tokens[i]! + tokens[i + 1]!);
    if (tokens.length > 2) all.push(tokens.join(''));
  }
  // Typical Australian plates are 5–7 characters mixing letters and digits; a reading that
  // matches a general-issue format after clean-up (1URX6YF → 1UR6YF) ranks above one that does not.
  const score = (t: string) =>
    (/\d/.test(t) ? 10 : 0) + (/[A-Z]/.test(t) ? 5 : 0) - Math.abs(t.length - 6) + (fitsPlateFormat(t) ? 4 : 0);
  return [...new Set(all.map(canonicalPlate))]
    .filter((t) => t.length >= 2 && t.length <= 8)
    .sort((a, b) => score(b) - score(a));
}
