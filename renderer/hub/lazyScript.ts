// Deferred <script> loading for the heavy, rarely-used vendor bundles.
//
// The hub parsed 5,476K of JavaScript before it painted anything, every
// launch, because every vendor library had an unconditional <script src> in
// index.html:
//
//     docx/index.iife.js       1097K   Word export
//     pdfmake.min.js           1029K   PDF export
//     vfs_fonts.js              835K   PDF export (fonts)
//     maplibre-gl-csp.js        714K   maps only
//     pptxgen.bundle.js         450K   PowerPoint export
//     assets/geo/*.js           212K   maps only
//     chart.js + 5 plugins      340K   the point of the app — stays eager
//     svelte/bundle.js          162K   eager on purpose, see below
//
// 4,336K of that is export formats most sessions never open and maps most
// datasets are not. Chart.js and its plugins stay eager: a chart is on screen
// within a second of opening a visual, so deferring it buys a spinner.
//
// (An earlier count said 6.0 MB. It was wrong — it matched a <script src> that
// appears inside an HTML COMMENT in index.html, and so counted vgplot's 594K
// as eager when Phase 3c had already deferred it.)
//
// ── WHY THIS IS A SAFE CHANGE ────────────────────────────────────────────────
// Every consumer of these globals ALREADY resolves them at call time and
// ALREADY guards on absence — `if (!window.pdfMake) { showToast('PDF engine
// not loaded'); return; }`, `if (typeof maplibregl === 'undefined') return;`,
// `if (!vg || typeof vg.createAPIContext !== 'function') return null;`. The
// renderer is a set of classic global-scope scripts with no import graph, so
// "not loaded yet" was always a state these call sites had to handle. This
// module only makes that state temporary instead of terminal: `await
// ensureBundle(...)` immediately before the existing guard, which then passes.
//
// ── CSP ──────────────────────────────────────────────────────────────────────
// The hub runs under `script-src 'self'` with no 'unsafe-inline'. A
// dynamically appended <script src> is NOT an inline script — it fetches a
// same-origin URL and is covered by 'self' exactly as the static tags in
// index.html are. No directive changes, no hash, no nonce. (An inline
// `<script>…</script>` would be refused, which is also why the MapLibre worker
// bootstrap is a file rather than an inline tag.)

/** src → in-flight or settled load. A second request never re-fetches. */
const _lazyScripts = new Map<string, Promise<void>>();

/**
 * Append one <script src> and resolve when it has executed. Rejects on a load
 * error so a caller can degrade rather than hang.
 *
 * `async = false` matters: bundles within one group are ordered (pdfmake's
 * vfs_fonts assigns onto the pdfMake global the previous file created), and a
 * dynamically-inserted script defaults to async, which would race them.
 */
function loadScriptOnce(src: string): Promise<void> {
  const existing = _lazyScripts.get(src);
  if (existing) return existing;

  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(el);
  });
  _lazyScripts.set(src, p);
  return p;
}

/**
 * Named groups, in load order. Paths are relative to renderer/hub/index.html,
 * identical to the <script src> values they replaced — so the packaged asar
 * resolves them the same way a checkout does, with no build step.
 */
const LAZY_BUNDLES: Record<string, string[]> = {
  pdf: ['../../node_modules/pdfmake/build/pdfmake.min.js', '../../node_modules/pdfmake/build/vfs_fonts.js'],
  pptx: ['../../node_modules/pptxgenjs/dist/pptxgen.bundle.js'],
  docx: ['../../node_modules/docx/dist/index.iife.js'],
  map: [
    '../../node_modules/maplibre-gl/dist/maplibre-gl-csp.js',
    'mapWorker.js',
    '../../assets/geo/world-countries.js',
    '../../assets/geo/us-states.js',
  ],
};

// NOT here, deliberately:
//   vendor/vgplot.js  — plotRender.ts already defers it, with its own retry-on-
//                       error latch, and that path is exercised. Rerouting
//                       working, tested code through this module would buy
//                       tidiness and risk a regression. Two mechanisms is the
//                       cheaper answer than one refactor.
//   svelte/bundle.js  — 162K, and svelte/main.ts states the reason it loads
//                       unflagged: a broken or stale bundle must be a console
//                       error on EVERY launch, not something only a flag-holder
//                       ever sees. Deferring it would quietly delete that
//                       check. The smoke test asserts on it in both flag states.

/**
 * Load a named bundle if it is not already loaded. Resolves `true` when the
 * global is ready to use, `false` when it could not be fetched — callers
 * already handle a missing global, so a `false` just takes the path they had
 * before.
 *
 * Concurrent callers share one load: `renderVizInArea` firing twice for two
 * cards on a dashboard fetches MapLibre once.
 */
async function ensureBundle(name: string): Promise<boolean> {
  const srcs = LAZY_BUNDLES[name];
  if (!srcs) return false;
  try {
    // Sequential, not Promise.all: within a group the order is load-bearing —
    // mapWorker.js calls maplibregl.setWorkerUrl() and must run after the
    // MapLibre UMD, and vfs_fonts.js writes onto pdfmake's global.
    for (const src of srcs) await loadScriptOnce(src);
    return true;
  } catch (err) {
    console.error('[lazyScript] bundle "' + name + '" failed to load', err);
    return false;
  }
}
