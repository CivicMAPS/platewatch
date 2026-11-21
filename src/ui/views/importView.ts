/**
 * Bulk import: pick CSV templates or CivicMAPS-preview JSON files, review what will be created,
 * updated and skipped, then save in one transaction. Templates can be downloaded from here.
 */
import { html, nothing, type TemplateResult } from 'lit-html';
import { createRef, ref } from 'lit-html/directives/ref.js';
import { getLists, putLists } from '../../lib/db';
import { saveFile } from '../../lib/files';
import { CSV_TEMPLATES, parseImportFile, planImport, templateCsv, type ImportPlan, type ImportResult } from '../../lib/importer';
import type { PlateList } from '../../lib/types';
import type { App, View } from '../app';
import { header, icon, page, spinner } from '../components';

const KIND_LABEL: Record<ImportResult['kind'], string> = {
  'timed-csv': 'Timed segments (CSV)',
  'allow-csv': 'Allow list (CSV)',
  'hot-csv': 'Hot list (CSV)',
  'civicmaps-kerbside': 'CivicMAPS kerbside segment',
  'civicmaps-road-segment': 'CivicMAPS road segment',
  'civicmaps-survey': 'CivicMAPS field survey',
  'civicmaps-parking-areas': 'CivicMAPS parking areas',
  'civicmaps-mixed': 'CivicMAPS (several kinds)',
  unknown: 'Not recognised',
};

const ISSUES_SHOWN = 50;

export function importView(_p: Record<string, string>, app: App): View {
  const fileRef = createRef<HTMLInputElement>();
  let results: ImportResult[] = [];
  let existing: PlateList[] = [];
  let updateExisting = true;
  let busy = false;
  let showAllIssues = false;

  const plan = (): ImportPlan => planImport(results.flatMap((r) => r.drafts), existing, { updateExisting });

  const read = async (files: FileList | null) => {
    if (!files?.length) return;
    busy = true;
    app.update();
    try {
      existing = await getLists();
      const read = await Promise.all([...files].map(async (f) => parseImportFile(await f.text(), f.name)));
      // Picking more files adds to the selection; the same file name replaces its earlier reading.
      const names = new Set(read.map((r) => r.file));
      results = [...results.filter((r) => !names.has(r.file)), ...read];
    } catch (e) {
      app.toast(`Could not read the file: ${(e as Error).message}`, 'error');
    } finally {
      busy = false;
      if (fileRef.value) fileRef.value.value = '';
      app.update();
    }
  };

  const save = async () => {
    const p = plan();
    const lists = [...p.created, ...p.updated];
    if (!lists.length) return;
    busy = true;
    app.update();
    try {
      await putLists(lists);
      app.toast(`Imported: ${p.created.length} list(s) created, ${p.updated.length} updated.`, 'success');
      app.navigate('/', true);
    } catch (e) {
      app.toast(`Import failed: ${(e as Error).message}`, 'error');
      busy = false;
      app.update();
    }
  };

  const download = (kind: keyof typeof CSV_TEMPLATES) =>
    void saveFile(new Blob([templateCsv(kind)], { type: 'text/csv' }), CSV_TEMPLATES[kind].fileName, 'PlateWatch import template').catch((e: Error) =>
      app.toast(`Could not save the template: ${e.message}`, 'error'),
    );

  const counts = (p: ImportPlan) => {
    const by = (type: PlateList['type'], ls: PlateList[]) => ls.filter((l) => l.type === type).length;
    const entries = [...p.created, ...p.updated].reduce((n, l) => n + (l.type === 'timed' ? 0 : l.entries.length), 0);
    return { timedNew: by('timed', p.created), timedUpd: by('timed', p.updated), otherNew: p.created.length - by('timed', p.created), otherUpd: p.updated.length - by('timed', p.updated), entries };
  };

  const summary = (): TemplateResult => {
    const p = plan();
    const c = counts(p);
    const issues = results.flatMap((r) => r.issues);
    const skipped = results.flatMap((r) => r.skipped.map((s) => `${r.file}: ${s}`));
    const shown = showAllIssues ? issues : issues.slice(0, ISSUES_SHOWN);
    return html`<section class="card mt-4" data-testid="import-summary">
        <h2 class="section-title">Files</h2>
        <ul class="divide-y divide-ink-700 text-sm">
          ${results.map(
            (r) => html`<li class="flex items-center justify-between gap-2 py-2">
              <span class="min-w-0"><span class="block truncate font-semibold">${r.file}</span><span class="text-xs ${r.kind === 'unknown' ? 'text-red-300' : 'text-slate-400'}">${KIND_LABEL[r.kind]}</span></span>
              <span class="flex-none text-xs text-slate-400">${r.drafts.length} list${r.drafts.length === 1 ? '' : 's'}${r.issues.length ? html` · <span class="text-amber-300">${r.issues.length} issue${r.issues.length === 1 ? '' : 's'}</span>` : nothing}</span>
            </li>`,
          )}
        </ul>
      </section>
      <section class="card mt-4" data-testid="import-plan">
        <h2 class="section-title">What will happen</h2>
        <ul class="grid gap-1 text-sm">
          <li><strong>${c.timedNew}</strong> timed list${c.timedNew === 1 ? '' : 's'} created${p.placeholders ? html` (<span class="text-amber-300">${p.placeholders} without restrictions yet</span>)` : nothing}</li>
          <li><strong>${c.timedUpd}</strong> timed list${c.timedUpd === 1 ? '' : 's'} updated</li>
          ${c.otherNew || c.otherUpd ? html`<li><strong>${c.otherNew}</strong> allow/hot list(s) created, <strong>${c.otherUpd}</strong> updated · ${c.entries} plate${c.entries === 1 ? '' : 's'}</li>` : nothing}
          ${p.unchanged ? html`<li class="text-slate-400">${p.unchanged} matching list(s) left as they are</li>` : nothing}
        </ul>
        <label class="mt-3 flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" class="h-5 w-5" .checked=${updateExisting} @change=${(e: Event) => { updateExisting = (e.target as HTMLInputElement).checked; app.update(); }} />
          <span>Update lists already on this device that match (same segment and side, or same list name)</span>
        </label>
        <p class="mt-1 text-xs text-slate-400">A matching list keeps its name, linked allow lists and scan history; restrictions already entered are kept when the import has none.</p>
        <div class="mt-4 grid grid-cols-2 gap-3">
          <button type="button" class="btn-secondary" ?disabled=${busy} @click=${() => { results = []; app.update(); }}>Clear</button>
          <button type="button" class="btn-primary" data-testid="import-save" ?disabled=${busy || !(p.created.length + p.updated.length)} @click=${() => void save()}>
            ${busy ? spinner() : icon('check')} Import
          </button>
        </div>
      </section>
      ${issues.length
        ? html`<section class="card mt-4">
            <h2 class="section-title text-amber-300">Not imported (${issues.length})</h2>
            <ul class="grid gap-1 text-sm" data-testid="import-issues">
              ${shown.map((i) => html`<li><span class="text-slate-400">${i.file}${i.row ? ` row ${i.row}` : ''}:</span> ${i.message}</li>`)}
            </ul>
            ${issues.length > shown.length ? html`<button type="button" class="btn-ghost mt-2" @click=${() => { showAllIssues = true; app.update(); }}>Show all ${issues.length}</button>` : nothing}
          </section>`
        : nothing}
      ${skipped.length
        ? html`<details class="card mt-4">
            <summary class="cursor-pointer text-sm font-semibold">Left out: nothing to time (${skipped.length})</summary>
            <ul class="mt-2 grid gap-1 text-xs text-slate-400">${skipped.map((s) => html`<li>${s}</li>`)}</ul>
          </details>`
        : nothing}`;
  };

  return {
    render() {
      return html`${header({ title: 'Import lists', subtitle: 'CSV templates or CivicMAPS data files', back: () => app.back() })}
        ${page(html`
          <section class="card">
            <h2 class="section-title">Choose files</h2>
            <p class="text-sm text-slate-300">Select one or more CSV files made from the templates below, or CivicMAPS-preview JSON files (kerbside segments, road segments, field surveys, parking areas). Nothing is saved until you press Import.</p>
            <input ${ref(fileRef)} type="file" accept=".csv,.json,text/csv,application/json" multiple class="hidden" data-testid="import-file"
              @change=${(e: Event) => void read((e.target as HTMLInputElement).files)} />
            <button type="button" class="btn-primary mt-3 w-full" ?disabled=${busy} @click=${() => fileRef.value?.click()}>
              ${busy ? spinner() : icon('upload')} ${results.length ? 'Add more files' : 'Choose files'}
            </button>
          </section>
          ${results.length ? summary() : nothing}
          <section class="card mt-4">
            <h2 class="section-title">Templates</h2>
            <p class="text-sm text-slate-300">Fill in with Excel or any spreadsheet and save as CSV. One row per sign; rows for the same street, cross streets and side become one timed list.</p>
            <div class="mt-3 grid gap-2">
              <button type="button" class="btn-secondary" @click=${() => download('timed')}>${icon('share')} Timed segments template</button>
              <button type="button" class="btn-secondary" @click=${() => download('allow')}>${icon('share')} Allow list template</button>
              <button type="button" class="btn-secondary" @click=${() => download('hot')}>${icon('share')} Hot list template</button>
            </div>
          </section>
        `)}`;
    },
  };
}
