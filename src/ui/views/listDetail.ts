import { paymentLines, restrictionPaymentLabel } from '../../lib/payment';
import { zoneLabel } from '../../lib/listIndex';
import { formatBays } from '../../lib/importer';
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
import { describeRestriction, nextRestrictionStart, restrictionInForce, summariseDays } from '../../lib/restriction';
import { formatClock, formatDateTime, formatDuration, formatIsoDate, formatUntil, localDateString } from '../../lib/time';
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
import { listPermissions, policyContext } from '../../lib/listPolicy';
import { DISMISS_LABEL, FLAG_LABEL } from '../../lib/dismissal';
import { banner, header, icon, LIST_TYPE_META, page, plateBadge, riskPill, statusPill, typeChip, UrlBag, type StatusKind } from '../components';
import { segmentLabel } from './home';

/** Scan outcome → CivicMAPS status (assessment §3): colour + icon + text, no red. */
const OUTCOME_STATUS: Record<ScanRecord['outcome'], { kind: StatusKind; text: string }> = {
  reviewed: { kind: 'reviewed', text: 'Reviewed' },
  recorded: { kind: 'timing', text: 'First sighting' },
  within_allowance: { kind: 'within_allowance', text: 'Within allowance' },
  overstay: { kind: 'overstay', text: 'Overstay' },
  hot_sighting: { kind: 'hot_sighting', text: 'Hot-list sighting' },
  permit_valid: { kind: 'permit_valid', text: 'Permit valid' },
  flag_confirmed: { kind: 'permit_valid', text: 'Vehicle confirmed' },
};

/** Outcome pill; a dismissed overstay alert adds a grey "Dismissed · reason" pill (history keeps both). */
export function outcomeChip(o: ScanRecord['outcome'], scan?: Pick<ScanRecord, 'alertDismissal' | 'flagCheck' | 'exemption'>): TemplateResult {
  const ex = scan?.exemption;
  const main =
    ex?.by === 'dismissed_earlier'
      ? statusPill('permit_valid', `Exempt · ${DISMISS_LABEL[ex.reason]}`)
      : statusPill(OUTCOME_STATUS[o].kind, OUTCOME_STATUS[o].text);
  const dismissal = scan?.alertDismissal;
  return dismissal
    ? html`${main}<span data-testid="dismissal-chip">${statusPill('dismissed', `Dismissed · ${DISMISS_LABEL[dismissal.reason]}`)}</span>`
    : scan?.flagCheck
      ? html`${main}${statusPill(scan.flagCheck.result === 'confirmed' ? 'reviewed' : 'not_on_list', scan.flagCheck.result === 'confirmed' ? FLAG_LABEL[scan.flagCheck.kind] : 'Tag removed')}`
      : main;
}

/** Neutral provenance tag for a system list (WF-S26 26b.1): not a status, so grey with an icon. */
const systemTag = (): TemplateResult =>
  html`<span class="chip border-neutral-300 bg-surface-sunken text-xs font-semibold tracking-[0.04em] text-neutral-700 uppercase" data-testid="system-tag">${icon('lock', 'h-3.5 w-3.5', 2.5)}System</span>`;

/** "Imported from file · date" for system lists; "Created for date" for officer lists. */
function provenance(l: PlateList): TemplateResult | typeof nothing {
  const src = l.source;
  if (!src) return nothing;
  const text =
    src.origin === 'system'
      ? [src.importedFrom ? `Imported from ${src.importedFrom}` : 'Imported', src.importedAt ? formatIsoDate(localDateString(src.importedAt)) : ''].filter(Boolean).join(' · ')
      : src.serviceDay
        ? `Officer list · created ${formatIsoDate(src.serviceDay)}`
        : '';
  return text ? html`<p class="mt-1 truncate text-xs text-neutral-600" data-testid="list-provenance">${text}</p>` : nothing;
}

export function listDetailView(params: Record<string, string>, app: App): View {
  const policy = policyContext();
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
    if (!ok || !listPermissions(list, policy).delete) return;
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
          ? html`<img src=${urls.get(first.thumb)} alt="" class="h-14 w-20 flex-none rounded-md object-cover" loading="lazy" />`
          : html`<div class="h-14 w-20 flex-none rounded-md bg-surface-sunken"></div>`}
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">${plateBadge(o.plate, 'sm')}<span class="font-plate text-xs text-neutral-600">${o.restrictionCode}</span></div>
          <p class="mt-1 text-xs text-neutral-600">First seen ${formatClock(o.startedAt)} · ${o.scanCount} scan${o.scanCount === 1 ? '' : 's'}</p>
        </div>
        <div class="flex flex-col items-end gap-1 text-right">
          <p class="font-plate text-base font-bold ${over ? 'text-alert-strong' : 'text-neutral-900'}">${formatDuration(elapsed)}</p>
          ${over ? statusPill('overdue') : html`<p class="text-xs text-neutral-600">ends <span class="font-plate">${formatClock(o.allowanceEndsAt).slice(0, 5)}</span></p>`}
        </div>
      </button>
    </li>`;
  };

  const timedSection = (l: TimedList, now: number): TemplateResult => {
    const inst = restrictionInForce(l, now);
    const next = inst ? null : nextRestrictionStart(l, now);
    return html`<section class="card mt-4">
        <h2 class="section-title">Segment</h2>
        <p class="font-semibold">${segmentLabel(l)}</p>
        ${paymentLines(l.payment).length ? html`<div class="mt-1 flex flex-wrap gap-1.5">${paymentLines(l.payment).map((line) => html`<span class="chip border-neutral-300 bg-surface-sunken font-plate text-xs text-neutral-800">${line}</span>`)}</div>` : nothing}
        ${l.segment.subFrom ? html`<p class="text-sm text-neutral-800">Part of side: ${l.segment.subFrom}${l.segment.subTo ? ` → ${l.segment.subTo}` : ''}</p>` : nothing}
        <p class="text-sm text-neutral-600">${[l.patrolZone || l.patrolZoneName ? zoneLabel(l.patrolZone?.trim() || l.patrolZoneName!.trim(), l.patrolZoneName?.trim()) : '', l.rpa ? `RPA ${l.rpa}` : '', l.segment.suburb, l.segment.side !== 'both' ? `${l.segment.side} side` : 'both sides', l.displayId ? `Segment ${l.displayId}` : l.roadSegmentId ? `Segment ID ${l.roadSegmentId}` : ''].filter(Boolean).join(' · ')}</p>
        ${l.bays?.length ? html`<p class="text-sm text-neutral-600">Bays <span class="font-plate">${formatBays(l.bays)}</span>${l.bayPoints?.length ? ` · ${l.bayPoints.length} with a position` : ''}</p>` : nothing}
        ${l.untimedControls?.length
          ? html`<p class="mt-2 text-xs font-semibold text-neutral-600">Other signs (not timed)</p>
              <ul class="grid gap-0.5 text-sm text-neutral-700" data-testid="untimed-controls">
                ${l.untimedControls.map((u) => html`<li>${u.label} · ${summariseDays(u.days)} ${u.allDay ? 'all times' : `${u.startTime}–${u.endTime}`}${u.description ? html` <span class="text-neutral-500">— ${u.description}</span>` : nothing}</li>`)}
              </ul>`
          : nothing}
        ${!l.restrictions.length ? html`<div class="mt-2">${banner('alert', 'Restrictions to enter', 'Imported without restrictions. Add them with Edit before scanning here.', 'pending-note')}</div>` : nothing}
        <ul class="mt-3 grid gap-1 text-sm" data-testid="restriction-lines">
          ${l.restrictions.map(
            (r) => html`<li class="flex flex-wrap items-center gap-2">
              ${inst?.restriction.id === r.id ? statusPill('in_force') : nothing}
              <span class=${inst?.restriction.id === r.id ? 'font-semibold text-neutral-900' : 'text-neutral-700'}>${describeRestriction(r)}${r.graceMinutes ? ` (+${r.graceMinutes}m grace)` : ''}</span>
              ${r.description ? html`<span class="text-neutral-500">— ${r.description}</span>` : nothing}
              ${restrictionPaymentLabel(l.payment, r) ? html`<span class="font-plate text-xs text-secondary-dark" data-testid="restriction-paid-by">· ${restrictionPaymentLabel(l.payment, r)}</span>` : nothing}
            </li>`,
          )}
        </ul>
        <p class="mt-3 text-sm">
          ${inst
            ? statusPill('in_force', `In force now: ${inst.restriction.code} until ${formatUntil(inst.end, now)}`)
            : statusPill('not_in_force', `Not in force${next ? ` — next ${formatDateTime(next.start)}` : ''}`)}
        </p>
        ${allowLists.length
          ? html`<p class="mt-2 text-sm text-neutral-700">Exempt: ${allowLists.map((a) => html`<a class="link" href="#/list/${a.id}">${a.name}</a> `)}</p>`
          : html`<p class="mt-2 text-sm text-neutral-500">No linked allow lists.</p>`}
      </section>
      <section class="card mt-4">
        <h2 class="section-title">Tracked vehicles (${observations.length})</h2>
        ${observations.length
          ? html`<ul class="divide-y divide-neutral-200">${observations.map((o) => observationRow(o, now))}</ul>`
          : html`<p class="text-sm text-neutral-600">No vehicles being timed. Scan to record first sightings.</p>`}
      </section>`;
  };

  const recentSection = (): TemplateResult => html`<section class="card mt-4">
    <h2 class="section-title">Recent scan records</h2>
    ${recent.length
      ? html`<ul class="divide-y divide-neutral-200">
          ${recent.map(
            (s) => html`<li>
              <button type="button" class="flex w-full items-center gap-3 py-2 text-left" @click=${() => app.navigate(`/record/${s.id}`)}>
                <img src=${urls.get(s.thumb)} alt="" class="h-12 w-16 flex-none rounded-md object-cover" loading="lazy" />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">${plateBadge(s.plate, 'sm')}${outcomeChip(s.outcome, s)}</div>
                  <p class="mt-1 text-xs text-neutral-600">${formatDateTime(s.meta.capturedAt)}${s.meta.location ? ` · ±${Math.round(s.meta.location.accuracy)} m` : ' · no GPS'}</p>
                </div>
              </button>
            </li>`,
          )}
        </ul>`
      : html`<p class="text-sm text-neutral-600">No scan records yet.</p>`}
  </section>`;

  const entriesSection = (l: PlateList): TemplateResult => {
    if (l.type === 'hot')
      return html`<section class="card mt-4">
        <h2 class="section-title">High-risk vehicles (${l.entries.length})</h2>
        ${l.entries.length
          ? html`<ul class="divide-y divide-neutral-200">
              ${l.entries.map(
                (e) => html`<li class="py-3">
                  <div class="flex flex-wrap items-center gap-2">${plateBadge(e.plate, 'sm')}${riskPill(e.riskLevel, RISK_LEVEL_LABELS[e.riskLevel])}</div>
                  <p class="mt-1 text-sm text-neutral-700">${[e.colour, e.make, e.model, e.bodyType].filter(Boolean).join(' ') || 'No vehicle details'}</p>
                  <p class="mt-1 text-xs font-medium text-alert-strong">${e.risks.map((r) => RISK_TAG_LABELS[r]).join(' · ')}</p>
                  ${e.notes ? html`<p class="mt-1 text-xs whitespace-pre-line text-neutral-600">${e.notes}</p>` : nothing}
                </li>`,
              )}
            </ul>`
          : html`<p class="text-sm text-neutral-600">No vehicles yet — edit the list to add some.</p>`}
      </section>`;
    if (l.type === 'allow')
      return html`<section class="card mt-4">
        <h2 class="section-title">Allowed plates (${l.entries.length})</h2>
        ${l.entries.length
          ? html`<ul class="divide-y divide-neutral-200">
              ${l.entries.map(
                (e) => html`<li class="flex items-center gap-3 py-2">
                  ${plateBadge(e.plate, 'sm')}
                  <div class="min-w-0 flex-1 text-sm">
                    <p class="truncate">${e.label || '—'}${e.permitNo ? html` <span class="font-plate text-neutral-600">#${e.permitNo}</span>` : nothing}</p>
                    ${e.validFrom || e.validTo ? html`<p class="text-xs text-neutral-600">Valid ${e.validFrom ? formatIsoDate(e.validFrom) : 'any time'} to ${e.validTo ? formatIsoDate(e.validTo) : 'no end date'}</p>` : nothing}
                  </div>
                </li>`,
              )}
            </ul>`
          : html`<p class="text-sm text-neutral-600">No plates yet — edit the list to add some.</p>`}
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
      const perm = listPermissions(l, policy, now);
      return html`${header({
          title: l.name,
          subtitle: LIST_TYPE_META[l.type].label,
          back: () => app.navigate('/'),
          actions: perm.edit ? html`<button type="button" class="btn-chrome" aria-label="Edit list" data-testid="edit-list" @click=${() => app.navigate(`/list/${l.id}/edit`)}>${icon('edit')}</button>` : nothing,
        })}
        ${page(html`
          <div class="flex flex-wrap items-center gap-2">${typeChip(l.type)}${perm.origin === 'system' ? systemTag() : nothing}${l.notes ? html`<p class="text-sm text-neutral-600">${l.notes}</p>` : nothing}</div>
          ${provenance(l)}
          ${perm.locked === 'system'
            ? html`<div class="mt-3">${banner('pending', 'Read-only system list', 'This list was imported or created in CommandMAPS. Its settings cannot be changed on this device.', 'system-locked')}</div>`
            : perm.locked === 'expired'
              ? html`<div class="mt-3">${banner('pending', 'List expired', `Officer lists last for the day they were created${l.source?.serviceDay ? ` (${formatIsoDate(l.source.serviceDay)})` : ''}.`, 'officer-expired')}</div>`
              : nothing}
          <button type="button" class="btn-primary mt-4 w-full py-4 text-md" @click=${() => app.navigate(`/scan/${l.id}`)}>${icon('camera', 'h-6 w-6', 1.75)} Scan number plate</button>
          ${l.type === 'timed' ? timedSection(l, now) : entriesSection(l)}
          ${l.type !== 'allow' ? recentSection() : nothing}
          ${perm.delete ? html`<button type="button" class="btn-secondary mt-8 w-full" data-testid="delete-list" @click=${remove}>${icon('trash')} Delete list</button>` : nothing}
        `)}`;
    },
  };
}
