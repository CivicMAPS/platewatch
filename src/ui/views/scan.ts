import { patrol, hasPatrol, frameUrlFor, type Sighting } from '../../lib/patrol';
import { deviceTimeZone, toLocalIso } from '../../lib/time';
import type { PluginListenerHandle } from '@capacitor/core';
import { paymentLines } from '../../lib/payment';
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
import { formatClock, formatDateTime, formatDuration, formatMinutes } from '../../lib/time';
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
import { icon, plateBadge, RISK_LEVEL_CLASS, spinner, UrlBag } from '../components';
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
      phase = 'live';
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
  const listeners: PluginListenerHandle[] = [];
  const queue: {s:Sighting; meta:PendingCapture['meta']}[] = [];
  let nativeActive = false;

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
      ocr = {plate:plateInput,candidates:[plateInput],confidence:0,rawText:plateInput,durationMs:0};
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
        queue.push({s,meta:{capturedAt:s.at,capturedAtLocal:toLocalIso(s.at),timeZone:deviceTimeZone(),location,
          locationAgeMs:location ? s.at-location.timestamp:null,userAgent:navigator.userAgent,
          payment:selected.type === 'timed' ? structuredClone(selected.payment) : undefined}});
        if (keys.has(s.plate) && settings().sound) void patrol.alert();
      }));
      listeners.push(await patrol.addListener('finished',async () => {
        nativeActive=false;
        await Promise.all(listeners.splice(0).map(h => h.remove()));
        if (!disposed) await reviewNext();
      }));
      await camera.stop();
      await patrol.start({mode});
    } catch(e) {
      nativeActive=false;
      await Promise.all(listeners.splice(0).map(h => h.remove()));
      app.toast((e as Error).message,'error');
      if (!queue.length) await startCamera();
    }
  };

  const resetToLive = () => {
    suggestions = [];
    dismissed = '';
    editing = false;
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

  const runOcr = async (crop: HTMLCanvasElement, mode: 'line' | 'sparse') => {
    try {
      ocr = await recognisePlate(crop, mode);
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
      const roi = padRect(
        mapCoverRect(
          { x: gr.left - vr.left, y: gr.top - vr.top, width: gr.width, height: gr.height },
          { width: vr.width, height: vr.height },
          { width: frame.width, height: frame.height },
        ),
        0.06,
        frame,
      );
      const crop = cropCanvas(frame, roi);
      cropUrl = crop.toDataURL('image/jpeg', 0.85);
      const meta = await metaPromise;
      if (list?.type === 'timed' && list.payment) meta.payment = structuredClone(list.payment);
      pending = { frame, crop, meta };
      if (!manual) await runOcr(crop, 'line');
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
    return {
      id: uid(),
      listId: targetListId,
      observationId,
      plate,
      key: plateKey(plate),
      ocrText: ocr?.rawText ?? '',
      ocrConfidence: ocr?.durationMs ? ocr.confidence : null,
      corrected: !!ocr && normalisePlate(ocr.plate) !== plate,
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

  const check = async () => {
    if (!pending || !list || phase !== 'confirm') return;
    const plate = normalisePlate(plateInput);
    if (!isValidPlate(plate)) {
      app.toast('Enter a valid number plate.', 'error');
      plateInputRef.value?.focus();
      return;
    }
    if (settings().requireLocation && !pending.meta.location) {
      app.toast('A GPS fix is required before checking (see Settings). Move to open sky and retake.', 'error');
      return;
    }
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
        if (d.kind === 'timed_new') saved = await recordNew(plate, l, at, d.instance);
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
      app.toast(`Check failed: ${(e as Error).message}`, 'error');
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

  const geoBadge = (): TemplateResult => {
    const warn = settings().accuracyWarnMetres;
    if (geoState.status === 'fix') {
      const tone = accuracyTone(geoState.fix.accuracy, warn);
      const cls = { good: 'bg-emerald-600', fair: 'bg-amber-600', poor: 'bg-red-600' }[tone];
      return html`<span class="chip border-transparent ${cls} text-white">${icon('pin', 'h-4 w-4')} ±${Math.round(geoState.fix.accuracy)} m</span>`;
    }
    const label =
      geoState.status === 'denied'
        ? 'GPS denied'
        : geoState.status === 'unsupported'
          ? 'No GPS'
          : geoState.status === 'error'
            ? 'GPS error'
            : 'GPS…';
    return html`<span class="chip border-transparent bg-ink-700 text-slate-200">${icon('pin', 'h-4 w-4')} ${label}</span>`;
  };

  const topBar = (): TemplateResult => html`<div class="absolute inset-x-0 top-0 z-20 flex items-center gap-2 bg-gradient-to-b from-black/80 to-transparent px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-6">
    <button type="button" class="btn-ghost min-h-11 px-2 text-white" aria-label="Back" @click=${() => app.navigate(`/list/${listId}`)}>${icon('back', 'h-6 w-6')}</button>
    <div class="min-w-0 flex-1">
      <p class="truncate font-bold text-white">${list?.name ?? ''}</p>
      <p class="truncate text-xs text-slate-300">${list?.type === 'timed' ? segmentLabel(list) : list?.type === 'hot' ? 'Hot list scan' : 'Allow list check'}</p>
    </div>
    <span class="font-plate text-sm text-white tabular-nums">${formatClock(Date.now())}</span>
    ${geoBadge()}
  </div>`;

  const liveControls = (): TemplateResult => html`<div class="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 to-transparent px-4 pt-10 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
    ${hasPatrol() ? html`<div class="mb-3 flex gap-2"><button class="btn-secondary" @click=${() => beginPatrol('walking')}>Walking patrol</button><button class="btn-secondary" @click=${() => beginPatrol('vehicle')}>Vehicle patrol</button></div>` : nothing}
    ${caps.zoom
      ? html`<label class="mb-4 flex items-center gap-3 text-sm text-white">
          Zoom
          <input type="range" class="flex-1 accent-brand-500" min=${caps.zoom.min} max=${Math.min(caps.zoom.max, 10)} step=${caps.zoom.step || 0.1} .value=${String(camera.zoom)}
            @input=${(e: Event) => void camera.setZoom(Number((e.target as HTMLInputElement).value))} />
        </label>`
      : nothing}
    <div class="flex items-center justify-between">
      <button type="button" class="btn-ghost min-h-14 w-16 flex-col gap-0 px-0 text-xs text-white" @click=${() => void capture(true)} ?disabled=${phase !== 'live'}>
        ${icon('keyboard', 'h-6 w-6')} Manual
      </button>
      <button type="button" aria-label="Capture number plate" data-testid="shutter"
        class="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white/20 transition active:scale-95 disabled:opacity-50"
        ?disabled=${phase !== 'live'} @click=${() => void capture(false)}>
        ${phase === 'processing' ? spinner('h-8 w-8 text-white') : html`<span class="h-14 w-14 rounded-full bg-white"></span>`}
      </button>
      ${caps.torch
        ? html`<button type="button" class="btn-ghost min-h-14 w-16 flex-col gap-0 px-0 text-xs ${camera.torchOn ? 'text-amber-300' : 'text-white'}"
            @click=${async () => { await camera.setTorch(!camera.torchOn); app.update(); }}>${icon('torch', 'h-6 w-6')} Torch</button>`
        : html`<button type="button" class="btn-ghost min-h-14 w-16 flex-col gap-0 px-0 text-xs text-white" @click=${() => fileRef.value?.click()}>
            ${icon('upload', 'h-6 w-6')} Photo
          </button>`}
    </div>
    ${phase === 'processing'
      ? html`<p class="mt-3 text-center text-sm text-slate-200">${ocrStatus && ocrStatus.progress < 1 ? `${ocrStatus.status} ${Math.round(ocrStatus.progress * 100)}%` : 'Reading plate…'}</p>`
      : html`<p class="mt-3 text-center text-sm text-slate-300">Fit the number plate inside the frame</p>`}
  </div>`;

  const cameraLayer = (): TemplateResult => html`<div class="fixed inset-0 z-10 bg-black ${phase === 'live' || phase === 'processing' || phase === 'starting' ? '' : 'invisible'}">
    <video ${ref(videoRef)} class="h-full w-full object-cover" autoplay muted playsinline></video>
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div ${ref(guideRef)} class="scan-guide relative aspect-[3/1] w-[82%] max-w-xl rounded-xl border-4 border-brand-400">
        <span class="absolute -top-7 left-0 text-xs font-semibold tracking-wide text-brand-100 uppercase">Plate</span>
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
      <dt class="text-slate-400">Time</dt>
      <dd class="font-plate">${p.meta.capturedAtLocal.replace('T', ' ')}</dd>
      <dt class="text-slate-400">Zone</dt>
      <dd>${p.meta.timeZone}</dd>
      <dt class="text-slate-400">Location</dt>
      <dd class=${loc ? (loc.accuracy > warn ? 'text-amber-300' : 'text-emerald-300') : 'text-red-300'}>
        ${loc ? html`${formatLatLng(loc)} <span class="text-slate-400">±${Math.round(loc.accuracy)} m</span>` : 'Unavailable — no GPS fix'}
      </dd>
    </dl>`;
  };

  const confirmPanel = (): TemplateResult => {
    const p = pending!;
    const busy = phase === 'saving';
    return html`<div class="mx-auto max-w-xl px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-28">
      <div class="flex items-center gap-2">
        <button type="button" class="btn-ghost min-h-11 px-2" aria-label="Retake" @click=${resetToLive}>${icon('back', 'h-6 w-6')}</button>
        <h1 class="text-lg font-bold">Confirm plate</h1>
      </div>
      ${cropUrl || frameUrl
        ? html`<img src=${cropUrl || frameUrl} alt="Captured plate" class="mt-3 w-full rounded-xl border border-ink-600 bg-black object-contain ${frameUrl ? 'max-h-64' : 'max-h-40'}" />`
        : nothing}
      ${suggestions.length ? html`<div role="dialog" aria-modal="true" class="fixed inset-0 z-50 grid place-items-center bg-black/80"><section class="card max-h-screen overflow-auto"><h2>Near match</h2><img class="max-h-48" src=${cropUrl || frameUrl} alt="Current capture"><p>Current scan · ${plateInput}</p>${suggestions.map(s => html`<p>${s}</p>`)}
        <button class="btn-primary" @click=${() => { suggestions = []; editing = true; app.update(); plateInputRef.value?.focus(); }}>Edit</button>
        <button class="btn-secondary" @click=${() => { suggestions = []; dismissed = normalisePlate(plateInput); void check(); }}>Dismiss</button></section></div>` : nothing}
      <form class="card mt-4" @submit=${(e: Event) => { e.preventDefault(); void check(); }}>
        <label for="plate" class="field-label">Number plate (editable)</label>
        <input ${ref(plateInputRef)} id="plate" name="plate" data-testid="plate-input"
          class="field text-center font-plate text-3xl font-bold tracking-[0.3em] uppercase"
          .value=${plateInput} maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text"
          @input=${(e: Event) => (plateInput = (e.target as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
        ${ocr
          ? html`<p class="mt-2 text-xs text-slate-400">${ocr.durationMs ? 'OCR confidence ' + ocr.confidence + '% · ' + ocr.durationMs + ' ms' : 'Patrol reading'}${ocr.rawText ? html` · raw “${ocr.rawText}”` : nothing}</p>
              ${ocr.candidates.length > 1
                ? html`<div class="mt-2 flex flex-wrap gap-2">
                    ${ocr.candidates.map(
                      (c) => html`<button type="button" class="chip min-h-10 border-ink-600 bg-ink-800 font-plate text-slate-200" @click=${() => { plateInput = c; app.update(); }}>${c}</button>`,
                    )}
                  </div>`
                : nothing}`
          : html`<p class="mt-2 text-xs text-slate-400">${ocrError || 'Manual entry'}</p>`}
        <div class="mt-4 border-t border-ink-700 pt-3">${metaSummary(p)}</div>
        <div class="mt-4 grid grid-cols-2 gap-3">
          <button type="button" class="btn-secondary" @click=${resetToLive} ?disabled=${busy}>${icon('refresh')} Retake</button>
          <button type="submit" class="btn-primary" data-testid="check" ?disabled=${busy}>${busy ? spinner() : icon('check')} ${editing ? 'Save and recheck' : 'Check'}</button>
        </div>
      </form>
    </div>`;
  };

  const hotAlert = (hits: HotHit[]): TemplateResult => html`<section class="rounded-2xl border-4 border-red-500 bg-red-950 p-4 shadow-2xl" role="alert" data-testid="hot-alert">
    <div class="flex items-center gap-3 animate-pulse-alert">
      ${icon('alert', 'h-10 w-10 text-red-300')}
      <div>
        <p class="text-xs font-bold tracking-widest text-red-300 uppercase">Officer safety</p>
        <p class="text-2xl font-black text-white">HOT LIST MATCH</p>
      </div>
    </div>
    <ul class="mt-4 grid gap-3">
      ${hits.map(
        (h) => html`<li class="rounded-xl bg-black/30 p-3">
          <div class="flex flex-wrap items-center gap-2">
            ${plateBadge(h.entry.plate, 'lg')}
            <span class="chip ${RISK_LEVEL_CLASS[h.entry.riskLevel]}">${RISK_LEVEL_LABELS[h.entry.riskLevel]}</span>
            ${h.strength === 'possible' ? html`<span class="chip border-amber-400 bg-amber-500/20 text-amber-100">Possible match — verify plate</span>` : nothing}
          </div>
          <p class="mt-2 text-lg font-bold text-white">${[h.entry.colour, h.entry.make, h.entry.model, h.entry.bodyType].filter(Boolean).join(' ') || 'No vehicle description'}</p>
          <div class="mt-2 flex flex-wrap gap-2">${h.entry.risks.map((r) => html`<span class="chip border-red-400/70 bg-red-500/20 text-red-100">${RISK_TAG_LABELS[r]}</span>`)}</div>
          ${h.entry.notes ? html`<p class="mt-2 text-sm whitespace-pre-line text-red-100">${h.entry.notes}</p>` : nothing}
          <p class="mt-2 text-xs text-red-300">List: ${h.list.name}</p>
        </li>`,
      )}
    </ul>
  </section>`;

  const evidenceTile = (label: string, s: ScanRecord): TemplateResult => html`<figure class="min-w-0">
    <figcaption class="mb-1 text-xs font-bold tracking-wide text-slate-400 uppercase">${label}</figcaption>
    <a href="#/record/${s.id}"><img src=${urls.get(s.image)} alt="${label} evidence" class="aspect-[4/3] w-full rounded-lg border border-ink-600 bg-black object-cover" /></a>
    <p class="mt-1 font-plate text-sm">${formatClock(s.meta.capturedAt)}</p>
    <p class="text-xs text-slate-400">${s.meta.location ? `±${Math.round(s.meta.location.accuracy)} m` : 'no GPS'}</p>
  </figure>`;

  const comparisonPanel = (c: Comparison): TemplateResult => {
    const o = c.observation;
    const tone = c.overstay ? 'border-red-500 bg-red-950' : 'border-amber-500 bg-amber-950/60';
    return html`<section class="rounded-2xl border-4 ${tone} p-4" data-testid="comparison">
      <p class="text-xs font-bold tracking-widest uppercase ${c.overstay ? 'text-red-300' : 'text-amber-300'}">${c.overstay ? 'Overstay' : 'Re-sighting — within allowance'}</p>
      <div class="mt-1 flex items-end justify-between gap-3">
        ${plateBadge(o.plate, 'lg')}
        <div class="text-right">
          <p class="text-xs text-slate-300">Elapsed since scan 1</p>
          <p class="font-plate text-3xl font-black ${c.overstay ? 'text-red-200' : 'text-amber-100'}" data-testid="elapsed">${formatDuration(c.elapsedMs)}</p>
        </div>
      </div>
      <p class="mt-2 text-sm text-slate-200">
        ${o.restrictionCode} allowance ${formatMinutes(o.limitMinutes)}${o.graceMinutes ? ` + ${formatMinutes(o.graceMinutes)} grace` : ''} ·
        ${c.remainingMs > 0 ? html`<strong>${formatDuration(c.remainingMs)} remaining</strong>` : html`<strong>exceeded by ${formatDuration(-c.remainingMs)}</strong>`}
      </p>
      <div class="mt-4 grid grid-cols-2 gap-3">${evidenceTile('Scan 1', c.first)}${evidenceTile(`Scan ${o.scanCount}`, c.current)}</div>
      <button type="button" class="btn-secondary mt-4 w-full" @click=${resetObservation}>${icon('refresh')} Vehicle moved — restart timing</button>
    </section>`;
  };

  const statusCard = (tone: 'ok' | 'info' | 'muted' | 'warn', title: string, body: TemplateResult | string, testid: string) => {
    const cls = {
      ok: 'border-emerald-500 bg-emerald-950/70',
      info: 'border-sky-500 bg-sky-950/70',
      muted: 'border-ink-600 bg-ink-900',
      warn: 'border-amber-500 bg-amber-950/70',
    }[tone];
    return html`<section class="rounded-2xl border-2 ${cls} p-4" data-testid=${testid}>
      <p class="text-xl font-bold">${title}</p>
      <div class="mt-1 text-slate-200">${body}</div>
    </section>`;
  };

  const decisionPanel = (r: ResultState): TemplateResult => {
    const d = r.decision;
    switch (d.kind) {
      case 'timed_exempt':
        return statusCard('ok', 'Exempt — ignored', html`On <strong>${d.hit.list.name}</strong>${d.hit.entry.label ? ` (${d.hit.entry.label})` : ''}${d.hit.entry.permitNo ? ` · permit #${d.hit.entry.permitNo}` : ''}. No record created.`, 'result-exempt');
      case 'timed_not_in_force':
        return statusCard('muted', 'Restriction not in force', d.next ? `Next restriction ${d.next.restriction.code} from ${formatDateTime(d.next.start)}. No record created.` : 'No upcoming restriction found. No record created.', 'result-not-in-force');
      case 'timed_new': {
        const r0 = d.instance.restriction;
        const ends = (r.saved?.meta.capturedAt ?? Date.now()) + r0.limitMinutes * 60_000;
        return statusCard('info', 'First sighting recorded', html`${r0.code} allowance (${formatMinutes(r0.limitMinutes)}) started. Expires <strong>${formatClock(ends)}</strong>. Re-scan after that time to check for overstay.`, 'result-recorded');
      }
      case 'timed_resighting':
        return r.comparison ? comparisonPanel(r.comparison) : statusCard('warn', 'Re-sighting', `Elapsed ${formatDuration(d.elapsedMs)}.`, 'result-resighting');
      case 'timed_possible':
        return html`<section class="rounded-2xl border-2 border-amber-500 bg-amber-950/60 p-4" data-testid="result-possible">
          <p class="text-xl font-bold">Possible earlier sighting</p>
          <p class="mt-1 text-sm text-slate-200">${r.plate} is similar to a tracked plate. Compare the images and confirm.</p>
          <ul class="mt-3 grid gap-3">
            ${d.candidates.map((o) => {
              const s = r.possibleFirsts.get(o.id);
              return html`<li class="rounded-xl bg-black/30 p-3">
                <div class="flex items-center gap-3">
                  ${s ? html`<img src=${urls.get(s.thumb)} alt="" class="h-16 w-24 rounded-lg object-cover" />` : nothing}
                  <div>${plateBadge(o.plate, 'sm')}<p class="mt-1 text-xs text-slate-300">First seen ${formatClock(o.startedAt)}</p></div>
                </div>
                <button type="button" class="btn-primary mt-3 w-full" @click=${() => void resolvePossible(o)}>Same vehicle</button>
              </li>`;
            })}
          </ul>
          <button type="button" class="btn-secondary mt-3 w-full" @click=${() => void resolvePossible(null)}>Different vehicle — record new</button>
        </section>`;
      case 'hot_match':
        return statusCard('warn', 'Sighting recorded', 'Evidence image with location and time saved to this hot list.', 'result-hot');
      case 'hot_none':
        return statusCard('ok', 'No hot-list match', `${r.plate} is not on any hot list.`, 'result-hot-none');
      case 'allow_member':
        return statusCard(
          d.validNow ? 'ok' : 'warn',
          d.validNow ? 'On allow list' : 'On allow list — not currently valid',
          html`${d.hit.entry.label || 'No label'}${d.hit.entry.permitNo ? ` · permit #${d.hit.entry.permitNo}` : ''}${d.hit.entry.validTo ? ` · valid to ${d.hit.entry.validTo}` : ''}`,
          'result-allow',
        );
      case 'allow_none':
        return statusCard(
          'muted',
          'Not on this allow list',
          html`${d.possible.length ? html`Similar: ${d.possible.map((e) => html`${plateBadge(e.plate, 'sm')} `)}` : nothing}
            <button type="button" class="btn-secondary mt-3 w-full" @click=${() => app.navigate(`/list/${listId}/edit?plate=${encodeURIComponent(r.plate)}`)}>${icon('plus')} Add ${r.plate} to this list</button>`,
          'result-allow-none',
        );
    }
  };

  const resultPanel = (): TemplateResult => {
    const r = result!;
    return html`<div class="mx-auto max-w-xl px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-32">
      <div class="mb-3 flex items-center justify-between">
        <h1 class="text-lg font-bold">Result</h1>
        ${plateBadge(r.plate, 'md')}
      </div>
      <div class="grid gap-4">
        ${r.hotHits.length ? hotAlert(r.hotHits) : nothing}
        ${decisionPanel(r)}
        ${['timed_new','timed_resighting'].includes(r.decision.kind) && paymentLines(pending?.meta.payment).length
          ? html`<section class="card"><h2>Check payment before enforcing</h2>${paymentLines(pending?.meta.payment).map(line => html`<p>${line}</p>`)}</section>` : nothing}
        ${r.saved
          ? html`<p class="text-center text-xs text-slate-500">Saved · SHA-256 ${r.saved.sha256.slice(0, 16)}… · <a class="underline" href="#/record/${r.saved.id}">view record</a></p>`
          : nothing}
      </div>
      <div class="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-950/95 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur">
        <button type="button" class="btn-primary mx-auto flex w-full max-w-xl py-4 text-lg" data-testid="next-scan" ?disabled=${phase === 'saving'} @click=${resetToLive}>
          ${icon('camera', 'h-6 w-6')} Next scan
        </button>
      </div>
    </div>`;
  };

  const noCameraPanel = (): TemplateResult => html`<div class="mx-auto max-w-xl px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-16">
    <div class="flex items-center gap-2">
      <button type="button" class="btn-ghost min-h-11 px-2" aria-label="Back" @click=${() => app.navigate(`/list/${listId}`)}>${icon('back', 'h-6 w-6')}</button>
      <h1 class="text-lg font-bold">${list?.name ?? 'Scan'}</h1>
    </div>
    <div class="card mt-4">
      <p class="font-semibold">Live camera unavailable</p>
      <p class="mt-1 text-sm text-slate-400">${cameraMessage}</p>
      <button type="button" class="btn-primary mt-4 w-full" @click=${() => fileRef.value?.click()}>${icon('camera')} Take photo with device camera</button>
      <button type="button" class="btn-secondary mt-3 w-full" @click=${() => void startCamera()}>${icon('refresh')} Retry live camera</button>
      <p class="mt-3 text-xs text-slate-500">Time and location are recorded when the photo is submitted.</p>
    </div>
    <div class="mt-4 flex items-center justify-center gap-2">${geoBadge()}</div>
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
    },
    async unmount() {
      disposed = true;
      await Promise.all(listeners.splice(0).map(h => h.remove()));
      if (nativeActive) await patrol.stop();
      await Promise.all(queue.splice(0).map(({s}) => patrol.release({path:s.path})));
      clearInterval(clock);
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

