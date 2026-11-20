import { comparePlates, normalisePlate } from '../../lib/plate';
import { getAllowLists,getHotLists,getObservations } from '../../lib/db';
import { correctRecord } from '../../lib/corrections';
import { paymentLines } from '../../lib/payment';
import { html, nothing, type TemplateResult } from 'lit-html';
import { evidenceFileName } from '../../lib/capture';
import { deleteScan, getList, getObservation, getScan, getScansForObservation, putObservation } from '../../lib/db';
import { readExifSummary } from '../../lib/exif';
import { shareFile } from '../../lib/files';
import { formatLatLng, mapUrl } from '../../lib/geo';
import { sha256Hex } from '../../lib/hash';
import { formatClock, formatDateTime, formatDuration, formatMinutes } from '../../lib/time';
import type { Observation, PlateList, ScanRecord } from '../../lib/types';
import type { App, View } from '../app';
import { header, icon, page, plateBadge, UrlBag } from '../components';
import { outcomeChip } from './listDetail';

export function recordView(params: Record<string, string>, app: App): View {
  const id = params.id ?? '';
  let scan: ScanRecord | null = null;
  let list: PlateList | undefined;
  let observation: Observation | undefined;
  let timeline: ScanRecord[] = [];
  let integrity: 'unchecked' | 'checking' | 'ok' | 'mismatch' = 'unchecked';
  let exif: ReturnType<typeof readExifSummary> | null = null;
  const urls = new UrlBag();

  let near: string[] = [];
  const saveDraft = async (dismiss = false) => {
    if (!scan || draft === null || !list) return;
    try {
      if (!dismiss) {
        const lists = [...await getHotLists(), ...((await getAllowLists()).filter(a =>
          list?.type === 'timed' ? list.allowListIds.includes(a.id) : a.id === list?.id))];
        const entries = lists.flatMap(l => l.entries.map(e => ({plate:e.plate,source:l.name})));
        if (list.type === 'timed') {
          const at = scan.meta.capturedAt;
          for (const o of await getObservations(list.id)) {
            if (o.firstScanId !== scan.id && o.startedAt <= at && o.windowEndsAt > at && (!o.closedAt || o.closedAt > at)) entries.push({plate:o.plate,source:list.name});
          }
        }
        near = entries.filter(e => comparePlates(draft!,e.plate) === 'possible').map(e => e.plate+' · '+e.source);
        if (near.length) {app.update();return;}
      }
      await correctRecord(id,normalisePlate(draft),scan.plate);
      near=[]; draft=null; await load();
    } catch(error) {app.toast((error as Error).message,'error');}
  };
  let draft: string | null = null;
  const load = async () => {
    const s = await getScan(id);
    if (!s) {
      app.toast('Record not found.', 'error');
      app.navigate('/', true);
      return;
    }
    scan = s;
    list = await getList(s.listId);
    observation = s.observationId ? await getObservation(s.observationId) : undefined;
    timeline = observation ? await getScansForObservation(observation.id) : [];
    app.update();
  };

  const verify = async () => {
    if (!scan) return;
    integrity = 'checking';
    app.update();
    const [hash, bin] = await Promise.all([
      sha256Hex(scan.image),
      scan.image.arrayBuffer().then((b) => {
        let s = '';
        const u = new Uint8Array(b);
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
        return s;
      }),
    ]);
    integrity = hash === scan.sha256 ? 'ok' : 'mismatch';
    try {
      exif = readExifSummary(bin);
    } catch {
      exif = null;
    }
    app.update();
  };

  const share = async () => {
    if (!scan) return;
    try {
      await shareFile(scan.image, evidenceFileName(scan.plate, scan.meta.capturedAt), `Evidence ${scan.plate}`);
    } catch (e) {
      app.toast(`Share failed: ${(e as Error).message}`, 'error');
    }
  };

  const remove = async () => {
    if (!scan) return;
    const isAnchor = observation?.firstScanId === scan.id;
    const ok = await app.confirm({
      title: 'Delete scan record?',
      body: isAnchor
        ? 'This is the first sighting for an active timing. Deleting it also closes that timing. This cannot be undone.'
        : 'The evidence image and metadata will be permanently deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    if (observation) {
      const remaining = timeline.filter((t) => t.id !== scan!.id);
      if (isAnchor || remaining.length === 0) {
        await putObservation({ ...observation, status: 'reset', closedAt: Date.now() });
      } else if (observation.lastScanId === scan.id) {
        await putObservation({ ...observation, lastScanId: remaining[remaining.length - 1]!.id, scanCount: remaining.length });
      } else {
        await putObservation({ ...observation, scanCount: remaining.length });
      }
    }
    await deleteScan(scan.id);
    app.toast('Record deleted.', 'success');
    app.navigate(`/list/${scan.listId}`, true);
  };

  const endTiming = async () => {
    if (!observation || observation.status !== 'active') return;
    const ok = await app.confirm({
      title: 'Stop timing this vehicle?',
      body: 'Use when the vehicle has left or moved. Scan records are kept.',
      confirmLabel: 'Stop timing',
    });
    if (!ok) return;
    observation = { ...observation, status: 'reset', closedAt: Date.now() };
    await putObservation(observation);
    app.toast('Timing stopped.', 'success');
    app.update();
  };

  const row = (label: string, value: TemplateResult | string) => html`<dt class="text-slate-400">${label}</dt><dd class="min-w-0 break-words">${value}</dd>`;

  return {
    mount: load,
    unmount: () => urls.revokeAll(),
    render() {
      if (!scan) return html`${header({ title: 'Loading…', back: () => app.back() })}`;
      const s = scan;
      const loc = s.meta.location;
      return html`${header({
          title: s.plate,
          subtitle: list ? list.name : 'Scan record',
          back: () => app.back(`/list/${s.listId}`),
          actions: html`<button type="button" class="btn-ghost min-h-11 px-3" aria-label="Share evidence" @click=${share}>${icon('share')}</button>`,
        })}
        ${page(html`
          <a href=${urls.get(s.image)} target="_blank" rel="noopener"><img src=${urls.get(s.image)} alt="Evidence image" class="w-full rounded-xl border border-ink-600 bg-black" /></a>
          ${draft === null ? html`<button class="btn-secondary" @click=${() => { draft=s.plate; app.update(); }}>Edit plate</button>` :
            html`<form @submit=${async (event:Event) => {
              event.preventDefault();
              await saveDraft();
            }}><label>Plate <input class="field" maxlength="10" .value=${draft} @input=${(e:Event) => draft=(e.target as HTMLInputElement).value}></label>
            <button class="btn-primary">Save and recheck</button><button type="button" class="btn-secondary" @click=${() => {draft=null;app.update();}}>Cancel</button></form>`}
          ${near.length ? html`<div role="dialog" class="fixed inset-0 z-50 grid place-items-center bg-black/80"><section class="card"><img class="max-h-48" src=${urls.get(s.thumb)} alt="Current capture"><p>Current scan · ${draft}</p>${near.map(n => html`<p>Near match · ${n}</p>`)}<button class="btn-primary" @click=${() => {near=[];app.update();}}>Edit</button><button class="btn-secondary" @click=${() => saveDraft(true)}>Dismiss</button></section></div>` : nothing}
          ${s.revisions?.map(r => html`<p>Previous plate ${r.plate} · ${r.outcome} · amended ${formatDateTime(r.at)}</p>`)}
          ${s.amendmentResult ? html`<p>Recheck · ${s.amendmentResult.replaceAll('_',' ')} ${s.amendmentMatches?.join(', ')}</p>` : nothing}
          <div class="mt-3 flex flex-wrap items-center gap-2">${plateBadge(s.plate, 'lg')}${outcomeChip(s.outcome)}${s.corrected ? html`<span class="chip border-ink-600 text-slate-300">OCR corrected</span>` : nothing}</div>

          ${observation
            ? html`<section class="card mt-4">
                <h2 class="section-title">Timing (${observation.restrictionCode} · ${formatMinutes(observation.limitMinutes)}${observation.graceMinutes ? ` + ${observation.graceMinutes}m grace` : ''})</h2>
                <p class="text-sm text-slate-300">Status: <strong>${observation.status}</strong> · started ${formatDateTime(observation.startedAt)} · allowance ends ${formatClock(observation.allowanceEndsAt)}</p>
                <ol class="mt-3 grid gap-2">
                  ${timeline.map(
                    (t, i) => html`<li>
                      <a href="#/record/${t.id}" class="flex items-center gap-3 rounded-xl p-2 ${t.id === s.id ? 'bg-ink-800' : ''}">
                        <img src=${urls.get(t.thumb)} alt="" class="h-12 w-16 rounded-md object-cover" />
                        <div class="flex-1 text-sm">
                          <p class="font-semibold">Scan ${i + 1} · ${formatClock(t.meta.capturedAt)}</p>
                          <p class="text-xs text-slate-400">${i === 0 ? 'First sighting' : `+${formatDuration(t.meta.capturedAt - observation!.startedAt)} after scan 1`}</p>
                        </div>
                        ${outcomeChip(t.outcome)}
                      </a>
                    </li>`,
                  )}
                </ol>
                ${observation.status === 'active'
                  ? html`<button type="button" class="btn-secondary mt-3 w-full" @click=${endTiming}>Stop timing (vehicle left)</button>`
                  : nothing}
              </section>`
            : nothing}

          <section class="card mt-4">
            <h2 class="section-title">Capture metadata</h2>
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              ${paymentLines(s.meta.payment).map(line => row('Paid parking', line))}
              ${row('Device time', html`<span class="font-plate">${s.meta.capturedAtLocal}</span>`)}
              ${row('UTC', html`<span class="font-plate">${new Date(s.meta.capturedAt).toISOString()}</span>`)}
              ${row('Time zone', s.meta.timeZone)}
              ${loc
                ? html`${row('Lat, lng', html`<a class="text-brand-400 underline" href=${mapUrl(loc)} target="_blank" rel="noopener noreferrer">${formatLatLng(loc)}</a>`)}
                  ${row('Accuracy', `±${loc.accuracy.toFixed(1)} m`)}
                  ${loc.altitude !== null ? row('Altitude', `${loc.altitude.toFixed(1)} m${loc.altitudeAccuracy !== null ? ` ±${loc.altitudeAccuracy.toFixed(1)}` : ''}`) : nothing}
                  ${loc.heading !== null ? row('Heading', `${loc.heading.toFixed(0)}°`) : nothing}
                  ${loc.speed !== null ? row('Speed', `${(loc.speed * 3.6).toFixed(1)} km/h`) : nothing}
                  ${row('Fix age', s.meta.locationAgeMs !== null ? `${(s.meta.locationAgeMs / 1000).toFixed(1)} s` : '—')}`
                : row('Location', html`<span class="text-red-300">Unavailable</span>`)}
              ${row('OCR', s.ocrConfidence !== null ? `${s.ocrConfidence}% · “${s.ocrText || '—'}”` : 'Manual entry')}
              ${row('SHA-256', html`<span class="font-plate text-xs">${s.sha256}</span>`)}
            </dl>
            <button type="button" class="btn-secondary mt-3 w-full" @click=${verify} ?disabled=${integrity === 'checking'}>${icon('shield')} Verify image integrity & EXIF</button>
            ${integrity === 'ok'
              ? html`<p class="mt-2 text-sm text-emerald-300">Image hash matches the value recorded at capture.</p>`
              : integrity === 'mismatch'
                ? html`<p class="mt-2 text-sm text-red-300">Hash mismatch — image differs from capture.</p>`
                : nothing}
            ${exif
              ? html`<p class="mt-1 text-xs text-slate-400">EXIF: DateTimeOriginal ${exif.dateTimeOriginal ?? '—'} ${exif.offset ?? ''} · GPS ${exif.lat !== undefined ? `${exif.lat.toFixed(6)}, ${exif.lng?.toFixed(6)}` : 'none'}${exif.accuracy !== undefined ? ` ±${exif.accuracy} m` : ''}</p>`
              : nothing}
          </section>

          <div class="mt-4 grid grid-cols-2 gap-3">
            <button type="button" class="btn-secondary" @click=${share}>${icon('share')} Share / save</button>
            <button type="button" class="btn-ghost text-red-300" @click=${remove}>${icon('trash')} Delete</button>
          </div>
        `)}`;
    },
  };
}
