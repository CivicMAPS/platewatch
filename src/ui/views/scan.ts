import { patrol, hasPatrol, frameUrlFor, type Sighting } from '../../lib/patrol';
import { deviceTimeZone, localDateString, toLocalIso } from '../../lib/time';
import type { PluginListenerHandle } from '@capacitor/core';
import { isPaidBy, paymentFor, paymentLines } from '../../lib/payment';
import { html, nothing, type TemplateResult } from 'lit-html';
import { createRef, ref } from 'lit-html/directives/ref.js';
import { CameraController, CameraError, fileToCanvas, type CameraCapabilities } from '../../lib/camera';
import { buildEvidence, captureMeta, type Evidence, type PendingCapture } from '../../lib/capture';
import {
  deleteFlag,
  dismissOverstay,
  expireObservations,
  getActiveObservations,
  getFlags,
  getObservations,
  putFlag,
  getAllowLists,
  getHotLists,
  putHotEvent,
  getList,
  getScan,
  putObservation,
  saveDismissed,
  saveScan,
  uid,
} from '../../lib/db';
import { disabilityDoubles, evaluate, isStatutoryRestriction, newObservation, resighting, timingDecision, type Decision, type HotHit, type PermitHit } from '../../lib/engine';
import { applyDismissal, confirmFlag, DISABILITY_BLOCKED_TEXT, disabilityBlocked, DISMISS_LABEL, DISMISS_REASONS, FLAG_LABEL, FLAG_MESSAGE, PERMIT_STATUS_TEXT } from '../../lib/dismissal';
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
import type { AllowList, DismissReason, GeoFix, HotList, HotListEvent, LookalikeLink, TimedRestriction } from '../../lib/types';
import { ackLocation, acknowledgementEvent, canSendAlerts, trySendAlert } from '../../lib/hotlist';
import { officerNumber } from '../../lib/host';
import { firstLookalike, hotLookalikes, logChoice, permitLookalikes, sameVehicleLink, type HotLookalike, type PermitLookalike } from '../../lib/lookalike';
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
  decisionSheet,
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
  /** Set once the officer dismissed this scan's overstay alert. */
  dismissedReason?: DismissReason;
  /** hot_sighting record per hot-list entry hit (WF-S29: the acknowledgement references it). */
  hotScanIds?: Record<string, string>;
  /** Hot-list acknowledgements for this scan; Next scan stays disabled until present (29a.5). */
  hotAcks?: HotListEvent[];
}



/** A capture's GPS fix as stored on hot-list events and payment checks. */
function fixOf(loc: GeoFix | null | undefined): { lat: number; lng: number; accuracyM: number } | null {
  return loc ? { lat: loc.latitude, lng: loc.longitude, accuracyM: loc.accuracy } : null;
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
  /** "Dismiss offence alert" reasons sheet open. */
  let dismissOpen = false;
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
  /* Look-alikes (WF-S28), per capture. Every candidate shown and the officer's choice is logged
     on each record the capture produces (OQ28-7). */
  let lookalikes: LookalikeLink[] = [];
  /** Hot-list entries the officer confirmed as this vehicle / decided are not. */
  const hotConfirmed = new Set<string>();
  const hotDeclined = new Set<string>();
  /** Permit look-alike decided for this capture (plate confirmed or not a match). */
  let permitDecided = false;
  /** Open look-alike prompt before anything is recorded: hot list first, then permit. */
  let lookalikePrompt: { kind: 'hot'; items: HotLookalike[] } | { kind: 'permit'; items: PermitLookalike[] } | null = null;
  /** Plates held, for the confirm-screen hint (28a); loaded once per capture. */
  let hintSources: { hotLists: HotList[]; allowLists: AllowList[]; observations: Observation[] } | null = null;
  let hintLoading = false;
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
    lookalikes = [];
    hotConfirmed.clear();
    hotDeclined.clear();
    permitDecided = false;
    lookalikePrompt = null;
    hintSources = null;
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
    extra: Partial<ScanRecord> = {},
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
      ...(lookalikes.length ? { lookalikes: [...lookalikes] } : {}),
      ...extra,
    };
  };

  const recordResighting = async (
    plate: string,
    d: Extract<Decision, { kind: 'timed_resighting' }>,
    extra: Partial<ScanRecord> = {},
    /** Joined through a look-alike link: the timing records the scan (WF-S28). */
    linked = false,
  ): Promise<{ saved: ScanRecord; comparison: Comparison | null }> => {
    const obs = d.observation;
    const saved = await makeRecord(plate, obs.listId, d.overstay ? 'overstay' : 'within_allowance', obs.id, extra);
    const updated: Observation = {
      ...obs,
      ...(linked ? { linkedScanIds: [...(obs.linkedScanIds ?? []), saved.id] } : {}),
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

  const recordNew = async (
    plate: string,
    l: TimedList,
    at: number,
    instance: NonNullable<ReturnType<typeof restrictionInForce>>,
    extra: Partial<ScanRecord> = {},
    concession?: 'disability',
  ) => {
    const obsId = uid();
    const saved = await makeRecord(plate, l.id, 'recorded', obsId, extra);
    const obs = newObservation({ id: obsId, list: l, plate, scanId: saved.id, at, instance, concession });
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
      const [hotLists, allowLists, observations, flags] = await Promise.all([
        getHotLists(),
        getAllowLists(),
        // Running timings, and dismissed ones (an alert dismissed earlier this period exempts).
        l.type === 'timed' ? getObservations(l.id).then((os) => os.filter((o) => o.status === 'active' || o.status === 'dismissed')) : Promise.resolve([] as Observation[]),
        l.type === 'timed' ? getFlags() : Promise.resolve([]),
      ]);
      // Evaluate against the shutter time, not the moment the officer pressed "Check".
      const at = pending.meta.capturedAt;
      const res = evaluate({ at, plate, list: l, hotLists, allowLists, observations, flags });
      /* Look-alikes routed by source (WF-S28): hot list → permit → timed. */
      // 1. Hot list: never dropped; the officer confirms or rejects each candidate first.
      for (const h of res.hotHits) if (h.strength === 'possible' && hotConfirmed.has(h.entry.id)) h.strength = 'exact';
      res.hotHits = res.hotHits.filter((h) => h.strength === 'exact' || !hotDeclined.has(h.entry.id));
      const openHot = hotLookalikes(plate, hotLists).filter((x) => !hotConfirmed.has(x.entry.id) && !hotDeclined.has(x.entry.id));
      if (openHot.length) {
        lookalikePrompt = { kind: 'hot', items: openHot };
        phase = 'confirm';
        feedback('alarm', settings());
        app.update();
        return;
      }
      if (l.type === 'hot' && res.decision.kind === 'hot_match' && !res.hotHits.some((h) => h.list.id === l.id)) res.decision = { kind: 'hot_none' };
      // 2. Permit: a similar permit plate never exempts; the officer checks the displayed permit.
      const openPermit = l.type === 'timed' && !permitDecided ? permitLookalikes(plate, l, allowLists) : [];
      if (openPermit.length) {
        lookalikePrompt = { kind: 'permit', items: openPermit };
        phase = 'confirm';
        feedback('warn', settings());
        app.update();
        return;
      }
      // 3. Timed: the engine returns timed_possible → "Possible earlier sighting" (no sheet first).
      // The near-match sheet (26e) stays only for a selected allow list.
      const allowNear = l.type === 'allow' ? l.entries.filter((e) => comparePlates(plate, e.plate) === 'possible').map((e) => `${e.plate} · ${l.name}`) : [];
      if (allowNear.length && dismissed !== plate) {
        suggestions = [...new Set(allowNear)];
        phase = 'confirm';
        app.update();
        return;
      }
      if (dismissed === plate && res.decision.kind === 'allow_none') res.decision.possible = [];
      await expireObservations(res.expireObservationIds, at);
      // Payment to check, and to keep with the evidence: the numbers tied to the restriction in force.
      if (l.type === 'timed' && l.payment) pending.meta.payment = paymentFor(l.payment, restrictionFor(l, timingDecision(res.decision)));

      let saved: ScanRecord | null = null;
      let comparison: Comparison | null = null;
      let possibleFirsts = new Map<string, ScanRecord>();

      // Officer-safety evidence: record exact hot-list sightings.
      const hotScanIds: Record<string, string> = {};
      for (const hit of res.hotHits.filter((h) => h.strength === 'exact')) {
        const rec = await makeRecord(plate, hit.list.id, 'hot_sighting', null);
        await saveScan(rec);
        hotScanIds[hit.entry.id] = rec.id;
        if (hit.list.id === l.id) saved = rec;
      }

      const d = res.decision;
      if (l.type === 'timed') {
        const applied = await applyTimed(plate, l, at, d);
        if (applied.saved) saved = applied.saved;
        ({ comparison, possibleFirsts } = applied);
      }
      dismissOpen = false;

      result = { plate, decision: d, hotHits: res.hotHits, comparison, saved, possibleFirsts, hotScanIds };
      phase = 'result';
      const s = settings();
      if (res.hotHits.length) feedback('alarm', s);
      else if (d.kind === 'timed_resighting') feedback(d.overstay ? 'warn' : 'info', s);
      else if (d.kind === 'timed_possible' || d.kind === 'timed_permit' || d.kind === 'timed_flag_check') feedback('warn', s);
      else feedback('ok', s);
    } catch (e) {
      console.error(e);
      confirmError = { title: 'Check failed', body: `${(e as Error).message} The capture is kept: check again or retake.` };
      phase = 'confirm';
    }
    app.update();
    window.scrollTo(0, 0);
  };

  /**
   * Record a timed-list decision. Pop-up decisions (permit held, known vehicle) record nothing
   * until the officer chooses; `extra` carries that choice onto the record.
   */
  const applyTimed = async (
    plate: string,
    l: TimedList,
    at: number,
    d: Decision,
    extra: Partial<ScanRecord> = {},
  ): Promise<{ saved: ScanRecord | null; comparison: Comparison | null; possibleFirsts: Map<string, ScanRecord> }> => {
    let saved: ScanRecord | null = null;
    let comparison: Comparison | null = null;
    const possibleFirsts = new Map<string, ScanRecord>();
    switch (d.kind) {
      case 'timed_exempt':
        // Evidence that the permit vehicle was seen here; no allowance clock is started.
        saved = await makeRecord(plate, l.id, 'permit_valid', null, extra);
        await saveScan(saved);
        break;
      case 'timed_flag_exempt':
        saved = await makeRecord(plate, l.id, 'flag_confirmed', null, { flagCheck: { kind: d.flag.kind, result: 'confirmed' }, ...extra });
        await saveScan(saved);
        break;
      case 'timed_dismissed':
        saved = await makeRecord(plate, l.id, 'permit_valid', null, { exemption: { by: 'dismissed_earlier', reason: d.reason }, ...extra });
        await saveScan(saved);
        break;
      case 'timed_new':
        saved = await recordNew(plate, l, at, d.instance, extra, d.concession);
        break;
      case 'timed_resighting':
        ({ saved, comparison } = await recordResighting(plate, d, extra));
        break;
      case 'timed_possible':
        for (const o of d.candidates) {
          const s = await getScan(o.firstScanId);
          if (s) possibleFirsts.set(o.id, s);
        }
        break;
      default:
        break;
    }
    return { saved, comparison, possibleFirsts };
  };

  /** Run an officer decision on the result screen, keeping the result if saving fails. */
  const decide = async (fn: (r: ResultState, l: TimedList, at: number) => Promise<ResultState>) => {
    if (!result || !list || list.type !== 'timed' || !pending || phase === 'saving') return;
    const r = result;
    const l = list;
    phase = 'saving';
    app.update();
    try {
      result = await fn(r, l, pending.meta.capturedAt);
      const d = result.decision;
      const s = settings();
      if (d.kind === 'timed_resighting') feedback(d.overstay ? 'warn' : 'info', s);
      else if (d.kind === 'timed_possible' || d.kind === 'timed_permit' || d.kind === 'timed_flag_check') feedback('warn', s);
      else feedback('ok', s);
    } catch (e) {
      app.toast(`Save failed: ${(e as Error).message}`, 'error');
    }
    phase = 'result';
    app.update();
  };

  /** Continue with the timing behind a pop-up (permit not exempting here / known vehicle not confirmed). */
  const continueTiming = (r: ResultState, l: TimedList, at: number, next: Decision, extra: Partial<ScanRecord> = {}) =>
    applyTimed(r.plate, l, at, next, extra).then((applied) => ({ ...r, decision: next, ...applied, saved: applied.saved ?? r.saved }));

  /** Permit pop-up: holding this permit here makes the vehicle exempt. */
  const acceptPermit = (hit: PermitHit) =>
    decide((r, l, at) => {
      const next: Decision = { kind: 'timed_exempt', hit };
      return continueTiming(r, l, at, next, { exemption: { by: 'permit', permitNo: hit.entry.permitNo, listName: hit.list.name, status: hit.status } });
    });

  /** Permit pop-up: the permit does not exempt here — time the vehicle as usual. */
  const declinePermit = () =>
    decide((r, l, at) => (r.decision.kind === 'timed_permit' ? continueTiming(r, l, at, r.decision.then) : Promise.resolve(r)));

  /** Known vehicle confirmed at the vehicle check: tag stays, recorded, no timer. */
  const confirmKnownVehicle = () =>
    decide(async (r, l, at) => {
      if (r.decision.kind !== 'timed_flag_check') return r;
      const flag = confirmFlag(r.decision.flag, at);
      await putFlag(flag);
      // Emergency: recorded, no timer. Disability: timed against twice the allowance.
      return continueTiming(r, l, at, r.decision.confirmed, { flagCheck: { kind: flag.kind, result: 'confirmed' } });
    });

  /** Known vehicle not confirmed: tag removed, recorded, timer applied. */
  const dismissKnownVehicle = () =>
    decide(async (r, l, at) => {
      if (r.decision.kind !== 'timed_flag_check') return r;
      const { flag, then } = r.decision;
      await deleteFlag(flag.key);
      return continueTiming(r, l, at, then, { flagCheck: { kind: flag.kind, result: 'removed' } });
    });

  /** Dismiss the overstay alert with a reason: the scan keeps it; disability / emergency tags the plate. */
  const dismissAlert = (reason: DismissReason) =>
    decide(async (r, l) => {
      const d = r.decision;
      if (d.kind !== 'timed_resighting' || !d.overstay || !r.saved) return r;
      const obs = r.comparison?.observation ?? d.observation;
      if (reason === 'disability_permit' && disabilityBlocked(obs, r.saved.meta.capturedAt, l.restrictions.find((x) => x.id === obs.restrictionId)?.description)) return r;
      const out = applyDismissal({ scan: r.saved, observation: obs, reason, at: Date.now() });
      await dismissOverstay(out);
      dismissOpen = false;
      // Disability: the same sighting re-timed against twice the allowance (no longer an overstay).
      const decision = reason === 'disability_permit' ? resighting(out.observation, r.saved.meta.capturedAt) : d;
      const comparison = r.comparison
        ? { ...r.comparison, observation: out.observation, current: out.scan, ...(reason === 'disability_permit' ? { remainingMs: decision.kind === 'timed_resighting' ? decision.remainingMs : 0, overstay: false } : {}) }
        : null;
      return { ...r, decision, saved: out.scan, comparison, dismissedReason: reason };
    });

  /**
   * "Possible earlier sighting" (WF-S28 28b/28c): the officer links the scan to one running timing
   * ("Same vehicle") or records a new one ("Different vehicle"). Every candidate shown is logged
   * with the choice; the scan keeps the plate as read and the timing records the linked scan.
   */
  const resolvePossible = async (obs: Observation | null) => {
    if (!result || !list || list.type !== 'timed' || result.decision.kind !== 'timed_possible' || !pending) return;
    const d = result.decision;
    const l = list;
    phase = 'saving';
    app.update();
    try {
      const at = pending.meta.capturedAt;
      const now = Date.now();
      for (const o of d.candidates) lookalikes.push(logChoice(result.plate, { source: 'timed', observation: o }, obs?.id === o.id ? 'same' : 'different', now));
      if (obs) {
        const r = resighting(obs, at);
        const { saved, comparison } = await recordResighting(result.plate, r, {}, true);
        result = { ...result, decision: r, saved, comparison };
        feedback(r.overstay ? 'warn' : 'info', settings());
      } else {
        const saved = await recordNew(result.plate, l, at, d.instance, {}, d.concession);
        result = { ...result, decision: { kind: 'timed_new', instance: d.instance, concession: d.concession }, saved };
        feedback('ok', settings());
      }
      phase = 'result';
    } catch (e) {
      app.toast(`Save failed: ${(e as Error).message}`, 'error');
      phase = 'result';
    }
    app.update();
  };

  /** Hot-list look-alike (28e): this is the hot-list vehicle — recorded as a hot-list sighting. */
  const confirmHotLookalike = (x: HotLookalike) => {
    if (!pending) return;
    hotConfirmed.add(x.entry.id);
    lookalikes.push(logChoice(normalisePlate(plateInput), x, 'hot_confirmed'));
    lookalikePrompt = null;
    void check();
  };

  /** Hot-list look-alike (28e): not the hot-list vehicle — logged on the entry log, check continues as read. */
  const declineHotLookalike = async (x: HotLookalike) => {
    if (!pending) return;
    const readAs = normalisePlate(plateInput);
    hotDeclined.add(x.entry.id);
    lookalikes.push(logChoice(readAs, x, 'not_hot'));
    const at = Date.now();
    await putHotEvent({
      id: uid(), kind: 'lookalike_not_matched', plate: x.entry.plate, key: x.entry.key, hotListId: x.list.id, hotListEntryId: x.entry.id,
      scanId: null, at, atLocal: toLocalIso(at), officerNumber: settings().officerNumber, location: fixOf(pending.meta.location), device: navigator.userAgent, readAs,
    }).catch(() => undefined);
    lookalikePrompt = lookalikePrompt?.kind === 'hot' && lookalikePrompt.items.length > 1 ? { kind: 'hot', items: lookalikePrompt.items.filter((y) => y !== x) } : null;
    if (!lookalikePrompt) void check();
    else app.update();
  };

  /** Permit look-alike (28f): the displayed permit shows the permit plate — re-check as that plate. */
  const confirmPermitPlate = (x: PermitLookalike) => {
    lookalikes.push(logChoice(normalisePlate(plateInput), x, 'permit_plate'));
    permitDecided = true;
    lookalikePrompt = null;
    plateInput = x.entry.plate;
    void check();
  };

  /** Permit look-alike (28f): not a match — check as read. */
  const declinePermitLookalike = () => {
    if (lookalikePrompt?.kind !== 'permit') return;
    const readAs = normalisePlate(plateInput);
    for (const x of lookalikePrompt.items) lookalikes.push(logChoice(readAs, x, 'not_permit'));
    permitDecided = true;
    lookalikePrompt = null;
    void check();
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

  /** Load the plates held, once per capture, for the look-alike hint (28a). */
  const loadHintSources = async () => {
    if (hintSources || hintLoading || !list) return;
    hintLoading = true;
    try {
      const [hotLists, allowLists, observations] = await Promise.all([getHotLists(), getAllowLists(), list.type === 'timed' ? getActiveObservations(list.id) : Promise.resolve([] as Observation[])]);
      hintSources = { hotLists, allowLists, observations };
    } finally {
      hintLoading = false;
      app.update();
    }
  };

  /**
   * 28a: amber strip while the plate field is a look-alike of a plate held. Does not block Check.
   * A hot-list candidate is named only as "a hot-list plate" until Check (OQ28-8).
   */
  const lookalikeHint = (): TemplateResult | typeof nothing => {
    if (!hintSources) {
      void loadHintSources();
      return nothing;
    }
    const plate = normalisePlate(plateInput);
    const x = firstLookalike(plate, { ...hintSources, list: list?.type === 'timed' ? list : null });
    if (!x) return nothing;
    const text =
      x.source === 'hot'
        ? html`Look-alike of a hot-list plate — Check will ask you to verify`
        : x.source === 'allow'
          ? html`Look-alike of permit plate <span class="font-plate">${x.entry.plate}</span> · ${x.list.name}`
          : html`Look-alike of <span class="font-plate">${x.observation.plate}</span> — timed on this segment · since <span class="font-plate">${formatClock(x.observation.startedAt)}</span>`;
    return html`<div class="mt-4 flex items-start gap-2 rounded-md border-2 border-alert bg-alert-bg p-3 text-sm text-neutral-900" role="status" data-testid="lookalike-hint">
      <span class="text-alert-strong">${icon('question', 'h-5 w-5')}</span><p>${text}</p>
    </div>`;
  };

  /** 28e: hot-list look-alike in verify form. The officer must choose; it is never dropped. */
  const hotLookalikeSheet = (items: HotLookalike[]) => {
    const read = normalisePlate(plateInput);
    return html`<div class="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="alertdialog" aria-modal="true" aria-labelledby="hot-verify-title" data-testid="hot-lookalike">
      <section class="max-h-[92vh] w-full max-w-md overflow-auto rounded-t-xl border-4 border-alert bg-surface pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-xl sm:rounded-xl sm:pb-4">
        <div class="flex items-center gap-3 bg-alert px-4 py-3 text-alert-text">
          ${icon('question', 'h-8 w-8', 1.75)}
          <div><p class="text-xs font-bold tracking-[0.08em] uppercase">Officer safety · verify plate</p><p id="hot-verify-title" class="text-lg font-bold">Possible hot list match</p></div>
        </div>
        <div class="p-4">
          <p class="text-sm text-neutral-800">Check the plate on the vehicle from a safe position. A look-alike is never treated as a match until you choose.</p>
          ${items.map(
            (x) => html`<div class="mt-3 rounded-md border border-alert-border bg-alert-bg p-3" data-testid="hot-lookalike-item">
              <div class="grid grid-cols-2 gap-3">
                <div><p class="text-xs font-semibold text-neutral-700">This scan</p>
                  ${cropUrl || frameUrl ? html`<img src=${cropUrl || frameUrl} alt="This scan" class="mt-1 aspect-[3/1] w-full rounded-md bg-black object-contain" />` : nothing}
                  <div class="mt-1">${plateBadge(read, 'md')}</div></div>
                <div><p class="text-xs font-semibold text-neutral-700">Hot list</p>
                  <p class="mt-1 flex aspect-[3/1] items-center justify-center rounded-md border border-dashed border-neutral-300 text-xs text-neutral-600">No image held</p>
                  <div class="mt-1">${plateBadge(x.entry.plate, 'md')}</div></div>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2">${riskPill(x.entry.riskLevel, RISK_LEVEL_LABELS[x.entry.riskLevel])}
                <span class="text-sm font-semibold text-neutral-900">${[x.entry.colour, x.entry.make, x.entry.model, x.entry.bodyType].filter(Boolean).join(' ') || 'No vehicle description'}</span></div>
              <div class="mt-3 grid gap-2">
                <button type="button" class="btn-primary" data-testid="hot-lookalike-same" @click=${() => confirmHotLookalike(x)}>${icon('shield')} Same vehicle — hot list sighting</button>
                <button type="button" class="btn-secondary" data-testid="hot-lookalike-not" @click=${() => void declineHotLookalike(x)}>Not the hot-list vehicle</button>
              </div>
            </div>`,
          )}
        </div>
      </section>
    </div>`;
  };

  /** 28f: a similar permit plate never exempts; the officer checks the vehicle's displayed permit. */
  const permitLookalikeSheet = (items: PermitLookalike[]) =>
    decisionSheet({
      testid: 'permit-lookalike',
      pill: statusPill('verify', 'Similar permit plate'),
      title: 'Check the vehicle’s displayed permit',
      body: html`<p>The plate as read is similar to a permit plate. A similar plate never exempts: only the permit plate itself can.</p>
        <ul class="mt-3 grid gap-3">
          ${items.map(
            (x) => html`<li class="rounded-md border border-neutral-200 bg-surface-sunken p-3" data-testid="permit-lookalike-item">
              <div class="grid grid-cols-2 gap-3">
                <div><p class="text-xs font-semibold text-neutral-700">This capture</p><div class="mt-1">${plateBadge(normalisePlate(plateInput), 'md')}</div></div>
                <div><p class="text-xs font-semibold text-neutral-700">Permit held</p><div class="mt-1">${plateBadge(x.entry.plate, 'md')}</div></div>
              </div>
              <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <dt class="text-neutral-600">List</dt><dd>${x.list.name}</dd>
                ${x.entry.permitNo ? html`<dt class="text-neutral-600">Permit</dt><dd class="font-plate">#${x.entry.permitNo}</dd>` : nothing}
                ${x.entry.vehicle ? html`<dt class="text-neutral-600">Vehicle</dt><dd class="font-semibold">${x.entry.vehicle}</dd>` : nothing}
                ${x.entry.validTo ? html`<dt class="text-neutral-600">Valid to</dt><dd>${formatIsoDate(x.entry.validTo)}</dd>` : nothing}
              </dl>
              <button type="button" class="btn-primary mt-3 w-full" data-testid="permit-lookalike-confirm" @click=${() => confirmPermitPlate(x)}>${icon('edit')} Permit plate confirmed — edit plate</button>
            </li>`,
          )}
        </ul>`,
      actions: html`<button type="button" class="btn-secondary" data-testid="permit-lookalike-not" @click=${declinePermitLookalike}>Not a match — check as read</button>`,
    });

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
      ${lookalikePrompt?.kind === 'hot' ? hotLookalikeSheet(lookalikePrompt.items) : nothing}
      ${lookalikePrompt?.kind === 'permit' ? permitLookalikeSheet(lookalikePrompt.items) : nothing}
      ${confirmError ? html`<div class="mt-4">${banner('alert', confirmError.title, confirmError.body, 'confirm-error')}</div>` : nothing}
      ${fromPatrol ? nothing : lookalikeHint()}
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

  /**
   * WF-S29: Acknowledge (29a), Acknowledged (29b) and Queued (29c). Acknowledging is required before
   * Next scan; it raises a soft Code 1 with dispatch and the compliance coordinator, who expect a
   * radio response from the officer.
   */
  const hotAckPanel = (r: ResultState): TemplateResult => {
    const acks = r.hotAcks;
    const logLinks = nothing;
    if (!acks?.length) {
      const officer = officerNumber(settings().officerNumber);
      return html`<section class="card border-2 border-alert" data-testid="hot-ack">
        <p class="text-sm text-neutral-800">Acknowledging records the time, your location and officer number on this plate’s hot-list entry log, and raises a <strong>soft Code 1</strong> with dispatch and the compliance coordinator. Expect a radio call.</p>
        ${officer
          ? html`<button type="button" class="btn-primary mt-3 w-full py-4 text-md" data-testid="hot-acknowledge" ?disabled=${phase === 'saving'} @click=${() => void acknowledgeHot()}>${icon('check')} Acknowledge</button>`
          : html`<div class="mt-3">${banner('alert', 'Officer number required', html`Set it in <a class="link" href="#/settings">Settings → Officer</a> to acknowledge hot-list alerts.`, 'hot-ack-officer-required')}</div>`}
      </section>`;
    }
    const a = acks[0]!;
    const sent = acks.every((e) => e.notification?.status === 'sent');
    const where = a.location ? html`<span class="font-plate">${a.location.lat.toFixed(5)}, ${a.location.lng.toFixed(5)} ±${Math.round(a.location.accuracyM)} m</span>` : 'no GPS fix';
    return html`<section class="rounded-md border-2 ${sent ? 'border-active bg-active-bg' : 'border-pending bg-pending-bg'} p-4" data-testid=${sent ? 'hot-acked' : 'hot-ack-queued'}>
      ${sent ? statusPill('permit_valid', 'Acknowledged') : statusPill('timing', 'Queued')}
      <p class="mt-2 font-bold text-neutral-900">${sent ? 'Soft Code 1 raised' : 'Acknowledged · alert not sent yet'}</p>
      <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        <dt class="text-neutral-600">When</dt><dd class="font-plate">${formatStamp(a.at)}</dd>
        <dt class="text-neutral-600">Where</dt><dd>${where}</dd>
        <dt class="text-neutral-600">Officer</dt><dd class="font-plate">${a.officerNumber}</dd>
        <dt class="text-neutral-600">Alerted</dt><dd>${sent ? 'Dispatch · compliance coordinator' : html`Dispatch · compliance coordinator — <span class="text-pending-strong">queued, attempt ${a.notification?.attempts ?? 0}</span>`}</dd>
      </dl>
      ${sent
        ? nothing
        : html`<p class="mt-2 text-xs text-neutral-700">${canSendAlerts() ? 'Saved on this device; it will be sent when the connection returns.' : 'Development build: alerts reach CommandMAPS only inside EnforcementMAPS. The acknowledgement is saved on this device.'}</p>
            <button type="button" class="btn-secondary mt-3 w-full" data-testid="hot-retry" @click=${() => void retryHotAlerts()}>${icon('refresh')} Retry now</button>`}
      <div class="mt-3">${banner('alert', sent ? 'Respond by radio' : 'Tell dispatch by radio', sent ? 'Dispatch will call you on the radio. Answer them; with no answer the soft Code 1 can be escalated to a Code 1.' : 'Until the alert is sent, dispatch and the compliance coordinator do not know about this sighting.', 'hot-radio')}</div>
      ${logLinks}
    </section>`;
  };

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
        <span class="font-plate">${o.restrictionCode}</span> allowance ${formatMinutes(o.limitMinutes)}${o.concession ? html` <span data-testid="disability-doubled">(2 × ${formatMinutes(o.concession.baseLimitMinutes)}, disability permit)</span>` : nothing}${o.graceMinutes ? ` + ${formatMinutes(o.graceMinutes)} grace` : ''} ·
        ${c.remainingMs > 0 ? html`<strong>${formatDuration(c.remainingMs)} remaining</strong>` : html`<strong class="text-alert-strong">exceeded by ${formatDuration(-c.remainingMs)}</strong>`}
      </p>
      <div class="mt-4 grid grid-cols-2 gap-3">${evidenceTile('Scan 1', c.first)}${evidenceTile(`Scan ${o.scanCount}`, c.current)}</div>
      ${c.overstay && !result?.dismissedReason
        ? html`<button type="button" class="btn-secondary mt-4 w-full" data-testid="dismiss-alert" @click=${() => { dismissOpen = true; app.update(); }}>${icon('x')} Dismiss offence alert</button>`
        : nothing}
      ${result?.dismissedReason ? nothing : html`<button type="button" class="btn-secondary mt-3 w-full" @click=${resetObservation}>${icon('refresh')} Vehicle moved — restart timing</button>`}
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
              ${e.vehicle ? html`<dt class="text-neutral-600">Vehicle</dt><dd>${e.vehicle}</dd>` : nothing}
              ${e.validFrom || e.validTo ? html`<dt class="text-neutral-600">Valid</dt><dd>${e.validFrom ? formatIsoDate(e.validFrom) : 'any time'} to ${e.validTo ? formatIsoDate(e.validTo) : 'no end date'}</dd>` : nothing}
            </dl>`,
          'result-exempt',
        );
      }
      case 'timed_permit':
        return statusCard('verify', 'Permit on record', 'Check the permit details and decide whether it exempts the vehicle here.', 'result-permit', 'Permit held');
      case 'timed_flag_check':
        return statusCard('verify', FLAG_MESSAGE[d.flag.kind], 'Check the vehicle, then confirm or dismiss.', 'result-flag-check', FLAG_LABEL[d.flag.kind]);
      case 'timed_flag_exempt':
        return statusCard('permit_valid', 'Known vehicle confirmed', `${FLAG_LABEL[d.flag.kind]}. Scan recorded; no timer applied.`, 'result-flag-confirmed', 'Vehicle confirmed');
      case 'timed_dismissed':
        return statusCard(
          'permit_valid',
          'Alert dismissed earlier today',
          html`${DISMISS_LABEL[d.reason]}${d.observation.closedAt ? html` at <span class="font-plate">${formatClock(d.observation.closedAt)}</span>` : nothing}, this restriction period. Scan recorded; no timer applied.`,
          'result-dismissed-earlier',
          'Exempt',
        );
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
        const doubled = d.concession === 'disability' && disabilityDoubles(r0.code, r0.description);
        const limit = doubled ? r0.limitMinutes * 2 : r0.limitMinutes;
        const ends = (r.saved?.meta.capturedAt ?? Date.now()) + limit * 60_000;
        return statusCard(
          'timing',
          'First sighting recorded',
          html`<span class="font-plate">${r0.code}</span> allowance (${formatMinutes(limit)}${doubled ? html`, <strong data-testid="disability-doubled">doubled for disability permit</strong>` : nothing}) started. Expires <strong class="font-plate">${formatClock(ends)}</strong>. Re-scan after that time to check for overstay.`,
          'result-recorded',
        );
      }
      case 'timed_resighting':
        return r.comparison ? comparisonPanel(r.comparison) : statusCard(d.overstay ? 'overstay' : 'within_allowance', 'Re-sighting', `Elapsed ${formatDuration(d.elapsedMs)}.`, 'result-resighting');
      case 'timed_possible': {
        // WF-S28 28b/28c: this scan and each candidate's scan 1 side by side, one row per candidate.
        const here = cropUrl || frameUrl;
        const n = d.candidates.length;
        return html`<section class="rounded-md border-2 ${TONE_PANEL.alert} p-4" data-testid="result-possible" data-tone="alert">
          ${statusPill('verify', n > 1 ? `Verify · ${n} candidates` : 'Verify')}
          <p class="mt-2 text-lg font-bold text-neutral-900">Possible earlier sighting</p>
          <p class="mt-1 text-sm text-neutral-800"><span class="font-plate">${r.plate}</span> looks like ${n > 1 ? 'plates' : 'a plate'} being timed here. Compare the plates and choose; nothing is recorded until you do.</p>
          <figure class="mt-3">
            <figcaption class="mb-1 text-xs font-semibold text-neutral-700">This scan</figcaption>
            ${here ? html`<img src=${here} alt="This scan" class="aspect-[3/1] w-full rounded-md border border-neutral-200 bg-black object-contain" />` : nothing}
            <div class="mt-1 flex items-center justify-between gap-2">${plateBadge(r.plate, 'md')}<span class="font-plate text-xs text-neutral-700">${pending ? formatClock(pending.meta.capturedAt) : ''}</span></div>
          </figure>
          <ul class="mt-3 grid gap-3">
            ${d.candidates.map((o) => {
              const s = r.possibleFirsts.get(o.id);
              return html`<li class="rounded-md border border-neutral-200 bg-surface p-3" data-testid="possible-candidate">
                <p class="mb-1 text-xs font-semibold text-neutral-700">Scan 1 of timing</p>
                ${s ? html`<img src=${urls.get(s.thumb)} alt="Scan 1 of ${o.plate}" class="aspect-[3/1] w-full rounded-md border border-neutral-200 bg-black object-contain" />` : nothing}
                <div class="mt-1 flex flex-wrap items-center justify-between gap-2">
                  ${plateBadge(o.plate, 'md')}
                  <span class="text-xs text-neutral-700">First seen <span class="font-plate">${formatClock(o.startedAt)}</span> · ${formatDuration((pending?.meta.capturedAt ?? Date.now()) - o.startedAt)} ago</span>
                </div>
                <button type="button" class="btn-primary mt-3 w-full" data-testid="possible-same" @click=${() => void resolvePossible(o)}>${icon('check')} Same vehicle — link to this timing</button>
              </li>`;
            })}
          </ul>
          <button type="button" class="btn-secondary mt-3 w-full" data-testid="possible-different" @click=${() => void resolvePossible(null)}>Different vehicle — record new</button>
          <button type="button" class="btn-ghost mt-1 w-full" data-testid="possible-edit" @click=${editFromResult}>${icon('edit')} Edit plate</button>
        </section>`;
      }
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
    return html`${header({ title: 'Result', subtitle: list?.name, back: mustAcknowledge(r) ? undefined : () => app.navigate(`/list/${listId}`), actions: html`<span class="pr-2">${plateBadge(r.plate, 'md')}</span>` })}
      <div class="mx-auto max-w-xl px-4 pt-4 pb-32">
      <div class="grid gap-4">
        ${r.hotHits.length ? hotAlert(r.hotHits) : nothing}
        ${r.hotHits.some((h) => h.strength === 'exact') ? hotAckPanel(r) : nothing}
        ${r.dismissedReason ? dismissedBanner(r.dismissedReason) : nothing}
        ${decisionPanel(r)}
        ${linkedNote(r)}
        ${r.dismissedReason ? nothing : paymentCard(r)}
        ${r.saved
          ? html`<p class="text-center text-xs text-neutral-600">Saved · SHA-256 <span class="font-plate">${r.saved.sha256.slice(0, 16)}…</span> · <a class="link" href="#/record/${r.saved.id}">view record</a></p>`
          : nothing}
      </div>
      <div class="fixed inset-x-0 bottom-0 z-30 border-t border-neutral-200 bg-surface px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-lg">
        <button type="button" class="btn-primary mx-auto flex w-full max-w-xl py-4 text-md" data-testid="next-scan" ?disabled=${phase === 'saving' || openDecision(r)} @click=${resetToLive}>
          ${icon('camera', 'h-6 w-6', 1.75)} Next scan
        </button>
      </div>
      ${r.decision.kind === 'timed_flag_check' ? flagSheet(r.decision) : nothing}
      ${r.decision.kind === 'timed_permit' ? permitSheet(r.decision) : nothing}
      ${dismissOpen ? dismissSheet(r) : nothing}
    </div>`;
  };

  /** A decision the officer must make before moving on (WF-S28 28b.6, 28g.4). */
  const openDecision = (r: ResultState): boolean =>
    r.decision.kind === 'timed_possible' || r.decision.kind === 'timed_permit' || r.decision.kind === 'timed_flag_check' || mustAcknowledge(r);

  /** A hot-list match not yet acknowledged (WF-S29 29a.5). */
  const mustAcknowledge = (r: ResultState): boolean => r.hotHits.some((h) => h.strength === 'exact') && !r.hotAcks?.length;

  /** 29a.4: acknowledge every hot-list hit on this scan; saved on the device, alert queued. */
  const acknowledgeHot = async () => {
    if (!result || !pending || phase === 'saving') return;
    const officer = officerNumber(settings().officerNumber);
    if (!officer) return;
    phase = 'saving';
    app.update();
    try {
      const at = Date.now();
      const location = ackLocation(geo.bestRecent(at), pending.meta.location, at);
      const r = result;
      const events: HotListEvent[] = [];
      for (const h of r.hotHits.filter((x) => x.strength === 'exact')) {
        let e = acknowledgementEvent({ id: uid(), list: h.list, entry: h.entry, scanId: r.hotScanIds?.[h.entry.id] ?? null, at, officerNumber: officer, location, device: navigator.userAgent });
        await putHotEvent(e); // saved first: never depends on the network
        e = await trySendAlert(e);
        await putHotEvent(e);
        events.push(e);
      }
      result = { ...r, hotAcks: events };
      feedback('ok', settings());
    } catch (e) {
      app.toast(`Acknowledge failed: ${(e as Error).message}`, 'error');
    }
    phase = 'result';
    app.update();
  };

  /** 29c.2: retry a queued alert now. */
  const retryHotAlerts = async () => {
    if (!result?.hotAcks) return;
    const next: HotListEvent[] = [];
    for (const e of result.hotAcks) {
      const sent = await trySendAlert(e);
      await putHotEvent(sent);
      next.push(sent);
    }
    result = { ...result, hotAcks: next };
    if (!canSendAlerts()) app.toast('No CommandMAPS connection in this build. Tell dispatch by radio.', 'warn');
    app.update();
  };

  /** "Edit plate" from a look-alike decision: back to the confirm screen with the plate field focused. */
  const editFromResult = () => {
    result = null;
    lookalikes = [];
    phase = 'confirm';
    editing = true;
    app.update();
    requestAnimationFrame(() => plateInputRef.value?.focus());
  };

  /** "⇄ Linked look-alike" note on a result reached through "Same vehicle" (28d.3). */
  const linkedNote = (r: ResultState): TemplateResult | typeof nothing => {
    const link = sameVehicleLink(r.saved?.lookalikes);
    if (!link) return nothing;
    return html`<section class="rounded-md border-2 border-dashed border-neutral-400 bg-surface p-3 text-sm" data-testid="lookalike-link">
      <p class="flex items-center gap-2 font-semibold text-neutral-900">${icon('link', 'h-4 w-4')} Linked look-alike</p>
      <p class="mt-1 text-neutral-800"><span class="font-plate">${link.readAs}</span> read as <span class="font-plate">${link.candidatePlate}</span> · Same vehicle chosen <span class="font-plate">${formatClock(link.decidedAt)}</span> · plate kept as read</p>
    </section>`;
  };

  const dismissedBanner = (reason: DismissReason) => {
    const flag = DISMISS_REASONS.find((x) => x.reason === reason)?.flag;
    return banner(
      'active',
      `Offence alert dismissed · ${DISMISS_LABEL[reason]}`,
      `${reason === 'disability_permit' && result?.comparison ? `Allowance doubled to ${formatMinutes(result.comparison.observation.limitMinutes)}; timing continues (ends ${formatClock(result.comparison.observation.allowanceEndsAt)}). No payment is required while the permit is displayed. ` : ''}The scan is kept in history with this reason.${flag ? ` The plate is tagged: from tomorrow every scan asks you to check the vehicle (“${FLAG_MESSAGE[flag]}”).` : ''}`,
      'alert-dismissed',
    );
  };

  /** Pill for a permit's status: green when it applies here, amber to check, grey when not valid. */
  const permitPill = (h: PermitHit) =>
    h.status === 'ACTIVE_IN_AREA'
      ? statusPill('permit_valid', PERMIT_STATUS_TEXT[h.status])
      : h.status === 'ACTIVE_NOT_IN_AREA' || h.status === 'ACTIVE_SCOPE_UNKNOWN'
        ? statusPill('verify', PERMIT_STATUS_TEXT[h.status])
        : statusPill('not_valid', PERMIT_STATUS_TEXT[h.status]);

  /** Permit pop-up: the permit details the council holds; the officer decides (as on the systems in use today). */
  const permitSheet = (d: Extract<Decision, { kind: 'timed_permit' }>) => {
    const active = d.hits.filter((h) => h.status.startsWith('ACTIVE'));
    const anyInArea = d.hits.some((h) => h.status === 'ACTIVE_IN_AREA');
    return decisionSheet({
      testid: 'permit-sheet',
      pill: statusPill('verify', d.hits.length === 1 ? 'Permit on record' : `${d.hits.length} permits on record`),
      title: `${result?.plate ?? ''} holds a permit`,
      body: html`<p>Exempt only if holding this permit at this location makes the vehicle exempt. If not, continue and the vehicle is timed as usual.</p>
        <ul class="mt-3 grid gap-3">
          ${d.hits.map(
            (h) => html`<li class="rounded-md border border-neutral-200 bg-surface-sunken p-3" data-testid="permit-hit" data-status=${h.status}>
              <div class="flex flex-wrap items-center gap-2">${plateBadge(h.entry.plate, 'sm')}${permitPill(h)}</div>
              <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                ${h.entry.vehicle ? html`<dt class="text-neutral-600">Vehicle</dt><dd class="font-semibold">${h.entry.vehicle}</dd>` : nothing}
                ${h.entry.rpa ? html`<dt class="text-neutral-600">Area</dt><dd>RPA <span class="font-plate">${h.entry.rpa}</span>${list?.type === 'timed' && list.rpa ? html` <span class="text-neutral-600">(here: ${list.rpa})</span>` : nothing}</dd>` : nothing}
                ${h.entry.streets?.length ? html`<dt class="text-neutral-600">Streets</dt><dd>${h.entry.streets.join(', ')}</dd>` : nothing}
                ${h.entry.permitNo ? html`<dt class="text-neutral-600">Permit</dt><dd class="font-plate">#${h.entry.permitNo}</dd>` : nothing}
                ${h.entry.label ? html`<dt class="text-neutral-600">Holder</dt><dd>${h.entry.label}</dd>` : nothing}
                <dt class="text-neutral-600">Valid</dt><dd>${h.entry.validFrom ? formatIsoDate(h.entry.validFrom) : 'any time'} to ${h.entry.validTo ? formatIsoDate(h.entry.validTo) : 'no end date'}</dd>
                <dt class="text-neutral-600">List</dt><dd>${h.list.name}${h.linked ? ' · linked to this segment' : ''}</dd>
              </dl>
              ${h.status.startsWith('ACTIVE')
                ? html`<button type="button" class=${`${h.status === 'ACTIVE_IN_AREA' ? 'btn-primary' : 'btn-secondary'} mt-3 w-full`} data-testid="permit-exempt" @click=${() => void acceptPermit(h)}>${icon('check')} Exempt here${h.entry.permitNo ? ` — permit #${h.entry.permitNo}` : ''}</button>`
                : nothing}
            </li>`,
          )}
        </ul>`,
      actions: html`<button type="button" class=${anyInArea ? 'btn-secondary' : 'btn-primary'} data-testid="permit-continue" @click=${() => void declinePermit()}>
        ${active.length ? 'Not exempt here — continue' : 'Permit not valid — continue'}</button>`,
    });
  };

  /** Known vehicle (tagged after a disability / emergency dismissal) scanned on a new day. */
  const flagSheet = (d: Extract<Decision, { kind: 'timed_flag_check' }>) =>
    decisionSheet({
      testid: 'flag-sheet',
      pill: statusPill('verify', FLAG_LABEL[d.flag.kind]),
      title: FLAG_MESSAGE[d.flag.kind],
      body: html`<p>Tagged ${formatIsoDate(localDateString(d.flag.createdAt))} when an overstay alert was dismissed (${FLAG_LABEL[d.flag.kind].toLowerCase()}).</p>`,
      actions: html`<button type="button" class="btn-primary flex-col gap-0" data-testid="flag-confirm" @click=${() => void confirmKnownVehicle()}>
          <span class="flex items-center gap-2">${icon('check')} Confirmed</span>
          <span class="text-sm font-normal text-white/80">${d.flag.kind === 'disability' ? 'Permit displayed' : 'Authorised vehicle'} · tag kept · no timer</span>
        </button>
        <button type="button" class="btn-secondary flex-col gap-0" data-testid="flag-dismiss" @click=${() => void dismissKnownVehicle()}>
          <span>Dismiss</span>
          <span class="text-sm font-normal text-neutral-600">Not confirmed at vehicle check · tag removed · timer applied</span>
        </button>`,
    });

  /** "Dismiss offence alert": the reasons an officer can dismiss an overstay after checking the vehicle. */
  const dismissSheet = (r: ResultState) => {
    const obs = r.comparison?.observation ?? (r.decision.kind === 'timed_resighting' ? r.decision.observation : undefined);
    const code = obs?.restrictionCode ?? '';
    const description = list?.type === 'timed' ? (list.restrictions.find((x) => x.id === obs?.restrictionId)?.description ?? '') : '';
    // A disability permit or a displayed resident permit never exempts in a statutory restriction.
    const statutory = isStatutoryRestriction(code) || isStatutoryRestriction(description);
    const reasons = DISMISS_REASONS.filter((x) => !statutory || x.reason === 'emergency_vehicle');
    const blocked = obs && r.saved ? disabilityBlocked(obs, r.saved.meta.capturedAt, description) : null;
    return decisionSheet({
      testid: 'dismiss-sheet',
      pill: statusPill('overstay'),
      title: 'Dismiss offence alert',
      onClose: () => { dismissOpen = false; app.update(); },
      body: html`<p>Choose why the vehicle is not committing an offence. The scan stays in history with the reason.</p>
        ${statutory ? html`<p class="mt-2 text-alert-strong"><span class="font-plate">${code}</span>${description ? ` (${description})` : ''} is a statutory restriction: disability and resident permits do not exempt here.</p>` : nothing}`,
      actions: html`${reasons.map((x) => {
        const off = x.reason === 'disability_permit' && blocked;
        return html`<button type="button" class="btn-secondary h-auto flex-col items-start gap-0 text-left" data-testid=${`dismiss-${x.reason}`} ?disabled=${!!off} @click=${() => void dismissAlert(x.reason)}>
          <span>${x.label}</span><span class="text-sm font-normal text-neutral-600">${off ? DISABILITY_BLOCKED_TEXT[blocked] : x.hint}</span>
        </button>`;
      })}
        <button type="button" class="btn-ghost" @click=${() => { dismissOpen = false; app.update(); }}>Cancel</button>`,
    });
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

