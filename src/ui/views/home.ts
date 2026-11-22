import { paymentLines } from '../../lib/payment';
import { html, nothing, type TemplateResult } from 'lit-html';
import { countDismissed, getAllObservations, getLists } from '../../lib/db';
import { groupByZone, NO_ZONE, patrolZones, searchTimedLists, zoneKey, zoneLabel, zoneNames, type FieldMatch } from '../../lib/listIndex';
import { nextRestrictionStart, restrictionInForce } from '../../lib/restriction';
import { formatUntil } from '../../lib/time';
import type { ListType, Observation, PlateList, StreetSide, TimedList } from '../../lib/types';
import type { App, View } from '../app';
import { emptyState, header, icon, LIST_TYPE_META, page, typeChip } from '../components';

export function segmentLabel(l: TimedList): string {
  return `${l.segment.street} — between ${l.segment.fromStreet} & ${l.segment.toStreet}`;
}

/** Above this many timed lists, "All zones" shows a card per zone instead of every row. */
const COLLAPSE_OVER = 150;

const SIDE_SHORT: Record<StreetSide, string> = { both: 'both sides', north: 'N side', south: 'S side', east: 'E side', west: 'W side', centre: 'centre', odd: 'odd nos', even: 'even nos' };

/**
 * Home: every list, laid out for finding a segment quickly in the field. Timed lists are grouped
 * by patrol zone, then road segment name, as compact rows; a search box matches patrol zone,
 * RPA, road segment, EasyPark area, PayStay zone and meter ID; zone chips narrow the view to one
 * patrol zone (remembered between visits).
 */
export function homeView(_p: Record<string, string>, app: App): View {
  let lists: PlateList[] = [];
  let active: Observation[] = [];
  let dismissedCount = 0;
  let loaded = false;
  let query = '';
  let timer: number | undefined;

  const load = async () => {
    lists = await getLists();
    active = (await getAllObservations()).filter((o) => o.status === 'active');
    dismissedCount = await countDismissed();
    loaded = true;
    app.update();
  };

  const zoneFilter = () => app.settings.listZoneFilter;
  const setZone = (z: string | null) => void app.updateSettings({ listZoneFilter: z });

  const statusChip = (l: TimedList, now: number): TemplateResult => {
    const inst = restrictionInForce(l, now);
    if (inst)
      return html`<span class="chip min-h-0 border-emerald-500/50 bg-emerald-500/10 py-0.5 text-xs text-emerald-200">${inst.restriction.code} until ${formatUntil(inst.end, now)}</span>`;
    const next = nextRestrictionStart(l, now);
    return html`<span class="chip min-h-0 border-ink-600 bg-ink-800 py-0.5 text-xs text-slate-400">Not in force${next ? html` · from ${new Intl.DateTimeFormat('en-AU', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(next.start)}` : nothing}</span>`;
  };

  const counts = (l: TimedList, now: number) => {
    const obs = active.filter((o) => o.listId === l.id && o.windowEndsAt > now);
    return { tracked: obs.length, overdue: obs.filter((o) => now - o.startedAt >= (o.limitMinutes + o.graceMinutes) * 60_000).length };
  };

  const scanButton = (l: PlateList) => html`<button type="button" class="btn-primary min-h-11 flex-none px-3" aria-label=${`Scan ${l.name}`} data-testid="row-scan" @click=${() => app.navigate(`/scan/${l.id}`)}>${icon('camera')}</button>`;

  const timedRow = (l: TimedList, now: number, matches: FieldMatch[]): TemplateResult => {
    const c = counts(l, now);
    const ids = [l.displayId ?? '', l.rpa ? `RPA ${l.rpa}` : '', ...paymentLines(l.payment).map((p) => p.replace('Parking area', 'Area').replace('AreaNumber ', '').replace('ParkingZone ', ''))].filter(Boolean);
    return html`<li class="flex items-center gap-2 py-2" data-testid="timed-row">
      <button type="button" class="min-w-0 flex-1 text-left" @click=${() => app.navigate(`/list/${l.id}`)}>
        <p class="truncate text-sm font-semibold">${l.segment.fromStreet} – ${l.segment.toStreet} <span class="font-normal text-slate-400">· ${SIDE_SHORT[l.segment.side] ?? l.segment.side}</span></p>
        ${l.segment.subFrom ? html`<p class="truncate text-xs text-slate-300">${l.segment.subFrom}${l.segment.subTo ? ` → ${l.segment.subTo}` : ''}</p>` : nothing}
        <div class="mt-1 flex flex-wrap items-center gap-1.5">
          ${l.restrictions.length
            ? statusChip(l, now)
            : html`<span class="chip min-h-0 border-amber-500/50 bg-amber-500/10 py-0.5 text-xs text-amber-200" data-testid="pending-chip">Restrictions to enter</span>`}
          ${c.tracked ? html`<span class="text-xs text-slate-300">${c.tracked} tracked</span>` : nothing}
          ${c.overdue ? html`<span class="chip min-h-0 border-red-500/60 bg-red-500/15 py-0.5 text-xs text-red-200">${c.overdue} overdue</span>` : nothing}
          ${ids.length ? html`<span class="truncate text-xs text-slate-500">${ids.join(' · ')}</span>` : nothing}
        </div>
        ${matches.length ? html`<p class="mt-0.5 truncate text-xs text-brand-300">${matches.map((m) => `${m.label} ${m.value}`).join(' · ')}</p>` : nothing}
      </button>
      ${scanButton(l)}
    </li>`;
  };

  const timedSection = (now: number): TemplateResult | typeof nothing => {
    const timed = lists.filter((l): l is TimedList => l.type === 'timed');
    if (!timed.length) return nothing;
    const zones = patrolZones(timed);
    const names = zoneNames(timed);
    const hasUnzoned = timed.some((l) => zoneKey(l) === NO_ZONE);
    let zone = zoneFilter();
    // A remembered zone that no longer exists shows everything.
    if (zone !== null && !(zone === NO_ZONE ? hasUnzoned : zones.includes(zone))) zone = null;
    const inZone = zone === null ? timed : timed.filter((l) => zoneKey(l) === zone);
    const results = searchTimedLists(inZone, query);
    const matchesById = new Map(results.map((r) => [r.list.id, r.matches]));
    const groups = groupByZone(results.map((r) => r.list));
    // After a bulk import there can be thousands of segments: with no zone chosen and no search,
    // show one summary card per zone and open a zone from there.
    const summarise = zone === null && !query.trim() && inZone.length > COLLAPSE_OVER;
    const chip = (value: string | null, label: string, n: number) =>
      html`<button type="button" class="chip min-h-10 flex-none whitespace-nowrap ${zone === value ? 'border-brand-400 bg-brand-500/20 text-brand-100' : 'border-ink-600 bg-ink-800 text-slate-300'}"
        aria-pressed=${zone === value} data-testid="zone-chip" @click=${() => setZone(value)}>${label} <span class="text-slate-400">${n}</span></button>`;
    return html`<section class="mb-6" data-testid="timed-section">
      <h2 class="section-title">Timed lists</h2>
      ${zones.length
        ? html`<div class="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1" role="group" aria-label="Patrol zone">
            ${chip(null, 'All zones', timed.length)}
            ${zones.map((z) => chip(z, zoneLabel(z, names.get(z)).replace(/^Patrol zone/, 'Zone'), timed.filter((l) => zoneKey(l) === z).length))}
            ${hasUnzoned ? chip(NO_ZONE, 'No zone', timed.filter((l) => zoneKey(l) === NO_ZONE).length) : nothing}
          </div>`
        : nothing}
      ${!groups.length
        ? html`<p class="card text-sm text-slate-400" data-testid="no-results">No timed list matches “${query}”${zone !== null ? html` in ${zoneLabel(zone, names.get(zone))} · <button type="button" class="text-brand-300 underline" @click=${() => setZone(null)}>search all zones</button>` : nothing}.</p>`
        : groups.map((g) => {
            const zoneLists = g.streets.flatMap((st) => st.lists);
            const overdue = zoneLists.reduce((n, l) => n + counts(l, now).overdue, 0);
            if (summarise)
              return html`<button type="button" class="card mb-2 flex w-full items-center justify-between gap-2 py-3 text-left" data-testid="zone-summary" @click=${() => setZone(g.zone)}>
                <span class="min-w-0"><span class="block truncate font-bold">${zoneLabel(g.zone, g.name)}</span>
                  <span class="text-xs text-slate-400">${g.streets.length} road${g.streets.length === 1 ? '' : 's'} · ${zoneLists.length} segment${zoneLists.length === 1 ? '' : 's'}</span></span>
                ${overdue ? html`<span class="chip min-h-0 flex-none border-red-500/60 bg-red-500/15 py-0.5 text-xs text-red-200">${overdue} overdue</span>` : nothing}
              </button>`;
            return html`<section class="card mb-3 py-2" data-testid="zone-group">
              <div class="flex items-baseline justify-between gap-2 border-b border-ink-700 pb-2">
                <h3 class="min-w-0 truncate font-bold">${zoneLabel(g.zone, g.name)}</h3>
                <p class="flex-none text-xs text-slate-400">${zoneLists.length} segment${zoneLists.length === 1 ? '' : 's'}${overdue ? html` · <span class="text-red-300">${overdue} overdue</span>` : nothing}</p>
              </div>
              ${g.streets.map(
                (st) => html`<div class="pt-2" data-testid="street-group">
                  <h4 class="text-xs font-semibold tracking-wide text-slate-400 uppercase">${st.street}</h4>
                  <ul class="divide-y divide-ink-700">${st.lists.map((l) => timedRow(l, now, query.trim() ? matchesById.get(l.id) ?? [] : []))}</ul>
                </div>`,
              )}
            </section>`;
          })}
    </section>`;
  };

  const otherSection = (type: 'hot' | 'allow'): TemplateResult | typeof nothing => {
    const q = query.trim().toLowerCase();
    const items = lists.filter((l) => l.type === type && (!q || l.name.toLowerCase().includes(q)));
    if (!items.length) return nothing;
    return html`<section class="mb-6">
      <h2 class="section-title">${LIST_TYPE_META[type].label}s</h2>
      <ul class="card divide-y divide-ink-700 py-1">
        ${items.map(
          (l) => html`<li class="flex items-center gap-2 py-2">
            <button type="button" class="min-w-0 flex-1 text-left" @click=${() => app.navigate(`/list/${l.id}`)}>
              <p class="truncate text-sm font-semibold">${l.name}</p>
              <p class="text-xs text-slate-400">${l.type !== 'timed' ? `${l.entries.length} plate${l.entries.length === 1 ? '' : 's'}` : ''}</p>
            </button>
            ${scanButton(l)}
          </li>`,
        )}
      </ul>
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
                  html`<div class="grid w-full gap-2"><button type="button" class="btn-primary" @click=${() => app.navigate('/new')}>${icon('plus')} Create list</button>
                    <button type="button" class="btn-secondary" data-testid="empty-import" @click=${() => app.navigate('/import')}>${icon('upload')} Import lists from a file</button></div>`,
                )
              : html`<div class="sticky top-[calc(env(safe-area-inset-top)+4.25rem)] z-20 -mx-4 mb-3 bg-ink-950/95 px-4 py-2 backdrop-blur">
                    <label class="relative block">
                      <span class="sr-only">Search lists</span>
                      <span class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400">${icon('search')}</span>
                      <input type="search" class="field pl-10" data-testid="list-search" placeholder="Street, zone, RPA, meter, area…" aria-describedby="search-help"
                        autocomplete="off" spellcheck="false" .value=${query}
                        @input=${(e: Event) => { query = (e.target as HTMLInputElement).value; app.update(); }} />
                    </label>
                    <p id="search-help" class="sr-only">Searches patrol zone, RPA, road segment, EasyPark area, PayStay zone and meter ID. Start with rpa, meter, zone, easypark or paystay to search only that field.</p>
                  </div>
                  ${timedSection(now)}${otherSection('hot')}${otherSection('allow')}`}
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
      ${page(html`<ul class="grid gap-3">${option('timed')}${option('hot')}${option('allow')}
        <li><button type="button" class="card block w-full text-left transition hover:border-brand-500" data-testid="type-import" @click=${() => app.navigate('/import')}>
          <div class="flex items-center gap-2">${icon('upload')}<span class="text-lg font-bold">Import from file</span></div>
          <p class="mt-2 text-slate-400">Many segments, permits or hot-list plates at once, from the CSV templates or CivicMAPS data files.</p>
        </button></li></ul>`)}`,
  };
}
