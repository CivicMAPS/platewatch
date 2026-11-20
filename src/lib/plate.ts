/**
 * Number plate normalisation and matching keys.
 *
 * - `normalisePlate`: what we display/store — uppercase A–Z/0–9 only.
 * Exact keys preserve letters and digits. Shape substitutions are review-only.
 */

const STRICT_MAP: Record<string, string> = { O: '0', Q: '0', I: '1' };
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
  // Typical Australian plates are 5–7 characters mixing letters and digits.
  const score = (t: string) => (/\d/.test(t) ? 10 : 0) + (/[A-Z]/.test(t) ? 5 : 0) - Math.abs(t.length - 6);
  return [...new Set(all)]
    .filter((t) => t.length >= 2 && t.length <= 8)
    .sort((a, b) => score(b) - score(a));
}
