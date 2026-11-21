import { paymentLines } from '../../lib/payment';
import { zoneLabel } from '../../lib/listIndex';
import { html, nothing, type TemplateResult } from 'lit-html';
import {
  deleteList,
  expireObservations,
  getAllowLists,
  getList,
  getObservations,
  getScan,
  getScansForList,
} from '../../lib/db';
import { describeRestriction, nextRestrictionStart, restrictionInForce } from '../../lib/restriction';
import { formatClock, formatDateTime, formatDuration, formatUntil } from '../../lib/time';
import {
  RISK_LEVEL_LABELS,
  RISK_TAG_LABELS,
  type AllowList,
  type Observation,
  type PlateList,
  type ScanRecord,
  type TimedList,
} from '../../lib/types';
import type { App, View } from '../app';
import { header, icon, LIST_TYPE_META, page, plateBadge, RISK_LEVEL_CLASS, typeChip, UrlBag } from '../components';
import { segmentLabel } from './home';

const OUTCOME_LABEL: Record<ScanRecord['outcome'], { text: string; cls: string }> = {
  reviewed: {text:'Reviewed',cls:'border-ink-600'},
  recorded: { text: 'First sighting', cls: 'border-sky-500/50 bg-sky-500/10 text-sky-200' },
  within_allowance: { text: 'Within allowance', cls: 'border-amber-500/50 bg-amber-500/10 text-amber-200' },
  overstay: { text: 'Overstay', cls: 'border-red-500/60 bg-red-500/15 text-red-200' },
  hot_sighting: { text: 'Hot-list sighting', cls: 'border-red-500/60 bg-red-500/15 text-red-200' },
  permit_valid: { text: 'Permit valid', cls: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200' },
};

export function outcomeChip(o: ScanRecord['outcome']): TemplateResult {
  return html`<span class="chip ${OUTCOME_LABEL[o].cls}">${OUTCOME_LABEL[o].text}</span>`;
}

export function listDetailView(params: Record<string, string>, app: App): View {
  const id = params.id ?? '';
  let list: PlateList | null = null;
  let allowLists: AllowList[] = [];
  let observations: Observation[] = [];
  let firstScans = new Map<string, ScanRecord>();
  let recent: ScanRecord[] = [];
  let tick: number | undefined;
  const urls = new UrlBag();

  const load = async () => {
    const found = await getList(id);
    if (!found) {
      app.toast('List not found.', 'error');
      app.navigate('/', true);
      return;
    }
    list = found;
    if (found.type === 'timed') {
      allowLists = (await getAllowLists()).filter((a) => found.allowListIds.includes(a.id));
      const now = Date.now();
      const all = await getObservations(id);
      const stale = all.filter((o) => o.status === 'active' && o.windowEndsAt <= now).map((o) => o.id);
      await expireObservations(stale, now);
      observations = all
        .filter((o) => o.status === 'active' && !stale.includes(o.id))
        .sort((a, b) => a.startedAt - b.startedAt);
      firstScans = new Map();
      for (const o of observations) {
        const s = await getScan(o.firstScanId);
        if (s) firstScans.set(o.id, s);
      }
    }
    recent = await getScansForList(id, 50);
    app.update();
  };

  const remove = async () => {
    if (!list) return;
    const ok = await app.confirm({
      title: `Delete “${list.name}”?`,
      body:
        list.type === 'allow'
          ? 'The list will be removed and unlinked from any timed lists. This cannot be undone.'
          : 'The list and all scan records and evidence images captured against it will be permanently deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await deleteList(list.id);
    app.toast('List deleted.', 'success');
    app.navigate('/', true);
  };

  const observationRow = (o: Observation, now: number): TemplateResult => {
    const elapsed = now - o.startedAt;
    const over = elapsed >= (o.limitMinutes + o.graceMinutes) * 60_000;
    const first = firstScans.get(o.id);
    return html`<li>
      <button type="button" class="flex w-full items-center gap-3 py-3 text-left" @click=${() => app.navigate(`/record/${o.lastScanId}`)}>
        ${first
          ? html`<img src=${urls.get(first.thumb)} alt="" class="h-14 w-20 flex-none rounded-lg object-cover" loading="lazy" />`
          : html`<div class="h-14 w-20 flex-none rounded-lg bg-ink-800"></div>`}
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">${plateBadge(o.plate, 'sm')}<span class="text-xs text-slate-400">${o.restrictionCode}</span></div>
          <p class="mt-1 text-xs text-slate-400">First seen ${formatClock(o.startedAt)} · ${o.scanCount} scan${o.scanCount === 1 ? '' : 's'}</p>
        </div>
        <div class="text-right">
          <p class="font-plate text-base font-bold ${over ? 'text-red-300' : 'text-slate-100'}">${formatDuration(elapsed)}</p>
          <p class="text-xs ${over ? 'text-red-300' : 'text-slate-400'}">${over ? 'OVERDUE' : `ends ${formatClock(o.allowanceEndsAt).slice(0, 5)}`}</p>
        </div>
      </button>
    </li>`;
  };

  const timedSection = (l: TimedList, now: number): TemplateResult => {
    const inst = restrictionInForce(l, now);
    const next = inst ? null : nextRestrictionStart(l, now);
    return html`<section class="card mt-4">
        <h2 class="section-title">Segment</h2>
        <p class="font-semibold">${segmentLabel(l)} ${paymentLines(l.payment).map(line => html`<span class="chip">${line}</span>`)}</p>
        <p class="text-sm text-slate-400">${[l.patrolZone || l.patrolZoneName ? zoneLabel(l.patrolZone?.trim() || l.patrolZoneName!.trim(), l.patrolZoneName?.trim()) : '', l.rpa ? `RPA ${l.rpa}` : '', l.segment.suburb, l.segment.side !== 'both' ? `${l.segment.side} side` : 'both sides'].filter(Boolean).join(' · ')}</p>
        <ul class="mt-3 grid gap-1 text-sm">
          ${l.restrictions.map(
            (r) => html`<li class="flex items-center gap-2">
              <span class=${inst?.restriction.id === r.id ? 'text-emerald-300' : 'text-slate-300'}>${describeRestriction(r)}${r.graceMinutes ? ` (+${r.graceMinutes}m grace)` : ''}</span>
              ${r.description ? html`<span class="text-slate-500">— ${r.description}</span>` : nothing}
            </li>`,
          )}
        </ul>
        <p class="mt-3 text-sm ${inst ? 'text-emerald-300' : 'text-slate-400'}">
          ${inst
            ? `In force now: ${inst.restriction.code} until ${formatUntil(inst.end, now)}`
            : `Not in force${next ? ` — next ${formatDateTime(next.start)}` : ''}`}
        </p>
        ${allowLists.length
          ? html`<p class="mt-2 text-sm text-slate-300">Exempt: ${allowLists.map((a) => html`<a class="text-brand-400 underline" href="#/list/${a.id}">${a.name}</a> `)}</p>`
          : html`<p class="mt-2 text-sm text-slate-500">No linked allow lists.</p>`}
      </section>
      <section class="card mt-4">
        <h2 class="section-title">Tracked vehicles (${observations.length})</h2>
        ${observations.length
          ? html`<ul class="divide-y divide-ink-700">${observations.map((o) => observationRow(o, now))}</ul>`
          : html`<p class="text-sm text-slate-400">No vehicles being timed. Scan to record first sightings.</p>`}
      </section>`;
  };

  const recentSection = (): TemplateResult => html`<section class="card mt-4">
    <h2 class="section-title">Recent scan records</h2>
    ${recent.length
      ? html`<ul class="divide-y divide-ink-700">
          ${recent.map(
            (s) => html`<li>
              <button type="button" class="flex w-full items-center gap-3 py-2 text-left" @click=${() => app.navigate(`/record/${s.id}`)}>
                <img src=${urls.get(s.thumb)} alt="" class="h-12 w-16 flex-none rounded-md object-cover" loading="lazy" />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">${plateBadge(s.plate, 'sm')}${outcomeChip(s.outcome)}</div>
                  <p class="mt-1 text-xs text-slate-400">${formatDateTime(s.meta.capturedAt)}${s.meta.location ? ` · ±${Math.round(s.meta.location.accuracy)} m` : ' · no GPS'}</p>
                </div>
              </button>
            </li>`,
          )}
        </ul>`
      : html`<p class="text-sm text-slate-400">No scan records yet.</p>`}
  </section>`;

  const entriesSection = (l: PlateList): TemplateResult => {
    if (l.type === 'hot')
      return html`<section class="card mt-4">
        <h2 class="section-title">High-risk vehicles (${l.entries.length})</h2>
        ${l.entries.length
          ? html`<ul class="divide-y divide-ink-700">
              ${l.entries.map(
                (e) => html`<li class="py-3">
                  <div class="flex flex-wrap items-center gap-2">${plateBadge(e.plate, 'sm')}<span class="chip ${RISK_LEVEL_CLASS[e.riskLevel]}">${RISK_LEVEL_LABELS[e.riskLevel]}</span></div>
                  <p class="mt-1 text-sm text-slate-300">${[e.colour, e.make, e.model, e.bodyType].filter(Boolean).join(' ') || 'No vehicle details'}</p>
                  <p class="mt-1 text-xs text-red-200">${e.risks.map((r) => RISK_TAG_LABELS[r]).join(' · ')}</p>
                  ${e.notes ? html`<p class="mt-1 text-xs whitespace-pre-line text-slate-400">${e.notes}</p>` : nothing}
                </li>`,
              )}
            </ul>`
          : html`<p class="text-sm text-slate-400">No vehicles yet — edit the list to add some.</p>`}
      </section>`;
    if (l.type === 'allow')
      return html`<section class="card mt-4">
        <h2 class="section-title">Allowed plates (${l.entries.length})</h2>
        ${l.entries.length
          ? html`<ul class="divide-y divide-ink-700">
              ${l.entries.map(
                (e) => html`<li class="flex items-center gap-3 py-2">
                  ${plateBadge(e.plate, 'sm')}
                  <div class="min-w-0 flex-1 text-sm">
                    <p class="truncate">${e.label || '—'}${e.permitNo ? html` <span class="text-slate-400">#${e.permitNo}</span>` : nothing}</p>
                    ${e.validFrom || e.validTo ? html`<p class="text-xs text-slate-400">Valid ${e.validFrom || '…'} → ${e.validTo || '…'}</p>` : nothing}
                  </div>
                </li>`,
              )}
            </ul>`
          : html`<p class="text-sm text-slate-400">No plates yet — edit the list to add some.</p>`}
      </section>`;
    return html``;
  };

  return {
    async mount() {
      await load();
      tick = window.setInterval(() => {
        if (list?.type === 'timed' && observations.length) app.update();
      }, 1000);
    },
    unmount() {
      clearInterval(tick);
      urls.revokeAll();
    },
    render() {
      if (!list) return html`${header({ title: 'Loading…', back: () => app.navigate('/') })}`;
      const l = list;
      const now = Date.now();
      return html`${header({
          title: l.name,
          subtitle: LIST_TYPE_META[l.type].label,
          back: () => app.navigate('/'),
          actions: html`<button type="button" class="btn-ghost min-h-11 px-3" aria-label="Edit list" @click=${() => app.navigate(`/list/${l.id}/edit`)}>${icon('edit')}</button>`,
        })}
        ${page(html`
          <div class="flex items-center gap-2">${typeChip(l.type)}${l.notes ? html`<p class="text-sm text-slate-400">${l.notes}</p>` : nothing}</div>
          <button type="button" class="btn-primary mt-4 w-full py-4 text-lg" @click=${() => app.navigate(`/scan/${l.id}`)}>${icon('camera', 'h-6 w-6')} Scan number plate</button>
          ${l.type === 'timed' ? timedSection(l, now) : entriesSection(l)}
          ${l.type !== 'allow' ? recentSection() : nothing}
          <button type="button" class="btn-ghost mt-8 w-full text-red-300" @click=${remove}>${icon('trash')} Delete list</button>
        `)}`;
    },
  };
}
