/** Canvas utilities: region-of-interest mapping, OCR pre-processing, JPEG/thumbnail encoding. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Map a rectangle in the <video> element's CSS box (rendered with
 * object-fit: cover) to intrinsic video pixel coordinates.
 */
export function mapCoverRect(
  rectInElement: Rect,
  element: { width: number; height: number },
  intrinsic: { width: number; height: number },
): Rect {
  const scale = Math.max(element.width / intrinsic.width, element.height / intrinsic.height);
  const shownW = intrinsic.width * scale;
  const shownH = intrinsic.height * scale;
  const offX = (shownW - element.width) / 2;
  const offY = (shownH - element.height) / 2;
  const x = (rectInElement.x + offX) / scale;
  const y = (rectInElement.y + offY) / scale;
  const width = rectInElement.width / scale;
  const height = rectInElement.height / scale;
  return clampRect({ x, y, width, height }, intrinsic);
}

export function clampRect(r: Rect, bounds: { width: number; height: number }): Rect {
  const x = Math.max(0, Math.min(bounds.width - 1, r.x));
  const y = Math.max(0, Math.min(bounds.height - 1, r.y));
  return {
    x,
    y,
    width: Math.max(1, Math.min(bounds.width - x, r.width)),
    height: Math.max(1, Math.min(bounds.height - y, r.height)),
  };
}

export function padRect(r: Rect, fraction: number, bounds: { width: number; height: number }): Rect {
  const dx = r.width * fraction;
  const dy = r.height * fraction;
  return clampRect({ x: r.x - dx, y: r.y - dy, width: r.width + 2 * dx, height: r.height + 2 * dy }, bounds);
}

export function cropCanvas(src: HTMLCanvasElement, r: Rect, targetHeight?: number): HTMLCanvasElement {
  const scale = targetHeight ? targetHeight / r.height : 1;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.width * scale));
  out.height = Math.max(1, Math.round(r.height * scale));
  const c = out.getContext('2d', { willReadFrequently: true })!;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, r.x, r.y, r.width, r.height, 0, 0, out.width, out.height);
  return out;
}

/** Downscale so the longest edge ≤ maxEdge (keeps aspect). */
export function resizeCanvas(src: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const longest = Math.max(src.width, src.height);
  if (longest <= maxEdge) return src;
  const s = maxEdge / longest;
  return cropCanvas(src, { x: 0, y: 0, width: src.width, height: src.height }, Math.round(src.height * s));
}

/** Luma histogram → Otsu threshold. */
export function otsuThreshold(gray: Uint8ClampedArray | Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of gray) hist[v]!++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * OCR variants for a plate crop:
 *  - `gray`: luma with 2–98 percentile contrast stretch
 *  - `binary`: Otsu threshold, polarity normalised to dark text on light ground
 */
export function preprocessForOcr(src: HTMLCanvasElement): { gray: HTMLCanvasElement; binary: HTMLCanvasElement } {
  const w = src.width;
  const h = src.height;
  const data = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
  const px = data.data;
  const luma = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    luma[j] = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
  }
  // Percentile contrast stretch
  const sorted = Uint8ClampedArray.from(luma).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)] ?? 0;
  const hi = sorted[Math.floor(sorted.length * 0.98)] ?? 255;
  const range = Math.max(1, hi - lo);
  for (let j = 0; j < luma.length; j++) luma[j] = ((luma[j]! - lo) * 255) / range;

  const t = otsuThreshold(luma);
  let dark = 0;
  for (const v of luma) if (v < t) dark++;
  // Plates are mostly background; if most pixels are dark the text is light → invert.
  const invert = dark > luma.length / 2;

  const mk = (fn: (v: number) => number) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let j = 0, i = 0; j < luma.length; j++, i += 4) {
      const v = fn(luma[j]!);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  };
  return {
    gray: mk((v) => (invert ? 255 - v : v)),
    binary: mk((v) => ((v < t) !== invert ? 0 : 255)),
  };
}

export function canvasToJpegDataUrl(c: HTMLCanvasElement, quality = 0.88): string {
  return c.toDataURL('image/jpeg', quality);
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/jpeg', quality = 0.8): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), type, quality),
  );
}

export async function makeThumbnail(src: HTMLCanvasElement, maxEdge = 480): Promise<Blob> {
  return canvasToBlob(resizeCanvas(src, maxEdge), 'image/jpeg', 0.75);
}
