import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { comparePlates, extractPlateCandidates, isValidPlate, looseKey, normalisePlate, plateKey } from '../src/lib/plate';

describe('plate normalisation', () => {
  it('uppercases and strips separators', () => {
    expect(normalisePlate(' abc-123 ')).toBe('ABC123');
    expect(normalisePlate('1ab·2cd')).toBe('1AB2CD');
  });
  it('strict key preserves O, Q, I and digits', () => {
    expect(plateKey('OIQ')).toBe('OIQ');
    expect(plateKey('B8S5')).toBe('B8S5');
  });
  it('loose key collapses commonly confused glyphs', () => {
    expect(looseKey('B8S5Z2G6')).toBe('88552266');
  });
  it('compares exact / possible / none', () => {
    expect(comparePlates('ABC123', 'abc 123')).toBe('exact');
    expect(comparePlates('ABO123', 'AB0123')).toBe('possible');
    expect(comparePlates('1BC123', '18C123')).toBe('possible');
    expect(comparePlates('ABC123', 'XYZ789')).toBe('none');
  });
  it('validates length', () => {
    expect(isValidPlate('')).toBe(false);
    expect(isValidPlate('A')).toBe(true);
    expect(isValidPlate('ABCDEFGHIJK')).toBe(false);
  });
  it('extracts the most plausible plate token from OCR noise', () => {
    expect(extractPlateCandidates('VICTORIA\n1AB 2CD\n')[0]).toBe('1AB2CD');
    expect(extractPlateCandidates('ABC123 | THE EDUCATION STATE')[0]).toBe('ABC123');
    expect(extractPlateCandidates('')).toEqual([]);
  });
});

describe('look-alike classes (shared vectors with the native reader, WF-S28)', () => {
  const rows = readFileSync(new URL('./fixtures/plate-lookalikes.tsv', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t') as [string, string, 'possible' | 'none' | 'exact']);
  it.each(rows)('%s / %s → %s', (a, b, expected) => {
    expect(comparePlates(a, b)).toBe(expected);
    expect(comparePlates(b, a)).toBe(expected);
  });
});
