// MapLibre GL worker bootstrap — the one line of setup the CSP-safe build needs.
//
// The hub loads `maplibre-gl-csp.js` rather than the default `maplibre-gl.js`.
// The default build ships its worker inlined as a blob: URL, which would force
// `worker-src blob:` (and, historically, 'unsafe-eval') into the hub CSP. The
// CSP build keeps the worker as a plain file on disk instead — the cost being
// that it has no idea where that file lives, so the app must tell it once, up
// front, via setWorkerUrl(). Everything below exists to answer that question.
//
// Ordering matters: this must run after maplibre-gl-csp.js and before any map
// is constructed. It is no longer a <script> tag in index.html — it is the
// second entry of the 'map' bundle in lazyScript.ts, which loads a group's
// scripts strictly in sequence, and `renderMapInArea` awaits that bundle before
// it touches maplibregl. Keep it second in that array.
//
// It is a separate file rather than an inline <script> because the hub CSP is
// `script-src 'self'` with no 'unsafe-inline' — an inline script would be
// silently refused.
(function bootstrapMapLibreWorker(): void {
  if (typeof maplibregl === 'undefined') return; // maplibre-gl-csp.js didn't load

  // Resolve against the document so the same code works from a checkout
  // (file:///…/renderer/hub/index.html) and from a packaged asar
  // (file:///…/app.asar/renderer/hub/index.html) with no build step and no
  // main-process round trip. The result is same-origin with the page, so
  // `script-src 'self'` covers the worker load — verified under the real hub
  // CSP in Electron; no `worker-src` directive is required.
  const workerUrl = new URL(
    '../../node_modules/maplibre-gl/dist/maplibre-gl-csp-worker.js',
    document.baseURI,
  ).href;

  maplibregl.setWorkerUrl(workerUrl);
})();
