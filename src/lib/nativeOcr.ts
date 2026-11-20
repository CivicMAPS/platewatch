/**
 * Plate reading with Google ML Kit on the Android app.
 *
 * Tesseract (ocr.ts) is a document engine: it needs a clean, tightly cropped line of text and
 * fails on a plate surrounded by bumper, frame, slogan and dealer text. ML Kit is built for
 * text in photos: it finds each line and its box, and this module picks the plate from them.
 * Tesseract stays as the fallback for the browser build, which has no ML Kit.
 */
import { extractPlateCandidates } from './plate';
import { hasPatrol, patrol } from './patrol';
import type { PlateOcrResult } from './ocr';

export interface TextLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Plate characters are 2–8 letters/digits; Australian plates are mostly 5–7 and mix both. */
function plausibility(c: string): number {
  return (/\d/.test(c) ? 5 : 0) + (/[A-Z]/.test(c) ? 3 : 0) - Math.abs(c.length - 6) * 2;
}

/**
 * Rank recognised lines and pick the plate. The plate is usually the largest text in the
 * capture and near the centre of the guide; slogans and dealer names are small and off-centre.
 */
export function plateFromLines(lines: readonly TextLine[], image: { width: number; height: number }): PlateOcrResult {
  const cx = image.width / 2;
  const cy = image.height / 2;
  const maxDist = Math.hypot(cx, cy) || 1;
  const scores = new Map<string, number>();
  for (const l of lines) {
    const dist = Math.hypot(l.x + l.width / 2 - cx, l.y + l.height / 2 - cy) / maxDist;
    const whole = l.text.toUpperCase().replace(/[\s-]/g, '');
    const lineScore = (l.height / Math.max(1, image.height)) * 100 + (1 - dist) * 20 + (/^[A-Z0-9]{2,8}$/.test(whole) ? 15 : 0);
    extractPlateCandidates(l.text).forEach((c, i) => {
      const s = lineScore + plausibility(c) - i * 3;
      if (s > (scores.get(c) ?? Number.NEGATIVE_INFINITY)) scores.set(c, s);
    });
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  return {
    plate: ranked[0] ?? '',
    candidates: ranked.slice(0, 5),
    confidence: 0,
    rawText: lines.map((l) => l.text.trim()).filter(Boolean).join(' | '),
    durationMs: 0,
    engine: 'mlkit',
  };
}

export const hasNativeOcr = hasPatrol;

/** Read a plate from a capture with ML Kit. Throws when ML Kit is unavailable or fails. */
export async function recognisePlateNative(capture: HTMLCanvasElement): Promise<PlateOcrResult> {
  const t0 = performance.now();
  const { lines, width, height } = await patrol.readText({ image: capture.toDataURL('image/jpeg', 0.92) });
  return { ...plateFromLines(lines, { width, height }), durationMs: Math.round(performance.now() - t0) };
}
