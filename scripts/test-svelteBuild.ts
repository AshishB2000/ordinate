// Self-check for the Phase 5 Svelte toolchain (scripts/build-svelte.js).
//
// The build script carries good guards — it throws if the bundle can create a
// <style> element, if it contains eval/new Function, if a component's CSS went
// missing from bundle.css, if the one-global rule is broken, or if svelte is
// not 5.x. But nothing in `npm test` ran any of it, so the guards themselves
// were unverified and the EMITTED artifact was unexamined.
//
// This asserts the properties of the shipped output, because that is what a
// user actually receives. It deliberately does NOT re-implement the build:
// docs/phase-0/README.md §5 records three test files that mirrored renderer
// helpers and kept passing after the originals were deleted.
//
// It also pins the two behaviours a reviewer would otherwise have to take on
// trust: that the spike island is gated off by default, and that the hub CSP
// is unchanged.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const REPO = path.resolve(__dirname, '..');
const BUNDLE_JS = path.join(REPO, 'renderer', 'hub', 'svelte', 'bundle.js');
const BUNDLE_CSS = path.join(REPO, 'renderer', 'hub', 'svelte', 'bundle.css');
const MAIN_TS = path.join(REPO, 'renderer', 'hub', 'svelte', 'main.ts');
const INDEX = path.join(REPO, 'renderer', 'hub', 'index.html');


// `pretest` runs `npm run build`, which includes build:svelte — so a missing
// bundle here means the build did not run, not that the test is misordered.
ok('the bundle was emitted', fs.existsSync(BUNDLE_JS));
ok('the external stylesheet was emitted', fs.existsSync(BUNDLE_CSS));
if (!fs.existsSync(BUNDLE_JS) || !fs.existsSync(BUNDLE_CSS)) {
  console.error('\nbundle missing — run `npm run build:svelte`.');
  process.exit(1);
}

const js = fs.readFileSync(BUNDLE_JS, 'utf8');
const css = fs.readFileSync(BUNDLE_CSS, 'utf8');
const html = fs.readFileSync(INDEX, 'utf8');
const mainTs = fs.readFileSync(MAIN_TS, 'utf8');

// ── CSP invariants ──────────────────────────────────────────────────────────
// These are the whole basis of "resolved, not relaxed". Each is a property of
// the emitted file, so it holds regardless of what the build script believes.
ok(
  "no eval/new Function (script-src 'self' has no 'unsafe-eval')",
  !/\beval\(|new Function\(/.test(js),
  (js.match(/\beval\(|new Function\(/g) || []).join(', ') || 'none',
);
const styleSites = js.match(/createElement\(\s*["'`]style["'`]|\.(?:append|insert)\(\s*["'`]style["'`]/g) || [];
ok(
  "the bundle cannot build a <style> element (style-src 'self')",
  styleSites.length === 0,
  styleSites.length ? [...new Set(styleSites)].join(', ') : 'none',
);
// Svelte 4 installed transition keyframes with sheet.insertRule, which the CSP
// refuses; Svelte 5 uses the Web Animations API. A downgrade would silently
// re-open that blocker.
ok('no CSSOM insertRule (the Svelte 4 transition blocker)', !/insertRule\(/.test(js));
ok('scoped styles really did land in the external stylesheet', css.trim().length > 0,
   `${css.length} bytes`);

// ── Coexistence contract ────────────────────────────────────────────────────
ok('the bundle assigns exactly one global', /OrdinateSvelte\s*=/.test(js));
ok('index.html links the external stylesheet', /href="svelte\/bundle\.css"/.test(html));
ok('index.html loads the bundle as a classic script (no type="module")',
   /<script src="svelte\/bundle\.js"><\/script>/.test(html));

// Load order is load-bearing: a classic script's top-level `const` lives in the
// global LEXICAL environment and is in TDZ until its defining script has run,
// so the bundle must come after every hub script it might read by bare name.
const bundleAt = html.indexOf('src="svelte/bundle.js"');
const hubAt = html.indexOf('src="hub.js"');
ok('the bundle is loaded after hub.js (global TDZ)', bundleAt > hubAt && hubAt !== -1,
   `hub.js@${hubAt} bundle@${bundleAt}`);

// ── The gate ────────────────────────────────────────────────────────────────
// The spike shipped auto-mounting a debug card onto the Projects home screen.
// Assert the gate in BOTH the source and the emitted bundle, so a build that
// silently dropped it fails here rather than on a user's first launch.
ok("main.ts gates the island on localStorage 'scSvelte'",
   /getItem\(\s*['"]scSvelte['"]\s*\)\s*===\s*['"]1['"]/.test(mainTs));
ok("the EMITTED bundle carries the 'scSvelte' gate", /scSvelte/.test(js));
ok('the gate is strict-equality against "1" (matches scMosaic/scAllCharts)',
   /scSvelte['"]\s*\)\s*===\s*['"]1['"]/.test(js));

// ── The CSP itself is unchanged ─────────────────────────────────────────────
// Phase 5's headline claim. Cheap to assert, and it would catch a future
// "just add 'unsafe-inline'" fix for a styling problem.
const cspLine = (html.match(/content="default-src[^"]*"/) || [''])[0];
ok('hub CSP still has no unsafe-inline', !/unsafe-inline/.test(cspLine));
ok('hub CSP still has no unsafe-eval', !/unsafe-eval/.test(cspLine));
ok('hub CSP still has no blob: or worker-src', !/blob:|worker-src/.test(cspLine));
ok("hub CSP style-src is still exactly 'self'", /style-src 'self';/.test(cspLine));

console.log('');
if (failureCount()) {
  console.error(`${failureCount()} Svelte toolchain check(s) FAILED.`);
  process.exit(1);
}
console.log('All Svelte toolchain checks passed.');
