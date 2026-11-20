/**
 * On-device OCR (Tesseract LSTM via WebAssembly). All assets are served from
 * /ocr — nothing is fetched from a CDN, so it works offline and under CSP.
 */
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { extractPlateCandidates } from './plate';
import { cropCanvas, preprocessForOcr } from './image';

export type OcrStatus = { status: string; progress: number };

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const statusListeners = new Set<(s: OcrStatus) => void>();

const PLATE_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function asset(path: string): string {
  return new URL(path, document.baseURI).href;
}

export function onOcrStatus(fn: (s: OcrStatus) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: asset('ocr/worker.min.js'),
    corePath: asset('ocr/core/'),
    langPath: asset('ocr/lang'),
    gzip: false, // see scripts/copy-ocr-assets.mjs
    workerBlobURL: false,
    cacheMethod: 'write',
    logger: (m: { status: string; progress: number }) => {
      for (const fn of statusListeners) fn({ status: m.status, progress: m.progress });
    },
    errorHandler: (e: unknown) => console.error('[ocr]', e),
  }, {
    // Plates are not dictionary words: disable language-model dictionaries.
    load_system_dawg: '0',
    load_freq_dawg: '0',
  }).catch((e: unknown) => {
    workerPromise = null;
    throw e;
  });
  return workerPromise;
}

/** Start loading the OCR engine in the background (call early). */
export function warmUpOcr(): Promise<void> {
  return getWorker().then(() => undefined);
}

/** Serialise jobs: parameters are per-worker state. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

export interface PlateOcrResult {
  /** Best plate candidate (may be empty). */
  plate: string;
  candidates: string[];
  /** 0–100 */
  confidence: number;
  rawText: string;
  durationMs: number;
}

/**
 * Read a plate from a cropped region.
 *
 * Three passes, then a consensus vote:
 *   1. binarised + A–Z/0–9 whitelist (most accurate glyph classification)
 *   2. binarised, no whitelist
 *   3. contrast-stretched grey, no whitelist
 * Tesseract reports a mean confidence of 0 whenever a character whitelist is
 * active, so confidence is taken from the unconstrained passes that agree.
 */
export function recognisePlate(crop: HTMLCanvasElement, mode: 'line' | 'sparse' = 'line'): Promise<PlateOcrResult> {
  return enqueue(async () => {
    const t0 = performance.now();
    const worker = await getWorker();
    // 'line' = aligned plate crop from the guide box; 'sparse' = whole uploaded photo.
    const psm = mode === 'line' ? PSM.SINGLE_LINE : PSM.SPARSE_TEXT;
    // Tesseract is most accurate with ~30–60 px glyphs; plate text is ~60% of crop height.
    const full = { x: 0, y: 0, width: crop.width, height: crop.height };
    const scaled =
      mode === 'line'
        ? crop.height < 140 || crop.height > 320
          ? cropCanvas(crop, full, 200)
          : crop
        : Math.max(crop.width, crop.height) > 2000
          ? cropCanvas(crop, full, Math.round((crop.height * 2000) / Math.max(crop.width, crop.height)))
          : crop;
    const { gray, binary } = preprocessForOcr(scaled);

    const passes: { img: HTMLCanvasElement; whitelist: boolean }[] = [
      { img: binary, whitelist: true },
      { img: binary, whitelist: false },
      { img: gray, whitelist: false },
    ];
    const readings: { text: string; confidence: number | null }[] = [];
    for (const pass of passes) {
      await worker.setParameters({
        tessedit_char_whitelist: pass.whitelist ? PLATE_WHITELIST : '',
        tessedit_pageseg_mode: psm,
        preserve_interword_spaces: '0',
      });
      const { data } = await worker.recognize(pass.img);
      readings.push({ text: data.text ?? '', confidence: pass.whitelist ? null : (data.confidence ?? 0) });
    }

    const tally = new Map<string, { score: number; confidence: number }>();
    for (const r of readings) {
      extractPlateCandidates(r.text).forEach((c, i) => {
        const t = tally.get(c) ?? { score: 0, confidence: 0 };
        t.score += Math.max(1, (r.confidence ?? 60) - i * 15);
        if (r.confidence !== null && i === 0) t.confidence = Math.max(t.confidence, r.confidence);
        tally.set(c, t);
      });
    }
    const ranked = [...tally.entries()].sort((a, b) => b[1].score - a[1].score);
    const best = ranked[0];
    return {
      plate: best?.[0] ?? '',
      candidates: ranked.slice(0, 5).map(([c]) => c),
      confidence: Math.round(best?.[1].confidence ?? 0),
      rawText: [...new Set(readings.map((r) => r.text.trim()).filter(Boolean))].join(' | '),
      durationMs: Math.round(performance.now() - t0),
    };
  });
}

export interface TextOcrResult {
  text: string;
  confidence: number;
  durationMs: number;
}

/** General text → editable text (signage, permits, notices). */
export function recogniseText(image: HTMLCanvasElement): Promise<TextOcrResult> {
  return enqueue(async () => {
    const t0 = performance.now();
    const worker = await getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: '',
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
    });
    const { data } = await worker.recognize(image);
    return {
      text: (data.text ?? '').replace(/\n{3,}/g, '\n\n').trim(),
      confidence: Math.round(data.confidence ?? 0),
      durationMs: Math.round(performance.now() - t0),
    };
  });
}

export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  await w?.terminate();
}
