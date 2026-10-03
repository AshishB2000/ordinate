import { defineConfig, type Plugin } from 'vitest/config';

// The built app's CSP. No inline script or style anywhere: Vite emits external
// <script type="module"> and <link rel="stylesheet"> only, and this meta makes
// any regression a console error (which T0.8's e2e fails on). Build only — the
// dev server injects CSS as <style> elements for HMR, which this would block.
// ponytail: meta tag, not a response header; T6.2 moves it to a header with the
// rest of the security headers (frame-ancestors only works there).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const cspMeta: Plugin = {
  name: 'ordinate-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
  ],
};

export default defineConfig({
  plugins: [cspMeta],
  oxc: { jsx: { runtime: 'automatic' } },
  server: {
    // `npm run server` listens on :8080 (src/server/env.ts default).
    proxy: { '/api': 'http://127.0.0.1:8080' },
    // web/ plus the one server file the client shares: the wire codec.
    fs: { allow: ['.', '../src/server/wire.ts'] },
  },
  build: {
    // The latest two releases of each supported browser, as of 2026-10
    // (Playwright 1.62 bundles Chromium 151 / Firefox 153; Safari 26 is the
    // older of the two current majors). A floor, not a ceiling: raising it only
    // stops syntax from being lowered.
    target: ['chrome149', 'edge149', 'firefox151', 'safari26'],
    rolldownOptions: {
      // TanStack Query ships "use client" for RSC frameworks; meaningless in a
      // SPA, and rolldown warns once per file.
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
});
