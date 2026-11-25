/** Wording for the record screen, kept out of the view so it can be tested. */
import type { Observation, ScanRecord } from './types';

const ENGINE_LABEL = { tesseract: 'Tesseract', mlkit: 'ML Kit', patrol: 'ML Kit patrol' } as const;

/** How the plate was read: engine, confidence (Tesseract only) and the raw text. */
export function describeOcr(r: Pick<ScanRecord, 'ocrEngine' | 'ocrText' | 'ocrConfidence'>): string {
  const raw = `“${r.ocrText || '—'}”`;
  if (r.ocrConfidence !== null) return `Tesseract ${r.ocrConfidence}% · ${raw}`;
  if (r.ocrEngine) return `${ENGINE_LABEL[r.ocrEngine]} · ${raw}`;
  // Records saved before the engine was stored: OCR text means it was read, not typed.
  if (r.ocrText) return `OCR · ${raw}`;
  return 'Manual entry';
}

/**
 * State of a timing observation at `now`. `overdue` means timing is still active but the
 * allowance (+ grace) has run out, matching OVERDUE on the list screen: a re-scan now records
 * an overstay.
 */
export function timingState(
  o: Pick<Observation, 'status' | 'startedAt' | 'limitMinutes' | 'graceMinutes'>,
  now: number,
): 'running' | 'overdue' | 'expired' | 'reset' | 'dismissed' | 'issued' {
  if (o.status !== 'active') return o.status;
  return now - o.startedAt >= (o.limitMinutes + o.graceMinutes) * 60_000 ? 'overdue' : 'running';
}
