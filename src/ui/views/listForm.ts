import { html, nothing, type TemplateResult } from 'lit-html';
import { getAllowLists, getList, getTimedLists, putList, uid } from '../../lib/db';
import { patrolZones, zoneNames } from '../../lib/listIndex';
import { formatBays, parseBays } from '../../lib/importer';
import { isValidPlate, normalisePlate, plateKey } from '../../lib/plate';
import { describeRestriction, minutesFromCode, validateRestriction } from '../../lib/restriction';
import {
  RISK_LEVEL_LABELS,
  RISK_TAG_LABELS,
  RISK_TAGS,
  type AllowEntry,
  type AllowList,
  type HotEntry,
  type ListType,
  type PlateList,
  type RiskLevel,
  type RiskTag,
  type StreetSide,
  type TimedRestriction,
  type Weekday,
} from '../../lib/types';
import type { App, View } from '../app';
import { header, icon, LIST_TYPE_META, page, plateBadge, RISK_LEVEL_CLASS, typeChip } from '../components';

export const VEHICLE_MAKES = [
  'Toyota', 'Mazda', 'Ford', 'Hyundai', 'Kia', 'Mitsubishi', 'Nissan', 'Holden', 'Volkswagen', 'Subaru',
  'Honda', 'Tesla', 'BYD', 'MG', 'GWM', 'Isuzu', 'Suzuki', 'BMW', 'Mercedes-Benz', 'Audi', 'Lexus', 'Jeep',
  'Land Rover', 'Volvo', 'Peugeot', 'Renault', 'Skoda', 'LDV', 'Chery', 'Porsche', 'Ram', 'Chevrolet',
];
export const BODY_TYPES = [
  'Sedan', 'Hatchback', 'Wagon', 'SUV', 'Ute', 'Van', 'Coupe', 'Convertible', 'People mover', 'Light truck',
  'Truck', 'Motorcycle', 'Other',
];
export const COLOURS = [
  'White', 'Black', 'Silver', 'Grey', 'Blue', 'Red', 'Green', 'Yellow', 'Orange', 'Brown', 'Gold', 'Beige',
  'Purple', 'Maroon', 'Other',
];
const SIDES: { value: StreetSide; label: string }[] = [
  { value: 'both', label: 'Both sides' },
  { value: 'north', label: 'North side' },
  { value: 'south', label: 'South side' },
  { value: 'east', label: 'East side' },
  { value: 'west', label: 'West side' },
  { value: 'odd', label: 'Odd numbers' },
  { value: 'even', label: 'Even numbers' },
];
const DAYS: { d: Weekday; label: string }[] = [
  { d: 1, label: 'Mon' },
  { d: 2, label: 'Tue' },
  { d: 3, label: 'Wed' },
  { d: 4, label: 'Thu' },
  { d: 5, label: 'Fri' },
  { d: 6, label: 'Sat' },
  { d: 0, label: 'Sun' },
];

function newRestriction(): TimedRestriction {
  return {
    id: uid(),
    code: '2P',
    limitMinutes: 120,
    graceMinutes: 0,
    days: [1, 2, 3, 4, 5],
    startTime: '08:00',
    endTime: '18:00',
    allDay: false,
    description: '',
  };
}

function emptyList(type: ListType): PlateList {
  const base = { id: uid(), name: '', notes: '', createdAt: Date.now(), updatedAt: Date.now() };
  switch (type) {
    case 'allow':
      return { ...base, type, entries: [] };
    case 'hot':
      return { ...base, type, entries: [] };
    case 'timed':
      return {
        ...base,
        type,
        segment: { street: '', fromStreet: '', toStreet: '', side: 'both', suburb: '' },
        restrictions: [newRestriction()],
        allowListIds: [],
      };
  }
}

interface AllowDraft {
  plate: string;
  label: string;
  permitNo: string;
  validFrom: string;
  validTo: string;
}
const emptyAllowDraft = (): AllowDraft => ({ plate: '', label: '', permitNo: '', validFrom: '', validTo: '' });

type HotDraft = Omit<HotEntry, 'id' | 'key' | 'addedAt'> & { id: string | null };
const emptyHotDraft = (): HotDraft => ({
  id: null,
  plate: '',
  risks: [],
  riskLevel: 'high',
  make: '',
  model: '',
  bodyType: '',
  colour: '',
  notes: '',
});

export function listFormView(params: Record<string, string>, app: App): View {
  const editingId = params.id ?? null;
  const prefillPlate = new URLSearchParams(location.hash.split('?')[1] ?? '').get('plate') ?? '';
  let list: PlateList | null = null;
  let allowLists: AllowList[] = [];
  /** Patrol zones and RPAs already used, offered as suggestions so the same zone is typed one way. */
  let knownZones: string[] = [];
  let knownZoneNames = new Map<string, string>();
  /** Bays as typed ("58-72;80"); parsed on save. */
  let bayDraft: string | null = null;
  let knownRpas: string[] = [];
  let errors: Record<string, string> = {};
  let saving = false;
  let allowDraft = emptyAllowDraft();
  let bulkText = '';
  let showBulk = false;
  let hotDraft = emptyHotDraft();
  let hotEditorOpen = false;

  const set = (fn: () => void) => {
    fn();
    app.update();
  };

  /* ───────────────────────── Validation / save ───────────────────────── */

  const validate = (l: PlateList): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!l.name.trim()) e.name = 'List name is required.';
    if (l.type === 'timed') {
      if (l.payment?.easyPark.some(area => !area.trim())) e.payment = 'EasyPark AreaNumber is required.';
      if (l.payment?.payStay.some(p => !p.zone.trim())) e.payment = 'PayStay ParkingZone is required.';
      if (!l.segment.street.trim()) e.street = 'Street / segment name is required.';
      if (!l.segment.fromStreet.trim()) e.fromStreet = 'Required.';
      if (!l.segment.toStreet.trim()) e.toStreet = 'Required.';
      if (!l.restrictions.length) e.restrictions = 'Add at least one parking restriction.';
      l.restrictions.forEach((r) => {
        const errs = validateRestriction(r);
        if (errs.length) e[`r-${r.id}`] = errs.join(' ');
      });
    }
    return e;
  };

  const save = async () => {
    if (!list || saving) return;
    // A permit typed but not yet added would otherwise be discarded silently, and the vehicle
    // would then be enforced as if it had no permit.
    if (list.type === 'allow' && allowDraft.plate.trim()) {
      addAllowEntry();
      if (errors.allowPlate) {
        app.toast('Fix the permit being added, or clear its plate, before saving.', 'error');
        document.getElementById('allow-plate')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
    }
    const cleaned: PlateList = { ...list, name: list.name.trim(), notes: list.notes.trim() } as PlateList;
    if (cleaned.type === 'timed') {
      cleaned.segment = {
        ...cleaned.segment,
        street: cleaned.segment.street.trim(),
        fromStreet: cleaned.segment.fromStreet.trim(),
        toStreet: cleaned.segment.toStreet.trim(),
        suburb: cleaned.segment.suburb.trim(),
      };
      cleaned.restrictions = cleaned.restrictions.map((r) => ({ ...r, code: r.code.trim().toUpperCase() }));
      if (cleaned.payment) {
        const area = cleaned.payment.parkingArea?.trim();
        if (area) cleaned.payment = { ...cleaned.payment, parkingArea: area };
        else {
          const { parkingArea: _drop, ...rest } = cleaned.payment;
          cleaned.payment = rest;
        }
      }
      const subFrom = cleaned.segment.subFrom?.trim();
      const subTo = cleaned.segment.subTo?.trim();
      const { subFrom: _f, subTo: _t, ...segRest } = cleaned.segment;
      cleaned.segment = { ...segRest, ...(subFrom ? { subFrom } : {}), ...(subTo ? { subTo } : {}) };
      if (bayDraft !== null) {
        const bays = bayDraft.trim() ? parseBays(bayDraft) : [];
        if (bays === null) {
          errors = { ...errors, bays: 'Bays must be numbers or ranges, e.g. 58-72;80.' };
          app.toast('Please fix the highlighted fields.', 'error');
          app.update();
          return;
        }
        cleaned.bays = bays;
      }
      if (!cleaned.bays?.length) delete cleaned.bays;
      for (const k of ['patrolZone', 'patrolZoneName', 'rpa', 'roadSegmentId'] as const) {
        const v = cleaned[k]?.trim();
        if (v) cleaned[k] = v;
        else delete cleaned[k];
      }
    }
    errors = validate(cleaned);
    if (Object.keys(errors).length) {
      app.toast('Please fix the highlighted fields.', 'error');
      app.update();
      document.querySelector('.field-invalid, [data-error]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    saving = true;
    app.update();
    try {
      await putList(cleaned);
      app.toast(`${LIST_TYPE_META[cleaned.type].label} saved.`, 'success');
      app.navigate(`/list/${cleaned.id}`, true);
    } catch (e) {
      app.toast(`Save failed: ${(e as Error).message}`, 'error');
    } finally {
      saving = false;
      app.update();
    }
  };

  /* ───────────────────────────── Field helpers ───────────────────────────── */

  const err = (k: string) => (errors[k] ? html`<p class="mt-1 text-sm text-red-300" data-error>${errors[k]}</p>` : nothing);
  const fieldCls = (k: string) => `field ${errors[k] ? 'field-invalid' : ''}`;

  const text = (opts: {
    id: string;
    label: string;
    value: string;
    onInput: (v: string) => void;
    placeholder?: string;
    required?: boolean;
    errKey?: string;
    type?: string;
    autocap?: string;
    list?: string;
    maxlength?: number;
  }) => html`<div>
    <label class="field-label" for=${opts.id}>${opts.label}${opts.required ? html` <span class="text-red-300">*</span>` : nothing}</label>
    <input
      id=${opts.id}
      class=${fieldCls(opts.errKey ?? '')}
      type=${opts.type ?? 'text'}
      .value=${opts.value}
      placeholder=${opts.placeholder ?? ''}
      autocapitalize=${opts.autocap ?? 'words'}
      list=${opts.list ?? ''}
      maxlength=${opts.maxlength ?? 200}
      @input=${(e: Event) => opts.onInput((e.target as HTMLInputElement).value)}
    />
    ${opts.errKey ? err(opts.errKey) : nothing}
  </div>`;

  /* ───────────────────────────── Timed list ───────────────────────────── */

  const restrictionEditor = (r: TimedRestriction, idx: number): TemplateResult => {
    if (list?.type !== 'timed') return html``;
    const l = list;
    const update = (patch: Partial<TimedRestriction>) =>
      set(() => {
        l.restrictions = l.restrictions.map((x) => (x.id === r.id ? { ...x, ...patch } : x));
      });
    return html`<div class="rounded-xl border ${errors[`r-${r.id}`] ? 'border-red-500' : 'border-ink-600'} bg-ink-800/60 p-3">
      <div class="mb-3 flex items-center justify-between">
        <p class="text-sm font-bold text-slate-200">Restriction ${idx + 1}</p>
        ${l.restrictions.length > 1
          ? html`<button type="button" class="btn-ghost min-h-9 px-2 py-1 text-sm text-red-300" @click=${() => set(() => (l.restrictions = l.restrictions.filter((x) => x.id !== r.id)))}>
              ${icon('trash', 'h-4 w-4')} Remove
            </button>`
          : nothing}
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="code-${r.id}">Sign code <span class="text-red-300">*</span></label>
          <input id="code-${r.id}" class="field font-plate uppercase" .value=${r.code} placeholder="2P" autocapitalize="characters" maxlength="12"
            @input=${(e: Event) => {
              const code = (e.target as HTMLInputElement).value.toUpperCase();
              const mins = minutesFromCode(code);
              update(mins ? { code, limitMinutes: mins } : { code });
            }} />
        </div>
        <div>
          <label class="field-label" for="limit-${r.id}">Allowance (min) <span class="text-red-300">*</span></label>
          <input id="limit-${r.id}" class="field" type="number" inputmode="numeric" min="1" max="1440" .value=${String(r.limitMinutes)}
            @input=${(e: Event) => update({ limitMinutes: Math.round(Number((e.target as HTMLInputElement).value)) })} />
        </div>
      </div>
      <fieldset class="mt-3">
        <legend class="field-label">Days</legend>
        <div class="flex flex-wrap gap-2">
          ${DAYS.map(({ d, label }) => {
            const on = r.days.includes(d);
            return html`<button type="button" aria-pressed=${on ? 'true' : 'false'}
              class="chip min-h-10 ${on ? 'border-brand-400 bg-brand-500/20 text-brand-100' : 'border-ink-600 bg-ink-800 text-slate-400'}"
              @click=${() => update({ days: on ? r.days.filter((x) => x !== d) : [...r.days, d] })}>${label}</button>`;
          })}
        </div>
      </fieldset>
      <label class="mt-3 flex items-center gap-3 text-sm text-slate-200">
        <input type="checkbox" class="h-5 w-5 accent-brand-500" .checked=${r.allDay} @change=${(e: Event) => update({ allDay: (e.target as HTMLInputElement).checked })} />
        Applies at all times on these days
      </label>
      ${r.allDay
        ? nothing
        : html`<div class="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label class="field-label" for="start-${r.id}">From</label>
              <input id="start-${r.id}" class="field" type="time" .value=${r.startTime} @input=${(e: Event) => update({ startTime: (e.target as HTMLInputElement).value })} />
            </div>
            <div>
              <label class="field-label" for="end-${r.id}">To</label>
              <input id="end-${r.id}" class="field" type="time" .value=${r.endTime === '24:00' ? '23:59' : r.endTime} @input=${(e: Event) => update({ endTime: (e.target as HTMLInputElement).value })} />
            </div>
          </div>`}
      <div class="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="grace-${r.id}">Grace (min)</label>
          <input id="grace-${r.id}" class="field" type="number" inputmode="numeric" min="0" max="120" .value=${String(r.graceMinutes)}
            @input=${(e: Event) => update({ graceMinutes: Math.round(Number((e.target as HTMLInputElement).value)) })} />
        </div>
        <div>
          <label class="field-label" for="desc-${r.id}">Notes</label>
          <input id="desc-${r.id}" class="field" .value=${r.description} placeholder="e.g. Permit zone 12 excepted" maxlength="120"
            @input=${(e: Event) => update({ description: (e.target as HTMLInputElement).value })} />
        </div>
      </div>
      <p class="mt-2 text-xs text-slate-400">${describeRestriction(r)}${r.graceMinutes ? ` · +${r.graceMinutes}m grace` : ''}</p>
      ${err(`r-${r.id}`)}
    </div>`;
  };

  const timedFields = (): TemplateResult => {
    if (list?.type !== 'timed') return html``;
    const l = list;
    const pay = l.payment ??= { easyPark: [], payStay: [] };
    const seg = (patch: Partial<typeof l.segment>) => set(() => (l.segment = { ...l.segment, ...patch }));
    return html`
      <section class="card mt-4 grid gap-3">
        <h2 class="section-title">Enforcement area</h2>
        <div class="grid grid-cols-[2fr_3fr] gap-3">
          ${text({ id: 'patrolZone', label: 'Patrol zone no.', value: l.patrolZone ?? '', placeholder: 'e.g. 9', list: 'known-zones', maxlength: 24,
            onInput: (v) => set(() => {
              l.patrolZone = v;
              // A zone already in use brings its operational name with it.
              const known = knownZoneNames.get(v.trim());
              if (known && !l.patrolZoneName?.trim()) l.patrolZoneName = known;
            }) })}
          ${text({ id: 'patrolZoneName', label: 'Zone name', value: l.patrolZoneName ?? '', onInput: (v) => set(() => (l.patrolZoneName = v)), placeholder: 'e.g. Flagstaff', list: 'known-zone-names', maxlength: 48 })}
        </div>
        ${text({ id: 'rpa', label: 'Residential permit area (RPA)', value: l.rpa ?? '', onInput: (v) => set(() => (l.rpa = v)), placeholder: 'Optional', list: 'known-rpas', maxlength: 24 })}
        <p class="text-xs text-slate-400">Patrol zone: the internal enforcement area number and its day-to-day name. Home groups timed lists by zone, then road, and search finds them by zone, RPA, parking area or bay sign, EasyPark, PayStay and meter ID.</p>
        <datalist id="known-zones">${knownZones.map((z) => html`<option value=${z}>${knownZoneNames.get(z) ?? ''}</option>`)}</datalist>
        <datalist id="known-zone-names">${[...new Set(knownZoneNames.values())].map((n) => html`<option value=${n}></option>`)}</datalist>
        <datalist id="known-rpas">${knownRpas.map((r) => html`<option value=${r}></option>`)}</datalist>
      </section>
      <section class="card mt-4 grid gap-3">
        <h2 class="section-title">Street segment</h2>
        ${text({ id: 'street', label: 'Street / segment name', value: l.segment.street, onInput: (v) => seg({ street: v }), placeholder: 'e.g. Smith Street', required: true, errKey: 'street' })}
        <div class="grid grid-cols-2 gap-3">
          ${text({ id: 'from', label: 'Between', value: l.segment.fromStreet, onInput: (v) => seg({ fromStreet: v }), placeholder: 'Cross street', required: true, errKey: 'fromStreet' })}
          ${text({ id: 'to', label: 'And', value: l.segment.toStreet, onInput: (v) => seg({ toStreet: v }), placeholder: 'Cross street', required: true, errKey: 'toStreet' })}
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="field-label" for="side">Side</label>
            <select id="side" class="field" @change=${(e: Event) => seg({ side: (e.target as HTMLSelectElement).value as StreetSide })}>
              ${SIDES.map((s) => html`<option value=${s.value} ?selected=${l.segment.side === s.value}>${s.label}</option>`)}
            </select>
          </div>
          ${text({ id: 'suburb', label: 'Suburb', value: l.segment.suburb, onInput: (v) => seg({ suburb: v }), placeholder: 'Optional' })}
        </div>
        <p class="text-xs text-slate-400">Part of the side (optional), where the signs change part way along: from and to a bay, an address or a cross street.</p>
        <div class="grid grid-cols-2 gap-3">
          ${text({ id: 'subFrom', label: 'Part from', value: l.segment.subFrom ?? '', onInput: (v) => seg({ subFrom: v }), placeholder: 'e.g. Bay 58' })}
          ${text({ id: 'subTo', label: 'Part to', value: l.segment.subTo ?? '', onInput: (v) => seg({ subTo: v }), placeholder: 'e.g. Bay 72' })}
        </div>
        <div class="grid grid-cols-2 gap-3">
          ${text({ id: 'bays', label: 'Bays', value: bayDraft ?? formatBays(l.bays, true), placeholder: 'e.g. 58-72;80', errKey: 'bays',
            onInput: (v) => { bayDraft = v; } })}
          ${text({ id: 'roadSegmentId', label: 'Road segment ID', value: l.roadSegmentId ?? '', onInput: (v) => set(() => (l.roadSegmentId = v)), placeholder: 'Optional', maxlength: 24 })}
        </div>
      </section>

<section class="card mt-4 grid gap-3"><h2 class="section-title">Paid parking (optional)</h2>
${text({ id: 'parkingArea', label: 'Parking area number', value: pay.parkingArea ?? '', placeholder: 'e.g. 637 (one per segment)', maxlength: 12, onInput: v => { pay.parkingArea = v.trim(); } })}
<p class="-mt-2 text-xs text-slate-400">A bay's kerb sign is this number followed by the bay number (637 + bay 58 = 63758); search accepts either.</p><label><input id="easyPark" type="checkbox" .checked=${!!pay.easyPark.length} @change=${() => set(() => { pay.easyPark = pay.easyPark.length ? [] : ['']; })}> EasyPark</label>
${pay.easyPark.map((entry, i) => html`<div class="grid gap-2">${text({ id: "easyPark-" + i, label: "AreaNumber", value: entry, required: true, onInput: v => { pay.easyPark[i] = v.trim(); } })}<button type="button" class="btn-secondary" @click=${() => set(() => pay.easyPark.splice(i, 1))}>Remove</button></div>`)}${pay.easyPark.length ? html`<button type="button" class="btn-secondary" @click=${() => set(() => pay.easyPark.push(''))}>Add EasyPark entry</button>` : nothing}<label><input id="payStay" type="checkbox" .checked=${!!pay.payStay.length} @change=${() => set(() => { pay.payStay = pay.payStay.length ? [] : [{ zone: '', meter: '' }]; })}> PayStay</label>
${pay.payStay.map((entry, i) => html`<div class="grid gap-2">${text({ id: "payStayzone-" + i, label: "ParkingZone", value: entry.zone, required: true, placeholder: "e.g. 3388… (one per side)", onInput: v => { entry.zone = v.trim(); } })}${text({ id: "payStaymeter-" + i, label: "Meter ID", value: entry.meter, placeholder: "Optional", onInput: v => { entry.meter = v.trim(); } })}<button type="button" class="btn-secondary" @click=${() => set(() => pay.payStay.splice(i, 1))}>Remove</button></div>`)}${pay.payStay.length ? html`<button type="button" class="btn-secondary" @click=${() => set(() => pay.payStay.push({ zone: '', meter: '' }))}>Add PayStay entry</button>` : nothing}${err('payment')}</section>
      <section class="card mt-4 grid gap-3">
        <h2 class="section-title">Parking restrictions</h2>
        ${l.restrictions.map((r, i) => restrictionEditor(r, i))}
        ${err('restrictions')}
        <button type="button" class="btn-secondary" @click=${() => set(() => (l.restrictions = [...l.restrictions, newRestriction()]))}>
          ${icon('plus')} Add restriction
        </button>
      </section>

      <section class="card mt-4">
        <h2 class="section-title">Linked allow lists (residential permits)</h2>
        ${allowLists.length === 0
          ? html`<p class="text-sm text-slate-400">No allow lists saved yet. Create one (e.g. resident permits), then link it here.</p>`
          : html`<ul class="grid gap-2">
              ${allowLists.map((a) => {
                const on = l.allowListIds.includes(a.id);
                return html`<li>
                  <label class="flex min-h-12 items-center gap-3 rounded-xl border border-ink-600 bg-ink-800 px-3">
                    <input type="checkbox" class="h-5 w-5 accent-brand-500" .checked=${on}
                      @change=${(e: Event) => set(() => {
                        const c = (e.target as HTMLInputElement).checked;
                        l.allowListIds = c ? [...l.allowListIds, a.id] : l.allowListIds.filter((x) => x !== a.id);
                      })} />
                    <span class="flex-1">${a.name}</span>
                    <span class="text-sm text-slate-400">${a.entries.length} plates</span>
                  </label>
                </li>`;
              })}
            </ul>`}
      </section>
    `;
  };

  /* ───────────────────────────── Allow list ───────────────────────────── */

  const addAllowEntry = () => {
    if (list?.type !== 'allow') return;
    const plate = normalisePlate(allowDraft.plate);
    if (!isValidPlate(plate)) {
      errors = { ...errors, allowPlate: 'Enter a valid plate (1–10 letters/numbers).' };
      app.update();
      return;
    }
    const key = plateKey(plate);
    if (list.entries.some((e) => plateKey(e.plate) === key)) {
      errors = { ...errors, allowPlate: `${plate} is already on this list.` };
      app.update();
      return;
    }
    if (allowDraft.validFrom && allowDraft.validTo && allowDraft.validTo < allowDraft.validFrom) {
      errors = { ...errors, allowPlate: 'Valid-to date is before valid-from.' };
      app.update();
      return;
    }
    const entry: AllowEntry = {
      id: uid(),
      plate,
      key,
      label: allowDraft.label.trim(),
      permitNo: allowDraft.permitNo.trim(),
      validFrom: allowDraft.validFrom,
      validTo: allowDraft.validTo,
      addedAt: Date.now(),
    };
    const l = list;
    set(() => {
      l.entries = [entry, ...l.entries];
      allowDraft = emptyAllowDraft();
      delete errors.allowPlate;
    });
    document.getElementById('allow-plate')?.focus();
  };

  const importBulk = () => {
    if (list?.type !== 'allow') return;
    const l = list;
    let added = 0;
    let skipped = 0;
    const existing = new Set(l.entries.map((e) => e.key));
    const fresh: AllowEntry[] = [];
    for (const line of bulkText.split(/\r?\n/)) {
      const [rawPlate = '', label = '', permitNo = ''] = line.split(/[,\t;]/).map((s) => s.trim());
      const plate = normalisePlate(rawPlate);
      if (!plate) continue;
      const key = plateKey(plate);
      if (!isValidPlate(plate) || existing.has(key)) {
        skipped++;
        continue;
      }
      existing.add(key);
      fresh.push({ id: uid(), plate, key, label, permitNo, validFrom: '', validTo: '', addedAt: Date.now() });
      added++;
    }
    set(() => {
      l.entries = [...fresh, ...l.entries];
      bulkText = '';
      showBulk = false;
    });
    app.toast(`Added ${added} plate${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} (duplicate/invalid)` : ''}.`, added ? 'success' : 'warn');
  };

  const allowFields = (): TemplateResult => {
    if (list?.type !== 'allow') return html``;
    const l = list;
    return html`<section class="card mt-4 grid gap-3">
      <h2 class="section-title">Add plate</h2>
      <form class="grid gap-3" @submit=${(e: Event) => { e.preventDefault(); addAllowEntry(); }}>
        <div>
          <label class="field-label" for="allow-plate">Number plate <span class="text-red-300">*</span></label>
          <input id="allow-plate" class="${fieldCls('allowPlate')} font-plate text-xl tracking-widest uppercase" .value=${allowDraft.plate} autocapitalize="characters" autocomplete="off" maxlength="12" placeholder="ABC123"
            @input=${(e: Event) => (allowDraft.plate = (e.target as HTMLInputElement).value.toUpperCase())} />
          ${err('allowPlate')}
        </div>
        <div class="grid grid-cols-2 gap-3">
          ${text({ id: 'allow-label', label: 'Label', value: allowDraft.label, onInput: (v) => (allowDraft.label = v), placeholder: 'e.g. 12 Smith St' })}
          ${text({ id: 'allow-permit', label: 'Permit no.', value: allowDraft.permitNo, onInput: (v) => (allowDraft.permitNo = v), placeholder: 'Optional', autocap: 'characters' })}
        </div>
        <div class="grid grid-cols-2 gap-3">
          ${text({ id: 'allow-from', label: 'Valid from', type: 'date', value: allowDraft.validFrom, onInput: (v) => (allowDraft.validFrom = v) })}
          ${text({ id: 'allow-to', label: 'Valid to', type: 'date', value: allowDraft.validTo, onInput: (v) => (allowDraft.validTo = v) })}
        </div>
        <button type="submit" class="btn-secondary">${icon('plus')} Add to list</button>
      </form>
      <button type="button" class="btn-ghost text-sm" @click=${() => set(() => (showBulk = !showBulk))}>${showBulk ? 'Hide bulk import' : 'Bulk import (paste)'}</button>
      ${showBulk
        ? html`<div class="grid gap-2">
            <label class="field-label" for="bulk">One plate per line: <code>PLATE, label, permit no</code></label>
            <textarea id="bulk" class="field min-h-32 font-plate uppercase" .value=${bulkText} @input=${(e: Event) => (bulkText = (e.target as HTMLTextAreaElement).value)}></textarea>
            <button type="button" class="btn-secondary" @click=${importBulk}>Import</button>
          </div>`
        : nothing}
    </section>
    <section class="card mt-4">
      <h2 class="section-title">Plates on this list (${l.entries.length})</h2>
      ${l.entries.length === 0
        ? html`<p class="text-sm text-slate-400">No plates added yet.</p>`
        : html`<ul class="divide-y divide-ink-700">
            ${l.entries.map(
              (e) => html`<li class="flex items-center gap-3 py-2">
                ${plateBadge(e.plate, 'sm')}
                <div class="min-w-0 flex-1 text-sm">
                  <p class="truncate text-slate-200">${e.label || '—'}${e.permitNo ? html` · <span class="text-slate-400">#${e.permitNo}</span>` : nothing}</p>
                  ${e.validFrom || e.validTo ? html`<p class="text-xs text-slate-400">Valid ${e.validFrom || '…'} → ${e.validTo || '…'}</p>` : nothing}
                </div>
                <button type="button" class="btn-ghost min-h-10 px-2 text-red-300" aria-label="Remove ${e.plate}" @click=${() => set(() => (l.entries = l.entries.filter((x) => x.id !== e.id)))}>${icon('trash', 'h-4 w-4')}</button>
              </li>`,
            )}
          </ul>`}
    </section>`;
  };

  /* ────────────────────────────── Hot list ────────────────────────────── */

  const saveHotEntry = () => {
    if (list?.type !== 'hot') return;
    const l = list;
    const plate = normalisePlate(hotDraft.plate);
    const e: Record<string, string> = {};
    if (!isValidPlate(plate)) e.hotPlate = 'Enter a valid plate (1–10 letters/numbers).';
    const key = plateKey(plate);
    if (l.entries.some((x) => plateKey(x.plate) === key && x.id !== hotDraft.id)) e.hotPlate = `${plate} is already on this list.`;
    if (hotDraft.risks.length === 0) e.hotRisks = 'Select at least one risk.';
    if (Object.keys(e).length) {
      errors = { ...errors, ...e };
      app.update();
      return;
    }
    const entry: HotEntry = {
      id: hotDraft.id ?? uid(),
      plate,
      key,
      risks: hotDraft.risks,
      riskLevel: hotDraft.riskLevel,
      make: hotDraft.make.trim(),
      model: hotDraft.model.trim(),
      bodyType: hotDraft.bodyType,
      colour: hotDraft.colour,
      notes: hotDraft.notes.trim(),
      addedAt: l.entries.find((x) => x.id === hotDraft.id)?.addedAt ?? Date.now(),
    };
    set(() => {
      l.entries = hotDraft.id ? l.entries.map((x) => (x.id === entry.id ? entry : x)) : [entry, ...l.entries];
      hotDraft = emptyHotDraft();
      hotEditorOpen = false;
      delete errors.hotPlate;
      delete errors.hotRisks;
    });
  };

  const hotEditor = (): TemplateResult => html`<section class="card mt-4 grid gap-3 border-red-500/40">
    <h2 class="section-title">${hotDraft.id ? 'Edit' : 'Add'} high-risk vehicle</h2>
    <div>
      <label class="field-label" for="hot-plate">Number plate <span class="text-red-300">*</span></label>
      <input id="hot-plate" class="${fieldCls('hotPlate')} font-plate text-xl tracking-widest uppercase" .value=${hotDraft.plate} autocapitalize="characters" autocomplete="off" maxlength="12" placeholder="ABC123"
        @input=${(e: Event) => (hotDraft.plate = (e.target as HTMLInputElement).value.toUpperCase())} />
      ${err('hotPlate')}
    </div>
    <fieldset>
      <legend class="field-label">Risk <span class="text-red-300">*</span></legend>
      <div class="flex flex-wrap gap-2">
        ${RISK_TAGS.map((t: RiskTag) => {
          const on = hotDraft.risks.includes(t);
          return html`<button type="button" aria-pressed=${on ? 'true' : 'false'}
            class="chip min-h-10 ${on ? 'border-red-400 bg-red-500/20 text-red-100' : 'border-ink-600 bg-ink-800 text-slate-300'}"
            @click=${() => set(() => (hotDraft.risks = on ? hotDraft.risks.filter((x) => x !== t) : [...hotDraft.risks, t]))}>
            ${on ? icon('check', 'h-4 w-4') : nothing}${RISK_TAG_LABELS[t]}
          </button>`;
        })}
      </div>
      ${err('hotRisks')}
    </fieldset>
    <fieldset>
      <legend class="field-label">Risk level</legend>
      <div class="grid grid-cols-3 gap-2">
        ${(Object.keys(RISK_LEVEL_LABELS) as RiskLevel[]).map((lvl) => {
          const on = hotDraft.riskLevel === lvl;
          return html`<button type="button" aria-pressed=${on ? 'true' : 'false'}
            class="chip min-h-11 justify-center ${on ? RISK_LEVEL_CLASS[lvl] : 'border-ink-600 bg-ink-800 text-slate-400'}"
            @click=${() => set(() => (hotDraft.riskLevel = lvl))}>${RISK_LEVEL_LABELS[lvl]}</button>`;
        })}
      </div>
    </fieldset>
    <div class="grid grid-cols-2 gap-3">
      ${text({ id: 'hot-make', label: 'Make', value: hotDraft.make, onInput: (v) => (hotDraft.make = v), placeholder: 'e.g. Toyota', list: 'makes' })}
      ${text({ id: 'hot-model', label: 'Model', value: hotDraft.model, onInput: (v) => (hotDraft.model = v), placeholder: 'e.g. Corolla' })}
    </div>
    <datalist id="makes">${VEHICLE_MAKES.map((m) => html`<option value=${m}></option>`)}</datalist>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="field-label" for="hot-body">Type</label>
        <select id="hot-body" class="field" @change=${(e: Event) => (hotDraft.bodyType = (e.target as HTMLSelectElement).value)}>
          <option value="" ?selected=${!hotDraft.bodyType}>—</option>
          ${BODY_TYPES.map((b) => html`<option value=${b} ?selected=${hotDraft.bodyType === b}>${b}</option>`)}
        </select>
      </div>
      <div>
        <label class="field-label" for="hot-colour">Colour</label>
        <select id="hot-colour" class="field" @change=${(e: Event) => (hotDraft.colour = (e.target as HTMLSelectElement).value)}>
          <option value="" ?selected=${!hotDraft.colour}>—</option>
          ${COLOURS.map((c) => html`<option value=${c} ?selected=${hotDraft.colour === c}>${c}</option>`)}
        </select>
      </div>
    </div>
    <div>
      <label class="field-label" for="hot-notes">Notes</label>
      <textarea id="hot-notes" class="field min-h-20" maxlength="1000" .value=${hotDraft.notes} placeholder="Incident references, behaviour, officer guidance…"
        @input=${(e: Event) => (hotDraft.notes = (e.target as HTMLTextAreaElement).value)}></textarea>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <button type="button" class="btn-secondary" @click=${() => set(() => { hotDraft = emptyHotDraft(); hotEditorOpen = false; delete errors.hotPlate; delete errors.hotRisks; })}>Cancel</button>
      <button type="button" class="btn-danger" @click=${saveHotEntry}>${hotDraft.id ? 'Update' : 'Add'} vehicle</button>
    </div>
  </section>`;

  const hotFields = (): TemplateResult => {
    if (list?.type !== 'hot') return html``;
    const l = list;
    return html`
      ${hotEditorOpen
        ? hotEditor()
        : html`<button type="button" class="btn-secondary mt-4 w-full" @click=${() => set(() => { hotDraft = emptyHotDraft(); hotEditorOpen = true; })}>${icon('plus')} Add high-risk vehicle</button>`}
      <section class="card mt-4">
        <h2 class="section-title">Vehicles on this list (${l.entries.length})</h2>
        ${l.entries.length === 0
          ? html`<p class="text-sm text-slate-400">No vehicles added yet.</p>`
          : html`<ul class="divide-y divide-ink-700">
              ${l.entries.map(
                (e) => html`<li class="py-3">
                  <div class="flex items-center gap-2">
                    ${plateBadge(e.plate, 'sm')}
                    <span class="chip ${RISK_LEVEL_CLASS[e.riskLevel]}">${RISK_LEVEL_LABELS[e.riskLevel]}</span>
                    <span class="flex-1"></span>
                    <button type="button" class="btn-ghost min-h-10 px-2" aria-label="Edit ${e.plate}" @click=${() => set(() => { hotDraft = { ...e }; hotEditorOpen = true; })}>${icon('edit', 'h-4 w-4')}</button>
                    <button type="button" class="btn-ghost min-h-10 px-2 text-red-300" aria-label="Remove ${e.plate}" @click=${() => set(() => (l.entries = l.entries.filter((x) => x.id !== e.id)))}>${icon('trash', 'h-4 w-4')}</button>
                  </div>
                  <p class="mt-1 text-sm text-slate-300">${[e.colour, e.make, e.model, e.bodyType].filter(Boolean).join(' ') || 'No vehicle details'}</p>
                  <p class="mt-1 text-xs text-red-200">${e.risks.map((r) => RISK_TAG_LABELS[r]).join(' · ')}</p>
                </li>`,
              )}
            </ul>`}
      </section>`;
  };

  /* ──────────────────────────────── View ──────────────────────────────── */

  return {
    async mount() {
      allowLists = (await getAllowLists()).sort((a, b) => a.name.localeCompare(b.name));
      const timedLists = await getTimedLists();
      knownZones = patrolZones(timedLists);
      knownZoneNames = zoneNames(timedLists);
      knownRpas = [...new Set(timedLists.map((t) => t.rpa?.trim() ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en-AU', { numeric: true }));
      if (editingId) {
        const found = await getList(editingId);
        if (!found) {
          app.toast('List not found.', 'error');
          app.navigate('/', true);
          return;
        }
        list = structuredClone(found);
      } else {
        const type = params.type as ListType;
        if (!['allow', 'timed', 'hot'].includes(type)) {
          app.navigate('/new', true);
          return;
        }
        list = emptyList(type);
      }
      if (prefillPlate) {
        if (list.type === 'allow') allowDraft.plate = normalisePlate(prefillPlate);
        if (list.type === 'hot') {
          hotDraft = { ...emptyHotDraft(), plate: normalisePlate(prefillPlate) };
          hotEditorOpen = true;
        }
      }
    },
    render() {
      if (!list) return html`${header({ title: 'Loading…', back: () => app.back() })}`;
      const l = list;
      return html`${header({
          title: editingId ? `Edit ${LIST_TYPE_META[l.type].label.toLowerCase()}` : `New ${LIST_TYPE_META[l.type].label.toLowerCase()}`,
          back: () => app.back(),
          actions: html`<button type="button" class="btn-primary min-h-11 px-4" ?disabled=${saving} @click=${save}>Save</button>`,
        })}
        ${page(html`
          <section class="card grid gap-3">
            <div class="flex items-center gap-2">${typeChip(l.type)}<span class="text-sm text-slate-400">${LIST_TYPE_META[l.type].description}</span></div>
            ${text({
              id: 'name',
              label: 'List name',
              value: l.name,
              onInput: (v) => (l.name = v),
              placeholder: l.type === 'timed' ? 'e.g. Smith St 2P (north)' : l.type === 'hot' ? 'e.g. Officer safety — North patrol' : 'e.g. Zone 12 resident permits',
              required: true,
              errKey: 'name',
            })}
            <div>
              <label class="field-label" for="notes">Notes</label>
              <textarea id="notes" class="field min-h-16" maxlength="2000" .value=${l.notes} @input=${(e: Event) => (l.notes = (e.target as HTMLTextAreaElement).value)}></textarea>
            </div>
          </section>
          ${timedFields()}${allowFields()}${hotFields()}
          <button type="button" class="btn-primary mt-6 w-full" ?disabled=${saving} @click=${save}>${icon('check')} Save list</button>
        `)}`;
    },
  };
}
