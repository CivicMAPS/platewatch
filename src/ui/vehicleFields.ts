/**
 * Vehicle details fields in the infringement-issuance structure: Registration type, State, Make,
 * Type, Colour (the licence plate is entered separately). Registration type and Type are fixed
 * lists (permit schema). Shared by the hot-list and permit forms and the infringement hand-off.
 */
import { html, type TemplateResult } from 'lit-html';
import { COLOURS, REGISTRATION_STATES, REGISTRATION_TYPES, VEHICLE_MAKES, VEHICLE_TYPES } from '../lib/vehicle';
import type { VehicleDetails } from '../lib/types';

export function vehicleFields(opts: { id: string; value: VehicleDetails; onChange: (patch: Partial<VehicleDetails>) => void; required?: boolean }): TemplateResult {
  const { id, value: v, onChange } = opts;
  const req = opts.required ? html` <span class="text-neutral-600" aria-hidden="true">*</span>` : '';
  const select = (key: 'registrationType' | 'bodyType' | 'colour' | 'registrationState', label: string, options: readonly (readonly [string, string])[], blank = true) => {
    const value = v[key] ?? '';
    const opts2 = value && !options.some(([c]) => c === value) ? [...options, [value, value] as const] : options;
    return html`<div>
      <label class="field-label" for="${id}-${key}">${label}${req}</label>
      <select id="${id}-${key}" class="field" data-testid="${id}-${key}" @change=${(e: Event) => onChange({ [key]: (e.target as HTMLSelectElement).value })}>
        ${blank ? html`<option value="" ?selected=${!value}>—</option>` : ''}
        ${opts2.map(([c, l]) => html`<option value=${c} ?selected=${value === c}>${l}</option>`)}
      </select>
    </div>`;
  };
  const pairs = (xs: readonly string[]) => xs.map((x) => [x, x] as const);
  return html`<div class="grid grid-cols-2 gap-3" data-testid="${id}-vehicle">
    ${select('registrationType', 'Registration type', REGISTRATION_TYPES)}
    ${select('registrationState', 'State', pairs(REGISTRATION_STATES), false)}
    <div>
      <label class="field-label" for="${id}-make">Make${req}</label>
      <input id="${id}-make" class="field" data-testid="${id}-make" list="${id}-makes" autocapitalize="words" maxlength="50" placeholder="e.g. Toyota"
        .value=${v.make} @input=${(e: Event) => onChange({ make: (e.target as HTMLInputElement).value })} />
    </div>
    ${select('bodyType', 'Type', VEHICLE_TYPES)}
    ${select('colour', 'Colour', pairs(COLOURS))}
    <datalist id="${id}-makes">${VEHICLE_MAKES.map((x) => html`<option value=${x}></option>`)}</datalist>
  </div>`;
}
