import { html, nothing } from 'lit-html';
import { createRef, ref } from 'lit-html/directives/ref.js';
import { fileToCanvas } from '../../lib/camera';
import { resizeCanvas } from '../../lib/image';
import { onOcrStatus, recogniseText, type OcrStatus } from '../../lib/ocr';
import type { App, View } from '../app';
import { header, icon, page, spinner } from '../components';

/** Image → editable text (signage, permits, notices). */
export function textReaderView(_p: Record<string, string>, app: App): View {
  const fileRef = createRef<HTMLInputElement>();
  let imageUrl = '';
  let text = '';
  let busy = false;
  let confidence: number | null = null;
  let status: OcrStatus | null = null;
  let unsub: (() => void) | null = null;

  const read = async (file: File) => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(file);
    busy = true;
    text = '';
    confidence = null;
    app.update();
    try {
      const canvas = resizeCanvas(await fileToCanvas(file), 2400);
      const r = await recogniseText(canvas);
      text = r.text;
      confidence = r.confidence;
      if (!text) app.toast('No text found. Try a closer, sharper photo.', 'warn');
    } catch (e) {
      app.toast(`Text recognition failed: ${(e as Error).message}`, 'error');
    } finally {
      busy = false;
      app.update();
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      app.toast('Copied to clipboard.', 'success');
    } catch {
      app.toast('Clipboard unavailable — select the text and copy manually.', 'warn');
    }
  };

  return {
    mount() {
      unsub = onOcrStatus((s) => {
        status = s;
        if (busy) app.update();
      });
    },
    unmount() {
      unsub?.();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    render: () => html`${header({ title: 'Text reader', subtitle: 'Convert image text into editable text', back: () => app.back() })}
      ${page(html`
        <input ${ref(fileRef)} type="file" accept="image/*" capture="environment" class="hidden"
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            const f = input.files?.[0];
            input.value = '';
            if (f) void read(f);
          }} />
        <div class="grid grid-cols-2 gap-3">
          <button type="button" class="btn-primary" ?disabled=${busy} @click=${() => { fileRef.value?.setAttribute('capture', 'environment'); fileRef.value?.click(); }}>${icon('camera')} Camera</button>
          <button type="button" class="btn-secondary" ?disabled=${busy} @click=${() => { fileRef.value?.removeAttribute('capture'); fileRef.value?.click(); }}>${icon('upload')} Choose image</button>
        </div>
        ${imageUrl ? html`<img src=${imageUrl} alt="Source" class="mt-4 max-h-72 w-full rounded-xl border border-ink-600 bg-black object-contain" />` : nothing}
        ${busy
          ? html`<p class="mt-4 flex items-center gap-2 text-slate-300">${spinner()} ${status && status.progress < 1 ? `${status.status} ${Math.round(status.progress * 100)}%` : 'Reading text…'}</p>`
          : nothing}
        ${imageUrl && !busy
          ? html`<div class="mt-4">
              <label class="field-label" for="ocr-text">Recognised text (editable)${confidence !== null ? html` · <span class="text-slate-400">${confidence}% confidence</span>` : nothing}</label>
              <textarea id="ocr-text" class="field min-h-56 font-plate text-sm" .value=${text} @input=${(e: Event) => (text = (e.target as HTMLTextAreaElement).value)}></textarea>
              <button type="button" class="btn-secondary mt-3 w-full" ?disabled=${!text} @click=${copy}>Copy text</button>
            </div>`
          : nothing}
        ${!imageUrl ? html`<p class="mt-4 text-sm text-slate-400">Photograph a parking sign, permit or notice. Recognition runs entirely on this device.</p>` : nothing}
      `)}`,
  };
}
