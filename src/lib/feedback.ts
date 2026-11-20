/** Haptic + audible feedback. No audio files: tones are synthesised (CSP/offline friendly). */
import type { Settings } from './types';

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, startOffset: number, duration: number, type: OscillatorType = 'sine', gain = 0.25) {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ac.currentTime + startOffset;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export type FeedbackKind = 'shutter' | 'ok' | 'info' | 'warn' | 'alarm';

const VIBRATION: Record<FeedbackKind, number[]> = {
  shutter: [30],
  ok: [60],
  info: [40, 60, 40],
  warn: [200, 100, 200],
  alarm: [500, 150, 500, 150, 500, 150, 800],
};

export function feedback(kind: FeedbackKind, settings: Pick<Settings, 'vibrate' | 'sound'>): void {
  if (settings.vibrate && 'vibrate' in navigator) {
    try {
      navigator.vibrate(VIBRATION[kind]);
    } catch {
      /* ignored: vibration not permitted */
    }
  }
  if (!settings.sound) return;
  switch (kind) {
    case 'shutter':
      tone(1800, 0, 0.05, 'square', 0.08);
      break;
    case 'ok':
      tone(880, 0, 0.12);
      tone(1320, 0.12, 0.15);
      break;
    case 'info':
      tone(660, 0, 0.15);
      break;
    case 'warn':
      tone(520, 0, 0.2, 'triangle', 0.3);
      tone(520, 0.3, 0.2, 'triangle', 0.3);
      break;
    case 'alarm':
      for (let i = 0; i < 4; i++) {
        tone(980, i * 0.5, 0.22, 'sawtooth', 0.3);
        tone(740, i * 0.5 + 0.25, 0.22, 'sawtooth', 0.3);
      }
      break;
  }
}

/** Must be called from a user gesture once so later alerts can play. */
export function unlockAudio(): void {
  audio();
}
