import { html, nothing, svg, type TemplateResult } from 'lit-html';
import type { ListType, RiskLevel } from '../lib/types';

/* ───────────────────────────── Icons ───────────────────────────── */

const ICON_PATHS = {
  back: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  camera:
    'M3 8a2 2 0 012-2h2l1.5-2h7L17 6h2a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V8zM12 17a4 4 0 100-8 4 4 0 000 8z',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  alert: 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6',
  edit: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  pin: 'M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0zM12 13a3 3 0 100-6 3 3 0 000 6z',
  torch: 'M9 2h6l-1 7h3l-6 13 1-9H9z',
  text: 'M4 7V4h16v3M9 20h6M12 4v16',
  upload: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  share: 'M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: IconName, cls = 'h-5 w-5'): TemplateResult {
  return html`<svg class=${cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg`<path d=${ICON_PATHS[name]}></path>`}</svg>`;
}

/* ─────────────────────────── Layout ─────────────────────────── */

export function header(opts: {
  title: string;
  subtitle?: string;
  back?: () => void;
  actions?: TemplateResult | typeof nothing;
}): TemplateResult {
  return html`<header class="sticky top-0 z-30 border-b border-ink-700 bg-ink-950/95 pt-[env(safe-area-inset-top)] backdrop-blur">
    <div class="mx-auto flex max-w-3xl items-center gap-2 px-3 py-3">
      ${opts.back
        ? html`<button type="button" class="btn-ghost -ml-1 min-h-11 px-2" aria-label="Back" @click=${opts.back}>${icon('back', 'h-6 w-6')}</button>`
        : nothing}
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-lg font-bold leading-tight">${opts.title}</h1>
        ${opts.subtitle ? html`<p class="truncate text-sm text-slate-400">${opts.subtitle}</p>` : nothing}
      </div>
      ${opts.actions ?? nothing}
    </div>
  </header>`;
}

export function page(content: TemplateResult): TemplateResult {
  return html`<main class="mx-auto max-w-3xl px-4 pt-4 pb-28">${content}</main>`;
}

export function plateBadge(plate: string, size: 'sm' | 'md' | 'lg' | 'xl' = 'md'): TemplateResult {
  const sizes = { sm: 'text-sm', md: 'text-lg', lg: 'text-2xl', xl: 'text-4xl px-4 py-1' } as const;
  return html`<span class="plate ${sizes[size]}">${plate || '—'}</span>`;
}

export const LIST_TYPE_META: Record<ListType, { label: string; short: string; description: string; chip: string }> = {
  timed: {
    label: 'Timed list',
    short: 'Timed',
    description: 'Time-limited street segment. Re-scans show elapsed time and flag overstays.',
    chip: 'border-sky-500/50 bg-sky-500/10 text-sky-200',
  },
  hot: {
    label: 'Hot list',
    short: 'Hot',
    description: 'High-risk drivers. A scan match raises an officer-safety alert.',
    chip: 'border-red-500/50 bg-red-500/10 text-red-200',
  },
  allow: {
    label: 'Allow list',
    short: 'Allow',
    description: 'Plates that are ignored (e.g. residential permits). Link to timed lists.',
    chip: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200',
  },
};

export function typeChip(type: ListType): TemplateResult {
  return html`<span class="chip ${LIST_TYPE_META[type].chip}">${LIST_TYPE_META[type].short}</span>`;
}

export const RISK_LEVEL_CLASS: Record<RiskLevel, string> = {
  caution: 'border-amber-400/60 bg-amber-500/15 text-amber-200',
  high: 'border-orange-400/60 bg-orange-500/15 text-orange-200',
  extreme: 'border-red-400/70 bg-red-500/20 text-red-100',
};

export function emptyState(title: string, body: string, action?: TemplateResult): TemplateResult {
  return html`<div class="card flex flex-col items-center gap-3 py-10 text-center">
    <div class="rounded-full bg-ink-800 p-4 text-brand-400">${icon('list', 'h-8 w-8')}</div>
    <h2 class="text-lg font-bold">${title}</h2>
    <p class="max-w-sm text-slate-400">${body}</p>
    ${action ?? nothing}
  </div>`;
}

export function spinner(cls = 'h-5 w-5'): TemplateResult {
  return html`<svg class="${cls} animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" class="opacity-25"></circle>
    <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" stroke-width="3" stroke-linecap="round"></path>
  </svg>`;
}

/* ─────────────────────── Object URL lifecycle ─────────────────────── */

/** Tracks object URLs created for a view so they are revoked on unmount. */
export class UrlBag {
  private map = new Map<Blob, string>();
  get(blob: Blob | null | undefined): string {
    if (!blob) return '';
    let url = this.map.get(blob);
    if (!url) {
      url = URL.createObjectURL(blob);
      this.map.set(blob, url);
    }
    return url;
  }
  revokeAll(): void {
    for (const url of this.map.values()) URL.revokeObjectURL(url);
    this.map.clear();
  }
}

/** Read a form field value by name. */
export function formValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
    return el.value;
  return '';
}
