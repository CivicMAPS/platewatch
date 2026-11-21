import { describe, expect, it } from 'vitest';
import { describeOcr, timingState } from '../src/lib/recordSummary';
import type { Observation } from '../src/lib/types';

describe('describeOcr', () => {
  it('names the engine for ML Kit and patrol readings instead of "Manual entry" (field test 2FE70T)', () => {
    expect(describeOcr({ ocrEngine: 'patrol', ocrText: '2FE70T', ocrConfidence: null })).toBe('ML Kit patrol · “2FE70T”');
    expect(describeOcr({ ocrEngine: 'mlkit', ocrText: '1AB 2CD', ocrConfidence: null })).toBe('ML Kit · “1AB 2CD”');
  });
  it('keeps the Tesseract confidence', () => {
    expect(describeOcr({ ocrEngine: 'tesseract', ocrText: 'ABC123', ocrConfidence: 87 })).toBe('Tesseract 87% · “ABC123”');
  });
  it('labels older records with OCR text but no engine as OCR, not manual', () => {
    expect(describeOcr({ ocrText: '2FE70T', ocrConfidence: null })).toBe('OCR · “2FE70T”');
  });
  it('says manual entry only when nothing was read', () => {
    expect(describeOcr({ ocrEngine: null, ocrText: '', ocrConfidence: null })).toBe('Manual entry');
    expect(describeOcr({ ocrText: '', ocrConfidence: null })).toBe('Manual entry');
  });
});

describe('timingState', () => {
  const start = Date.parse('2026-11-20T21:52:08Z'); // 08:52:08 Melbourne
  const obs = { status: 'active', startedAt: start, allowanceEndsAt: start + 3_600_000, graceMinutes: 0, limitMinutes: 60 } as Observation;

  it('is running inside the allowance', () => {
    expect(timingState(obs, start + 30 * 60_000)).toBe('running');
  });
  it('is overdue once allowance + grace has passed, while timing is still active (field test 13:22)', () => {
    expect(timingState(obs, start + 4.5 * 3_600_000)).toBe('overdue');
    expect(timingState({ ...obs, graceMinutes: 10 }, start + 65 * 60_000)).toBe('running');
  });
  it('reports closed observations as they are', () => {
    expect(timingState({ ...obs, status: 'expired' }, start + 4.5 * 3_600_000)).toBe('expired');
    expect(timingState({ ...obs, status: 'reset' }, start)).toBe('reset');
  });
});
