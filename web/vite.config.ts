import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { appLicences } from './scripts/licenses.ts';

// The channels whose contract is `access: 'write'`, for the RPC client's
// view-only safety net (src/api/client.ts): read off the contracts at build
// time, so the list cannot drift and no zod reaches the bundle. From the
// COMPILED contracts (`npm run build:ts`, which postinstall runs): the root
// package is CommonJS, and its TypeScript cannot be imported from this ES module.
function writeChannels(): string[] {
  let api: typeof import('../src/api/index.ts');
  try {
    api = createRequire(import.meta.url)('../src/api/index.js') as typeof api;
  } catch (cause) {
    throw new Error('The compiled contracts (src/api/index.js) could not be loaded: run `npm run build:ts` in the repo root first.', { cause });
  }
  return Object.entries(api.contracts)
    .filter(([, c]) => c.access === 'write')
    .map(([name]) => name);
}

// The About page's licences (T2.14): every production dependency the app
// ships, read from node_modules at build time and written beside index.html.
// The dev server answers the same file from memory.
function licences(): Plugin {
  const json = () => JSON.stringify(appLicences(import.meta.dirname));
  return {
    name: 'ordinate-licences',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'licenses.json', source: json() });
    },
    configureServer(server) {
      server.middlewares.use('/licenses.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(json());
      });
    },
  };
}

// The CSP is a response HEADER set by the server (src/server/headers.ts,
// APP_CSP) — the one place it is written, frame-ancestors included. The build
// emits no inline script or style (external <script type="module"> and
// <link rel="stylesheet"> only), which the e2e harness proves: any CSP
// violation is a test failure. The dev server (HMR injects <style>) has none.

export default defineConfig({
  plugins: [licences()],
  define: { __WRITE_CHANNELS__: JSON.stringify(writeChannels()) },
  oxc: { jsx: { runtime: 'automatic' } },
  server: {
    // `npm run server` listens on :8080 (src/server/env.ts default).
    // changeOrigin stays false — the string shorthand turns it on — so the
    // server sees the browser's Host (:5173), the same host its Origin names;
    // otherwise the CSRF check (src/server/csrf.ts) refuses every POST with
    // 403 `origin`. e2e/devproxy.e2e.ts proves it.
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
    // web/ plus the one server file the client shares: the wire codec.
    // …and the desktop icon set, which a test diffs the generated icons against
    // (its directory: a `?raw` id only passes the check as a child path).
    // …and the app's formatter and message formatter, which the chart engine shares (no runtime imports).
    // …and the story Markdown parser the server's report pages share (T2.13).
    fs: { allow: ['.', '../src/server/wire.ts', '../src/app/format.ts', '../src/app/i18nCore.ts', '../src/analysis/storyText.ts'] },
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
