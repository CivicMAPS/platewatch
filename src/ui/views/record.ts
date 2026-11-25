import { comparePlates, normalisePlate } from '../../lib/plate';
import { getAllowLists,getHotLists,getObservations } from '../../lib/db';
import { correctRecord } from '../../lib/corrections';
import { paymentLines } from '../../lib/payment';
import { html, nothing, type TemplateResult } from 'lit-html';
import { evidenceFileName } from '../../lib/capture';
import { deleteScan, getList, getObservation, getScan, getScansForObservation, putObservation } from '../../lib/db';
import { readExifSummary } from '../../lib/exif';
import { describeOcr, timingState } from '../../lib/recordSummary';
import { shareFile } from '../../lib/files';
import { formatLatLng, mapUrl } from '../../lib/geo';
import { sha256Hex } from '../../lib/hash';
import { formatClock, formatDateTime, formatDuration, formatMinutes, formatStamp } from '../../lib/time';
import type { LookalikeLink, Observation, PlateList, ScanRecord } from '../../lib/types';
import { sameVehicleLink } from '../../lib/lookalike';
import { formatInfringementNumber } from '../../lib/infringement';
import type { App, View } from '../app';
import { banner, header, icon, nearMatchSheet, page, plateBadge, statusPill, UrlBag } from '../components';
import { outcomeChip } from './listDetail';
import { DISMISS_LABEL } from '../../lib/dismissal';

const CHOICE_TEXT: Record<LookalikeLink['choice'], string> = {
  same: 'Same vehicle — linked to this timing',
  different: 'Different vehicle — recorded new',
  hot_confirmed: 'Same vehicle — hot list sighting',
  not_hot: 'Not the hot-list vehicle',
  permit_plate: 'Permit plate confirmed — plate edited',
  not_permit: 'Not the permit plate — checked as read',
};
const SOURCE_TEXT: Record<LookalikeLink['source'], string> = { timed: 'timed on this segment', hot: 'hot list', allow: 'permit list' };

/** Neutral dashed chip: a look-alike link is not a status (WF-S28). */
const lookalikeChip = (): TemplateResult =>
  html`<span class="chip border-dashed border-neutral-400 bg-surface text-xs font-semibold tracking-[0.04em] text-neutral-700 uppercase" data-testid="lookalike-chip">${icon('link', 'h-3.5 w-3.5')} Look-alike link</span>`;

/**
 * 28h.2: look-alike decisions on this scan (every candidate shown, with the choice and time), and
 * on a timing's first scan the scans that were linked to it.
 */
function lookalikeCard(s: ScanRecord, linked: ScanRecord[] = []): TemplateResult | typeof nothing {
  const links = s.lookalikes ?? [];
  if (!links.length && !linked.length) return nothing;
  return html`<section class="card mt-3 border-2 border-dashed border-neutral-400 text-sm" data-testid="lookalike-card">
    <h2 class="section-title flex items-center gap-2">${icon('link', 'h-4 w-4')} Look-alike</h2>
    <ul class="grid gap-2">
      ${links.map(
        (l) => html`<li><span class="font-plate">${l.readAs}</span> read · similar to <span class="font-plate">${l.candidatePlate}</span> (${SOURCE_TEXT[l.source]})<br />
          <span class="font-semibold">${CHOICE_TEXT[l.choice]}</span> · <span class="font-plate">${formatStamp(l.decidedAt)}</span></li>`,
      )}
      ${linked.map((t) => html`<li>Linked: <span class="font-plate">${t.plate}</span> at <span class="font-plate">${formatClock(t.meta.capturedAt)}</span></li>`)}
    </ul>
  </section>`;
}

/** 31h.1: the infringement issued from this scan. */
function infringementRecord(i: NonNullable<ScanRecord['infringement']>): TemplateResult {
  return html`<section class="card mt-3 border-2 border-issued text-sm" data-testid="record-infringement">
    <h2 class="section-title">Infringement</h2>
    <p class="font-plate text-md font-bold">${formatInfringementNumber(i.number)}</p>
    <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      <dt class="text-neutral-600">Status</dt><dd>${i.status}${i.sync === 'pending' ? ' · sync queued' : i.sync === 'rejected' ? ' · sync rejected' : ''}</dd>
      <dt class="text-neutral-600">Offence</dt><dd class="font-plate">${i.offenceCode}${i.offenceOverridden ? ' (changed from the suggestion)' : ''}</dd>
      <dt class="text-neutral-600">Time</dt><dd class="font-plate">${formatClock(i.timeFrom)} → ${formatClock(i.timeTo)}</dd>
      ${i.issuedAt ? html`<dt class="text-neutral-600">Issued</dt><dd class="font-plate">${formatStamp(i.issuedAt)}</dd>` : nothing}
      <dt class="text-neutral-600">Officer</dt><dd class="font-plate">${i.officerNumber || '—'}</dd>
    </dl>
  </section>`;
}

const PAY_SOURCE: Record<NonNullable<ScanRecord['payment']>['source'], string> = { easypark: 'EasyPark', paystay: 'PayStay', meter: 'Meter', ticket: 'Ticket', other: 'Other' };

/** 30g.2: the officer's payment check, with earlier paid-to values (top-ups) as history. */
function paymentRecord(p: NonNullable<ScanRecord['payment']>): TemplateResult {
  return html`<section class="card mt-3 text-sm" data-testid="record-payment">
    <h2 class="section-title flex items-center gap-2">Payment check ${p.status === 'paid' ? statusPill('permit_valid', 'Paid') : statusPill('not_in_force', 'Not found')}</h2>
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      <dt class="text-neutral-600">Method</dt><dd>${PAY_SOURCE[p.source]}${p.sourceRef ? html` <span class="font-plate">${p.sourceRef}</span>` : nothing}</dd>
      ${p.paidFrom !== undefined ? html`<dt class="text-neutral-600">Paid from</dt><dd class="font-plate">${formatStamp(p.paidFrom)}</dd>` : nothing}
      ${p.paidTo !== undefined ? html`<dt class="text-neutral-600">Paid to</dt><dd class="font-plate">${formatStamp(p.paidTo)}</dd>` : nothing}
      <dt class="text-neutral-600">Entered by</dt><dd class="font-plate">${p.checkedBy || '—'}</dd>
      <dt class="text-neutral-600">Entered at</dt><dd class="font-plate">${formatStamp(p.checkedAt)}</dd>
      ${(p.history ?? []).map((h) => html`<dt class="text-neutral-600">Earlier paid to</dt><dd><span class="font-plate">${formatStamp(h.paidTo)}</span> · <span class="font-plate">${h.checkedBy || '—'}</span></dd>`)}
    </dl>
  </section>`;
}

/** Timing status; "overdue" matches OVERDUE on the list once allowance + grace has run out. */
function timingLine(o: Observation): TemplateResult {
  const now = Date.now();
  const state = timingState(o, now);
  const started = `started ${formatDateTime(o.startedAt)}`;
  if (state === 'overdue') {
    const endedAt = o.allowanceEndsAt + o.graceMinutes * 60_000;
    return html`<p class="text-sm text-neutral-700">${statusPill('overdue')} ${started} · allowance ended <span class="font-plate">${formatClock(endedAt)}</span> (${formatDuration(now - endedAt)} ago). Re-scan the vehicle to record an overstay.</p>`;
  }
  if (state === 'dismissed')
    return html`<p class="text-sm text-neutral-700">${statusPill('dismissed', 'Alert dismissed')} ${started}${o.dismissReason ? ` · ${DISMISS_LABEL[o.dismissReason]}` : ''}</p>`;
  const pill = state === 'running' ? statusPill('timing', 'Active') : statusPill('not_in_force', state);
  return html`<p class="text-sm text-neutral-700">${pill} ${started} · allowance ends <span class="font-plate">${formatClock(o.allowanceEndsAt)}</span></p>`;
}

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
  /** Persistent error for the edit-plate form (assessment D6). */
  let draftError = '';
  const saveDraft = async (dismiss = false) => {
    if (!scan || draft === null || !list) return;
    draftError = '';
    try {
      if (!dismiss) {
        const lists = [...await getHotLists(), ...((await getAllowLists()).filter(a =>
          list?.type === 'timed' ? list.allowListIds.includes(a.id) : list?.type === 'permit_zone' || a.id === list?.id))];
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
    } catch (error) {
      near = [];
      draftError = (error as Error).message;
      app.update();
    }
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

  const row = (label: string, value: TemplateResult | string) => html`<dt class="text-neutral-600">${label}</dt><dd class="min-w-0 break-words">${value}</dd>`;

  return {
    mount: load,
    unmount: () => urls.revokeAll(),
    render() {
      if (!scan) return html`${header({ title: 'Loading…', back: () => app.back() })}`;
      const s = scan;
      const loc = s.meta.location;
      /** 31h.2: a scan with an issued infringement cannot be edited or deleted (IR-23). */
      const locked = !!s.infringement && s.infringement.status !== 'cancelled';
      return html`${header({
          title: s.plate,
          subtitle: list ? list.name : 'Scan record',
          back: () => app.back(`/list/${s.listId}`),
          actions: html`<button type="button" class="btn-chrome" aria-label="Share evidence" @click=${share}>${icon('share')}</button>`,
        })}
        ${page(html`
          <a href=${urls.get(s.image)} target="_blank" rel="noopener"><img src=${urls.get(s.image)} alt="Evidence image" class="w-full rounded-md border border-neutral-200 bg-black" /></a>
          <div class="mt-3 flex flex-wrap items-center gap-2">${plateBadge(s.plate, 'lg')}${outcomeChip(s.outcome, s)}${s.corrected ? html`<span class="chip border-neutral-300 bg-surface text-xs text-neutral-700">${icon('edit', 'h-3.5 w-3.5')} OCR corrected</span>` : nothing}</div>
          ${s.payment ? paymentRecord(s.payment) : nothing}
          ${lookalikeCard(s, observation?.firstScanId === s.id ? timeline.filter((t) => observation?.linkedScanIds?.includes(t.id)) : [])}
          ${s.infringement ? infringementRecord(s.infringement) : nothing}
          ${locked
            ? html`<p class="mt-3 text-sm text-neutral-700" data-testid="record-locked">${icon('lock', 'h-4 w-4 inline')} Evidence locked: an infringement was issued from this scan, so the plate cannot be edited or the record deleted.</p>`
            : draft === null
            ? html`<button type="button" class="btn-secondary mt-3 w-full" @click=${() => { draft = s.plate; draftError = ''; app.update(); }}>${icon('edit')} Edit plate</button>`
            : html`<form class="card mt-3" @submit=${async (event: Event) => { event.preventDefault(); await saveDraft(); }}>
                <label for="edit-plate" class="field-label">Corrected plate</label>
                <input id="edit-plate" class="field text-center font-plate text-2xl font-bold tracking-[0.2em] uppercase" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false"
                  .value=${draft} @input=${(e: Event) => (draft = (e.target as HTMLInputElement).value)} />
                <p class="mt-2 text-xs text-neutral-600">Re-runs the check at the original capture time. The evidence image and its SHA-256 are not changed.</p>
                ${draftError ? html`<div class="mt-3">${banner('alert', 'Could not save the corrected plate', draftError)}</div>` : nothing}
                <div class="mt-3 grid grid-cols-2 gap-3">
                  <button type="button" class="btn-secondary" @click=${() => { draft = null; draftError = ''; app.update(); }}>Cancel</button>
                  <button type="submit" class="btn-primary">${icon('check')} Save and recheck</button>
                </div>
              </form>`}
          ${near.length
            ? nearMatchSheet({
                imageUrl: urls.get(s.thumb),
                plate: normalisePlate(draft ?? ''),
                suggestions: near,
                onEdit: () => { near = []; app.update(); },
                onNotMatch: () => void saveDraft(true),
              })
            : nothing}
          ${s.amendmentResult
            ? html`<div class="mt-3">${banner('pending', 'Rechecked after plate correction', html`${s.amendmentResult.replaceAll('_', ' ')}${s.amendmentMatches?.length ? html` · <span class="font-plate">${s.amendmentMatches.join(', ')}</span>` : nothing}`)}</div>`
            : nothing}
          ${s.revisions?.length
            ? html`<section class="card mt-3">
                <h2 class="section-title">Plate history</h2>
                <ul class="grid gap-1 text-sm">${s.revisions.map((r) => html`<li>Previous plate <span class="font-plate font-semibold">${r.plate}</span> · ${r.outcome.replaceAll('_', ' ')} · amended ${formatDateTime(r.at)}</li>`)}</ul>
              </section>`
            : nothing}

          ${observation
            ? html`<section class="card mt-4">
                <h2 class="section-title">Timing (${observation.restrictionCode} · ${formatMinutes(observation.limitMinutes)}${observation.graceMinutes ? ` + ${observation.graceMinutes}m grace` : ''})</h2>
                ${timingLine(observation)}
                <ol class="mt-3 grid gap-2">
                  ${timeline.map(
                    (t, i) => html`<li>
                      <a href="#/record/${t.id}" class="flex items-center gap-3 rounded-md p-2 ${t.id === s.id ? 'bg-surface-sunken' : ''}">
                        <img src=${urls.get(t.thumb)} alt="" class="h-12 w-16 rounded-md object-cover" />
                        <div class="min-w-0 flex-1 text-sm">
                          <p class="font-semibold">Scan ${i + 1} · <span class="font-plate">${formatClock(t.meta.capturedAt)}</span> · <span class="font-plate">${t.plate}</span></p>
                          <p class="text-xs text-neutral-600">${i === 0 ? 'First sighting' : `+${formatDuration(t.meta.capturedAt - observation!.startedAt)} after scan 1`}</p>
                          <div class="mt-1 flex flex-wrap gap-1">${outcomeChip(t.outcome, t)}${sameVehicleLink(t.lookalikes) ? lookalikeChip() : nothing}</div>
                        </div>
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
              ${row('Device time', html`<span class="font-plate">${formatStamp(s.meta.capturedAt)}</span>`)}
              ${row('ISO 8601', html`<span class="font-plate text-xs">${s.meta.capturedAtLocal}</span>`)}
              ${row('UTC', html`<span class="font-plate">${new Date(s.meta.capturedAt).toISOString()}</span>`)}
              ${row('Time zone', s.meta.timeZone)}
              ${loc
                ? html`${row('Lat, lng', html`<a class="link font-plate" href=${mapUrl(loc)} target="_blank" rel="noopener noreferrer">${formatLatLng(loc)}</a>`)}
                  ${row('Accuracy', `±${loc.accuracy.toFixed(1)} m`)}
                  ${loc.altitude !== null ? row('Altitude', `${loc.altitude.toFixed(1)} m${loc.altitudeAccuracy !== null ? ` ±${loc.altitudeAccuracy.toFixed(1)}` : ''}`) : nothing}
                  ${loc.heading !== null ? row('Heading', `${loc.heading.toFixed(0)}°`) : nothing}
                  ${loc.speed !== null ? row('Speed', `${(loc.speed * 3.6).toFixed(1)} km/h`) : nothing}
                  ${row('Fix age', s.meta.locationAgeMs !== null ? `${(s.meta.locationAgeMs / 1000).toFixed(1)} s` : '—')}`
                : row('Location', html`<span class="inline-flex items-center gap-1 font-semibold text-alert-strong">${icon('alert', 'h-4 w-4')} Unavailable</span>`)}
              ${row('OCR', describeOcr(s))}
              ${row('SHA-256', html`<span class="font-plate text-xs">${s.sha256}</span>`)}
            </dl>
            <button type="button" class="btn-secondary mt-3 w-full" @click=${verify} ?disabled=${integrity === 'checking'}>${icon('shield')} Verify image integrity & EXIF</button>
            ${integrity === 'ok'
              ? html`<div class="mt-3">${banner('active', 'Image hash matches the value recorded at capture.', undefined, 'integrity-ok')}</div>`
              : integrity === 'mismatch'
                ? html`<div class="mt-3">${banner('alert', 'Hash mismatch — image differs from capture.', 'Do not rely on this image as evidence.', 'integrity-mismatch')}</div>`
                : nothing}
            ${exif
              ? html`<p class="mt-1 text-xs text-neutral-600">EXIF: DateTimeOriginal ${exif.dateTimeOriginal ?? '—'} ${exif.offset ?? ''} · GPS ${exif.lat !== undefined ? `${exif.lat.toFixed(6)}, ${exif.lng?.toFixed(6)}` : 'none'}${exif.accuracy !== undefined ? ` ±${exif.accuracy} m` : ''}</p>`
              : nothing}
          </section>

          <div class="mt-4 grid grid-cols-2 gap-3">
            <button type="button" class="btn-secondary" @click=${share}>${icon('share')} Share / save</button>
            <button type="button" class="btn-secondary" ?disabled=${locked} @click=${remove}>${icon('trash')} Delete</button>
          </div>
        `)}`;
    },
  };
}
