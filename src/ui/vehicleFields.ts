/**
 * Vehicle details fields in the infringement-issuance structure: Registration type, Make, Type,
 * Colour (the licence plate is entered separately). Shared by the hot-list and permit forms and the
 * infringement hand-off.
 */
import { html, type TemplateResult } from 'lit-html';
import { BODY_TYPES, COLOURS, REGISTRATION_TYPE_SUGGESTIONS, VEHICLE_MAKES } from '../lib/vehicle';
import type { VehicleDetails } from '../lib/types';

export function vehicleFields(opts: { id: string; value: VehicleDetails; onChange: (patch: Partial<VehicleDetails>) => void; required?: boolean }): TemplateResult {
  const { id, value: v, onChange } = opts;
  const req = opts.required ? html` <span class="text-neutral-600" aria-hidden="true">*</span>` : '';
  const select = (key: 'bodyType' | 'colour', label: string, options: readonly string[]) => html`<div>
    <label class="field-label" for="${id}-${key}">${label}${req}</label>
    <select id="${id}-${key}" class="field" data-testid="${id}-${key}" @change=${(e: Event) => onChange({ [key]: (e.target as HTMLSelectElement).value })}>
      <option value="" ?selected=${!v[key]}>—</option>
      ${[...new Set([...options, ...(v[key] && !options.includes(v[key]) ? [v[key]] : [])])].map((o) => html`<option value=${o} ?selected=${v[key] === o}>${o}</option>`)}
    </select>
  </div>`;
  const input = (key: 'registrationType' | 'make', label: string, list: string, placeholder: string) => html`<div>
    <label class="field-label" for="${id}-${key}">${label}${req}</label>
    <input id="${id}-${key}" class="field" data-testid="${id}-${key}" list="${id}-${list}" autocapitalize="words" maxlength="40" placeholder=${placeholder}
      .value=${v[key]} @input=${(e: Event) => onChange({ [key]: (e.target as HTMLInputElement).value })} />
  </div>`;
  return html`<div class="grid grid-cols-2 gap-3" data-testid="${id}-vehicle">
    ${input('registrationType', 'Registration type', 'regtypes', 'e.g. Standard')}
    ${input('make', 'Make', 'makes', 'e.g. Toyota')}
    ${select('bodyType', 'Type', BODY_TYPES)}
    ${select('colour', 'Colour', COLOURS)}
    <datalist id="${id}-regtypes">${REGISTRATION_TYPE_SUGGESTIONS.map((x) => html`<option value=${x}></option>`)}</datalist>
    <datalist id="${id}-makes">${VEHICLE_MAKES.map((x) => html`<option value=${x}></option>`)}</datalist>
  </div>`;
}
