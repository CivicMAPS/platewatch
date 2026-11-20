/**
 * Save/share files in both runtimes:
 *  - Android APK (Capacitor WebView): blob downloads are not supported, so the
 *    file is written to the app cache and handed to the Android share sheet
 *    (Save to Files / Drive / email…).
 *  - Browser/PWA: Web Share with files where available, else a normal download.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { downloadBlob } from './backup';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export const isNative = () => Capacitor.isNativePlatform();

export async function saveFile(blob: Blob, filename: string, title = 'Save file'): Promise<'shared' | 'downloaded'> {
  if (isNative()) {
    const written = await Filesystem.writeFile({
      path: filename,
      data: await blobToBase64(blob),
      directory: Directory.Cache,
      recursive: true,
    });
    await Share.share({ title, files: [written.uri], dialogTitle: title });
    return 'shared';
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

export async function shareFile(blob: Blob, filename: string, title: string): Promise<'shared' | 'downloaded'> {
  if (isNative()) return saveFile(blob, filename, title);
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'shared';
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}
