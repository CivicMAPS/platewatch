import { patrol, hasPatrol, frameUrlFor, type Sighting } from '../../lib/patrol';
import { deviceTimeZone, toLocalIso } from '../../lib/time';
import type { PluginListenerHandle } from '@capacitor/core';
import { isPaidBy, paymentFor, paymentLines } from '../../lib/payment';
import { html, nothing, type TemplateResult } from 'lit-html';
import { createRef, ref } from 'lit-html/directives/ref.js';
import { CameraController, CameraError, fileToCanvas, type CameraCapabilities } from '../../lib/camera';
import { buildEvidence, captureMeta, type Evidence, type PendingCapture } from '../../lib/capture';
import {
  expireObservations,
  getActiveObservations,
  getAllowLists,
  getHotLists,
  getList,
  getScan,
  putObservation,
  saveDismissed,
  saveScan,
  uid,
} from '../../lib/db';
import { evaluate, newObservation, resighting, type Decision, type HotHit } from '../../lib/engine';
import { feedback, unlockAudio } from '../../lib/feedback';
import { accuracyTone, formatLatLng, geo, type GeoState } from '../../lib/geo';
import { cropCanvas, mapCoverRect, padRect } from '../../lib/image';
import { onOcrStatus, recognisePlate, warmUpOcr, type OcrStatus, type PlateOcrResult } from '../../lib/ocr';
import { comparePlates, isValidPlate, normalisePlate, plateKey } from '../../lib/plate';
import { restrictionInForce } from '../../lib/restriction';
import { formatClock, formatDateTime, formatDuration, formatIsoDate, formatMinutes, formatStamp } from '../../lib/time';
import { clampZoom, formatZoom, LONG_PRESS_MS, nextPreset, sliderRange, ZOOM_PRESETS } from '../../lib/zoom';
import { hasNativeOcr, recognisePlateNative } from '../../lib/nativeOcr';
import { diagnosticsEnabled, logDiag } from '../../lib/diagnostics';
import type { GeoFix, TimedRestriction } from '../../lib/types';
import {
  RISK_LEVEL_LABELS,
  RISK_TAG_LABELS,
  type Observation,
  type PlateList,
  type ScanOutcome,
  type ScanRecord,
  type TimedList,
} from '../../lib/types';
import type { App, View } from '../app';
import {
  banner,
  header,
  icon,
  nearMatchSheet,
  plateBadge,
  riskPill,
  spinner,
  STATUS,
  statusPill,
  TONE_PANEL,
  TONE_PILL,
  TONE_TEXT,
  UrlBag,
  type StatusKind,
} from '../components';
import { segmentLabel } from './home';

type Phase = 'starting' | 'live' | 'processing' | 'confirm' | 'saving' | 'result' | 'no_camera';

interface Comparison {
  observation: Observation;
  first: ScanRecord;
  current: ScanRecord;
  elapsedMs: number;
  remainingMs: number;
  overstay: boolean;
}

interface ResultState {
  plate: string;
  decision: Decision;
  hotHits: HotHit[];
  comparison: Comparison | null;
  saved: ScanRecord | null;
  possibleFirsts: Map<string, ScanRecord>;
}


/** The restriction a timed decision is about: the one in force for a new sighting, or the observation's. */
function restrictionFor(l: TimedList, d: Decision): TimedRestriction | undefined {
  if (d.kind === 'timed_new' || d.kind === 'timed_possible') return d.instance.restriction;
  if (d.kind === 'timed_resighting') return l.restrictions.find((r) => r.id === d.observation.restrictionId);
  return undefined;
}

export function scanView(params: Record<string, string>, app: App): View {
  const listId = params.id ?? '';
  const camera = new CameraController();
  const videoRef = createRef<HTMLVideoElement>();
  const guideRef = createRef<HTMLDivElement>();
  const fileRef = createRef<HTMLInputElement>();
  const plateInputRef = createRef<HTMLInputElement>();
  const urls = new UrlBag();

  let list: PlateList | null = null;
  let phase: Phase = 'starting';
  let cameraMessage = '';
  let caps: CameraCapabilities = { torch: false, zoom: null };
  let zoomSliderOpen = false;
  let pressTimer: number | undefined;
  let longPressed = false;
  let geoState: GeoState = { status: 'idle' };
  let pending: PendingCapture | null = null;
  let cropUrl = '';
  let frameUrl = '';
  let ocr: PlateOcrResult | null = null;
  let ocrStatus: OcrStatus | null = null;
  let ocrError = '';
  let plateInput = '';
  let result: ResultState | null = null;
  let evidence: Evidence | null = null;
  let clock: number | undefined;
  let unsubGeo: (() => void) | null = null;
  let unsubOcr: (() => void) | null = null;
  let disposed = false;

  const settings = () => app.settings;

  /* ─────────────────────────── Diagnostics ─────────────────────────── */

  const fixInfo = (fix: GeoFix | null, at: number) =>
    fix ? { accuracy: Math.round(fix.accuracy * 10) / 10, ageMs: at - fix.timestamp, speed: fix.speed } : null;

  const deviceStatus = async (): Promise<Record<string, unknown>> => {
    try {
      if (hasPatrol()) return { ...(await patrol.deviceStatus()) };
      const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> };
      const b = await nav.getBattery?.();
      return b ? { battery: Math.round(b.level * 100), charging: b.charging } : {};
    } catch {
      return {};
    }
  };

  /** Every minute while scanning: battery, heat and the current GPS fix. */
  let sampler: number | undefined;
  const sample = async () => {
    if (!diagnosticsEnabled()) return;
    const fix = geoState.status === 'fix' ? geoState.fix : null;
    await logDiag('sample', {
      surface: nativeActive ? 'patrol' : 'default',
      phase,
      geo: geoState.status,
      fix: fixInfo(fix, Date.now()),
      ...(await deviceStatus()),
    });
  };

  /* ───────────────────────────── Camera ───────────────────────────── */

  const startCamera = async () => {
    const video = videoRef.value;
    if (!video) return;
    phase = 'starting';
    app.update();
    try {
      caps = await camera.start(video);
      if (disposed) {
        await camera.stop();
        return;
      }
      if (caps.zoom) await camera.setZoom(clampZoom(settings().cameraZoom, caps.zoom));
      phase = 'live';
      void logDiag('camera_start', {
        surface: 'default',
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        zoomRange: caps.zoom,
        zoom: camera.zoom,
        torch: caps.torch,
      });
    } catch (e) {
      phase = 'no_camera';
      cameraMessage =
        e instanceof CameraError && e.reason === 'denied'
          ? 'Camera permission was denied. Allow camera access in your browser/app settings, or use the device camera below.'
          : (e as Error).message;
    }
    app.update();
  };

  let suggestions: string[] = [];
  let dismissed = '';
  let editing = false;
  /** Blocking problem on the confirm screen: a persistent banner, not a toast (assessment D6). */
  let confirmError: { title: string; body?: string; field?: 'plate' } | null = null;
  const listeners: PluginListenerHandle[] = [];
  /** Patrol captures awaiting review; `variants` are other readings of the same plate seen after it. */
  const queue: {s:Sighting; meta:PendingCapture['meta']; variants:string[]}[] = [];
  let nativeActive = false;
  /** The capture under review came from a patrol: it can only be checked or dismissed, not retaken. */
  let fromPatrol = false;

  const reviewNext = async () => {
    const item = queue[0];
    if (!item) { await startCamera(); return; }
    try {
      const response = await fetch(frameUrlFor(item.s));
      if (!response.ok) throw new Error('Capture unavailable');
      const frame = await fileToCanvas(await response.blob());
      const crop = cropCanvas(frame,item.s);
      pending = {frame,crop,meta:item.meta};
      cropUrl = crop.toDataURL('image/jpeg');
      plateInput = item.s.plate;
      const candidates = [...new Set([item.s.plate,...item.variants].filter(Boolean))];
      ocr = {plate:plateInput,candidates,confidence:0,rawText:item.s.raw || plateInput,durationMs:0,engine:'patrol'};
      fromPatrol = true;
      phase = 'confirm';
      queue.shift();
      await patrol.release({path:item.s.path});
    } catch (e) { phase = 'no_camera'; cameraMessage = (e as Error).message; }
    app.update();
  };

  const beginPatrol = async (mode:'walking'|'vehicle') => {
    if (nativeActive || !list) return;
    nativeActive = true;
    try {
      const [hot,allow,observed] = await Promise.all([getHotLists(),getAllowLists(),getActiveObservations(list.id)]);
      const selected = list;
      const keys = new Set([...hot.flatMap(l => l.entries),...allow.filter(l => selected.type === 'allow' ? l.id === selected.id : selected.type === 'timed' && selected.allowListIds.includes(l.id)).flatMap(l => l.entries),...observed].map(e => plateKey(e.plate)));
      listeners.push(await patrol.addListener('sighting', s => {
        // Best fix produced at or before the frame; a later fix must not displace older valid ones.
        const location = geo.bestRecent(s.at, s.at);
        void logDiag('sighting', { mode, manual: !!s.manual, captureMode: s.captureMode, plate: s.plate, raw: s.raw ?? s.plate, zoom: s.zoom, fix: fixInfo(location, s.at) });
        queue.push({s,variants:[],meta:{capturedAt:s.at,capturedAtLocal:toLocalIso(s.at),timeZone:deviceTimeZone(),location,
          locationAgeMs:location ? s.at-location.timestamp:null,userAgent:navigator.userAgent,
          payment:selected.type === 'timed' ? structuredClone(selected.payment) : undefined}});
        if (keys.has(s.plate) && settings().sound) void patrol.alert();
      }));
      listeners.push(await patrol.addListener('variant', v => {
        void logDiag('variant', { mode, plate: v.plate, variant: v.variant });
        // Attach to the latest capture of that plate; offered as a candidate chip at review.
        const item = [...queue].reverse().find(q => q.s.plate === v.plate);
        if (item && !item.variants.includes(v.variant)) item.variants.push(v.variant);
      }));
      listeners.push(await patrol.addListener('zoom', ({ratio}) => void app.updateSettings({cameraZoom: ratio})));
      listeners.push(await patrol.addListener('stats', stats => void logDiag('patrol_stats', {...stats})));
      listeners.push(await patrol.addListener('camera', info => void logDiag('patrol_camera', {mode, ...info})));
      listeners.push(await patrol.addListener('finished',async () => {
        nativeActive=false;
        void logDiag('patrol_end', { mode, queued: queue.length });
        await Promise.all(listeners.splice(0).map(h => h.remove()));
        if (!disposed) await reviewNext();
      }));
      await camera.stop();
      void logDiag('patrol_start', { mode, captureMode: 'multi', zoom: settings().cameraZoom });
      await patrol.start({mode, captureMode: 'multi', zoom: settings().cameraZoom, presets: [...ZOOM_PRESETS], diagnostics: settings().diagnostics});
    } catch(e) {
      nativeActive=false;
      await Promise.all(listeners.splice(0).map(h => h.remove()));
      app.toast((e as Error).message,'error');
      if (!queue.length) await startCamera();
    }
  };

  const resetToLive = () => {
    fromPatrol = false;
    suggestions = [];
    dismissed = '';
    editing = false;
    confirmError = null;
    pending = null;
    ocr = null;
    ocrError = '';
    plateInput = '';
    result = null;
    evidence = null;
    cropUrl = '';
    frameUrl = '';
    urls.revokeAll();
    if (!camera.active && hasPatrol()) { void reviewNext(); return; }
    phase = camera.active ? 'live' : 'no_camera';
    app.update();
  };

  /* ───────────────────────────── Capture ───────────────────────────── */

  /**
   * Android app: ML Kit reads `wide` (the guide plus a margin, so a plate not quite inside the box
   * is still read). Browser, or if ML Kit fails: Tesseract on the guide crop.
   */
  const runOcr = async (crop: HTMLCanvasElement, mode: 'line' | 'sparse', wide?: HTMLCanvasElement) => {
    try {
      if (hasNativeOcr()) {
        try {
          ocr = await recognisePlateNative(wide ?? crop);
        } catch (e) {
          void logDiag('ocr_fallback', { error: (e as Error).message });
          ocr = await recognisePlate(crop, mode);
        }
      } else {
        ocr = await recognisePlate(crop, mode);
      }
      plateInput = ocr.plate;
    } catch (e) {
      console.error(e);
      ocrError = `Text recognition failed: ${(e as Error).message || 'unknown error'}. Enter the plate manually.`;
    }
  };

  const capture = async (manual = false) => {
    if (phase !== 'live') return;
    unlockAudio();
    const video = videoRef.value;
    const guide = guideRef.value;
    if (!video || !guide) return;
    phase = 'processing';
    ocrStatus = null;
    feedback('shutter', settings());
    app.update();
    try {
      const frame = camera.captureFrame();
      const metaPromise = captureMeta();
      const vr = video.getBoundingClientRect();
      const gr = guide.getBoundingClientRect();
      const guideRect = mapCoverRect(
        { x: gr.left - vr.left, y: gr.top - vr.top, width: gr.width, height: gr.height },
        { width: vr.width, height: vr.height },
        { width: frame.width, height: frame.height },
      );
      const crop = cropCanvas(frame, padRect(guideRect, 0.06, frame));
      const wide = hasNativeOcr() ? cropCanvas(frame, padRect(guideRect, 0.35, frame)) : undefined;
      cropUrl = crop.toDataURL('image/jpeg', 0.85);
      const meta = await metaPromise;
      if (list?.type === 'timed' && list.payment) meta.payment = structuredClone(list.payment);
      pending = { frame, crop, meta };
      if (!manual) await runOcr(crop, 'line', wide);
      void logDiag('capture', {
        surface: 'default',
        manual,
        engine: manual ? null : (ocr?.engine ?? null),
        ocrMs: ocr?.durationMs ?? null,
        plate: ocr?.plate ?? '',
        candidates: ocr?.candidates ?? [],
        rawText: ocr?.rawText ?? '',
        zoom: camera.zoom,
        frameWidth: frame.width,
        frameHeight: frame.height,
        cropWidth: crop.width,
        cropHeight: crop.height,
        fix: fixInfo(meta.location, meta.capturedAt),
      });
      phase = 'confirm';
    } catch (e) {
      app.toast((e as Error).message || 'Capture failed.', 'error');
      phase = 'live';
    }
    app.update();
    if (phase === 'confirm') queueMicrotask(() => plateInputRef.value?.focus());
  };

  const captureFromFile = async (file: File) => {
    unlockAudio();
    phase = 'processing';
    app.update();
    try {
      const metaPromise = captureMeta();
      const frame = await fileToCanvas(file);
      const meta = await metaPromise;
      if (list?.type === 'timed' && list.payment) meta.payment = structuredClone(list.payment);
      pending = { frame, crop: frame, meta };
      frameUrl = urls.get(file);
      cropUrl = '';
      await runOcr(frame, 'sparse');
      void logDiag('capture', {
        surface: 'photo',
        engine: ocr?.engine ?? null,
        ocrMs: ocr?.durationMs ?? null,
        plate: ocr?.plate ?? '',
        rawText: ocr?.rawText ?? '',
        frameWidth: frame.width,
        frameHeight: frame.height,
        fix: fixInfo(meta.location, meta.capturedAt),
      });
      phase = 'confirm';
    } catch (e) {
      app.toast(`Could not read image: ${(e as Error).message}`, 'error');
      if (!camera.active && hasPatrol()) { void reviewNext(); return; }
    phase = camera.active ? 'live' : 'no_camera';
    }
    app.update();
  };

  /* ───────────────────────────── Check ───────────────────────────── */

  const ensureEvidence = async (plate: string): Promise<Evidence> => {
    if (!pending || !list) throw new Error('No capture.');
    evidence ??= await buildEvidence(pending, plate, list, __APP_VERSION__);
    return evidence;
  };

  const makeRecord = async (
    plate: string,
    targetListId: string,
    outcome: ScanOutcome,
    observationId: string | null,
  ): Promise<ScanRecord> => {
    const ev = await ensureEvidence(plate);
    const p = pending!;
    const corrected = !!ocr && normalisePlate(ocr.plate) !== plate;
    // OCR accuracy in the field: what was read against what the officer confirmed.
    void logDiag('record', { engine: ocr?.engine ?? null, ocrPlate: ocr?.plate ?? '', plate, corrected, outcome });
    return {
      id: uid(),
      listId: targetListId,
      observationId,
      plate,
      key: plateKey(plate),
      ocrText: ocr?.rawText ?? '',
      ocrEngine: ocr?.engine ?? null,
      ocrConfidence: ocr?.durationMs && ocr.engine === 'tesseract' ? ocr.confidence : null,
      corrected,
      outcome,
      meta: p.meta,
      image: ev.image,
      thumb: ev.thumb,
      sha256: ev.sha256,
      createdAt: Date.now(),
    };
  };

  const recordResighting = async (
    plate: string,
    d: Extract<Decision, { kind: 'timed_resighting' }>,
  ): Promise<{ saved: ScanRecord; comparison: Comparison | null }> => {
    const obs = d.observation;
    const saved = await makeRecord(plate, obs.listId, d.overstay ? 'overstay' : 'within_allowance', obs.id);
    const updated: Observation = {
      ...obs,
      lastScanId: saved.id,
      scanCount: obs.scanCount + 1,
      overstayFlaggedAt: d.overstay ? (obs.overstayFlaggedAt ?? saved.meta.capturedAt) : obs.overstayFlaggedAt,
    };
    await saveScan(saved, updated);
    const first = await getScan(obs.firstScanId);
    return {
      saved,
      comparison: first
        ? { observation: updated, first, current: saved, elapsedMs: d.elapsedMs, remainingMs: d.remainingMs, overstay: d.overstay }
        : null,
    };
  };

  const recordNew = async (plate: string, l: TimedList, at: number, instance: NonNullable<ReturnType<typeof restrictionInForce>>) => {
    const obsId = uid();
    const saved = await makeRecord(plate, l.id, 'recorded', obsId);
    const obs = newObservation({ id: obsId, list: l, plate, scanId: saved.id, at, instance });
    await saveScan(saved, obs);
    return saved;
  };

  /**
   * Patrol review: discard the capture from the intended list. It is kept, with its evidence
   * frame and metadata, in the global Dismissed list (Home → Dismissed) and starts no timing.
   */
  const dismiss = async () => {
    if (!pending || !list || phase !== 'confirm') return;
    const plate = normalisePlate(plateInput);
    // Officer safety: a hot-list plate is never dismissed without a second look.
    const hot = plate ? (await getHotLists()).find(h => h.entries.some(e => plateKey(e.plate) === plateKey(plate))) : undefined;
    if (hot && !(await app.confirm({
      title: 'Hot list plate',
      body: `${plate} is on the hot list “${hot.name}”. Dismiss it anyway?`,
      confirmLabel: 'Dismiss',
      cancelLabel: 'Keep reviewing',
      danger: true,
    }))) return;
    phase = 'saving';
    app.update();
    try {
      const ev = await ensureEvidence(plate || '—');
      await saveDismissed({
        id: uid(),
        plate,
        ocrText: ocr?.rawText ?? '',
        ocrEngine: ocr?.engine ?? null,
        intendedListId: list.id,
        intendedListName: list.name,
        meta: pending.meta,
        image: ev.image,
        thumb: ev.thumb,
        sha256: ev.sha256,
        createdAt: Date.now(),
      });
      // Which readings officers throw away: the false-capture rate for the next field test.
      void logDiag('dismiss', { engine: ocr?.engine ?? null, ocrPlate: ocr?.plate ?? '', plate, listId: list.id });
      app.toast(`${plate || 'Capture'} dismissed`, 'info');
    } catch (e) {
      phase = 'confirm';
      confirmError = { title: 'Could not dismiss this capture', body: (e as Error).message };
      app.update();
      return;
    }
    resetToLive();
  };

  const check = async () => {
    if (!pending || !list || phase !== 'confirm') return;
    const plate = normalisePlate(plateInput);
    if (!isValidPlate(plate)) {
      confirmError = { title: 'Enter a valid number plate', body: 'Letters and digits only, as shown on the plate.', field: 'plate' };
      app.update();
      plateInputRef.value?.focus();
      return;
    }
    if (settings().requireLocation && !pending.meta.location) {
      confirmError = { title: 'GPS fix required before checking', body: 'Move to open sky and retake. This requirement is set in Settings → Scanning.' };
      app.update();
      return;
    }
    confirmError = null;
    phase = 'saving';
    app.update();
    try {
      const l = (await getList(listId)) ?? list;
      list = l;
      const [hotLists, allowLists, observations] = await Promise.all([
        getHotLists(),
        getAllowLists(),
        l.type === 'timed' ? getActiveObservations(l.id) : Promise.resolve([] as Observation[]),
      ]);
      // Evaluate against the shutter time, not the moment the officer pressed "Check".
      const at = pending.meta.capturedAt;
      const res = evaluate({ at, plate, list: l, hotLists, allowLists, observations });
      const candidates = [...hotLists, ...allowLists.filter(a => l.type === 'allow' ? a.id === l.id : l.type === 'timed' && l.allowListIds.includes(a.id))]
        .flatMap(source => source.entries.filter(entry => comparePlates(plate, entry.plate) === 'possible').map(entry => entry.plate + ' · ' + source.name));
      if (res.decision.kind === 'timed_possible') candidates.push(...res.decision.candidates.map(o => o.plate + ' · ' + l.name));
      if (candidates.length && dismissed !== plate) {
        suggestions = [...new Set(candidates)];
        phase = 'confirm';
        app.update();
        return;
      }
      if (dismissed === plate) {
        res.hotHits = res.hotHits.filter(h => h.strength === 'exact');
        if (res.decision.kind === 'timed_possible') res.decision = {kind:'timed_new', instance:res.decision.instance};
        if (res.decision.kind === 'hot_match' && !res.hotHits.some(h => h.list.id === l.id)) res.decision = {kind:'hot_none'};
        if (res.decision.kind === 'allow_none') res.decision.possible = [];
      }
      await expireObservations(res.expireObservationIds, at);
      // Payment to check, and to keep with the evidence: the numbers tied to the restriction in force.
      if (l.type === 'timed' && l.payment) pending.meta.payment = paymentFor(l.payment, restrictionFor(l, res.decision));

      let saved: ScanRecord | null = null;
      let comparison: Comparison | null = null;
      const possibleFirsts = new Map<string, ScanRecord>();

      // Officer-safety evidence: record exact hot-list sightings.
      for (const hit of res.hotHits.filter((h) => h.strength === 'exact')) {
        const rec = await makeRecord(plate, hit.list.id, 'hot_sighting', null);
        await saveScan(rec);
        if (hit.list.id === l.id) saved = rec;
      }

      const d = res.decision;
      if (l.type === 'timed') {
        if (d.kind === 'timed_exempt') {
          // Evidence that the permit vehicle was seen here; no allowance clock is started.
          saved = await makeRecord(plate, l.id, 'permit_valid', null);
          await saveScan(saved);
        } else if (d.kind === 'timed_new') saved = await recordNew(plate, l, at, d.instance);
        else if (d.kind === 'timed_resighting') ({ saved, comparison } = await recordResighting(plate, d));
        else if (d.kind === 'timed_possible') {
          for (const o of d.candidates) {
            const s = await getScan(o.firstScanId);
            if (s) possibleFirsts.set(o.id, s);
          }
        }
      }

      result = { plate, decision: d, hotHits: res.hotHits, comparison, saved, possibleFirsts };
      phase = 'result';
      const s = settings();
      if (res.hotHits.length) feedback('alarm', s);
      else if (d.kind === 'timed_resighting') feedback(d.overstay ? 'warn' : 'info', s);
      else if (d.kind === 'timed_possible') feedback('warn', s);
      else feedback('ok', s);
    } catch (e) {
      console.error(e);
      confirmError = { title: 'Check failed', body: `${(e as Error).message} The capture is kept: check again or retake.` };
      phase = 'confirm';
    }
    app.update();
    window.scrollTo(0, 0);
  };

  /** Officer resolved a fuzzy re-sighting candidate. */
  const resolvePossible = async (obs: Observation | null) => {
    if (!result || !list || list.type !== 'timed' || result.decision.kind !== 'timed_possible' || !pending) return;
    const d = result.decision;
    const l = list;
    phase = 'saving';
    app.update();
    try {
      const at = pending.meta.capturedAt;
      if (obs) {
        const r = resighting(obs, at);
        const { saved, comparison } = await recordResighting(result.plate, r);
        result = { ...result, decision: r, saved, comparison };
        feedback(r.overstay ? 'warn' : 'info', settings());
      } else {
        const saved = await recordNew(result.plate, l, at, d.instance);
        result = { ...result, decision: { kind: 'timed_new', instance: d.instance }, saved };
        feedback('ok', settings());
      }
      phase = 'result';
    } catch (e) {
      app.toast(`Save failed: ${(e as Error).message}`, 'error');
      phase = 'result';
    }
    app.update();
  };

  /** Vehicle has moved since the first sighting: close the old chalk and restart from this scan. */
  const resetObservation = async () => {
    if (!result?.comparison || !list || list.type !== 'timed') return;
    const { observation, current } = result.comparison;
    const ok = await app.confirm({
      title: 'Vehicle moved?',
      body: `Close the current timing for ${observation.plate} and start a new allowance from this scan (${formatClock(current.meta.capturedAt)}).`,
      confirmLabel: 'Restart timing',
    });
    if (!ok) return;
    const at = current.meta.capturedAt;
    await putObservation({ ...observation, status: 'reset', closedAt: at });
    const instance = restrictionInForce(list, at);
    if (!instance) {
      app.toast('Timing closed. No restriction is in force, so no new allowance was started.', 'warn');
      resetToLive();
      return;
    }
    const obsId = uid();
    const updatedScan: ScanRecord = { ...current, observationId: obsId, outcome: 'recorded' };
    const obs = newObservation({ id: obsId, list, plate: current.plate, scanId: current.id, at, instance });
    await saveScan(updatedScan, obs);
    app.toast(`New ${instance.restriction.code} allowance started for ${current.plate}.`, 'success');
    resetToLive();
  };

  /* ────────────────────────────── Render ────────────────────────────── */

  /** GPS accuracy: colour + icon + text. Poor or missing GPS is amber (act: move to open sky), never red. */
  const geoBadge = (onCamera = true): TemplateResult => {
    const warn = settings().accuracyWarnMetres;
    const base = 'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm font-semibold whitespace-nowrap';
    if (geoState.status === 'fix') {
      const acc = `±${Math.round(geoState.fix.accuracy)} m`;
      const tone = accuracyTone(geoState.fix.accuracy, warn);
      if (tone === 'good') return html`<span class="${base} ${TONE_PILL.active}" data-gps="good">${icon('pin', 'h-4 w-4')} ${acc}</span>`;
      if (tone === 'fair') return html`<span class="${base} ${onCamera ? 'border-white/40 bg-black/50 text-white' : TONE_PILL.inactive}" data-gps="fair">${icon('pin', 'h-4 w-4')} ${acc}</span>`;
      return html`<span class="${base} ${TONE_PILL.alert}" data-gps="poor">${icon('alert', 'h-4 w-4')} Poor GPS ${acc}</span>`;
    }
    const label =
      geoState.status === 'denied'
        ? 'GPS denied'
        : geoState.status === 'unsupported'
          ? 'No GPS'
          : geoState.status === 'error'
            ? 'GPS error'
            : 'GPS…';
    const searching = geoState.status === 'idle' || geoState.status === 'searching';
    return html`<span class="${base} ${searching ? (onCamera ? 'border-white/40 bg-black/50 text-white' : TONE_PILL.inactive) : TONE_PILL.alert}">${icon(searching ? 'pin' : 'alert', 'h-4 w-4')} ${label}</span>`;
  };

  /* Camera chrome stays dark: it sits over the live image (functional, not brand — assessment D1). */
  const topBar = (): TemplateResult => html`<div class="absolute inset-x-0 top-0 z-20 flex items-center gap-2 bg-gradient-to-b from-black/80 to-transparent px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-6">
    <button type="button" class="btn min-h-11 px-2 text-white hover:bg-white/10" aria-label="Back" @click=${() => app.navigate(`/list/${listId}`)}>${icon('back', 'h-6 w-6')}</button>
    <div class="min-w-0 flex-1">
      <p class="truncate font-bold text-white">${list?.name ?? ''}</p>
      <p class="truncate text-xs text-white/80">${list?.type === 'timed' ? segmentLabel(list) : list?.type === 'hot' ? 'Hot list scan' : 'Allow list check'}</p>
    </div>
    ${settings().diagnostics
      ? html`<span class="inline-flex items-center gap-1 rounded-full border border-white/40 bg-black/50 px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-white" data-testid="diag-indicator" title="Field diagnostics recording">${icon('activity', 'h-3.5 w-3.5')} DIAG</span>`
      : nothing}
    <span class="font-plate text-sm text-white tabular-nums">${formatClock(Date.now())}</span>
    ${geoBadge()}
  </div>`;

  /* Zoom: tap a preset to jump to it; long-press any preset to open the slider. */
  const chooseZoom = async (z: number, persist: boolean) => {
    if (!caps.zoom) return;
    await camera.setZoom(clampZoom(z, caps.zoom));
    if (persist) await app.updateSettings({ cameraZoom: camera.zoom });
    else app.update();
  };

  const zoomControls = (): TemplateResult | typeof nothing => {
    if (!caps.zoom) return nothing;
    const range = sliderRange(caps.zoom);
    const startPress = () => {
      longPressed = false;
      clearTimeout(pressTimer);
      pressTimer = window.setTimeout(() => {
        longPressed = true;
        zoomSliderOpen = !zoomSliderOpen;
        app.update();
      }, LONG_PRESS_MS);
    };
    const endPress = () => clearTimeout(pressTimer);
    return html`<div class="mb-4" data-testid="zoom-controls">
      ${zoomSliderOpen
        ? html`<label class="mb-3 flex items-center gap-3 text-sm text-white">
            <span class="w-12 font-plate tabular-nums">${formatZoom(camera.zoom)}</span>
            <input type="range" class="flex-1 accent-accent" aria-label="Zoom" data-testid="zoom-slider"
              min=${range.min} max=${range.max} step=${range.step} .value=${String(camera.zoom)}
              @input=${(e: Event) => void chooseZoom(Number((e.target as HTMLInputElement).value), false)}
              @change=${(e: Event) => void chooseZoom(Number((e.target as HTMLInputElement).value), true)} />
          </label>`
        : nothing}
      <div class="flex justify-center">
        <button type="button" data-testid="zoom-button"
          class="min-h-12 min-w-20 rounded-full border border-white/50 bg-black/50 px-4 font-plate text-base font-semibold tabular-nums text-white"
          aria-label=${`Zoom ${formatZoom(camera.zoom)}. Tap for the next zoom step, long-press for a custom zoom.`}
          @pointerdown=${startPress} @pointerup=${endPress} @pointerleave=${endPress} @pointercancel=${endPress}
          @contextmenu=${(e: Event) => e.preventDefault()}
          @click=${() => {
            if (longPressed) { longPressed = false; return; }
            zoomSliderOpen = false;
            void chooseZoom(nextPreset(camera.zoom, range), true);
          }}>${formatZoom(camera.zoom)}</button>
      </div>
    </div>`;
  };

  const cameraButton = 'btn min-h-14 w-16 flex-col gap-0 px-0 text-xs text-white hover:bg-white/10';

  const liveControls = (): TemplateResult => html`<div class="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 to-transparent px-4 pt-10 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
    ${hasPatrol() ? html`<div class="mx-auto mb-4 grid max-w-md grid-cols-2 gap-3">
        <button type="button" class="btn-secondary w-full justify-center" aria-label="Start walking patrol" @click=${() => beginPatrol('walking')}>${icon('walking')} Walking</button>
        <button type="button" class="btn-secondary w-full justify-center" aria-label="Start vehicle patrol" @click=${() => beginPatrol('vehicle')}>${icon('vehicle')} Vehicle</button>
      </div>` : nothing}
    ${zoomControls()}
    <div class="flex items-center justify-between">
      <button type="button" class=${cameraButton} @click=${() => void capture(true)} ?disabled=${phase !== 'live'}>
        ${icon('keyboard', 'h-6 w-6', 1.75)} Manual
      </button>
      <button type="button" aria-label="Capture number plate" data-testid="shutter"
        class="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white/20 transition active:scale-[0.96] disabled:opacity-40"
        ?disabled=${phase !== 'live'} @click=${() => void capture(false)}>
        ${phase === 'processing' ? spinner('h-8 w-8 text-white') : html`<span class="h-14 w-14 rounded-full bg-white"></span>`}
      </button>
      ${caps.torch
        ? html`<button type="button" class="${cameraButton} ${camera.torchOn ? 'text-accent' : ''}" aria-pressed=${camera.torchOn}
            @click=${async () => { await camera.setTorch(!camera.torchOn); app.update(); }}>${icon('torch', 'h-6 w-6', 1.75)} ${camera.torchOn ? 'Torch on' : 'Torch'}</button>`
        : html`<button type="button" class=${cameraButton} @click=${() => fileRef.value?.click()}>
            ${icon('upload', 'h-6 w-6', 1.75)} Photo
          </button>`}
    </div>
    ${phase === 'processing'
      ? html`<p class="mt-3 text-center text-sm text-white">${ocrStatus && ocrStatus.progress < 1 ? `${ocrStatus.status} ${Math.round(ocrStatus.progress * 100)}%` : 'Reading plate…'}</p>`
      : html`<p class="mt-3 text-center text-sm text-white/80">Fit the number plate inside the frame</p>`}
  </div>`;

  const cameraLayer = (): TemplateResult => html`<div class="fixed inset-0 z-10 bg-black ${phase === 'live' || phase === 'processing' || phase === 'starting' ? '' : 'invisible'}">
    <video ${ref(videoRef)} class="h-full w-full object-cover" autoplay muted playsinline></video>
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div ${ref(guideRef)} class="scan-guide relative aspect-[3/1] w-[82%] max-w-xl rounded-md border-4 border-accent">
        <span class="absolute -top-7 left-0 text-xs font-semibold text-white">Plate</span>
      </div>
    </div>
    ${phase === 'starting' ? html`<div class="absolute inset-0 flex items-center justify-center text-white">${spinner('h-10 w-10')}</div>` : nothing}
    ${topBar()}
    ${liveControls()}
  </div>`;

  const metaSummary = (p: PendingCapture): TemplateResult => {
    const loc = p.meta.location;
    const warn = settings().accuracyWarnMetres;
    return html`<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt class="text-neutral-600">Time</dt>
      <dd class="font-plate text-neutral-900" title=${p.meta.capturedAtLocal}>${formatStamp(p.meta.capturedAt)}</dd>
      <dt class="text-neutral-600">Zone</dt>
      <dd class="text-neutral-900">${p.meta.timeZone}</dd>
      <dt class="text-neutral-600">Location</dt>
      <dd>
        ${loc
          ? html`<span class="font-plate text-neutral-900">${formatLatLng(loc)}</span>
              ${loc.accuracy > warn
                ? html`<span class="ml-1 inline-flex items-center gap-1 font-semibold text-alert-strong">${icon('alert', 'h-4 w-4')} ±${Math.round(loc.accuracy)} m · low accuracy</span>`
                : html`<span class="ml-1 inline-flex items-center gap-1 text-active-strong">${icon('check', 'h-4 w-4')} ±${Math.round(loc.accuracy)} m</span>`}`
          : html`<span class="inline-flex items-center gap-1 font-semibold text-alert-strong">${icon('alert', 'h-4 w-4')} Unavailable — no GPS fix</span>`}
      </dd>
    </dl>`;
  };

  const confirmPanel = (): TemplateResult => {
    const p = pending!;
    const busy = phase === 'saving';
    return html`${header({
        title: 'Confirm plate',
        subtitle: list?.name,
        back: busy ? undefined : () => (fromPatrol ? void dismiss() : resetToLive()),
        actions: fromPatrol
          ? html`<span class="px-2 text-sm text-white/90" data-testid="review-remaining">${queue.length ? `${queue.length} more to review` : 'Last capture'}</span>`
          : nothing,
      })}
      <div class="mx-auto max-w-xl px-4 pt-4 pb-28">
      ${cropUrl || frameUrl
        ? html`<img src=${cropUrl || frameUrl} alt="Captured plate" class="w-full rounded-md border border-neutral-200 bg-black object-contain ${frameUrl ? 'max-h-64' : 'max-h-40'}" />`
        : nothing}
      ${suggestions.length
        ? nearMatchSheet({
            imageUrl: cropUrl || frameUrl,
            plate: plateInput,
            suggestions,
            onEdit: () => { suggestions = []; editing = true; app.update(); plateInputRef.value?.focus(); },
            onNotMatch: () => { suggestions = []; dismissed = normalisePlate(plateInput); void check(); },
          })
        : nothing}
      ${confirmError ? html`<div class="mt-4">${banner('alert', confirmError.title, confirmError.body, 'confirm-error')}</div>` : nothing}
      <form class="card mt-4" @submit=${(e: Event) => { e.preventDefault(); void check(); }}>
        <label for="plate" class="field-label">Number plate (editable)</label>
        <input ${ref(plateInputRef)} id="plate" name="plate" data-testid="plate-input"
          class="field text-center font-plate text-3xl font-bold tracking-[0.3em] uppercase ${confirmError?.field === 'plate' ? 'field-invalid' : ''}"
          aria-invalid=${confirmError?.field === 'plate' ? 'true' : 'false'}
          .value=${plateInput} maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text"
          @input=${(e: Event) => {
            plateInput = (e.target as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (confirmError?.field === 'plate') { confirmError = null; app.update(); }
          }} />
        ${ocr
          ? html`<p class="mt-2 text-xs text-neutral-600">${ocr.durationMs ? 'OCR confidence ' + ocr.confidence + '% · ' + ocr.durationMs + ' ms' : 'Patrol reading'}${ocr.rawText ? html` · raw <span class="font-plate">“${ocr.rawText}”</span>` : nothing}</p>
              ${ocr.candidates.length > 1
                ? html`<div class="mt-2 flex flex-wrap gap-2" role="group" aria-label="Other readings">
                    ${ocr.candidates.map(
                      (c) => html`<button type="button" class="chip-button font-plate" aria-pressed=${plateInput === c} @click=${() => { plateInput = c; if (confirmError?.field === 'plate') confirmError = null; app.update(); }}>${c}</button>`,
                    )}
                  </div>`
                : nothing}`
          : html`<p class="mt-2 text-xs text-neutral-600">${ocrError || 'Manual entry'}</p>`}
        <div class="mt-4 border-t border-neutral-200 pt-3">${metaSummary(p)}</div>
        <div class="mt-4 grid grid-cols-2 gap-3">
          ${fromPatrol
            ? html`<button type="button" class="btn-secondary" data-testid="dismiss" @click=${() => void dismiss()} ?disabled=${busy}>${icon('archive')} Dismiss</button>`
            : html`<button type="button" class="btn-secondary" @click=${resetToLive} ?disabled=${busy}>${icon('refresh')} Retake</button>`}
          <button type="submit" class="btn-primary" data-testid="check" ?disabled=${busy}>${busy ? spinner() : icon('check')} ${editing ? 'Save and recheck' : 'Check'}</button>
        </div>
      </form>
    </div>`;
  };

  /**
   * Officer-safety interrupt (WF-S27 27g). Persistent, never a toast, no pulse. Drawn as an
   * interaction-required (amber) alert: red stays reserved for Code 1 pending OQ27-1.
   */
  const hotAlert = (hits: HotHit[]): TemplateResult => html`<section class="overflow-hidden rounded-md border-4 border-alert bg-surface shadow-xl" role="alert" data-testid="hot-alert">
    <div class="flex items-center gap-3 bg-alert px-4 py-3 text-alert-text">
      ${icon('shield', 'h-9 w-9', 1.75)}
      <div>
        <p class="text-xs font-bold tracking-[0.08em] uppercase">Officer safety</p>
        <p class="text-xl font-bold">Hot list match</p>
      </div>
    </div>
    <ul class="grid gap-3 p-4">
      ${hits.map(
        (h) => html`<li class="rounded-md border border-alert-border bg-alert-bg p-3">
          <div class="flex flex-wrap items-center gap-2">
            ${plateBadge(h.entry.plate, 'lg')}
            ${riskPill(h.entry.riskLevel, RISK_LEVEL_LABELS[h.entry.riskLevel])}
            ${h.strength === 'possible' ? statusPill('verify', 'Possible match — verify plate') : nothing}
          </div>
          <p class="mt-2 text-md font-bold text-neutral-900">${[h.entry.colour, h.entry.make, h.entry.model, h.entry.bodyType].filter(Boolean).join(' ') || 'No vehicle description'}</p>
          <div class="mt-2 flex flex-wrap gap-2">${h.entry.risks.map((r) => html`<span class="chip border-alert-border bg-surface text-sm text-alert-strong">${RISK_TAG_LABELS[r]}</span>`)}</div>
          ${h.entry.notes ? html`<p class="mt-2 text-sm whitespace-pre-line text-neutral-800">${h.entry.notes}</p>` : nothing}
          <p class="mt-2 text-xs text-neutral-700">List: ${h.list.name}</p>
        </li>`,
      )}
    </ul>
  </section>`;

  const evidenceTile = (label: string, s: ScanRecord): TemplateResult => html`<figure class="min-w-0">
    <figcaption class="mb-1 text-xs font-semibold text-neutral-700">${label}</figcaption>
    <a href="#/record/${s.id}"><img src=${urls.get(s.image)} alt="${label} evidence" class="aspect-[4/3] w-full rounded-md border border-neutral-200 bg-black object-cover" /></a>
    <p class="mt-1 font-plate text-sm text-neutral-900">${formatClock(s.meta.capturedAt)}</p>
    <p class="text-xs text-neutral-600">${s.meta.location ? `±${Math.round(s.meta.location.accuracy)} m` : 'no GPS'}</p>
  </figure>`;

  /** Re-sighting: within allowance = Pending blue (passive), overstay = amber (officer must act). */
  const comparisonPanel = (c: Comparison): TemplateResult => {
    const o = c.observation;
    const tone = c.overstay ? 'alert' : 'pending';
    return html`<section class="rounded-md border-2 ${TONE_PANEL[tone]} p-4" data-testid="comparison" data-tone=${tone}>
      ${c.overstay ? statusPill('overstay') : statusPill('within_allowance')}
      <div class="mt-2 flex items-end justify-between gap-3">
        ${plateBadge(o.plate, 'lg')}
        <div class="text-right">
          <p class="text-xs text-neutral-700">Elapsed since scan 1</p>
          <p class="font-plate text-2xl font-bold whitespace-nowrap ${TONE_TEXT[tone]}" data-testid="elapsed">${formatDuration(c.elapsedMs)}</p>
        </div>
      </div>
      <p class="mt-2 text-sm text-neutral-800">
        <span class="font-plate">${o.restrictionCode}</span> allowance ${formatMinutes(o.limitMinutes)}${o.graceMinutes ? ` + ${formatMinutes(o.graceMinutes)} grace` : ''} ·
        ${c.remainingMs > 0 ? html`<strong>${formatDuration(c.remainingMs)} remaining</strong>` : html`<strong class="text-alert-strong">exceeded by ${formatDuration(-c.remainingMs)}</strong>`}
      </p>
      <div class="mt-4 grid grid-cols-2 gap-3">${evidenceTile('Scan 1', c.first)}${evidenceTile(`Scan ${o.scanCount}`, c.current)}</div>
      <button type="button" class="btn-secondary mt-4 w-full" @click=${resetObservation}>${icon('refresh')} Vehicle moved — restart timing</button>
    </section>`;
  };

  const statusCard = (kind: StatusKind, title: string, body: TemplateResult | string, testid: string, pillLabel?: string) => {
    const tone = STATUS[kind].tone;
    return html`<section class="rounded-md border-2 ${TONE_PANEL[tone]} p-4" data-testid=${testid} data-tone=${tone}>
      ${statusPill(kind, pillLabel)}
      <p class="mt-2 text-lg font-bold text-neutral-900">${title}</p>
      <div class="mt-1 text-neutral-800">${body}</div>
    </section>`;
  };

  const decisionPanel = (r: ResultState): TemplateResult => {
    const d = r.decision;
    switch (d.kind) {
      case 'timed_exempt': {
        const e = d.hit.entry;
        return statusCard(
          'permit_valid',
          'Permit valid',
          html`<p>Sighting recorded; no time limit applies.</p>
            <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
              <dt class="text-neutral-600">List</dt><dd class="font-semibold">${d.hit.list.name}</dd>
              ${e.label ? html`<dt class="text-neutral-600">Label</dt><dd>${e.label}</dd>` : nothing}
              ${e.permitNo ? html`<dt class="text-neutral-600">Permit</dt><dd class="font-plate">#${e.permitNo}</dd>` : nothing}
              ${e.validFrom || e.validTo ? html`<dt class="text-neutral-600">Valid</dt><dd>${e.validFrom ? formatIsoDate(e.validFrom) : 'any time'} to ${e.validTo ? formatIsoDate(e.validTo) : 'no end date'}</dd>` : nothing}
            </dl>`,
          'result-exempt',
        );
      }
      case 'timed_not_in_force':
        // An imported placeholder: the segment exists but its signs are still to be entered (WF-S26 26a.8, WF-S27 27e).
        if (list?.type === 'timed' && !list.restrictions.length)
          return statusCard(
            'restrictions_to_enter',
            'Restrictions not entered yet',
            'This segment was imported without its parking restrictions. Add them under Edit list, then re-scan. No record created.',
            'result-not-in-force',
          );
        return statusCard(
          'not_in_force',
          'Restriction not in force',
          html`<p>${d.next ? html`Next restriction <span class="font-plate">${d.next.restriction.code}</span> from ${formatDateTime(d.next.start)}.` : 'No upcoming restriction found.'} No record created.</p>
            ${pending ? html`<p class="mt-1 text-sm text-neutral-600">Captured <span class="font-plate">${formatStamp(pending.meta.capturedAt)}</span></p>` : nothing}`,
          'result-not-in-force',
        );
      case 'timed_new': {
        const r0 = d.instance.restriction;
        const ends = (r.saved?.meta.capturedAt ?? Date.now()) + r0.limitMinutes * 60_000;
        return statusCard('timing', 'First sighting recorded', html`<span class="font-plate">${r0.code}</span> allowance (${formatMinutes(r0.limitMinutes)}) started. Expires <strong class="font-plate">${formatClock(ends)}</strong>. Re-scan after that time to check for overstay.`, 'result-recorded');
      }
      case 'timed_resighting':
        return r.comparison ? comparisonPanel(r.comparison) : statusCard(d.overstay ? 'overstay' : 'within_allowance', 'Re-sighting', `Elapsed ${formatDuration(d.elapsedMs)}.`, 'result-resighting');
      case 'timed_possible':
        return html`<section class="rounded-md border-2 ${TONE_PANEL.alert} p-4" data-testid="result-possible" data-tone="alert">
          ${statusPill('verify')}
          <p class="mt-2 text-lg font-bold text-neutral-900">Possible earlier sighting</p>
          <p class="mt-1 text-sm text-neutral-800">${r.plate} is similar to a tracked plate. Compare the images and confirm.</p>
          <ul class="mt-3 grid gap-3">
            ${d.candidates.map((o) => {
              const s = r.possibleFirsts.get(o.id);
              return html`<li class="rounded-md border border-neutral-200 bg-surface p-3">
                <div class="flex items-center gap-3">
                  ${s ? html`<img src=${urls.get(s.thumb)} alt="" class="h-16 w-24 rounded-md object-cover" />` : nothing}
                  <div>${plateBadge(o.plate, 'sm')}<p class="mt-1 text-xs text-neutral-700">First seen <span class="font-plate">${formatClock(o.startedAt)}</span></p></div>
                </div>
                <button type="button" class="btn-primary mt-3 w-full" @click=${() => void resolvePossible(o)}>Same vehicle</button>
              </li>`;
            })}
          </ul>
          <button type="button" class="btn-secondary mt-3 w-full" @click=${() => void resolvePossible(null)}>Different vehicle — record new</button>
        </section>`;
      case 'hot_match':
        return statusCard('hot_sighting', 'Sighting recorded', 'Evidence image with location and time saved to this hot list.', 'result-hot');
      case 'hot_none':
        return statusCard('not_on_list', 'No hot-list match', `${r.plate} is not on any hot list.`, 'result-hot-none', 'No match');
      case 'allow_member':
        return statusCard(
          d.validNow ? 'on_list' : 'not_valid',
          d.validNow ? 'On allow list' : 'On allow list — not currently valid',
          html`${d.hit.entry.label || 'No label'}${d.hit.entry.permitNo ? html` · permit <span class="font-plate">#${d.hit.entry.permitNo}</span>` : ''}${d.hit.entry.validTo ? ` · valid to ${formatIsoDate(d.hit.entry.validTo)}` : ''}`,
          'result-allow',
        );
      case 'allow_none':
        return statusCard(
          'not_on_list',
          'Not on this allow list',
          html`${d.possible.length ? html`Similar: ${d.possible.map((e) => html`${plateBadge(e.plate, 'sm')} `)}` : nothing}
            <button type="button" class="btn-secondary mt-3 w-full" @click=${() => app.navigate(`/list/${listId}/edit?plate=${encodeURIComponent(r.plate)}`)}>${icon('plus')} Add ${r.plate} to this list</button>`,
          'result-allow-none',
        );
    }
  };

  /** Paid parking numbers to check before enforcing; promoted to amber on an overstay (WF-S27 27c.4). */
  const paymentCard = (r: ResultState): TemplateResult | typeof nothing => {
    const lines = paymentLines(pending?.meta.payment);
    if (!['timed_new', 'timed_resighting'].includes(r.decision.kind) || !lines.length) return nothing;
    const overstay = r.decision.kind === 'timed_resighting' && r.decision.overstay;
    // The numbers tied to the restriction in force (pending.meta.payment is already narrowed to it).
    const enforced = list?.type === 'timed' ? restrictionFor(list, r.decision) : undefined;
    return html`<section class="rounded-md border p-4 shadow-sm ${overstay ? 'border-2 border-alert bg-surface' : 'border-neutral-200 bg-surface'}" data-testid="payment-check">
      <h2 class="flex items-center gap-2 text-md font-semibold text-neutral-900">${overstay ? html`<span class="text-alert-strong">${icon('alert')}</span>` : icon('info', 'h-5 w-5 text-neutral-600')} Check payment before enforcing${isPaidBy(enforced) ? html` · <span class="font-plate">${enforced.code}</span>` : nothing}</h2>
      <ul class="mt-2 grid gap-1">${lines.map((line) => html`<li class="font-plate text-sm text-neutral-800">${line}</li>`)}</ul>
    </section>`;
  };

  const resultPanel = (): TemplateResult => {
    const r = result!;
    return html`${header({ title: 'Result', subtitle: list?.name, back: () => app.navigate(`/list/${listId}`), actions: html`<span class="pr-2">${plateBadge(r.plate, 'md')}</span>` })}
      <div class="mx-auto max-w-xl px-4 pt-4 pb-32">
      <div class="grid gap-4">
        ${r.hotHits.length ? hotAlert(r.hotHits) : nothing}
        ${decisionPanel(r)}
        ${paymentCard(r)}
        ${r.saved
          ? html`<p class="text-center text-xs text-neutral-600">Saved · SHA-256 <span class="font-plate">${r.saved.sha256.slice(0, 16)}…</span> · <a class="link" href="#/record/${r.saved.id}">view record</a></p>`
          : nothing}
      </div>
      <div class="fixed inset-x-0 bottom-0 z-30 border-t border-neutral-200 bg-surface px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-lg">
        <button type="button" class="btn-primary mx-auto flex w-full max-w-xl py-4 text-md" data-testid="next-scan" ?disabled=${phase === 'saving'} @click=${resetToLive}>
          ${icon('camera', 'h-6 w-6', 1.75)} Next scan
        </button>
      </div>
    </div>`;
  };

  const noCameraPanel = (): TemplateResult => html`${header({ title: list?.name ?? 'Scan', subtitle: 'Live camera unavailable', back: () => app.navigate(`/list/${listId}`) })}
    <div class="mx-auto max-w-xl px-4 pt-4 pb-16">
    ${banner('alert', 'Live camera unavailable', cameraMessage)}
    <div class="card mt-4">
      <button type="button" class="btn-primary w-full" @click=${() => fileRef.value?.click()}>${icon('camera')} Take photo with device camera</button>
      <button type="button" class="btn-secondary mt-3 w-full" @click=${() => void startCamera()}>${icon('refresh')} Retry live camera</button>
      <p class="mt-3 text-xs text-neutral-600">Time and location are recorded when the photo is submitted.</p>
    </div>
    <div class="mt-4 flex items-center justify-center gap-2">${geoBadge(false)}</div>
  </div>`;

  return {
    async mount() {
      const found = await getList(listId);
      if (!found) {
        app.toast('List not found.', 'error');
        app.navigate('/', true);
        return;
      }
      list = found;
      unsubGeo = geo.subscribe((s) => {
        geoState = s;
        if (phase === 'live' || phase === 'starting' || phase === 'no_camera') app.update();
      });
      geo.start();
      unsubOcr = onOcrStatus((s) => {
        ocrStatus = s;
        if (phase === 'processing') app.update();
      });
      void warmUpOcr().catch((e: unknown) => console.warn('[ocr] warm-up failed', e));
      app.update();
      await startCamera();
      clock = window.setInterval(() => {
        if (phase === 'live') app.update();
      }, 1000);
      sampler = window.setInterval(() => void sample(), 60_000);
      void sample();
    },
    async unmount() {
      disposed = true;
      await Promise.all(listeners.splice(0).map(h => h.remove()));
      if (nativeActive) await patrol.stop();
      await Promise.all(queue.splice(0).map(({s}) => patrol.release({path:s.path})));
      clearInterval(clock);
      clearInterval(sampler);
      clearTimeout(pressTimer);
      unsubGeo?.();
      unsubOcr?.();
      geo.stop();
      await camera.stop();
      urls.revokeAll();
    },
    render() {
      return html`
        <input ${ref(fileRef)} type="file" accept="image/*" capture="environment" class="hidden"
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            const f = input.files?.[0];
            input.value = '';
            if (f) void captureFromFile(f);
          }} />
        ${cameraLayer()}
        ${phase === 'confirm' || (phase === 'saving' && !result) ? confirmPanel() : nothing}
        ${phase === 'result' || (phase === 'saving' && result) ? resultPanel() : nothing}
        ${phase === 'no_camera' ? noCameraPanel() : nothing}
      `;
    },
  };
}

