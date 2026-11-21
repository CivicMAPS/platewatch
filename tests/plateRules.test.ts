import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalPlate, isAutoCapturePlate, isPlateVariant } from '../src/lib/plate';

const vectors = readFileSync(new URL('./fixtures/plate-readings.tsv', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => l.split('\t') as [string, string, string]);

describe('canonicalPlate (shared vectors with the native patrol reader)', () => {
  it.each(vectors)('%s → %s', (raw, canonical) => {
    expect(canonicalPlate(raw)).toBe(canonical);
  });
});

describe('isAutoCapturePlate (shared vectors)', () => {
  it.each(vectors)('%s auto-capture: %s', (raw, _c, auto) => {
    expect(isAutoCapturePlate(canonicalPlate(raw))).toBe(auto === 'yes');
  });
});

describe('isPlateVariant', () => {
  it('treats one OCR slip of the same plate as the same vehicle', () => {
    expect(isPlateVariant('1UR6YF', '1UP6YF')).toBe(true); // R read as P
    expect(isPlateVariant('1UR6YF', '1UD6YF')).toBe(true); // R read as D
    expect(isPlateVariant('EDA8899', 'EDAB899')).toBe(true); // 8 read as B
    expect(isPlateVariant('EDA8899', 'DA8899')).toBe(true); // extra leading character
    expect(isPlateVariant('ABO123', 'AB0123')).toBe(true);
  });
  it('keeps different vehicles apart', () => {
    expect(isPlateVariant('1UR6YF', '2FE70T')).toBe(false);
    expect(isPlateVariant('ZAF402', '1XA5PL')).toBe(false);
    expect(isPlateVariant('ABC123', 'ABC789')).toBe(false);
  });
});
