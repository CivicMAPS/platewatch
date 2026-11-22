import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatIsoDate, formatStamp, zoneAbbreviation } from '../src/lib/time';

// 21/11/2026 10:41:07 local time.
const at = new Date(2026, 10, 21, 10, 41, 7).getTime();

describe('on-screen date formats (CivicMAPS: DD/MM/YYYY on screen, ISO 8601 on the wire)', () => {
  it('formats dates as DD/MM/YYYY', () => {
    expect(formatDate(at)).toBe('21/11/2026');
  });

  it('formats date-times with weekday, DD/MM/YYYY and 24-hour time', () => {
    expect(formatDateTime(at)).toBe('Sat 21/11/2026 10:41:07');
  });

  it('stamps capture times with the zone abbreviation', () => {
    // Tests run in Australia/Melbourne (vite.config.ts); November is daylight time.
    expect(zoneAbbreviation(at)).toBe('AEDT');
    expect(formatStamp(at)).toBe('21/11/2026 10:41:07 AEDT');
  });

  it('shows stored YYYY-MM-DD validity dates as DD/MM/YYYY and leaves other text alone', () => {
    expect(formatIsoDate('2026-12-31')).toBe('31/12/2026');
    expect(formatIsoDate(' 2027-01-05 ')).toBe('05/01/2027');
    expect(formatIsoDate('')).toBe('');
    expect(formatIsoDate('ongoing')).toBe('ongoing');
  });
});
