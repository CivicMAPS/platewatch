/**
 * Hot-list entry log for one plate (WF-S29 29d): sightings, acknowledgements and look-alike
 * decisions, newest first. Personal and safety data: retention and access logging are OQ29-5.
 */
import { html, nothing } from 'lit-html';
import { getHotEventsForEntry, getHotLists, getScansForList } from '../../lib/db';
import { hotLogRows, type HotLogRow } from '../../lib/hotlist';
import { formatStamp } from '../../lib/time';
import { RISK_LEVEL_LABELS, type HotEntry, type HotList } from '../../lib/types';
import type { App, View } from '../app';
import { emptyState, header, icon, page, plateBadge, riskPill, statusPill } from '../components';

export function hotLogView(params: Record<string, string>, app: App): View {
  const entryId = decodeURIComponent(params.entryId ?? '');
  let list: HotList | undefined;
  let entry: HotEntry | undefined;
  let rows: HotLogRow[] = [];
  let loaded = false;

  const load = async () => {
    for (const l of await getHotLists()) {
      const e = l.entries.find((x) => x.id === entryId);
      if (e) { list = l; entry = e; break; }
    }
    if (list && entry) rows = hotLogRows(entry, await getScansForList(list.id, 500), await getHotEventsForEntry(entry.id));
    loaded = true;
    app.update();
  };

  const row = (r: HotLogRow) => {
    if (r.kind === 'sighting')
      return html`<li class="py-3" data-testid="hot-log-row" data-kind="sighting">
        <div class="flex flex-wrap items-center gap-2">${statusPill('hot_sighting', 'Sighting')}<span class="font-plate text-sm">${formatStamp(r.at)}</span></div>
        <p class="mt-1 text-sm text-neutral-700">Read <span class="font-plate">${r.plate}</span> · <a class="link" href="#/record/${r.scanId}">open record</a></p>
      </li>`;
    const e = r.event;
    const where = e.location ? html` · <span class="font-plate">${e.location.lat.toFixed(5)}, ${e.location.lng.toFixed(5)} ±${Math.round(e.location.accuracyM)} m</span>` : nothing;
    if (r.kind === 'acknowledged')
      return html`<li class="py-3" data-testid="hot-log-row" data-kind="acknowledged">
        <div class="flex flex-wrap items-center gap-2">${statusPill('permit_valid', 'Ack')}<span class="font-plate text-sm">${formatStamp(e.at)}</span></div>
        <p class="mt-1 text-sm text-neutral-700">Officer <span class="font-plate">${e.officerNumber || '—'}</span>${where} · soft Code 1 ${e.notification?.status === 'sent' ? 'sent' : 'queued'}</p>
      </li>`;
    return html`<li class="py-3" data-testid="hot-log-row" data-kind="not_matched">
      <div class="flex flex-wrap items-center gap-2">${statusPill('not_on_list', 'Not matched')}<span class="font-plate text-sm">${formatStamp(e.at)}</span></div>
      <p class="mt-1 text-sm text-neutral-700">Look-alike <span class="font-plate">${e.readAs ?? ''}</span> — not the hot-list vehicle · officer <span class="font-plate">${e.officerNumber || '—'}</span></p>
    </li>`;
  };

  return {
    mount: load,
    render() {
      return html`${header({ title: 'Hot-list entry log', subtitle: entry?.plate, back: () => app.back() })}
        ${page(html`
          ${!loaded
            ? html`<p class="text-neutral-600">Loading…</p>`
            : !entry || !list
              ? emptyState('Entry not found', 'The hot-list entry may have been removed.')
              : html`<section class="card" data-testid="hot-log-entry">
                  <div class="flex flex-wrap items-center gap-2">${plateBadge(entry.plate, 'md')}${riskPill(entry.riskLevel, RISK_LEVEL_LABELS[entry.riskLevel])}</div>
                  <p class="mt-2 font-semibold">${[entry.colour, entry.make, entry.model, entry.bodyType].filter(Boolean).join(' ') || 'No vehicle description'}</p>
                  <p class="text-sm text-neutral-600">List: ${list.name}</p>
                </section>
                <section class="card mt-4">
                  <h2 class="section-title">Log (newest first)</h2>
                  ${rows.length ? html`<ul class="divide-y divide-neutral-200" data-testid="hot-log">${rows.map(row)}</ul>` : html`<p class="text-sm text-neutral-600">No sightings recorded on this device.</p>`}
                </section>
                <p class="mt-3 flex items-start gap-2 text-xs text-neutral-600">${icon('info', 'h-4 w-4')} Holds personal and safety data. Kept on this device until deleted with the scan records; retention rules are still to be decided.</p>`}
        `)}`;
    },
  };
}
