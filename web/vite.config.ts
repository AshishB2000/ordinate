import { defineConfig } from 'vitest/config';

// The CSP is a response HEADER set by the server (src/server/headers.ts,
// APP_CSP) — the one place it is written, frame-ancestors included. The build
// emits no inline script or style (external <script type="module"> and
// <link rel="stylesheet"> only), which the e2e harness proves: any CSP
// violation is a test failure. The dev server (HMR injects <style>) has none.

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  server: {
    // `npm run server` listens on :8080 (src/server/env.ts default).
    proxy: { '/api': 'http://127.0.0.1:8080' },
    // web/ plus the one server file the client shares: the wire codec.
    // …and the desktop icon set, which a test diffs the generated icons against
    // (its directory: a `?raw` id only passes the check as a child path).
    // …and the app's formatter and message formatter, which the chart engine shares (no runtime imports).
    fs: { allow: ['.', '../src/server/wire.ts', '../renderer/hub', '../src/app/format.ts', '../src/app/i18nCore.ts'] },
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
