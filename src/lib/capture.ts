/** Capture pipeline: shutter metadata → evidence JPEG (data bar + EXIF) → thumbnail → SHA-256. */
import { paymentLines } from './payment';
import { embedExif } from './exif';
import { geo } from './geo';
import { sha256Hex } from './hash';
import { canvasToJpegDataUrl, makeThumbnail, resizeCanvas } from './image';
import { deviceTimeZone, toLocalIso } from './time';
import type { CaptureMeta, PlateList } from './types';

export interface PendingCapture {
  /** Full frame as captured. */
  frame: HTMLCanvasElement;
  /** Plate region used for OCR. */
  crop: HTMLCanvasElement;
  meta: CaptureMeta;
}

export interface Evidence {
  image: Blob;
  thumb: Blob;
  sha256: string;
}

/**
 * Stamp device time at the shutter, then attach the best location fix.
 * The clock is read *before* awaiting location so a slow fix never shifts
 * the recorded capture time.
 */
export async function captureMeta(): Promise<CaptureMeta> {
  const capturedAt = Date.now();
  const location = await geo.fixForCapture(capturedAt);
  return {
    capturedAt,
    capturedAtLocal: toLocalIso(capturedAt),
    timeZone: deviceTimeZone(),
    location,
    locationAgeMs: location ? capturedAt - location.timestamp : null,
    userAgent: navigator.userAgent,
  };
}

function drawDataBar(src: HTMLCanvasElement, lines: string[]): HTMLCanvasElement {
  const fontPx = Math.max(16, Math.round(src.width / 70));
  const pad = Math.round(fontPx * 0.6);
  const barH = lines.length * Math.round(fontPx * 1.35) + pad * 2;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height + barH;
  const c = out.getContext('2d')!;
  c.drawImage(src, 0, 0);
  c.fillStyle = '#000';
  c.fillRect(0, src.height, out.width, barH);
  c.fillStyle = '#fff';
  c.font = `600 ${fontPx}px ui-monospace, "DejaVu Sans Mono", monospace`;
  c.textBaseline = 'top';
  lines.forEach((line, i) => c.fillText(line, pad, src.height + pad + i * Math.round(fontPx * 1.35)));
  return out;
}

export async function buildEvidence(p: PendingCapture, plate: string, list: PlateList, appVersion: string): Promise<Evidence> {
  const base = resizeCanvas(p.frame, 2560);
  const loc = p.meta.location;
  const lines = [
    `${plate}  |  ${list.name} (${list.type})`,
    `${p.meta.capturedAtLocal}  ${p.meta.timeZone}`,
    loc
      ? `${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}  ±${Math.round(loc.accuracy)} m`
      : 'LOCATION UNAVAILABLE',
  ];
  lines.push(...paymentLines(p.meta.payment));
  const stamped = drawDataBar(base, lines);
  const image = embedExif(canvasToJpegDataUrl(stamped, 0.88), p.meta, {
    plate,
    listName: list.name,
    listType: list.type,
    appVersion,
  });
  const [thumb, sha256] = await Promise.all([makeThumbnail(base), sha256Hex(image)]);
  return { image, thumb, sha256 };
}

export function evidenceFileName(plate: string, capturedAt: number): string {
  const iso = new Date(capturedAt).toISOString().replace(/[:.]/g, '-');
  return `${iso}_${plate}.jpg`;
}
