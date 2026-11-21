import { paymentLines } from '../../lib/payment';
import { html, nothing, type TemplateResult } from 'lit-html';
import { countDismissed, getAllObservations, getLists } from '../../lib/db';
import { describeRestriction, nextRestrictionStart, restrictionInForce } from '../../lib/restriction';
import { formatUntil } from '../../lib/time';
import type { ListType, Observation, PlateList, TimedList } from '../../lib/types';
import type { App, View } from '../app';
import { emptyState, header, icon, LIST_TYPE_META, page, typeChip } from '../components';

export function segmentLabel(l: TimedList): string {
  return `${l.segment.street} — between ${l.segment.fromStreet} & ${l.segment.toStreet}`;
}

export function homeView(_p: Record<string, string>, app: App): View {
  let lists: PlateList[] = [];
  let active: Observation[] = [];
  let dismissedCount = 0;
  let loaded = false;
  let timer: number | undefined;

  const load = async () => {
    lists = await getLists();
    active = (await getAllObservations()).filter((o) => o.status === 'active');
    dismissedCount = await countDismissed();
    loaded = true;
    app.update();
  };

  const timedStatus = (l: TimedList, now: number): TemplateResult => {
    const inst = restrictionInForce(l, now);
    if (inst)
      return html`<span class="chip border-emerald-500/50 bg-emerald-500/10 text-emerald-200">${icon('clock', 'h-4 w-4')} ${inst.restriction.code} until ${formatUntil(inst.end, now)}</span>`;
    const next = nextRestrictionStart(l, now);
    return html`<span class="chip border-ink-600 bg-ink-800 text-slate-300">Not in force${next ? html` · from ${new Intl.DateTimeFormat('en-AU', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(next.start)}` : nothing}</span>`;
  };

  const listCard = (l: PlateList, now: number): TemplateResult => {
    const obs = l.type === 'timed' ? active.filter((o) => o.listId === l.id && o.windowEndsAt > now) : [];
    const overdue = obs.filter((o) => now - o.startedAt >= (o.limitMinutes + o.graceMinutes) * 60_000).length;
    return html`<li class="card">
      <button type="button" class="block w-full text-left" @click=${() => app.navigate(`/list/${l.id}`)}>
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">${typeChip(l.type)}<h3 class="truncate text-base font-bold">${l.name}</h3></div>
            ${l.type === 'timed'
              ? html`<p class="mt-1 text-sm text-slate-300">${segmentLabel(l)} ${paymentLines(l.payment).map(line => html`<span class="chip">${line}</span>`)}</p>
                  <p class="mt-1 text-xs text-slate-400">${l.restrictions.map(describeRestriction).join('  ·  ') || 'No restrictions set'}</p>`
              : html`<p class="mt-1 text-sm text-slate-400">${l.entries.length} plate${l.entries.length === 1 ? '' : 's'}</p>`}
          </div>
        </div>
        ${l.type === 'timed'
          ? html`<div class="mt-3 flex flex-wrap gap-2">
              ${timedStatus(l, now)}
              <span class="chip border-ink-600 bg-ink-800 text-slate-300">${obs.length} tracked</span>
              ${overdue ? html`<span class="chip border-red-500/60 bg-red-500/15 text-red-200">${overdue} overdue</span>` : nothing}
            </div>`
          : nothing}
      </button>
      <button type="button" class="btn-primary mt-3 w-full" @click=${() => app.navigate(`/scan/${l.id}`)}>
        ${icon('camera')} Scan
      </button>
    </li>`;
  };

  const section = (type: ListType, now: number) => {
    const items = lists.filter((l) => l.type === type);
    if (!items.length) return nothing;
    return html`<section class="mb-6">
      <h2 class="section-title">${LIST_TYPE_META[type].label}s</h2>
      <ul class="grid gap-3 sm:grid-cols-2">${items.map((l) => listCard(l, now))}</ul>
    </section>`;
  };

  return {
    async mount() {
      await load();
      timer = window.setInterval(() => app.update(), 30_000);
    },
    unmount() {
      clearInterval(timer);
    },
    render() {
      const now = Date.now();
      return html`${header({
          title: 'PlateWatch',
          subtitle: 'Number plate scanning',
          actions: html`
            <button type="button" class="btn-ghost min-h-11 px-3" aria-label="Text reader" @click=${() => app.navigate('/text')}>${icon('text')}</button>
            <button type="button" class="btn-ghost min-h-11 px-3" aria-label="Settings" @click=${() => app.navigate('/settings')}>${icon('settings')}</button>
          `,
        })}
        ${page(html`
          ${!loaded
            ? html`<p class="text-slate-400">Loading…</p>`
            : lists.length === 0
              ? emptyState(
                  'No lists yet',
                  'Create a timed, hot or allow list to start scanning number plates.',
                  html`<button type="button" class="btn-primary" @click=${() => app.navigate('/new')}>${icon('plus')} Create list</button>`,
                )
              : html`${section('timed', now)}${section('hot', now)}${section('allow', now)}`}
          ${loaded && dismissedCount
            ? html`<button type="button" class="card flex w-full items-center justify-between text-left" data-testid="dismissed-link" @click=${() => app.navigate('/dismissed')}>
                <span><span class="font-semibold">Dismissed captures</span><span class="block text-sm text-slate-400">Patrol captures dismissed at review, kept apart from every list</span></span>
                <span class="chip border-ink-600 bg-ink-800 text-slate-300">${dismissedCount}</span>
              </button>`
            : nothing}
        `)}
        ${loaded && lists.length
          ? html`<button type="button" class="btn-primary fixed right-4 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-20 rounded-full px-5 shadow-xl" @click=${() => app.navigate('/new')}>
              ${icon('plus')} New list
            </button>`
          : nothing}`;
    },
  };
}

export function newListTypeView(_p: Record<string, string>, app: App): View {
  const option = (type: ListType) => html`<li>
    <button type="button" class="card block w-full text-left transition hover:border-brand-500" @click=${() => app.navigate(`/new/${type}`)}>
      <div class="flex items-center gap-2">${typeChip(type)}<span class="text-lg font-bold">${LIST_TYPE_META[type].label}</span></div>
      <p class="mt-2 text-slate-400">${LIST_TYPE_META[type].description}</p>
    </button>
  </li>`;
  return {
    render: () =>
      html`${header({ title: 'Create list', subtitle: 'Select list type', back: () => app.back() })}
      ${page(html`<ul class="grid gap-3">${option('timed')}${option('hot')}${option('allow')}</ul>`)}`,
  };
}
