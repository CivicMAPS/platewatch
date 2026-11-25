/**
 * Officer-safety overlay (owner direction 25/11/2026), above every screen:
 * - Hot-list pop-up: blocks the app until the officer answers CODE 1 or SAFE & CLEAR. Amber.
 * - Own Code 1: red banner until dispatch clears it; the officer can cancel one raised in error.
 * - Branch Code 1 (another officer): red flashing alarm with sound until RECEIVED, then a banner
 *   with the location pin until cleared.
 * Colour + icon + text throughout; red only for Code 1.
 */
import { html, nothing, render, type TemplateResult } from 'lit-html';
import { getHotEventsForEntry } from '../lib/db';
import { SAFE_CLEAR_HELP, SAFE_CLEAR_LABEL } from '../lib/hotlist';
import type { HotProfile, LiveAlert } from '../lib/host';
import { cancelCode1, currentOfficer, escalatedCode1, hotProfile, onSafetyChange, receiveCode1, respond, safetyState, type PendingHit } from '../lib/safety';
import { formatStamp } from '../lib/time';
import { RISK_LEVEL_LABELS, RISK_TAG_LABELS, type HotListEvent, type RiskLevel, type RiskTag } from '../lib/types';
import type { App } from './app';
import { icon, plateBadge, riskPill } from './components';

const OPEN = new Set(['active', 'radio_requested', 'acknowledged']);
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const mapLink = (l: { lat: number; lng: number } | null | undefined) =>
  l ? html`<a class="font-semibold underline" target="_blank" rel="noopener noreferrer" href=${`https://www.google.com/maps/search/?api=1&query=${l.lat.toFixed(6)},${l.lng.toFixed(6)}`}>Open map pin</a>` : nothing;
const where = (l: { lat: number; lng: number; accuracyM?: number | null } | null | undefined) =>
  l ? html`<span class="font-plate">${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}${l.accuracyM ? ` ±${Math.round(l.accuracyM)} m` : ''}</span>` : html`no location`;

export function mountSafetyOverlay(app: App): void {
  const host = document.createElement('div');
  host.id = 'safety-overlay';
  document.body.appendChild(host);

  let note = '';
  let officerDraft = '';
  let moreOpen = false;
  let busy = false;
  let profiles: Record<string, HotProfile | null | 'loading'> = {};
  let localLog: Record<string, HotListEvent[]> = {};
  let lastPendingKey = '';

  const loadProfile = async (h: PendingHit) => {
    if (profiles[h.hit.id] !== undefined) return;
    profiles = { ...profiles, [h.hit.id]: 'loading' };
    draw();
    const [p, local] = await Promise.all([hotProfile(h.hit.plate, h.hit.hotListEntryId), getHotEventsForEntry(h.hit.hotListEntryId).catch(() => [])]);
    profiles = { ...profiles, [h.hit.id]: p };
    localLog = { ...localLog, [h.hit.id]: local.filter((e) => e.kind === 'acknowledged') };
    draw();
  };

  const answer = async (response: 'safe_clear' | 'code1') => {
    if (busy) return;
    const officer = currentOfficer() || officerDraft.trim();
    // CODE 1 is never blocked; SAFE & CLEAR needs the officer number for the log.
    if (!officer && response !== 'code1') return;
    busy = true;
    draw();
    try {
      if (!currentOfficer() && officerDraft.trim()) await app.updateSettings({ officerNumber: officerDraft.trim() });
      await respond(response, note, officer);
      note = '';
      moreOpen = false;
    } finally {
      busy = false;
      draw();
    }
  };

  const profileView = (h: PendingHit): TemplateResult => {
    const p = profiles[h.hit.id];
    const e = h.hit.entry;
    const local = localLog[h.hit.id] ?? [];
    return html`<section class="mt-3 grid gap-3 rounded-md border border-neutral-200 bg-surface p-3 text-sm" data-testid="hot-profile">
      <div><p class="font-semibold text-neutral-900">Registered owner</p><p>${e.ownerDescription || 'No description held.'}</p></div>
      ${h.notes ? html`<div><p class="font-semibold text-neutral-900">Notes</p><p>${h.notes}</p></div>` : nothing}
      ${p === 'loading'
        ? html`<p class="text-neutral-600">Loading history…</p>`
        : p
          ? html`<div><p class="font-semibold text-neutral-900">Hot-list match history (${p.history.length})</p>
                <ul class="mt-1 grid gap-1" data-testid="hot-profile-history">${p.history.slice(0, 10).map((x) => html`<li><span class="font-plate">${formatStamp(x.at)}</span> · officer <span class="font-plate">${x.officerNumber}</span>${x.where ? ` · ${x.where}` : ''}${x.response ? ` · ${x.response === 'code1' ? 'CODE 1' : SAFE_CLEAR_LABEL}` : ' · no answer'}${x.alerts.length ? ` · ${x.alerts.map((a) => `${a.kind === 'code1' ? 'Code 1' : 'soft Code 1'} ${a.status}`).join(', ')}` : ''}</li>`)}</ul></div>
              <div><p class="font-semibold text-neutral-900">Interaction details</p>
                ${p.interactions.length ? html`<ul class="mt-1 grid gap-1">${p.interactions.slice(0, 10).map((x) => html`<li><span class="font-plate">${formatStamp(x.at)}</span> · <span class="font-plate">${x.officerNumber}</span>: ${x.note}</li>`)}</ul>` : html`<p class="text-neutral-600">No officer notes yet.</p>`}</div>
              <div><p class="font-semibold text-neutral-900">Known locations</p>
                ${p.knownLocations.length ? html`<ul class="mt-1 grid gap-1">${p.knownLocations.slice(0, 8).map((x) => html`<li>${x.label} · ${x.count}× · last <span class="font-plate">${formatStamp(x.lastAt)}</span></li>`)}</ul>` : html`<p class="text-neutral-600">None recorded.</p>`}</div>`
          : html`<div><p class="font-semibold text-neutral-900">History on this device (${local.length})</p>
              ${local.length ? html`<ul class="mt-1 grid gap-1">${local.slice(0, 10).map((x) => html`<li><span class="font-plate">${formatStamp(x.at)}</span> · ${x.response === 'code1' ? 'CODE 1' : SAFE_CLEAR_LABEL}${x.note ? ` — ${x.note}` : ''}</li>`)}</ul>` : html`<p class="text-neutral-600">No earlier interactions on this device. All officers' history needs the CommandMAPS connection.</p>`}</div>`}
    </section>`;
  };

  const pendingModal = (): TemplateResult | typeof nothing => {
    const p = safetyState().pending;
    if (!p) return nothing;
    const now = Date.now();
    const sc = p.softCode1;
    // The EnforcementMAPS sign-in identity counts; only the development build asks for a number.
    const officerSet = !!currentOfficer();
    const escalated = escalatedCode1()[0];
    const status = escalated
      ? html`<strong>CODE 1 raised for you</strong> (no radio response): your branch is alerted and help is coming.`
      : !sc
        ? html`Soft Code 1 to dispatch and your supervisor in <span class="font-plate" data-testid="hot-countdown">${mmss(p.deadline - now)}</span> unless you answer.`
        : sc.status === 'sent'
          ? html`<strong>Soft Code 1 sent.</strong> Dispatch or your supervisor will call you on the radio — answer them.`
          : sc.status === 'sending'
            ? html`Sending soft Code 1…`
            : sc.status === 'unavailable'
              ? html`<strong>No connection to dispatch on this device.</strong> Call dispatch on the radio now.`
              : html`<strong>Soft Code 1 not sent yet (retrying).</strong> Call dispatch on the radio.`;
    return html`<div class="fixed inset-0 z-[80] flex flex-col overflow-auto bg-black/70" role="alertdialog" aria-modal="true" aria-labelledby="hot-pop-title" data-testid="hot-popup">
      <header class="flash-amber flex items-center gap-3 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3 text-alert-text">
        ${icon('alert', 'h-7 w-7', 2.5)}
        <div class="min-w-0 flex-1"><p id="hot-pop-title" class="text-lg font-extrabold tracking-[0.06em] uppercase">Hot list · officer safety</p>
          <p class="text-sm font-semibold" data-testid="hot-soft-status" data-status=${escalated ? 'code1' : (sc?.status ?? 'counting')}>${status}</p></div>
      </header>
      <div class="mx-auto w-full max-w-xl flex-1 bg-surface p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        ${p.hits.map((h) => {
          const e = h.hit.entry;
          return html`<section class="mb-4" data-testid="hot-popup-hit">
            <div class="flex flex-wrap items-center gap-2">${plateBadge(h.hit.plate, 'xl')}${riskPill(e.riskLevel as RiskLevel, RISK_LEVEL_LABELS[e.riskLevel as RiskLevel] ?? e.riskLevel)}</div>
            <p class="mt-2 text-md font-semibold text-neutral-900" data-testid="hot-popup-vehicle">${[e.make, e.type, e.colour].filter(Boolean).join(' · ') || 'Vehicle details not held'}</p>
            <p class="mt-3 rounded-md border-2 border-alert bg-alert-bg p-3 text-lg font-bold text-alert-text" data-testid="hot-popup-message">${e.alertMessage || `Officer safety: ${e.risks.map((r) => RISK_TAG_LABELS[r as RiskTag] ?? r).join(', ') || 'see the hot list'}`}</p>
            ${e.risks.length ? html`<p class="mt-1 text-sm text-neutral-700">Risks: ${e.risks.map((r) => RISK_TAG_LABELS[r as RiskTag] ?? r).join(' · ')}</p>` : nothing}
            <button type="button" class="btn-ghost mt-2 w-full" data-testid="hot-more" aria-expanded=${moreOpen} @click=${() => { moreOpen = !moreOpen; if (moreOpen) void loadProfile(h); draw(); }}>${icon('info')} ${moreOpen ? 'Hide information' : 'More information'}</button>
            ${moreOpen ? profileView(h) : nothing}
          </section>`;
        })}
        ${officerSet
          ? nothing
          : html`<label class="mb-3 block"><span class="field-label">Your officer number (required for ${SAFE_CLEAR_LABEL})</span>
              <input class="field font-plate" data-testid="hot-officer" inputmode="numeric" maxlength="12" .value=${officerDraft} @input=${(ev: Event) => { officerDraft = (ev.target as HTMLInputElement).value; draw(); }} /></label>`}
        <label class="block"><span class="field-label">Note (optional) — kept on this plate’s history</span>
          <textarea class="field" rows="2" maxlength="1000" data-testid="hot-note" .value=${note} @input=${(ev: Event) => (note = (ev.target as HTMLTextAreaElement).value)}></textarea></label>
        <div class="mt-4 grid gap-3">
          <button type="button" class="flex min-h-16 w-full items-center justify-center gap-2 rounded-md bg-emergency px-4 text-lg font-extrabold tracking-[0.06em] text-white uppercase shadow-lg disabled:opacity-50" data-testid="hot-code1"
            ?disabled=${busy} @click=${() => void answer('code1')}>${icon('alert', 'h-6 w-6', 2.5)} Code 1 — I need help</button>
          <button type="button" class="btn-primary min-h-16 w-full flex-col gap-0 py-3 text-lg" data-testid="hot-safe-clear" ?disabled=${busy || (!officerSet && !officerDraft.trim())} @click=${() => void answer('safe_clear')}>
            <span class="flex items-center gap-2 font-extrabold tracking-[0.06em]">${icon('check', 'h-6 w-6', 2.5)} ${SAFE_CLEAR_LABEL}</span>
            <span class="text-sm font-normal">${SAFE_CLEAR_HELP}</span></button>
        </div>
        <p class="mt-3 text-center text-xs text-neutral-600">Nothing else can be done in PlateWatch until you answer. Time, location and officer number are logged with your answer.</p>
      </div>
    </div>`;
  };

  const branchAlarm = (a: LiveAlert): TemplateResult => html`<div class="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-4 p-6 text-center text-white flash-red" role="alertdialog" aria-modal="true" data-testid="code1-alarm" data-alert=${a.id}>
    <span class="text-white">${icon('alert', 'h-16 w-16', 2.5)}</span>
    <p class="text-3xl font-extrabold tracking-[0.08em] text-white uppercase">Code 1</p>
    <p class="text-lg font-bold text-white">${a.officerName ?? 'Officer'} · <span class="font-plate">${a.officerNumber}</span>${a.team ? ` · team ${a.team}` : ''} needs help</p>
    <p class="text-md text-white">Raised <span class="font-plate">${formatStamp(a.raisedAt)}</span>${a.hit ? html` · hot-list vehicle <span class="font-plate">${a.hit.plate}</span>` : nothing}</p>
    <p class="text-md text-white">${a.location ? html`${where(a.location)} · ${mapLink(a.location)}` : 'Location not received yet — it updates every 10 s'}</p>
    <button type="button" class="min-h-16 w-full max-w-sm rounded-md bg-white px-6 text-lg font-extrabold tracking-[0.06em] text-emergency-text uppercase" data-testid="code1-received" @click=${() => void receiveCode1(a.id)}>Received — silence alarm</button>
  </div>`;

  const banners = (): TemplateResult => {
    const s = safetyState();
    const own = s.code1;
    const ownLive = own ? s.own.find((a) => a.id === own.id) : undefined;
    const ownSoft = s.own.filter((a) => a.kind === 'soft_code1' && OPEN.has(a.status));
    const branchOpen = s.branch.filter((a) => OPEN.has(a.status) && a.received);
    return html`<div class="fixed inset-x-0 top-0 z-[75] grid gap-1 px-2 pt-[env(safe-area-inset-top)]" data-testid="safety-banners">
      ${own
        ? html`<div class="rounded-b-md bg-emergency px-3 py-2 text-sm text-white shadow-lg" role="alert" data-testid="code1-own" data-status=${own.status}>
            <p class="font-extrabold tracking-[0.06em] text-white uppercase">${icon('alert', 'h-4 w-4 inline', 2.5)} Code 1 active</p>
            <p class="text-white">${own.cancelRequested ? 'Cancelling — waiting for dispatch to confirm.' : own.status === 'sent' ? (ownLive?.acknowledgedBy ? `Acknowledged by ${ownLive.acknowledgedBy}. Help is coming; your location is shared every 10 s.` : 'Sent to dispatch and your branch. Your location is shared every 10 s.') : own.status === 'unavailable' ? 'No connection to dispatch on this device: use the radio duress button now.' : 'Sending… use the radio duress button as well.'}</p>
            <button type="button" class="mt-1 text-white underline" data-testid="code1-cancel" @click=${() => { const r = window.prompt('Cancel this Code 1 — raised in error? Reason:'); if (r !== null) void cancelCode1(r || 'raised in error'); }}>Cancel — raised in error</button>
          </div>`
        : nothing}
      ${escalatedCode1().map((a) => html`<div class="rounded-b-md bg-emergency px-3 py-2 text-sm text-white shadow-lg" role="alert" data-testid="code1-own-escalated" data-status=${a.status}>
          <p class="font-extrabold tracking-[0.06em] text-white uppercase">${icon('alert', 'h-4 w-4 inline', 2.5)} Code 1 raised for you</p>
          <p class="text-white">No radio response to the soft Code 1: your branch has been alerted and help is coming. Your location is shared every 10 s.${a.acknowledgedBy ? ` Dispatch: ${a.acknowledgedBy}.` : ''}</p></div>`)}
      ${ownSoft.map((a) => html`<div class="rounded-b-md border-2 border-alert bg-alert-bg px-3 py-2 text-sm text-alert-text shadow" role="status" data-testid="soft-code1-own" data-status=${a.status}>
          <strong>Soft Code 1 open.</strong> ${a.status === 'radio_requested' ? `${a.acknowledgedBy ?? 'Dispatch'} is calling you on the radio — answer now.` : 'Dispatch and your supervisor have been alerted — answer the radio.'}</div>`)}
      ${branchOpen.map((a) => html`<div class="rounded-b-md bg-emergency px-3 py-2 text-sm text-white shadow" role="status" data-testid="code1-branch-banner">
          <strong>CODE 1</strong> · ${a.officerName ?? 'officer'} <span class="font-plate">${a.officerNumber}</span> · ${where(a.location)} · ${mapLink(a.location)}${a.acknowledgedBy ? ` · dispatch: ${a.acknowledgedBy}` : ''}</div>`)}
    </div>`;
  };

  const draw = () => {
    const s = safetyState();
    const key = s.pending?.hits.map((h) => h.hit.id).join() ?? '';
    if (key !== lastPendingKey) {
      lastPendingKey = key;
      note = '';
      moreOpen = false;
    }
    const ringing = s.branch.find((a) => OPEN.has(a.status) && !a.received);
    render(html`${banners()}${pendingModal()}${ringing ? branchAlarm(ringing) : nothing}`, host);
  };

  onSafetyChange(draw);
  // The countdown.
  setInterval(() => safetyState().pending && draw(), 1000);
  draw();
}
