/**
 * Issue Infringement wizard for the development host (WF-S8 8d-i–8d-iv, WF-S31 31b–31e). Inside
 * EnforcementMAPS the host's own wizard is used; with the PlateWatch backend configured this one
 * runs on the device so testers see the whole life cycle. The I-N is allocated (and signed) when
 * the wizard opens; Cancel consumes it (owner, 16–23/11/2026).
 */
import { html, nothing, render, type TemplateResult } from 'lit-html';
import { formatInfringementNumber, type InfringementHandoff } from '../lib/infringement';
import { evidenceCount, issueProblems, MIN_EVIDENCE_IMAGES, timeFromFor, variantFor, type WizardValues } from '../lib/issuance';
import { offenceChipText } from '../lib/offence';
import type { WizardOutcome } from '../lib/backend';
import { banner, plateBadge } from './components';

const STEPS = ['Location & vehicle', 'Evidence & notes', 'Offence & time', 'Review & issue'] as const;

const pad = (n: number) => String(n).padStart(2, '0');
const toInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fromInput = (v: string) => (v ? new Date(v).getTime() : NaN);
const stamp = (iso: string | number) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const ROLE: Record<string, string> = { first_sighting: 'First sighting', current_scan: 'This scan' };

export function openInfringementWizard(args: { handoff: InfringementHandoff; number: string; initial?: Partial<WizardValues>; reissueOf?: string }): Promise<WizardOutcome> {
  const h = args.handoff;
  const loc = h.location as Record<string, unknown>;
  const veh = h.vehicle as Record<string, unknown>;
  const ev = (h.evidence as { scanId: string; role: string; capturedAt: string; sha256: string }[]) ?? [];
  const pay = h.payment as { status?: string; source?: string; sourceRef?: string; paidFrom?: string; paidTo?: string } | undefined;

  let step = 0;
  let confirmed = false;
  let overrideOn = !!args.initial?.evidenceOverride;
  let v: WizardValues = {
    offenceCode: args.initial?.offenceCode ?? h.offence.suggestedCode,
    timeTo: args.initial?.timeTo ?? Date.parse(h.times.timeTo),
    notes: args.initial?.notes ?? String((h as { notesTemplate?: string }).notesTemplate ?? ''),
    vehicle: { registrationType: veh.registrationType ?? '', make: veh.make ?? '', type: veh.type ?? '', colour: veh.colour ?? '', registrationState: veh.registrationState ?? 'VIC', ...(args.initial?.vehicle ?? {}) },
    evidenceOverride: args.initial?.evidenceOverride ?? '',
  };

  const host = document.createElement('div');
  document.body.appendChild(host);

  return new Promise<WizardOutcome>((resolve) => {
    const finish = (o: WizardOutcome) => {
      render(nothing, host);
      host.remove();
      resolve(o);
    };
    const set = (patch: Partial<WizardValues>) => {
      v = { ...v, ...patch };
      draw();
    };
    const setVehicle = (k: string, value: string) => set({ vehicle: { ...v.vehicle, [k]: value } });
    const row = (label: string, value: TemplateResult | string, badge = false) => html`<dt class="text-neutral-600">${label}</dt><dd class="min-w-0 break-words">${value}${badge ? html` <span class="ml-1 rounded-full border border-pending-border bg-pending-bg px-2 py-0.5 text-[11px] font-semibold text-pending-strong">Auto-filled</span>` : nothing}</dd>`;
    const field = (label: string, key: string, testid: string) => html`<label class="block"><span class="field-label">${label}</span>
      <input class="field" data-testid=${testid} .value=${String(v.vehicle[key] ?? '')} @input=${(e: Event) => setVehicle(key, (e.target as HTMLInputElement).value)} /></label>`;

    const problems = () => issueProblems(h, { ...v, evidenceOverride: overrideOn ? v.evidenceOverride : '' });
    const timeFrom = () => timeFromFor(h, v.offenceCode);
    const chip = (code: '701' | '702') => offenceChipText({ code, internalVariant: variantFor(h, code) === 'expired_session' ? 'expired_session' : 'no_payment' });

    const body = (): TemplateResult => {
      if (step === 0)
        return html`<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            ${row('Street segment', String(loc.street ?? ''), true)}
            ${row('Between', String(loc.fromStreet ?? ''), true)}
            ${row('And', String(loc.toStreet ?? ''), true)}
            ${row('Side of street', String(loc.side ?? ''), true)}
            ${loc.parkingArea ? row('Parking area', html`<span class="font-plate">${loc.parkingArea}</span>`, true) : nothing}
            ${(loc.easyPark as string[] | undefined)?.length ? row('EasyPark', html`<span class="font-plate">${(loc.easyPark as string[]).join(', ')}</span>`, true) : nothing}
            ${(loc.payStay as string[] | undefined)?.length ? row('PayStay', html`<span class="font-plate">${(loc.payStay as string[]).join(', ')}</span>`, true) : nothing}
            ${row('Licence plate', plateBadge(String(veh.registration ?? ''), 'sm'))}
          </dl>
          <p class="mt-1 text-xs text-neutral-600">The licence plate is locked: it was entered twice and checked. To change it, cancel and correct the plate in PlateWatch, which re-runs the check.</p>
          <div class="mt-3 grid grid-cols-2 gap-3">
            ${field('Registration state', 'registrationState', 'wiz-state')}${field('Registration type', 'registrationType', 'wiz-regtype')}
            ${field('Make', 'make', 'wiz-make')}${field('Type', 'type', 'wiz-type')}
            ${field('Colour', 'colour', 'wiz-colour')}
          </div>`;
      if (step === 1)
        return html`<p class="font-semibold text-neutral-900">Evidence <span class="font-plate">${evidenceCount(h)}/${MIN_EVIDENCE_IMAGES}</span></p>
          <ul class="mt-1 grid gap-1 text-sm">${ev.map((e) => html`<li><span class="font-semibold">${ROLE[e.role] ?? e.role}</span> · <span class="font-plate">${stamp(e.capturedAt)}</span> · SHA-256 <span class="font-plate">${e.sha256.slice(0, 12)}…</span></li>`)}</ul>
          ${evidenceCount(h) < MIN_EVIDENCE_IMAGES
            ? html`<label class="mt-3 flex min-h-11 items-center gap-2"><input type="checkbox" class="h-5 w-5" data-testid="wiz-override" .checked=${overrideOn} @change=${(e: Event) => { overrideOn = (e.target as HTMLInputElement).checked; draw(); }} /> Fewer than ${MIN_EVIDENCE_IMAGES} photos — override</label>
              ${overrideOn ? html`<label class="block"><span class="field-label">Override reason (required)</span><textarea class="field" rows="2" data-testid="wiz-override-reason" .value=${v.evidenceOverride ?? ''} @input=${(e: Event) => set({ evidenceOverride: (e.target as HTMLTextAreaElement).value })}></textarea></label>` : nothing}`
            : nothing}
          <label class="mt-3 block"><span class="field-label">Officer notes</span><textarea class="field" rows="5" data-testid="wiz-notes" .value=${v.notes} @input=${(e: Event) => set({ notes: (e.target as HTMLTextAreaElement).value })}></textarea></label>
          <p class="text-xs text-neutral-600">After issue, notes and evidence can only be added to, never changed.</p>`;
      if (step === 2)
        return html`<p class="field-label">Offence</p>
          <div class="grid gap-2" role="group" aria-label="Offence">${(['701', '702'] as const).map(
            (code) => html`<button type="button" class="chip-button justify-start font-plate" aria-pressed=${v.offenceCode === code} data-testid=${`wiz-code-${code}`} @click=${() => set({ offenceCode: code })}>${chip(code)}${code === h.offence.suggestedCode ? ' · suggested' : ''}</button>`,
          )}</div>
          ${v.offenceCode !== h.offence.suggestedCode ? html`<div class="mt-2">${banner('alert', `Changed from the suggested ${h.offence.suggestedCode}`, 'The change is recorded on the infringement.')}</div>` : nothing}
          ${pay ? html`<p class="mt-2 text-xs text-neutral-700">Payment check: ${pay.status === 'paid' ? 'paid session' : 'no payment found'} (${pay.source}${pay.sourceRef ? ` ${pay.sourceRef}` : ''})${pay.paidTo ? html`, paid to <span class="font-plate">${stamp(pay.paidTo)}</span>` : nothing}.</p>` : nothing}
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            ${row('Time from (locked)', html`<span class="font-plate" data-testid="wiz-time-from">${stamp(timeFrom())}</span>`)}
          </dl>
          <label class="mt-2 block"><span class="field-label">Time to</span><input type="datetime-local" step="1" class="field font-plate" data-testid="wiz-time-to" .value=${toInput(v.timeTo)} @input=${(e: Event) => set({ timeTo: fromInput((e.target as HTMLInputElement).value) })} /></label>
          <p class="mt-1 text-sm text-neutral-700">Issuance time — captured at issue.</p>`;
      const p = problems();
      return html`<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="wiz-review">
          ${row('Infringement number', html`<span class="font-plate font-bold" data-testid="wiz-number">${formatInfringementNumber(args.number)}</span>`)}
          ${args.reissueOf ? row('Reissue of', html`<span class="font-plate">${formatInfringementNumber(args.reissueOf)}</span>`) : nothing}
          ${row('Location', `${loc.street}, ${loc.fromStreet} – ${loc.toStreet} (${loc.side})`)}
          ${row('Vehicle', `${veh.registration} · ${v.vehicle.registrationState} · ${v.vehicle.make} ${v.vehicle.type} · ${v.vehicle.colour}`)}
          ${row('Offence', html`<span class="font-plate">${chip(v.offenceCode)}</span>`)}
          ${row('Time from', html`<span class="font-plate">${stamp(timeFrom())}</span> (locked)`)}
          ${row('Time to', html`<span class="font-plate">${Number.isFinite(v.timeTo) ? stamp(v.timeTo) : '—'}</span>`)}
          ${row('Issuance time', 'captured at issue')}
          ${row('Evidence', `${evidenceCount(h)} image(s)${overrideOn && v.evidenceOverride ? ` · override: ${v.evidenceOverride}` : ''}`)}
          ${row('Notes', v.notes || '—')}
        </dl>
        ${p.length ? html`<div class="mt-3">${banner('alert', 'Cannot issue yet', html`<ul class="list-disc pl-4">${p.map((x) => html`<li>${x}</li>`)}</ul>`, 'wiz-problems')}</div>` : nothing}
        <label class="mt-3 flex min-h-11 items-center gap-2 font-semibold"><input type="checkbox" class="h-5 w-5" data-testid="wiz-confirm" .checked=${confirmed} @change=${(e: Event) => { confirmed = (e.target as HTMLInputElement).checked; draw(); }} /> I confirm these details are correct</label>`;
    };

    const draw = () => {
      const last = step === STEPS.length - 1;
      const canIssue = confirmed && problems().length === 0;
      render(
        html`<div class="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="wiz-title" data-testid="infringement-wizard">
          <section class="flex max-h-[94vh] w-full max-w-lg flex-col rounded-t-xl border border-neutral-200 bg-surface shadow-xl sm:rounded-xl">
            <header class="border-b border-neutral-200 p-4">
              <p class="text-xs font-semibold tracking-[0.04em] text-neutral-600 uppercase">Issue infringement · step ${step + 1} of ${STEPS.length}</p>
              <h2 id="wiz-title" class="mt-1 text-lg font-bold text-neutral-900">${STEPS[step]}</h2>
              <p class="mt-1 font-plate text-sm text-neutral-700">I-N ${formatInfringementNumber(args.number)}</p>
            </header>
            <div class="min-h-0 flex-1 overflow-auto p-4 text-sm text-neutral-800">${body()}</div>
            <footer class="grid grid-cols-[auto_1fr_1fr] gap-2 border-t border-neutral-200 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
              <button type="button" class="btn-ghost" data-testid="wiz-cancel" @click=${() => { if (window.confirm(`Cancel this infringement? Number ${formatInfringementNumber(args.number)} is consumed and cannot be used again.`)) finish({ action: 'cancel' }); }}>Cancel</button>
              <button type="button" class="btn-secondary" data-testid="wiz-back" ?disabled=${step === 0} @click=${() => { step -= 1; draw(); }}>Back</button>
              ${last
                ? html`<button type="button" class="btn-primary" data-testid="wiz-issue" ?disabled=${!canIssue} @click=${() => finish({ action: 'issue', values: { ...v, evidenceOverride: overrideOn ? v.evidenceOverride : undefined } })}>Issue</button>`
                : html`<button type="button" class="btn-primary" data-testid="wiz-next" @click=${() => { step += 1; draw(); }}>Next</button>`}
            </footer>
          </section>
        </div>`,
        host,
      );
    };
    draw();
  });
}
