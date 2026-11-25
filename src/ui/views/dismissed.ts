/**
 * Global list of patrol captures dismissed at review. They belong to no plate list and start no
 * timing; each keeps its evidence frame, reading and capture metadata until deleted here or
 * purged by the retention setting.
 */
import { html, nothing } from 'lit-html';
import { clearDismissed, deleteDismissed, getDismissed } from '../../lib/db';
import { formatLatLng } from '../../lib/geo';
import { describeOcr } from '../../lib/recordSummary';
import { formatDateTime } from '../../lib/time';
import type { DismissedCapture } from '../../lib/types';
import type { App, View } from '../app';
import { emptyState, header, icon, page, plateBadge, statusPill, UrlBag } from '../components';

export function dismissedView(_p: Record<string, string>, app: App): View {
  let items: DismissedCapture[] = [];
  let loaded = false;
  const urls = new UrlBag();

  const load = async () => {
    items = await getDismissed();
    loaded = true;
    app.update();
  };

  const remove = async (d: DismissedCapture) => {
    const ok = await app.confirm({
      title: 'Delete dismissed capture',
      body: `Delete ${d.plate || 'this capture'} and its evidence image? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await deleteDismissed(d.id);
    await load();
  };

  const clearAll = async () => {
    const ok = await app.confirm({
      title: 'Clear dismissed captures',
      body: `Delete all ${items.length} dismissed captures and their evidence images? This cannot be undone.`,
      confirmLabel: 'Delete all',
      danger: true,
    });
    if (!ok) return;
    await clearDismissed();
    await load();
  };

  const row = (d: DismissedCapture) => {
    const loc = d.meta.location;
    return html`<li class="card flex gap-3" data-testid="dismissed-item">
      <a href=${urls.get(d.image)} target="_blank" rel="noopener" class="flex-none" aria-label="Open evidence image">
        <img src=${urls.get(d.thumb)} alt="" class="h-16 w-24 rounded-md object-cover" loading="lazy" />
      </a>
      <div class="min-w-0 flex-1 text-sm">
        <div class="flex flex-wrap items-center gap-2">${plateBadge(d.plate, 'sm')}${statusPill('dismissed')}<span class="truncate text-neutral-600">for ${d.intendedListName}</span></div>
        <p class="mt-1 text-neutral-700">${formatDateTime(d.meta.capturedAt)}${loc ? html` · <span class="font-plate text-neutral-600">${formatLatLng(loc)}</span> <span class="text-neutral-600">±${Math.round(loc.accuracy)} m</span>` : nothing}</p>
        <p class="text-xs text-neutral-600">${describeOcr({ ocrEngine: d.ocrEngine, ocrText: d.ocrText, ocrConfidence: null })}</p>
      </div>
      <button type="button" class="btn-ghost min-h-11 flex-none px-2" aria-label=${`Delete ${d.plate || 'capture'}`} @click=${() => void remove(d)}>${icon('trash')}</button>
    </li>`;
  };

  return {
    async mount() {
      await load();
    },
    unmount() {
      urls.revokeAll();
    },
    render() {
      return html`${header({
          title: 'Dismissed',
          subtitle: 'Patrol captures dismissed at review',
          back: () => app.back(),
          actions: items.length
            ? html`<button type="button" class="btn-chrome" @click=${() => void clearAll()}>${icon('trash')} Clear all</button>`
            : nothing,
        })}
        ${page(
          !loaded
            ? html`<p class="text-neutral-600">Loading…</p>`
            : items.length
              ? html`<ul class="grid gap-3">${items.map(row)}</ul>`
              : emptyState('Nothing dismissed', 'Patrol captures you dismiss at review appear here, apart from every list.'),
        )}`;
    },
  };
}
