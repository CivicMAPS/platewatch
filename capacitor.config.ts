import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'au.techcorp.platewatch',
  appName: 'PlateWatch',
  webDir: 'dist',
  android: {
    // Served from https://localhost inside the WebView: a secure context, so
    // camera, geolocation, crypto.subtle and IndexedDB all behave as on the web.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
