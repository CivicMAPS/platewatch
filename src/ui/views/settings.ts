import { html, nothing } from 'lit-html';
import { createRef, ref } from 'lit-html/directives/ref.js';
import { createBackup, restoreBackup } from '../../lib/backup';
import { countDismissed, purgeScansOlderThan } from '../../lib/db';
import { clearDiagnostics, countDiagnostics, diagnosticsExport } from '../../lib/diagnostics';
import { saveFile } from '../../lib/files';
import { formatLatLng, geo, type GeoState } from '../../lib/geo';
import { warmUpOcr } from '../../lib/ocr';
import { deviceTimeZone, toLocalIso } from '../../lib/time';
import type { App, View } from '../app';
import { header, icon, page, spinner } from '../components';


type PermState = PermissionState | 'unknown';

async function permission(name: 'camera' | 'geolocation'): Promise<PermState> {
  try {
    const r = await navigator.permissions.query({ name: name as PermissionName });
    return r.state;
  } catch {
    return 'unknown';
  }
}

export function settingsView(_p: Record<string, string>, app: App): View {
  const importRef = createRef<HTMLInputElement>();
  let cameraPerm: PermState = 'unknown';
  let geoPerm: PermState = 'unknown';
  let storage: { usage: number; quota: number; persisted: boolean } | null = null;
  let ocrState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  let geoState: GeoState = { status: 'idle' };
  let geoTesting = false;
  let busy = false;
  let unsubGeo: (() => void) | null = null;
  let diagCount = 0;
  let dismissedCount = 0;
  /** Add the Dismissed list to the next export (off by default; it carries evidence images). */
  let includeDismissed = false;

  const refresh = async () => {
    [cameraPerm, geoPerm] = await Promise.all([permission('camera'), permission('geolocation')]);
    diagCount = await countDiagnostics().catch(() => 0);
    dismissedCount = await countDismissed().catch(() => 0);
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      storage = { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted: (await navigator.storage.persisted?.()) ?? false };
    }
    app.update();
  };

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const permChip = (s: PermState) => {
    const cls = s === 'granted' ? 'text-emerald-300' : s === 'denied' ? 'text-red-300' : 'text-slate-400';
    return html`<span class=${cls}>${s === 'prompt' ? 'not yet asked' : s}</span>`;
  };

  const exportBackup = async (includeScans: boolean) => {
    busy = true;
    app.update();
    try {
      const withDismissed = includeDismissed && dismissedCount > 0;
      const blob = await createBackup(includeScans, __APP_VERSION__, { includeDismissed: withDismissed });
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_platewatch-${includeScans ? 'full' : 'lists'}${withDismissed ? '+dismissed' : ''}.json`;
      await saveFile(blob, name, 'PlateWatch backup');
    } catch (e) {
      app.toast(`Export failed: ${(e as Error).message}`, 'error');
    } finally {
      busy = false;
      app.update();
    }
  };

  const exportDiagnostics = async () => {
    busy = true;
    app.update();
    try {
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_platewatch-diagnostics.json`;
      await saveFile(await diagnosticsExport(__APP_VERSION__), name, 'PlateWatch diagnostics');
    } catch (e) {
      app.toast(`Export failed: ${(e as Error).message}`, 'error');
    } finally {
      busy = false;
      app.update();
    }
  };

  const clearDiag = async () => {
    const ok = await app.confirm({
      title: 'Clear diagnostics',
      body: `Delete ${diagCount} diagnostic event(s) from this device? Export them first if you need them.`,
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;
    await clearDiagnostics();
    await refresh();
  };

  const importBackup = async (file: File) => {
    const merge = await app.confirm({
      title: 'Import backup',
      body: 'Merge keeps existing lists and adds/updates from the file.\nReplace deletes everything on this device first.',
      confirmLabel: 'Merge',
      cancelLabel: 'Replace…',
    });
    if (!merge) {
      const sure = await app.confirm({
        title: 'Replace all data?',
        body: 'All lists, scan records and evidence on this device will be deleted and replaced by the backup.',
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!sure) return;
    }
    busy = true;
    app.update();
    try {
      const r = await restoreBackup(await file.text(), merge);
      app.toast(`Imported ${r.lists} list(s), ${r.scans} scan record(s)${r.dismissed ? ` and ${r.dismissed} dismissed capture(s)` : ''}.`, 'success');
    } catch (e) {
      app.toast(`Import failed: ${(e as Error).message}`, 'error');
    } finally {
      busy = false;
      await refresh();
    }
  };

  const purgeNow = async () => {
    const days = app.settings.retentionDays || 30;
    const ok = await app.confirm({
      title: `Delete scan records older than ${days} days?`,
      body: 'Evidence images and metadata older than this will be permanently deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const n = await purgeScansOlderThan(days);
    app.toast(`Deleted ${n} record(s).`, 'success');
    await refresh();
  };

  const testOcr = async () => {
    ocrState = 'loading';
    app.update();
    try {
      await warmUpOcr();
      ocrState = 'ready';
    } catch (e) {
      console.error(e);
      ocrState = 'error';
    }
    app.update();
  };

  const testGps = () => {
    geoTesting = !geoTesting;
    if (geoTesting) geo.start();
    else geo.stop();
    app.update();
    void refresh();
  };

  return {
    async mount() {
      unsubGeo = geo.subscribe((s) => {
        geoState = s;
        app.update();
      });
      await refresh();
    },
    unmount() {
      unsubGeo?.();
      if (geoTesting) geo.stop();
    },
    render() {
      const s = app.settings;
      return html`${header({ title: 'Settings', back: () => app.back() })}
        ${page(html`
          <input ${ref(importRef)} type="file" accept="application/json,.json" class="hidden"
            @change=${(e: Event) => {
              const input = e.target as HTMLInputElement;
              const f = input.files?.[0];
              input.value = '';
              if (f) void importBackup(f);
            }} />

          <section class="card">
            <h2 class="section-title">Device & permissions</h2>
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt class="text-slate-400">Camera</dt><dd>${permChip(cameraPerm)}</dd>
              <dt class="text-slate-400">Location</dt><dd>${permChip(geoPerm)}</dd>
              <dt class="text-slate-400">Device time</dt><dd class="font-plate">${toLocalIso(Date.now()).slice(0, 19).replace('T', ' ')}</dd>
              <dt class="text-slate-400">Time zone</dt><dd>${deviceTimeZone()}</dd>
              <dt class="text-slate-400">Secure context</dt><dd>${window.isSecureContext ? 'yes' : html`<span class="text-red-300">no — camera/GPS need HTTPS</span>`}</dd>
              ${storage
                ? html`<dt class="text-slate-400">Storage</dt><dd>${mb(storage.usage)} of ${mb(storage.quota)} · ${storage.persisted ? 'persistent' : html`<span class="text-amber-300">may be cleared by the browser</span>`}</dd>`
                : nothing}
            </dl>
            <div class="mt-3 grid grid-cols-2 gap-3">
              <button type="button" class="btn-secondary" @click=${testGps}>${icon('pin')} ${geoTesting ? 'Stop GPS test' : 'Test GPS'}</button>
              <button type="button" class="btn-secondary" @click=${testOcr} ?disabled=${ocrState === 'loading'}>
                ${ocrState === 'loading' ? spinner() : icon('text')} ${ocrState === 'ready' ? 'OCR ready' : ocrState === 'error' ? 'OCR failed — retry' : 'Load OCR'}
              </button>
            </div>
            ${geoTesting
              ? html`<p class="mt-2 text-sm text-slate-300">
                  ${geoState.status === 'fix' ? html`${formatLatLng(geoState.fix)} · ±${geoState.fix.accuracy.toFixed(1)} m` : geoState.status === 'searching' ? 'Searching for GPS fix…' : 'message' in geoState ? geoState.message : geoState.status}
                </p>`
              : nothing}
            ${storage && !storage.persisted
              ? html`<button type="button" class="btn-ghost mt-2 w-full text-sm" @click=${async () => { await navigator.storage.persist?.(); await refresh(); }}>Request persistent storage</button>`
              : nothing}
          </section>

          <section class="card mt-4 grid gap-4">
            <h2 class="section-title">Scanning</h2>
            <label class="flex items-center justify-between gap-3">
              <span><span class="block font-medium">Require GPS fix</span><span class="text-sm text-slate-400">Block checks without a location</span></span>
              <input type="checkbox" class="h-6 w-6 accent-brand-500" .checked=${s.requireLocation} @change=${(e: Event) => void app.updateSettings({ requireLocation: (e.target as HTMLInputElement).checked })} />
            </label>
            <label class="block">
              <span class="field-label">Warn when GPS accuracy is worse than (metres)</span>
              <input type="number" class="field" min="3" max="500" inputmode="numeric" .value=${String(s.accuracyWarnMetres)}
                @change=${(e: Event) => void app.updateSettings({ accuracyWarnMetres: Math.max(3, Math.min(500, Math.round(Number((e.target as HTMLInputElement).value) || 25))) })} />
            </label>
            <label class="flex items-center justify-between gap-3">
              <span class="font-medium">Vibration alerts</span>
              <input type="checkbox" class="h-6 w-6 accent-brand-500" .checked=${s.vibrate} @change=${(e: Event) => void app.updateSettings({ vibrate: (e.target as HTMLInputElement).checked })} />
            </label>
            <label class="flex items-center justify-between gap-3">
              <span class="font-medium">Sound alerts</span>
              <input type="checkbox" class="h-6 w-6 accent-brand-500" .checked=${s.sound} @change=${(e: Event) => void app.updateSettings({ sound: (e.target as HTMLInputElement).checked })} />
            </label>
          </section>

          <section class="card mt-4 grid gap-3" data-testid="diagnostics">
            <h2 class="section-title">Field diagnostics</h2>
            <label class="flex items-center justify-between gap-3">
              <span><span class="block font-medium">Record diagnostics</span><span class="text-sm text-slate-400">Camera, plate reading, GPS, battery and heat measurements for field tests. Shown as ● DIAG on the camera.</span></span>
              <input type="checkbox" class="h-6 w-6 accent-brand-500" .checked=${s.diagnostics} @change=${(e: Event) => void app.updateSettings({ diagnostics: (e.target as HTMLInputElement).checked })} />
            </label>
            <p class="text-sm text-slate-400">${diagCount} event(s) recorded on this device.</p>
            <button type="button" class="btn-secondary" ?disabled=${busy || !diagCount} @click=${() => void exportDiagnostics()}>${icon('share')} Export diagnostics</button>
            <button type="button" class="btn-ghost text-sm" ?disabled=${!diagCount} @click=${() => void clearDiag()}>${icon('trash')} Clear diagnostics</button>
            <p class="text-xs text-slate-500">Diagnostics include number plates, OCR text and locations. They stay on this device unless you export them.</p>
          </section>

          <section class="card mt-4 grid gap-3">
            <h2 class="section-title">Data retention</h2>
            <label class="block">
              <span class="field-label">Auto-delete scan records after (days, 0 = keep)</span>
              <input type="number" class="field" min="0" max="3650" inputmode="numeric" .value=${String(s.retentionDays)}
                @change=${(e: Event) => void app.updateSettings({ retentionDays: Math.max(0, Math.min(3650, Math.round(Number((e.target as HTMLInputElement).value) || 0))) })} />
            </label>
            <button type="button" class="btn-secondary" @click=${purgeNow}>${icon('trash')} Delete old records now</button>
          </section>

          <section class="card mt-4 grid gap-3">
            <h2 class="section-title">Backup</h2>
            <label class="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" class="h-5 w-5" data-testid="include-dismissed" .checked=${includeDismissed} ?disabled=${!dismissedCount}
                @change=${(e: Event) => { includeDismissed = (e.target as HTMLInputElement).checked; app.update(); }} />
              <span>Include dismissed captures <span class="text-slate-400">(${dismissedCount}${dismissedCount ? ', with evidence images' : ''})</span></span>
            </label>
            <button type="button" class="btn-secondary" ?disabled=${busy} @click=${() => void exportBackup(false)}>${icon('share')} Export lists</button>
            <button type="button" class="btn-secondary" ?disabled=${busy} @click=${() => void exportBackup(true)}>${icon('share')} Export lists + scan records</button>
            <button type="button" class="btn-secondary" ?disabled=${busy} @click=${() => importRef.value?.click()}>${icon('upload')} Import backup</button>
            <button type="button" class="btn-secondary" @click=${() => app.navigate('/import')}>${icon('upload')} Import lists from CSV / CivicMAPS files</button>
            <p class="text-xs text-slate-500">All data stays on this device unless you export it. Backups containing scan records include evidence images, locations and number plates — handle as personal information.</p>
          </section>

          <p class="mt-6 text-center text-xs text-slate-500">PlateWatch v${__APP_VERSION__}</p>
        `)}`;
    },
  };
}
