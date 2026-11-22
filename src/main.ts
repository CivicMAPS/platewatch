import './styles.css';
import { Capacitor } from '@capacitor/core';
import { registerSW } from 'virtual:pwa-register';
import { purgeScansOlderThan } from './lib/db';
import { warmUpOcr } from './lib/ocr';
import { App } from './ui/app';
import { homeView, newListTypeView } from './ui/views/home';
import { dismissedView } from './ui/views/dismissed';
import { importView } from './ui/views/importView';
import { listDetailView } from './ui/views/listDetail';
import { listFormView } from './ui/views/listForm';
import { recordView } from './ui/views/record';
import { scanView } from './ui/views/scan';
import { settingsView } from './ui/views/settings';
import { textReaderView } from './ui/views/textReader';
import { tagsView } from './ui/views/tags';

const root = document.getElementById('app');
if (!root) throw new Error('#app root missing');

const app = new App(root)
  .route('/', homeView)
  .route('/new', newListTypeView)
  .route('/new/:type', listFormView)
  .route('/list/:id', listDetailView)
  .route('/list/:id/edit', listFormView)
  .route('/scan/:id', scanView)
  .route('/record/:id', recordView)
  .route('/text', textReaderView)
  .route('/dismissed', dismissedView)
  .route('/tags', tagsView)
  .route('/import', importView)
  .route('/settings', settingsView);

await app.start();

// Ask the browser not to evict evidence under storage pressure.
void navigator.storage?.persist?.().catch(() => false);

// Apply retention policy.
if (app.settings.retentionDays > 0) {
  void purgeScansOlderThan(app.settings.retentionDays)
    .then((n) => n && app.toast(`Retention: removed ${n} old scan record(s).`, 'info'))
    .catch((e: unknown) => console.warn('[retention]', e));
}

// Load the OCR engine while the officer is still on the home screen.
const idle = (cb: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 1500));
idle(() => void warmUpOcr().catch((e: unknown) => console.warn('[ocr] warm-up failed', e)));

// Service worker: web/PWA only. The APK already ships every asset locally.
if ('serviceWorker' in navigator && import.meta.env.PROD && !Capacitor.isNativePlatform()) {
  registerSW({
    immediate: true,
    onNeedRefresh() {
      app.toast('Update installed — reopen the app to use the latest version.', 'info', 6000);
    },
    onOfflineReady() {
      app.toast('Ready to work offline.', 'success');
    },
  });
}
