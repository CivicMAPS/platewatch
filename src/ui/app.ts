import { html, nothing, render, type TemplateResult } from 'lit-html';
import { getSettings, saveSettings } from '../lib/db';
import { configureDiagnostics } from '../lib/diagnostics';
import type { Settings } from '../lib/types';
import { DEFAULT_SETTINGS } from '../lib/types';

export interface View {
  render(): TemplateResult;
  mount?(): void | Promise<void>;
  unmount?(): void | Promise<void>;
}

export type ViewFactory = (params: Record<string, string>, app: App) => View;

interface Route {
  pattern: RegExp;
  keys: string[];
  factory: ViewFactory;
}

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

const TOAST_CLASS: Record<ToastTone, string> = {
  info: 'border-sky-500/60 bg-sky-950 text-sky-100',
  success: 'border-emerald-500/60 bg-emerald-950 text-emerald-100',
  warn: 'border-amber-500/60 bg-amber-950 text-amber-100',
  error: 'border-red-500/60 bg-red-950 text-red-100',
};

export class App {
  private routes: Route[] = [];
  private view: View | null = null;
  private toasts: Toast[] = [];
  private toastSeq = 0;
  private confirmReq: ConfirmRequest | null = null;
  private navToken = 0;
  settings: Settings = DEFAULT_SETTINGS;

  constructor(private root: HTMLElement) {}

  route(path: string, factory: ViewFactory): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/\//g, '\\/').replace(/:([a-zA-Z]+)/g, (_, k: string) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ pattern, keys, factory });
    return this;
  }

  async start(): Promise<void> {
    this.settings = await getSettings();
    configureDiagnostics(this.settings.diagnostics);
    window.addEventListener('hashchange', () => void this.resolve());
    await this.resolve();
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    configureDiagnostics(this.settings.diagnostics);
    await saveSettings(this.settings);
    this.update();
  }

  navigate(path: string, replace = false): void {
    const target = `#${path}`;
    if (location.hash === target) {
      void this.resolve();
      return;
    }
    if (replace) history.replaceState(null, '', target);
    else location.hash = target;
    if (replace) void this.resolve();
  }

  back(fallback = '/'): void {
    if (history.length > 1) history.back();
    else this.navigate(fallback, true);
  }

  private async resolve(): Promise<void> {
    const token = ++this.navToken;
    const path = decodeURIComponent(location.hash.replace(/^#/, '').split('?')[0] ?? '') || '/';
    let factory: ViewFactory | null = null;
    let params: Record<string, string> = {};
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (m) {
        factory = r.factory;
        params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1] ?? '']));
        break;
      }
    }
    if (!factory) {
      this.navigate('/', true);
      return;
    }
    const prev = this.view;
    this.view = null;
    this.confirmReq?.resolve(false);
    this.confirmReq = null;
    await prev?.unmount?.();
    if (token !== this.navToken) return;
    const next = factory(params, this);
    this.view = next;
    this.update();
    window.scrollTo(0, 0);
    try {
      await next.mount?.();
    } catch (e) {
      console.error(e);
      this.toast((e as Error).message || 'Something went wrong.', 'error');
    }
    if (token === this.navToken) this.update();
  }

  update(): void {
    render(
      html`
        ${this.view?.render() ?? nothing}
        <div class="pointer-events-none fixed inset-x-0 bottom-[calc(6.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 p-3" aria-live="polite">
          ${this.toasts.map(
            (t) => html`<div class="w-full max-w-md rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${TOAST_CLASS[t.tone]}">
              ${t.message}
            </div>`,
          )}
        </div>
        ${this.confirmReq ? this.renderConfirm(this.confirmReq) : nothing}
      `,
      this.root,
    );
  }

  toast(message: string, tone: ToastTone = 'info', ms = 3500): void {
    const t = { id: ++this.toastSeq, message, tone };
    this.toasts = [...this.toasts.slice(-2), t];
    this.update();
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id);
      this.update();
    }, ms);
  }

  confirm(opts: { title: string; body: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
    this.confirmReq?.resolve(false);
    return new Promise((resolve) => {
      this.confirmReq = {
        title: opts.title,
        body: opts.body,
        confirmLabel: opts.confirmLabel ?? 'Confirm',
        cancelLabel: opts.cancelLabel ?? 'Cancel',
        danger: opts.danger ?? false,
        resolve: (ok) => {
          this.confirmReq = null;
          this.update();
          resolve(ok);
        },
      };
      this.update();
    });
  }

  private renderConfirm(c: ConfirmRequest): TemplateResult {
    return html`<div class="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="card w-full max-w-md shadow-2xl">
        <h2 id="confirm-title" class="text-lg font-bold">${c.title}</h2>
        <p class="mt-2 whitespace-pre-line text-slate-300">${c.body}</p>
        <div class="mt-5 grid grid-cols-2 gap-3">
          <button type="button" class="btn-secondary" @click=${() => c.resolve(false)}>${c.cancelLabel}</button>
          <button type="button" class=${c.danger ? 'btn-danger' : 'btn-primary'} @click=${() => c.resolve(true)}>${c.confirmLabel}</button>
        </div>
      </div>
    </div>`;
  }
}
