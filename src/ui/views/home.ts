import { paymentLines } from '../../lib/payment';
import { html, nothing, type TemplateResult } from 'lit-html';
import { countDismissed, getAllObservations, getLists } from '../../lib/db';
import { groupByZone, NO_ZONE, patrolZones, searchTimedLists, zoneKey, zoneLabel, zoneNames, type FieldMatch } from '../../lib/listIndex';
import { nextRestrictionStart, restrictionInForce } from '../../lib/restriction';
import { formatUntil } from '../../lib/time';
import type { ListType, Observation, PlateList, StreetSide, TimedList } from '../../lib/types';
import type { App, View } from '../app';
import { emptyState, header, icon, LIST_TYPE_META, page, statusPill, typeChip } from '../components';

export function segmentLabel(l: TimedList): string {
  return `${l.segment.street} — between ${l.segment.fromStreet} & ${l.segment.toStreet}`;
}

const SIDE_SHORT: Record<StreetSide, string> = { both: 'both sides', north: 'N side', south: 'S side', east: 'E side', west: 'W side', odd: 'odd nos', even: 'even nos' };

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
    if (inst) return statusPill('in_force', `${inst.restriction.code} until ${formatUntil(inst.end, now)}`);
    const next = nextRestrictionStart(l, now);
    return statusPill('not_in_force', `Not in force${next ? ` · from ${new Intl.DateTimeFormat('en-AU', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(next.start)}` : ''}`);
  };

  const counts = (l: TimedList, now: number) => {
    const obs = active.filter((o) => o.listId === l.id && o.windowEndsAt > now);
    return { tracked: obs.length, overdue: obs.filter((o) => now - o.startedAt >= (o.limitMinutes + o.graceMinutes) * 60_000).length };
  };

  const scanButton = (l: PlateList) => html`<button type="button" class="btn-primary min-h-11 flex-none px-3" aria-label=${`Scan ${l.name}`} data-testid="row-scan" @click=${() => app.navigate(`/scan/${l.id}`)}>${icon('camera')}</button>`;

  const timedRow = (l: TimedList, now: number, matches: FieldMatch[]): TemplateResult => {
    const c = counts(l, now);
    const ids = [l.rpa ? `RPA ${l.rpa}` : '', ...paymentLines(l.payment).map((p) => p.replace('Parking area', 'Area').replace('AreaNumber ', '').replace('ParkingZone ', ''))].filter(Boolean);
    return html`<li class="flex items-center gap-2 py-2" data-testid="timed-row">
      <button type="button" class="min-w-0 flex-1 text-left" @click=${() => app.navigate(`/list/${l.id}`)}>
        <p class="truncate text-sm font-semibold">${l.segment.fromStreet} – ${l.segment.toStreet} <span class="font-normal text-neutral-600">· ${SIDE_SHORT[l.segment.side] ?? l.segment.side}</span></p>
        <div class="mt-1 flex flex-wrap items-center gap-1.5">
          ${statusChip(l, now)}
          ${c.tracked ? html`<span class="text-xs text-neutral-700">${c.tracked} tracked</span>` : nothing}
          ${c.overdue ? statusPill('overdue', `${c.overdue} overdue`) : nothing}
          ${ids.length ? html`<span class="truncate font-plate text-xs text-neutral-600">${ids.join(' · ')}</span>` : nothing}
        </div>
        ${matches.length ? html`<p class="mt-0.5 truncate text-xs font-medium text-secondary">${matches.map((m) => `${m.label} ${m.value}`).join(' · ')}</p>` : nothing}
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
    const chip = (value: string | null, label: string, n: number) =>
      html`<button type="button" class="chip-button group flex-none whitespace-nowrap"
        aria-pressed=${zone === value} data-testid="zone-chip" @click=${() => setZone(value)}>${label} <span class="font-plate text-neutral-600 group-aria-pressed:text-white/80">${n}</span></button>`;
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
        ? html`<p class="card text-sm text-neutral-600" data-testid="no-results">No timed list matches “${query}”${zone !== null ? html` in ${zoneLabel(zone, names.get(zone))} · <button type="button" class="link" @click=${() => setZone(null)}>search all zones</button>` : nothing}.</p>`
        : groups.map((g) => {
            const zoneLists = g.streets.flatMap((st) => st.lists);
            const overdue = zoneLists.reduce((n, l) => n + counts(l, now).overdue, 0);
            return html`<section class="card mb-3 py-2" data-testid="zone-group">
              <div class="flex items-baseline justify-between gap-2 border-b border-neutral-200 pb-2">
                <h3 class="min-w-0 truncate font-bold">${zoneLabel(g.zone, g.name)}</h3>
                <p class="flex flex-none items-center gap-1 text-xs text-neutral-600">${zoneLists.length} segment${zoneLists.length === 1 ? '' : 's'}${overdue ? html` · ${statusPill('overdue', `${overdue} overdue`)}` : nothing}</p>
              </div>
              ${g.streets.map(
                (st) => html`<div class="pt-2" data-testid="street-group">
                  <h4 class="text-xs font-semibold text-neutral-600">${st.street}</h4>
                  <ul class="divide-y divide-neutral-200">${st.lists.map((l) => timedRow(l, now, query.trim() ? matchesById.get(l.id) ?? [] : []))}</ul>
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
      <ul class="card divide-y divide-neutral-200 py-1">
        ${items.map(
          (l) => html`<li class="flex items-center gap-2 py-2">
            <button type="button" class="min-w-0 flex-1 text-left" @click=${() => app.navigate(`/list/${l.id}`)}>
              <p class="truncate text-sm font-semibold">${l.name}</p>
              <p class="text-xs text-neutral-600">${l.type !== 'timed' ? `${l.entries.length} plate${l.entries.length === 1 ? '' : 's'}` : ''}</p>
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
            <button type="button" class="btn-chrome" aria-label="Text reader" @click=${() => app.navigate('/text')}>${icon('text')}</button>
            <button type="button" class="btn-chrome" aria-label="Settings" @click=${() => app.navigate('/settings')}>${icon('settings')}</button>
          `,
        })}
        ${page(html`
          ${!loaded
            ? html`<p class="text-neutral-600">Loading…</p>`
            : lists.length === 0
              ? emptyState(
                  'No lists yet',
                  'Create a timed, hot or allow list to start scanning number plates.',
                  html`<button type="button" class="btn-primary" @click=${() => app.navigate('/new')}>${icon('plus')} Create list</button>`,
                )
              : html`<div class="sticky top-[calc(env(safe-area-inset-top)+4rem)] z-20 -mx-4 mb-3 border-b border-neutral-200 bg-surface-raised px-4 py-2">
                    <label class="relative block">
                      <span class="sr-only">Search lists</span>
                      <span class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-neutral-500">${icon('search')}</span>
                      <input type="search" class="field pl-10" data-testid="list-search" placeholder="Street, zone, RPA, meter, area…" aria-describedby="search-help"
                        autocomplete="off" spellcheck="false" .value=${query}
                        @input=${(e: Event) => { query = (e.target as HTMLInputElement).value; app.update(); }} />
                    </label>
                    <p id="search-help" class="sr-only">Searches patrol zone, RPA, road segment, EasyPark area, PayStay zone and meter ID. Start with rpa, meter, zone, easypark or paystay to search only that field.</p>
                  </div>
                  ${timedSection(now)}${otherSection('hot')}${otherSection('allow')}`}
          ${loaded && dismissedCount
            ? html`<button type="button" class="card flex w-full items-center justify-between text-left" data-testid="dismissed-link" @click=${() => app.navigate('/dismissed')}>
                <span><span class="font-semibold">Dismissed captures</span><span class="block text-sm text-neutral-600">Patrol captures dismissed at review, kept apart from every list</span></span>
                <span class="flex items-center gap-2">${statusPill('dismissed', String(dismissedCount))}<span class="text-neutral-500">${icon('chevron')}</span></span>
              </button>`
            : nothing}
        `)}
        ${loaded && lists.length
          ? html`<button type="button" class="btn-primary fixed right-4 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-20 px-5 shadow-lg" @click=${() => app.navigate('/new')}>
              ${icon('plus')} New list
            </button>`
          : nothing}`;
    },
  };
}

export function newListTypeView(_p: Record<string, string>, app: App): View {
  const option = (type: ListType) => html`<li>
    <button type="button" class="card block w-full text-left transition hover:border-primary" @click=${() => app.navigate(`/new/${type}`)}>
      <div class="flex items-center gap-2">${typeChip(type)}<span class="text-md font-bold">${LIST_TYPE_META[type].label}</span></div>
      <p class="mt-2 text-neutral-600">${LIST_TYPE_META[type].description}</p>
    </button>
  </li>`;
  return {
    render: () =>
      html`${header({ title: 'Create list', subtitle: 'Select list type', back: () => app.back() })}
      ${page(html`<ul class="grid gap-3">${option('timed')}${option('hot')}${option('allow')}</ul>`)}`,
  };
}
