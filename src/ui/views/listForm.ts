import { html, nothing, type TemplateResult } from 'lit-html';
import { getAllowLists, getList, getTimedLists, putList, uid } from '../../lib/db';
import { patrolZones, zoneNames } from '../../lib/listIndex';
import { formatBays, parseBays } from '../../lib/importer';
import { isValidPlate, normalisePlate, plateKey } from '../../lib/plate';
import { normalisePayment, paidByLabel, prunePaidBy } from '../../lib/payment';
import { describeRestriction, minutesFromCode, validateRestriction } from '../../lib/restriction';
import {
  RISK_LEVEL_LABELS,
  RISK_TAG_LABELS,
  RISK_TAGS,
  type AllowEntry,
  type VehicleDetails,
  type AllowList,
  type HotEntry,
  type ListType,
  type PlateList,
  type RiskLevel,
  type RiskTag,
  type PaidBy,
  type PaymentAreas,
  type StreetSide,
  type TimedList,
  type TimedRestriction,
  type Weekday,
} from '../../lib/types';
import { formatIsoDate } from '../../lib/time';
import type { App, View } from '../app';
import { banner, header, icon, LIST_TYPE_META, page, plateBadge, riskPill, typeChip } from '../components';
import { allowsPaidParking, creatableListTypes, listPermissions, officerSource, policyContext } from '../../lib/listPolicy';
import { compactVehicle, describeVehicle, EMPTY_VEHICLE, hasVehicle, vehicleComplete, vehicleOf } from '../../lib/vehicle';
import { parsePermitNumber } from '../../lib/permit';
import { vehicleFields } from '../vehicleFields';

const SIDES: { value: StreetSide; label: string }[] = [
  { value: 'both', label: 'Both sides' },
  { value: 'north', label: 'North side' },
  { value: 'south', label: 'South side' },
  { value: 'east', label: 'East side' },
  { value: 'west', label: 'West side' },
  { value: 'centre', label: 'Centre (median)' },
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
  // Created on the device: the officer's own list (a daily chalking list in EnforcementMAPS).
  const base = { id: uid(), name: '', notes: '', createdAt: Date.now(), updatedAt: Date.now(), source: officerSource() };
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
  vehicle: VehicleDetails;
  rpa: string;
  /** Issuing council code (com, copp) and CivicMAPS linking ID once onboarded. */
  council: string;
  linkingId: string;
  streetNumber: string;
  street: string;
}
const emptyAllowDraft = (): AllowDraft => ({ plate: '', label: '', permitNo: '', validFrom: '', validTo: '', vehicle: { ...EMPTY_VEHICLE }, rpa: '', council: '', linkingId: '', streetNumber: '', street: '' });

type HotDraft = Omit<HotEntry, 'id' | 'key' | 'addedAt'> & { id: string | null };
const emptyHotDraft = (): HotDraft => ({
  id: null,
  plate: '',
  risks: [],
  riskLevel: 'high',
  registrationType: '',
  make: '',
  bodyType: '',
  colour: '',
  notes: '',
});

export function listFormView(params: Record<string, string>, app: App): View {
  const editingId = params.id ?? null;
  const policy = policyContext();
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
      if (l.payment?.meters?.some(m => !m.id.trim())) e.payment = 'Meter ID is required.';
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
    // Blank payment numbers and meter IDs are reported before cleaning would drop them.
    if (list.type === 'timed') {
      const payErr = validate(list).payment;
      if (payErr) {
        errors = { ...errors, payment: payErr };
        app.toast('Please fix the highlighted fields.', 'error');
        app.update();
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
      if (cleaned.payment) {
        const pay = normalisePayment(cleaned.payment);
        // Meters keep only links to numbers still on the segment (none left = whole segment).
        if (pay.meters) pay.meters = pay.meters.map((m) => ({ id: m.id, ...(prunePaidBy(m, pay) ?? { easyPark: [], payStay: [] }) }));
        cleaned.payment = pay;
      }
      // Officer chalking lists in EnforcementMAPS are for segments not linked to paid parking.
      if (!allowsPaidParking(cleaned, policy)) delete cleaned.payment;
      const payment = cleaned.payment;
      cleaned.restrictions = cleaned.restrictions.map((r) => {
        const { paidBy: _p, ...rest } = r;
        const paidBy = prunePaidBy(r.paidBy, payment);
        return { ...rest, code: r.code.trim().toUpperCase(), ...(paidBy ? { paidBy } : {}) };
      });
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

  /** Field error: amber (interaction required) + icon + text; red is reserved for Code 1. */
  const err = (k: string) => (errors[k] ? html`<p class="mt-1 flex items-start gap-1 text-sm font-medium text-alert-strong" data-error>${icon('alert', 'h-4 w-4 mt-0.5')}<span>${errors[k]}</span></p>` : nothing);
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
    <label class="field-label" for=${opts.id}>${opts.label}${opts.required ? html` <span class="text-neutral-600" aria-hidden="true">*</span>` : nothing}</label>
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
    return html`<div class="rounded-md border ${errors[`r-${r.id}`] ? 'border-2 border-alert-strong' : 'border-neutral-300'} bg-neutral-50 p-3">
      <div class="mb-3 flex items-center justify-between">
        <p class="text-sm font-bold text-neutral-800">Restriction ${idx + 1}</p>
        ${l.restrictions.length > 1
          ? html`<button type="button" class="btn-ghost min-h-11 px-2 py-1 text-sm" @click=${() => set(() => (l.restrictions = l.restrictions.filter((x) => x.id !== r.id)))}>
              ${icon('trash', 'h-4 w-4')} Remove
            </button>`
          : nothing}
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="code-${r.id}">Sign code <span class="text-neutral-600" aria-hidden="true">*</span></label>
          <input id="code-${r.id}" class="field font-plate uppercase" .value=${r.code} placeholder="2P" autocapitalize="characters" maxlength="12"
            @input=${(e: Event) => {
              const code = (e.target as HTMLInputElement).value.toUpperCase();
              const mins = minutesFromCode(code);
              update(mins ? { code, limitMinutes: mins } : { code });
            }} />
        </div>
        <div>
          <label class="field-label" for="limit-${r.id}">Allowance (min) <span class="text-neutral-600" aria-hidden="true">*</span></label>
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
              class="chip-button"
              @click=${() => update({ days: on ? r.days.filter((x) => x !== d) : [...r.days, d] })}>${label}</button>`;
          })}
        </div>
      </fieldset>
      <label class="mt-3 flex items-center gap-3 text-sm text-neutral-800">
        <input type="checkbox" class="h-5 w-5 accent-primary" .checked=${r.allDay} @change=${(e: Event) => update({ allDay: (e.target as HTMLInputElement).checked })} />
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
      ${paidWith(l, r, update)}
      <p class="mt-2 text-xs text-neutral-600">${describeRestriction(r)}${r.graceMinutes ? ` · +${r.graceMinutes}m grace` : ''}${paidByLabel(r.paidBy) ? ` · paid with ${paidByLabel(r.paidBy)}` : ''}</p>
      ${err(`r-${r.id}`)}
    </div>`;
  };

  /* Paid parking: numbers on the segment, meters, and which numbers pay for each restriction. */

  /** Toggle chip, as for days. */
  const toggleChip = (label: string, on: boolean, onClick: () => void, testId?: string) =>
    html`<button type="button" aria-pressed=${on ? 'true' : 'false'} data-testid=${testId ?? nothing}
      class="chip-button"
      @click=${onClick}>${label}</button>`;

  const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

  /** The segment's payment numbers that can be tied to a restriction or meter. */
  const payNumbers = (pay: PaymentAreas | undefined) => [
    ...(pay?.easyPark ?? []).filter(Boolean).map((v) => ({ kind: 'easyPark' as const, v, label: `EasyPark ${v}` })),
    ...[...new Set((pay?.payStay ?? []).map((p) => p.zone).filter(Boolean))].map((v) => ({ kind: 'payStay' as const, v, label: `PayStay ${v}` })),
  ];

  /** "Paid with" on a restriction: which of the segment's EasyPark areas and PayStay zones pay for it. */
  const paidWith = (l: TimedList, r: TimedRestriction, update: (patch: Partial<TimedRestriction>) => void): TemplateResult | typeof nothing => {
    const numbers = payNumbers(l.payment);
    if (!numbers.length) return nothing;
    const paid: PaidBy = r.paidBy ?? { easyPark: [], payStay: [] };
    return html`<fieldset class="mt-3">
      <legend class="field-label">Paid with</legend>
      <div class="flex flex-wrap gap-2">
        ${numbers.map((n) =>
          toggleChip(n.label, paid[n.kind].includes(n.v), () => update({ paidBy: { ...paid, [n.kind]: toggle(paid[n.kind], n.v) } }), `paid-${r.id}-${n.v}`),
        )}
      </div>
      <p class="mt-1 text-xs text-neutral-600">Choose the numbers that pay for this restriction. None chosen: not tied to a payment number.</p>
    </fieldset>`;
  };

  /** Editing a payment number carries its links on restrictions and meters with it. */
  const renameNumber = (l: TimedList, kind: 'easyPark' | 'payStay', from: string, to: string) => {
    if (from === to || !from) return;
    const swap = (xs: string[]) => (xs.includes(from) ? [...new Set(xs.map((x) => (x === from ? to : x)).filter(Boolean))] : xs);
    l.restrictions = l.restrictions.map((r) => (r.paidBy ? { ...r, paidBy: { ...r.paidBy, [kind]: swap(r.paidBy[kind]) } } : r));
    for (const m of l.payment?.meters ?? []) m[kind] = swap(m[kind]);
  };

  const paymentFields = (l: TimedList): TemplateResult => {
    const pay = (l.payment ??= { easyPark: [], payStay: [] });
    const meters = (pay.meters ??= []);
    const numbers = payNumbers(pay);
    return html`<section class="card mt-4 grid gap-3">
      <h2 class="section-title">Paid parking (optional)</h2>
      ${text({ id: 'parkingArea', label: 'Parking area number', value: pay.parkingArea ?? '', placeholder: 'e.g. 637 (one per segment)', maxlength: 12, onInput: (v) => { pay.parkingArea = v.trim(); } })}
      <p class="-mt-2 text-xs text-neutral-600">A bay's kerb sign is this number followed by the bay number (637 + bay 58 = 63758); search accepts either.</p>
      <label class="flex min-h-12 items-center gap-3"><input id="easyPark" type="checkbox" class="h-5 w-5 accent-primary" .checked=${!!pay.easyPark.length} @change=${() => set(() => { pay.easyPark = pay.easyPark.length ? [] : ['']; })}> EasyPark</label>
      ${pay.easyPark.map((entry, i) => html`<div class="grid grid-cols-[1fr_auto] items-end gap-2">
        ${text({ id: `easyPark-${i}`, label: 'AreaNumber', value: entry, required: true, onInput: (v) => set(() => { renameNumber(l, 'easyPark', pay.easyPark[i]!, v.trim()); pay.easyPark[i] = v.trim(); }) })}
        <button type="button" class="btn-secondary" @click=${() => set(() => pay.easyPark.splice(i, 1))}>Remove</button>
      </div>`)}
      ${pay.easyPark.length ? html`<button type="button" class="btn-secondary" @click=${() => set(() => pay.easyPark.push(''))}>Add EasyPark area</button>` : nothing}
      <label class="flex min-h-12 items-center gap-3"><input id="payStay" type="checkbox" class="h-5 w-5 accent-primary" .checked=${!!pay.payStay.length} @change=${() => set(() => { pay.payStay = pay.payStay.length ? [] : [{ zone: '' }]; })}> PayStay</label>
      ${pay.payStay.map((entry, i) => html`<div class="grid grid-cols-[1fr_auto] items-end gap-2">
        ${text({ id: `payStayzone-${i}`, label: 'ParkingZone', value: entry.zone, required: true, placeholder: 'e.g. 3388… (one per side)', onInput: (v) => set(() => { renameNumber(l, 'payStay', entry.zone, v.trim()); entry.zone = v.trim(); }) })}
        <button type="button" class="btn-secondary" @click=${() => set(() => pay.payStay.splice(i, 1))}>Remove</button>
      </div>`)}
      ${pay.payStay.length ? html`<button type="button" class="btn-secondary" @click=${() => set(() => pay.payStay.push({ zone: '' }))}>Add PayStay zone</button>` : nothing}
      <h3 class="mt-2 text-sm font-semibold text-neutral-800">Meters</h3>
      ${meters.map((m, i) => html`<div class="grid gap-2 rounded-md border border-neutral-300 bg-surface-sunken p-3">
        <div class="grid grid-cols-[1fr_auto] items-end gap-2">
          ${text({ id: `meter-${i}`, label: 'Meter ID', value: m.id, required: true, placeholder: 'e.g. GLP1', maxlength: 24, onInput: (v) => { m.id = v.trim(); } })}
          <button type="button" class="btn-secondary" @click=${() => set(() => meters.splice(i, 1))}>Remove</button>
        </div>
        <p class="field-label">Pays for</p>
        <div class="flex flex-wrap gap-2">
          ${toggleChip('Whole segment', !m.easyPark.length && !m.payStay.length, () => set(() => { m.easyPark = []; m.payStay = []; }), `meter-${i}-segment`)}
          ${numbers.map((n) => toggleChip(n.label, m[n.kind].includes(n.v), () => set(() => { m[n.kind] = toggle(m[n.kind], n.v); }), `meter-${i}-${n.v}`))}
        </div>
      </div>`)}
      <button type="button" class="btn-secondary" data-testid="add-meter" @click=${() => set(() => meters.push({ id: '', easyPark: [], payStay: [] }))}>${icon('plus')} Add meter</button>
      <p class="text-xs text-neutral-600">A meter pays for the whole segment${pay.parkingArea ? ` and parking area ${pay.parkingArea}` : ' (and its parking area)'}, or for the EasyPark areas and PayStay zones chosen; one meter can serve several. Tie each restriction to its numbers under <em>Paid with</em> below.</p>
      ${err('payment')}
    </section>`;
  };

  const timedFields = (): TemplateResult => {
    if (list?.type !== 'timed') return html``;
    const l = list;
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
        <p class="text-xs text-neutral-600">Patrol zone: the internal enforcement area number and its day-to-day name. Home groups timed lists by zone, then road, and search finds them by zone, RPA, parking area or bay sign, EasyPark, PayStay and meter ID.</p>
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
        <p class="text-xs text-neutral-600">Part of the side (optional), where the signs change part way along: from and to a bay, an address or a cross street.</p>
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

${allowsPaidParking(l, policy) ? paymentFields(l) : nothing}
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
          ? html`<p class="text-sm text-neutral-600">No allow lists saved yet. Create one (e.g. resident permits), then link it here.</p>`
          : html`<ul class="grid gap-2">
              ${allowLists.map((a) => {
                const on = l.allowListIds.includes(a.id);
                return html`<li>
                  <label class="flex min-h-12 items-center gap-3 rounded-md border border-neutral-300 bg-surface-sunken px-3">
                    <input type="checkbox" class="h-5 w-5 accent-primary" .checked=${on}
                      @change=${(e: Event) => set(() => {
                        const c = (e.target as HTMLInputElement).checked;
                        l.allowListIds = c ? [...l.allowListIds, a.id] : l.allowListIds.filter((x) => x !== a.id);
                      })} />
                    <span class="flex-1">${a.name}</span>
                    <span class="text-sm text-neutral-600">${a.entries.length} plates</span>
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
    // Permit structure (schemas/civicmaps-parking-permit.v1.schema.json): the permit number is
    // authoritative and gives the types; dates, address, council and vehicle details are required.
    const d = allowDraft;
    const permitNo = d.permitNo.trim().toUpperCase();
    const parts = parsePermitNumber(permitNo);
    const problems = [
      !parts ? 'permit number like RPA-2026-0789, RSP-2026-0790/1 or RPA/COMB/FS-2026-0791' : '',
      !d.validFrom || !d.validTo ? 'valid from and valid to' : d.validTo < d.validFrom ? 'valid to on or after valid from' : '',
      !d.council.trim() ? 'council (e.g. com)' : '',
      !d.streetNumber.trim() || !d.street.trim() ? 'street number and street' : '',
      parts?.types.includes('RPA') && !d.rpa.trim() ? 'parking area (RPA permit)' : '',
      !vehicleComplete(d.vehicle) ? 'registration type, make, type and colour' : '',
    ].filter(Boolean);
    if (problems.length) {
      errors = { ...errors, allowPlate: `Needed: ${problems.join('; ')}.` };
      app.update();
      return;
    }
    const entry: AllowEntry = {
      id: uid(),
      plate,
      key,
      label: d.label.trim(),
      permitNo,
      validFrom: d.validFrom,
      validTo: d.validTo,
      addedAt: Date.now(),
      permitTypes: parts!.types,
      council: { code: d.council.trim().toLowerCase(), ...(d.linkingId.trim() ? { linkingId: d.linkingId.trim() } : {}) },
      address: { streetNumber: d.streetNumber.trim(), street: d.street.trim() },
    };
    Object.assign(entry, compactVehicle(d.vehicle));
    if (d.rpa.trim()) entry.rpa = d.rpa.trim().toUpperCase();
    // RSP / RP apply on the registered address's street.
    if (parts!.types.some((t) => t === 'RSP' || t === 'RP')) entry.streets = [d.street.trim()];
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
          <label class="field-label" for="allow-plate">Number plate <span class="text-neutral-600" aria-hidden="true">*</span></label>
          <input id="allow-plate" class="${fieldCls('allowPlate')} font-plate text-xl tracking-widest uppercase" .value=${allowDraft.plate} autocapitalize="characters" autocomplete="off" maxlength="12" placeholder="ABC123"
            @input=${(e: Event) => (allowDraft.plate = (e.target as HTMLInputElement).value.toUpperCase())} />
          ${err('allowPlate')}
        </div>
        <div class="grid grid-cols-2 gap-3">
          ${text({ id: 'allow-permit', label: 'Permit number', value: allowDraft.permitNo, onInput: (v) => (allowDraft.permitNo = v), placeholder: 'RPA-2026-0789', autocap: 'characters', required: true })}
          ${text({ id: 'allow-council', label: 'Council', value: allowDraft.council, onInput: (v) => (allowDraft.council = v), placeholder: 'e.g. com', required: true, maxlength: 8 })}
        </div>
        <p class="-mt-1 text-xs text-neutral-600">Types from the number: RPA (residential parking area), RSP (residential street permit), RP (resident permit, in front of the address), FS (foreshore); a combination lists each with COMB, e.g. RPA/COMB/FS.</p>
        <div class="grid grid-cols-2 gap-3">
          ${text({ id: 'allow-from', label: 'Valid from', type: 'date', value: allowDraft.validFrom, onInput: (v) => (allowDraft.validFrom = v), required: true })}
          ${text({ id: 'allow-to', label: 'Valid to', type: 'date', value: allowDraft.validTo, onInput: (v) => (allowDraft.validTo = v), required: true })}
        </div>
        <p class="-mt-1 text-xs text-neutral-600">Expires at midnight at the end of the valid-to date.</p>
        <div class="grid grid-cols-[1fr_2fr] gap-3">
          ${text({ id: 'allow-street-number', label: 'Street no.', value: allowDraft.streetNumber, onInput: (v) => (allowDraft.streetNumber = v), placeholder: '12', required: true, maxlength: 12 })}
          ${text({ id: 'allow-street', label: 'Street (registered address)', value: allowDraft.street, onInput: (v) => (allowDraft.street = v), placeholder: 'e.g. Gladstone Street', required: true })}
        </div>
        <div class="grid grid-cols-2 gap-3">
          ${text({ id: 'allow-rpa', label: 'Parking area (RPA)', value: allowDraft.rpa, onInput: (v) => (allowDraft.rpa = v), placeholder: 'e.g. 7, 4B, 15A', maxlength: 4, autocap: 'characters' })}
          ${text({ id: 'allow-label', label: 'Holder / label', value: allowDraft.label, onInput: (v) => (allowDraft.label = v), placeholder: 'Optional' })}
        </div>
        <p class="field-label -mb-1">Vehicle details</p>
        ${vehicleFields({ id: 'allow', value: allowDraft.vehicle, required: true, onChange: (patch) => set(() => (allowDraft.vehicle = { ...allowDraft.vehicle, ...patch })) })}
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
        ? html`<p class="text-sm text-neutral-600">No plates added yet.</p>`
        : html`<ul class="divide-y divide-neutral-200">
            ${l.entries.map(
              (e) => html`<li class="flex items-center gap-3 py-2">
                ${plateBadge(e.plate, 'sm')}
                <div class="min-w-0 flex-1 text-sm">
                  <p class="truncate text-neutral-800">${e.label || '—'}${e.permitNo ? html` · <span class="text-neutral-600">#${e.permitNo}</span>` : nothing}</p>
                  ${hasVehicle(e) || e.rpa || e.streets?.length ? html`<p class="truncate text-xs text-neutral-700">${[describeVehicle(e), e.rpa ? `RPA ${e.rpa}` : '', e.streets?.join(', ')].filter(Boolean).join(' · ')}</p>` : nothing}
                  ${e.validFrom || e.validTo ? html`<p class="text-xs text-neutral-600">Valid ${e.validFrom ? formatIsoDate(e.validFrom) : 'any time'} to ${e.validTo ? formatIsoDate(e.validTo) : 'no end date'}</p>` : nothing}
                </div>
                <button type="button" class="btn-ghost min-h-11 px-2" aria-label="Remove ${e.plate}" @click=${() => set(() => (l.entries = l.entries.filter((x) => x.id !== e.id)))}>${icon('trash', 'h-4 w-4')}</button>
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
      registrationType: hotDraft.registrationType.trim(),
      make: hotDraft.make.trim(),
      bodyType: hotDraft.bodyType,
      colour: hotDraft.colour,
      ...(hotDraft.model ? { model: hotDraft.model } : {}),
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

  const hotEditor = (): TemplateResult => html`<section class="card mt-4 grid gap-3 border-2 border-alert-border">
    <h2 class="section-title">${hotDraft.id ? 'Edit' : 'Add'} high-risk vehicle</h2>
    <div>
      <label class="field-label" for="hot-plate">Number plate <span class="text-neutral-600" aria-hidden="true">*</span></label>
      <input id="hot-plate" class="${fieldCls('hotPlate')} font-plate text-xl tracking-widest uppercase" .value=${hotDraft.plate} autocapitalize="characters" autocomplete="off" maxlength="12" placeholder="ABC123"
        @input=${(e: Event) => (hotDraft.plate = (e.target as HTMLInputElement).value.toUpperCase())} />
      ${err('hotPlate')}
    </div>
    <fieldset>
      <legend class="field-label">Risk <span class="text-neutral-600" aria-hidden="true">*</span></legend>
      <div class="flex flex-wrap gap-2">
        ${RISK_TAGS.map((t: RiskTag) => {
          const on = hotDraft.risks.includes(t);
          return html`<button type="button" aria-pressed=${on ? 'true' : 'false'}
            class="chip-button"
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
            class="chip-button justify-center"
            @click=${() => set(() => (hotDraft.riskLevel = lvl))}>${RISK_LEVEL_LABELS[lvl]}</button>`;
        })}
      </div>
    </fieldset>
    <p class="field-label -mb-1">Vehicle details</p>
    ${vehicleFields({ id: 'hot', value: vehicleOf(hotDraft), onChange: (patch) => set(() => Object.assign(hotDraft, patch)) })}
    <div>
      <label class="field-label" for="hot-notes">Notes</label>
      <textarea id="hot-notes" class="field min-h-20" maxlength="1000" .value=${hotDraft.notes} placeholder="Incident references, behaviour, officer guidance…"
        @input=${(e: Event) => (hotDraft.notes = (e.target as HTMLTextAreaElement).value)}></textarea>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <button type="button" class="btn-secondary" @click=${() => set(() => { hotDraft = emptyHotDraft(); hotEditorOpen = false; delete errors.hotPlate; delete errors.hotRisks; })}>Cancel</button>
      <button type="button" class="btn-primary" @click=${saveHotEntry}>${hotDraft.id ? 'Update' : 'Add'} vehicle</button>
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
          ? html`<p class="text-sm text-neutral-600">No vehicles added yet.</p>`
          : html`<ul class="divide-y divide-neutral-200">
              ${l.entries.map(
                (e) => html`<li class="py-3">
                  <div class="flex items-center gap-2">
                    ${plateBadge(e.plate, 'sm')}
                    ${riskPill(e.riskLevel, RISK_LEVEL_LABELS[e.riskLevel])}
                    <span class="flex-1"></span>
                    <button type="button" class="btn-ghost min-h-11 px-2" aria-label="Edit ${e.plate}" @click=${() => set(() => { hotDraft = { ...e }; hotEditorOpen = true; })}>${icon('edit', 'h-4 w-4')}</button>
                    <button type="button" class="btn-ghost min-h-11 px-2" aria-label="Remove ${e.plate}" @click=${() => set(() => (l.entries = l.entries.filter((x) => x.id !== e.id)))}>${icon('trash', 'h-4 w-4')}</button>
                  </div>
                  <p class="mt-1 text-sm text-neutral-700">${describeVehicle(e) || 'No vehicle details'}</p>
                  <p class="mt-1 text-xs font-medium text-alert-strong">${e.risks.map((r) => RISK_TAG_LABELS[r]).join(' · ')}</p>
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
        if (!listPermissions(found, policy).edit) {
          app.toast('This list cannot be edited on this device.', 'warn');
          app.navigate(`/list/${found.id}`, true);
          return;
        }
        list = structuredClone(found);
        // Older lists kept one meter with each PayStay zone entry; edit them as separate meters.
        if (list.type === 'timed' && list.payment) list.payment = normalisePayment(list.payment);
      } else {
        const type = params.type as ListType;
        if (!creatableListTypes(policy).includes(type)) {
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
          actions: html`<button type="button" class="btn-chrome-primary" ?disabled=${saving} @click=${save}>Save</button>`,
        })}
        ${page(html`
          ${listPermissions(l, policy).devOverride
            ? html`<div class="mb-4">${banner('pending', 'System list — editable in this development build', 'This list was imported. Once PlateWatch runs inside EnforcementMAPS, lists imported or created in CommandMAPS cannot be edited on the device.', 'dev-override')}</div>`
            : nothing}
          <section class="card grid gap-3">
            <div class="flex items-center gap-2">${typeChip(l.type)}<span class="text-sm text-neutral-600">${LIST_TYPE_META[l.type].description}</span></div>
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
