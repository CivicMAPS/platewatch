/** Rear camera controller: high-resolution stream, torch, zoom, frame capture, wake lock. */

export interface CameraCapabilities {
  torch: boolean;
  zoom: { min: number; max: number; step: number } | null;
}

type ExtendedCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  zoom?: { min: number; max: number; step: number };
};

export class CameraError extends Error {
  constructor(
    message: string,
    readonly reason: 'unsupported' | 'denied' | 'not_found' | 'in_use' | 'unknown',
  ) {
    super(message);
  }
}

export class CameraController {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  torchOn = false;
  zoom = 1;

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  get active(): boolean {
    return !!this.stream?.getVideoTracks().some((t) => t.readyState === 'live');
  }

  private get track(): MediaStreamTrack | undefined {
    return this.stream?.getVideoTracks()[0];
  }

  async start(video: HTMLVideoElement): Promise<CameraCapabilities> {
    if (!CameraController.supported) {
      throw new CameraError('This browser cannot access the camera.', 'unsupported');
    }
    this.video = video;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
          frameRate: { ideal: 30 },
          // Chromium reports the zoom capability only when zoom is requested here.
          zoom: true,
        } as MediaTrackConstraints,
      });
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'NotAllowedError' || name === 'SecurityError')
        throw new CameraError('Camera permission denied.', 'denied');
      if (name === 'NotFoundError' || name === 'OverconstrainedError')
        throw new CameraError('No camera found.', 'not_found');
      if (name === 'NotReadableError') throw new CameraError('Camera is in use by another app.', 'in_use');
      throw new CameraError((e as Error).message || 'Camera failed to start.', 'unknown');
    }
    video.srcObject = this.stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play().catch(() => undefined);
    await this.acquireWakeLock();

    // Continuous autofocus where supported.
    const caps = (this.track?.getCapabilities?.() ?? {}) as ExtendedCapabilities & { focusMode?: string[] };
    if (caps.focusMode?.includes('continuous')) {
      await this.track
        ?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
        .catch(() => undefined);
    }
    // Focus and expose on the plate guide (screen centre) so the lens does not hunt onto
    // passing objects. Applied separately: a camera without points of interest keeps the
    // continuous focus set above.
    await this.track
      ?.applyConstraints({ advanced: [{ pointsOfInterest: [{ x: 0.5, y: 0.5 }] } as MediaTrackConstraintSet] })
      .catch(() => undefined);
    return {
      torch: !!caps.torch,
      zoom: caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null,
    };
  }

  async setTorch(on: boolean): Promise<boolean> {
    try {
      await this.track?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      this.torchOn = on;
    } catch {
      this.torchOn = false;
    }
    return this.torchOn;
  }

  async setZoom(z: number): Promise<void> {
    try {
      await this.track?.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] });
      this.zoom = z;
    } catch {
      /* zoom unsupported */
    }
  }

  /** Full-resolution frame from the live stream. */
  captureFrame(): HTMLCanvasElement {
    const v = this.video;
    if (!v || !v.videoWidth) throw new CameraError('Camera not ready.', 'unknown');
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const c = canvas.getContext('2d');
    if (!c) throw new CameraError('Canvas unavailable.', 'unknown');
    c.drawImage(v, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  private async acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      this.wakeLock = null;
    }
  }

  async stop(): Promise<void> {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.torchOn = false;
    try {
      await this.wakeLock?.release();
    } catch {
      /* already released */
    }
    this.wakeLock = null;
  }
}

/** Decode an uploaded/native-camera image file into a canvas (EXIF orientation honoured). */
export async function fileToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return canvas;
}
