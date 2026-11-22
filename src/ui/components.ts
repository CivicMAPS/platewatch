import { html, nothing, svg, type TemplateResult } from 'lit-html';
import {
  Activity,
  Archive,
  ArrowLeft,
  Camera,
  Car,
  Check,
  ChevronRight,
  CircleCheck,
  CircleQuestionMark,
  Clock,
  Download,
  Flashlight,
  Footprints,
  Info,
  Keyboard,
  List,
  Lock,
  MapPin,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Share2,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Type,
  Upload,
  X,
  type IconNode,
} from 'lucide';
import type { ListType, RiskLevel } from '../lib/types';

/* ───────────────────────────── Icons ─────────────────────────────
 * Lucide, the CivicMAPS icon set (design system §6): the same glyphs EnforcementMAPS gets from
 * lucide-react-native. Only the icons named here are bundled. */

const ICONS = {
  back: ArrowLeft,
  plus: Plus,
  search: Search,
  camera: Camera,
  settings: Settings,
  clock: Clock,
  shield: ShieldAlert,
  alert: TriangleAlert,
  info: Info,
  check: Check,
  checkCircle: CircleCheck,
  question: CircleQuestionMark,
  dash: Minus,
  x: X,
  trash: Trash2,
  edit: Pencil,
  pin: MapPin,
  torch: Flashlight,
  text: Type,
  upload: Upload,
  keyboard: Keyboard,
  share: Share2,
  refresh: RefreshCw,
  list: List,
  lock: Lock,
  chevron: ChevronRight,
  archive: Archive,
  activity: Activity,
  walking: Footprints,
  vehicle: Car,
  download: Download,
} as const satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

const iconChild = ([tag, a]: IconNode[number]) => {
  const v = (k: string) => (a as Record<string, string | number | undefined>)[k] ?? nothing;
  switch (tag) {
    case 'path':
      return svg`<path d=${v('d')}></path>`;
    case 'circle':
      return svg`<circle cx=${v('cx')} cy=${v('cy')} r=${v('r')}></circle>`;
    case 'rect':
      return svg`<rect x=${v('x')} y=${v('y')} width=${v('width')} height=${v('height')} rx=${v('rx')} ry=${v('ry')}></rect>`;
    case 'line':
      return svg`<line x1=${v('x1')} y1=${v('y1')} x2=${v('x2')} y2=${v('y2')}></line>`;
    case 'polyline':
      return svg`<polyline points=${v('points')}></polyline>`;
    case 'polygon':
      return svg`<polygon points=${v('points')}></polygon>`;
    case 'ellipse':
      return svg`<ellipse cx=${v('cx')} cy=${v('cy')} rx=${v('rx')} ry=${v('ry')}></ellipse>`;
    default:
      return nothing;
  }
};

/** Lucide icon: 24×24 grid, currentColor, round caps/joins. Stroke 2 inline, 1.75 at 24 px+. */
export function icon(name: IconName, cls = 'h-5 w-5', strokeWidth = 2): TemplateResult {
  return html`<svg class="flex-none ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${strokeWidth} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name].map(iconChild)}</svg>`;
}

/* ─────────────────────────── Status ───────────────────────────
 * Every operational status is colour + icon + text (design system §5, assessment D5), using the
 * proposed PlateWatch → CivicMAPS mapping (assessment §3, WF-S27). Red is never used: it is
 * reserved for Code 1. */

export type StatusTone = 'pending' | 'active' | 'alert' | 'inactive' | 'issued';

export type StatusKind =
  | 'timing'
  | 'within_allowance'
  | 'overstay'
  | 'overdue'
  | 'permit_valid'
  | 'not_in_force'
  | 'in_force'
  | 'verify'
  | 'officer_safety'
  | 'hot_sighting'
  | 'reviewed'
  | 'dismissed'
  | 'on_list'
  | 'not_on_list'
  | 'not_valid'
  | 'restrictions_to_enter';

export const STATUS: Record<StatusKind, { tone: StatusTone; icon: IconName; label: string }> = {
  timing: { tone: 'pending', icon: 'clock', label: 'Timing' },
  within_allowance: { tone: 'pending', icon: 'clock', label: 'Within allowance' },
  overstay: { tone: 'alert', icon: 'alert', label: 'Overstay' },
  overdue: { tone: 'alert', icon: 'alert', label: 'Overdue' },
  permit_valid: { tone: 'active', icon: 'check', label: 'Permit valid' },
  in_force: { tone: 'active', icon: 'clock', label: 'In force' },
  not_in_force: { tone: 'inactive', icon: 'dash', label: 'Not in force' },
  verify: { tone: 'alert', icon: 'question', label: 'Verify' },
  // OQ27-1: drawn as an interaction-required (amber) interrupt until the owner decides whether a
  // hot-list match is a Code-1-equivalent event.
  officer_safety: { tone: 'alert', icon: 'shield', label: 'Officer safety' },
  hot_sighting: { tone: 'alert', icon: 'shield', label: 'Hot-list sighting' },
  reviewed: { tone: 'inactive', icon: 'check', label: 'Reviewed' },
  dismissed: { tone: 'inactive', icon: 'archive', label: 'Dismissed' },
  on_list: { tone: 'active', icon: 'check', label: 'On allow list' },
  not_on_list: { tone: 'inactive', icon: 'dash', label: 'Not on list' },
  not_valid: { tone: 'alert', icon: 'alert', label: 'Not currently valid' },
  // WF-S26 26a.8: a segment imported without its restrictions. Amber — someone must act.
  restrictions_to_enter: { tone: 'alert', icon: 'alert', label: 'Restrictions to enter' },
};

/** Pill colours per tone: tinted background, matching border, strong foreground. */
export const TONE_PILL: Record<StatusTone, string> = {
  pending: 'border-pending-border bg-pending-bg text-pending-strong',
  active: 'border-active-border bg-active-bg text-active-strong',
  alert: 'border-alert bg-alert-bg text-alert-strong',
  inactive: 'border-inactive-border bg-inactive-bg text-neutral-700',
  issued: 'border-issued-border bg-issued-bg text-issued-strong',
};

/** Panel colours per tone (result cards, banners). */
export const TONE_PANEL: Record<StatusTone, string> = {
  pending: 'border-pending bg-pending-bg',
  active: 'border-active bg-active-bg',
  alert: 'border-alert bg-alert-bg',
  inactive: 'border-neutral-300 bg-surface',
  issued: 'border-issued bg-issued-bg',
};

export const TONE_TEXT: Record<StatusTone, string> = {
  pending: 'text-pending-strong',
  active: 'text-active-strong',
  alert: 'text-alert-strong',
  inactive: 'text-neutral-600',
  issued: 'text-issued-strong',
};

/** Compact status badge: uppercase (badges are the only caps in the system), icon + text. */
export function statusPill(kind: StatusKind, label?: string, extraCls = ''): TemplateResult {
  const s = STATUS[kind];
  return html`<span class="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-[0.04em] whitespace-nowrap uppercase ${TONE_PILL[s.tone]} ${extraCls}" data-status=${kind}>${icon(s.icon, 'h-3.5 w-3.5', 2.5)}${label ?? s.label}</span>`;
}

/**
 * Persistent inline banner for anything the officer must act on (assessment D6: blocking errors
 * are never transient toasts). `alert` = must act; `pending` = information; `active` = done.
 */
export function banner(tone: StatusTone, title: string, body?: TemplateResult | string, testid?: string): TemplateResult {
  const ic: IconName = tone === 'alert' ? 'alert' : tone === 'active' ? 'checkCircle' : 'info';
  return html`<div class="flex gap-3 rounded-md border-2 p-3 ${TONE_PANEL[tone]}" role=${tone === 'alert' ? 'alert' : 'status'} data-testid=${testid ?? nothing}>
    <span class=${TONE_TEXT[tone]}>${icon(ic, 'h-5 w-5 mt-0.5')}</span>
    <div class="min-w-0 flex-1">
      <p class="font-semibold text-neutral-900">${title}</p>
      ${body ? html`<div class="mt-0.5 text-sm text-neutral-700">${body}</div>` : nothing}
    </div>
  </div>`;
}

/**
 * Near match (assessment D11/D12): bottom sheet showing the capture beside the look-alike plates.
 * "Not a match — check as read" replaces the old ambiguous "Dismiss" (which also names the patrol
 * Dismissed list). `suggestions` are "PLATE · source list" strings.
 */
export function nearMatchSheet(opts: {
  imageUrl: string;
  plate: string;
  suggestions: string[];
  onEdit: () => void;
  onNotMatch: () => void;
}): TemplateResult {
  const n = opts.suggestions.length;
  return html`<div class="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="near-match-title" data-testid="near-match">
    <section class="max-h-[90vh] w-full max-w-md overflow-auto rounded-t-xl border border-neutral-200 bg-surface p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-xl sm:rounded-xl sm:pb-4">
      <div class="flex flex-wrap items-center gap-2">
        ${statusPill('verify', 'Near match')}
        <h2 id="near-match-title" class="text-lg font-bold">Check the plate</h2>
      </div>
      <p class="mt-2 text-sm">The plate looks like ${n === 1 ? 'a plate' : 'plates'} on a list. Compare before checking: OCR look-alikes (O/0, I/1, B/8, S/5) are never treated as a match automatically.</p>
      <div class="mt-3 grid grid-cols-2 gap-3">
        <figure class="min-w-0">
          <figcaption class="mb-1 text-xs font-semibold text-neutral-600">Current scan</figcaption>
          ${opts.imageUrl ? html`<img class="aspect-[3/1] w-full rounded-md border border-neutral-200 bg-black object-contain" src=${opts.imageUrl} alt="Current capture" />` : nothing}
          <div class="mt-2">${plateBadge(opts.plate, 'md')}</div>
        </figure>
        <div class="min-w-0">
          <p class="mb-1 text-xs font-semibold text-neutral-600">Similar plate${n === 1 ? '' : 's'}</p>
          <ul class="grid gap-2">
            ${opts.suggestions.map((s) => {
              const [plate, ...source] = s.split(' · ');
              return html`<li>${plateBadge(plate ?? '', 'md')}<p class="mt-0.5 truncate text-xs text-neutral-700">${source.join(' · ')}</p></li>`;
            })}
          </ul>
        </div>
      </div>
      <div class="mt-4 grid gap-3">
        <button type="button" class="btn-primary" data-testid="near-match-edit" @click=${opts.onEdit}>${icon('edit')} Edit plate</button>
        <button type="button" class="btn-secondary" data-testid="near-match-not-match" @click=${opts.onNotMatch}>Not a match — check as read</button>
      </div>
    </section>
  </div>`;
}

/**
 * Bottom sheet for a decision the officer must make before the scan is recorded (permit details,
 * known-vehicle check, dismissing an overstay alert). Same frame as the near-match sheet.
 */
export function decisionSheet(opts: {
  testid: string;
  pill: TemplateResult;
  title: string;
  body: TemplateResult;
  actions: TemplateResult;
  onClose?: () => void;
}): TemplateResult {
  return html`<div class="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="${opts.testid}-title" data-testid=${opts.testid}>
    <section class="max-h-[90vh] w-full max-w-md overflow-auto rounded-t-xl border border-neutral-200 bg-surface p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-xl sm:rounded-xl sm:pb-4">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">${opts.pill}</div>
          <h2 id="${opts.testid}-title" class="mt-2 text-lg font-bold text-neutral-900">${opts.title}</h2>
        </div>
        ${opts.onClose ? html`<button type="button" class="btn-ghost min-h-11 px-2" aria-label="Close" @click=${opts.onClose}>${icon('x')}</button>` : nothing}
      </div>
      <div class="mt-2 text-sm text-neutral-800">${opts.body}</div>
      <div class="mt-4 grid gap-3">${opts.actions}</div>
    </section>
  </div>`;
}

/* ─────────────────────────── Layout ─────────────────────────── */

/** App header: Civic Navy chrome (design system §5). Flat — no blur on operational screens. */
export function header(opts: {
  title: string;
  subtitle?: string;
  back?: () => void;
  actions?: TemplateResult | typeof nothing;
}): TemplateResult {
  return html`<header class="sticky top-0 z-30 bg-primary pt-[env(safe-area-inset-top)] text-white shadow-md">
    <div class="mx-auto flex max-w-3xl items-center gap-1 px-2 py-2">
      ${opts.back
        ? html`<button type="button" class="btn-chrome px-2" aria-label="Back" @click=${opts.back}>${icon('back', 'h-6 w-6')}</button>`
        : html`<span class="w-2"></span>`}
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-md font-bold leading-tight text-white">${opts.title}</h1>
        ${opts.subtitle ? html`<p class="truncate text-sm text-white/80">${opts.subtitle}</p>` : nothing}
      </div>
      ${opts.actions ?? nothing}
    </div>
  </header>`;
}

export function page(content: TemplateResult): TemplateResult {
  return html`<main class="mx-auto max-w-3xl px-4 pt-4 pb-28">${content}</main>`;
}

export function plateBadge(plate: string, size: 'sm' | 'md' | 'lg' | 'xl' = 'md'): TemplateResult {
  const sizes = { sm: 'text-sm', md: 'text-md', lg: 'text-xl', xl: 'text-4xl px-4 py-1' } as const;
  return html`<span class="plate ${sizes[size]}">${plate || '—'}</span>`;
}

export const LIST_TYPE_META: Record<ListType, { label: string; short: string; description: string; icon: IconName; chip: string }> = {
  timed: {
    label: 'Timed list',
    short: 'Timed',
    description: 'Time-limited street segment. Re-scans show elapsed time and flag overstays.',
    icon: 'clock',
    chip: 'border-pending-border bg-pending-bg text-pending-strong',
  },
  hot: {
    label: 'Hot list',
    short: 'Hot',
    description: 'High-risk drivers. A scan match raises an officer-safety alert.',
    icon: 'shield',
    chip: 'border-alert bg-alert-bg text-alert-strong',
  },
  allow: {
    label: 'Allow list',
    short: 'Allow',
    description: 'Plates that are ignored (e.g. residential permits). Link to timed lists.',
    icon: 'check',
    chip: 'border-active-border bg-active-bg text-active-strong',
  },
};

/** List type tag: icon + text (never colour alone). */
export function typeChip(type: ListType): TemplateResult {
  const m = LIST_TYPE_META[type];
  return html`<span class="chip ${m.chip}">${icon(m.icon, 'h-4 w-4')}${m.short}</span>`;
}

/** Risk level is carried by the word, not the hue: one amber pill for every level (WF-S27 27g.2, OQ27-1). */
export const RISK_LEVEL_CLASS: Record<RiskLevel, string> = {
  caution: TONE_PILL.alert,
  high: TONE_PILL.alert,
  extreme: TONE_PILL.alert,
};

export function riskPill(level: RiskLevel, label: string): TemplateResult {
  return html`<span class="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-[0.04em] uppercase ${RISK_LEVEL_CLASS[level]}">${icon('shield', 'h-3.5 w-3.5', 2.5)}${label}</span>`;
}

export function emptyState(title: string, body: string, action?: TemplateResult): TemplateResult {
  return html`<div class="card flex flex-col items-center gap-3 py-10 text-center">
    <div class="text-neutral-500">${icon('list', 'h-12 w-12', 1.5)}</div>
    <h2 class="text-lg font-bold text-neutral-900">${title}</h2>
    <p class="max-w-sm text-neutral-600">${body}</p>
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
