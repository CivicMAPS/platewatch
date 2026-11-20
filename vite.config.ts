/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

/**
 * Content Security Policy applied to the production build.
 *
 * - No inline script or style is emitted anywhere in the app, so neither
 *   'unsafe-inline' nor nonces are required (the app is static; there is no
 *   server render in which a per-request nonce could be minted).
 * - 'wasm-unsafe-eval' is the narrowest grant that permits the Tesseract OCR
 *   WebAssembly core to compile. It does NOT permit eval()/new Function().
 * - blob:/mediastream: cover captured evidence images and the live camera.
 *
 * The same policy (plus header-only directives) is emitted to dist/_headers
 * for hosts such as Cloudflare Pages / Netlify. See docs/SECURITY.md.
 */
export const CSP_DIRECTIVES: Record<string, string> = {
  'default-src': "'self'",
  'script-src': "'self' 'wasm-unsafe-eval'",
  'worker-src': "'self' blob:",
  'connect-src': "'self' blob: data:",
  'img-src': "'self' blob: data:",
  'media-src': "'self' blob: mediastream:",
  'style-src': "'self'",
  'font-src': "'self'",
  'manifest-src': "'self'",
  'object-src': "'none'",
  'base-uri': "'self'",
  'form-action': "'self'",
};

const HEADER_ONLY_DIRECTIVES: Record<string, string> = {
  'frame-ancestors': "'none'",
};

const toPolicy = (d: Record<string, string>) =>
  Object.entries(d)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'platewatch-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // Vite dev server injects <style> tags for HMR, so the meta CSP is only
        // applied to production output.
        return html.replace(
          '<!--CSP-->',
          `<meta http-equiv="Content-Security-Policy" content="${toPolicy(CSP_DIRECTIVES)}" />`,
        );
      },
    },
    generateBundle() {
      const policy = toPolicy({ ...CSP_DIRECTIVES, ...HEADER_ONLY_DIRECTIVES });
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: [
          '/*',
          `  Content-Security-Policy: ${policy}`,
          '  X-Content-Type-Options: nosniff',
          '  Referrer-Policy: no-referrer',
          '  Permissions-Policy: camera=(self), geolocation=(self), microphone=(), payment=(), usb=()',
          '  Cross-Origin-Opener-Policy: same-origin',
          '',
          '/ocr/*',
          '  Cache-Control: public, max-age=31536000, immutable',
          '',
        ].join('\n'),
      });
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    tailwindcss(),
    cspPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        id: './',
        name: 'PlateWatch',
        short_name: 'PlateWatch',
        description: 'Number plate scanning for timed parking, allow lists and hot lists.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b1220',
        theme_color: '#0b1220',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['ocr/**'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // OCR runtime is large (≈7 MB for the one core variant a device
            // actually uses + 3 MB model). Cache on first use rather than
            // precaching all three CPU variants.
            urlPattern: ({ url }) => url.pathname.includes('/ocr/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'platewatch-ocr',
              expiration: { maxEntries: 16 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    env: { TZ: 'Australia/Melbourne' },
  },
});
