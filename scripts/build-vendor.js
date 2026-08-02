'use strict';
// Build the vendored @uwdata/vgplot bundle for the hub renderer.
//
//   node scripts/build-vendor.js        (or: npm run build:vendor)
//
// WHY THIS EXISTS (blocker B1 in docs/phase-3/README.md §2)
// --------------------------------------------------------
// The hub loads renderer libraries as plain `<script src>` tags — this repo has
// no bundler, only `tsc` with in-place sibling emit. vgplot cannot be loaded
// that way: it is ~1,000 ESM modules across ~50 packages that import each other
// by BARE SPECIFIER, which a browser cannot resolve. The two bundler-free
// escapes both fail under the hub CSP: an `<script type="importmap">` is inline
// script (`script-src 'self'` blocks it), and rewriting every bare specifier by
// hand IS a bundler. So we bundle ONCE, at build time, into a single IIFE that
// behaves exactly like the existing `chart.umd.js` tag, and commit the output.
//
// The two emitted files are DELIBERATELY COMMITTED to the repo. That is the
// whole point: CI, `npm ci` and electron-builder never need the 180+ MB vgplot
// dependency tree, and nothing here lands in `dependencies`/`devDependencies`.
//
// This script installs into a scratch directory it creates and owns under the
// OS temp dir — NEVER into the repo's own node_modules. (`predist:mac` installs
// a DuckDB binding into the repo; do not copy that precedent here. An earlier
// `npm i --no-save` in this repo pruned 46 real dependencies.)
//
// WHY plot.css (blocker B2)
// -------------------------
// Observable Plot ships its base ruleset by appending a `<style>` element at
// RUNTIME (see `@observablehq/plot/src/plot.js` and `src/legends/*.js`). Under
// `style-src 'self'` that stylesheet is refused, so plots overflow their box
// and tick labels collapse whitespace — AND Chromium logs a console error plus
// fires a securitypolicyviolation on every render, which `npm run smoke` fails
// on. So this script does two things, and both are needed:
//
//   1. It extracts the exact ruleset text from the installed Plot SOURCE and
//      writes it as a real same-origin `.css` file the hub can `<link>`.
//   2. It REMOVES the runtime injection from the bundle (see the transform
//      further down), so nothing is ever refused and the hub CSP stays
//      byte-identical — no hash, no nonce, no relaxed directive.
//
// Nothing is hand-transcribed and nothing is hardcoded: both halves are derived
// from the installed source, and both assert loudly if a version bump moves
// what they depend on. Because (2) removes the injection, (1) becomes the ONLY
// source of those rules — plot.css MUST be linked wherever vgplot.js is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Pins. Bump deliberately, re-run, and re-check the rendered output — Plot's
// stylesheet and vgplot's mark vocabulary are both version-coupled.
// ---------------------------------------------------------------------------
const VGPLOT = '@uwdata/vgplot';
const VGPLOT_VERSION = '0.29.2';
const ESBUILD_VERSION = '0.25.12';

const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'renderer', 'hub', 'vendor');
const OUT_JS = path.join(OUT_DIR, 'vgplot.js');
const OUT_CSS = path.join(OUT_DIR, 'plot.css');

// Scratch install root. Overridable so CI can point it at a cache.
const WORK = process.env.ORDINATE_VENDOR_DIR
  || path.join(os.tmpdir(), 'ordinate-vendor-build');

function log(...args) { console.log('[build-vendor]', ...args); }

function kb(file) {
  return (fs.statSync(file).size / 1024).toFixed(1) + ' KB';
}

// ---------------------------------------------------------------------------
// 1. Install the pinned packages into the scratch dir.
// ---------------------------------------------------------------------------

/** Read an installed package's version, or null if it is not installed. */
function installedVersion(name) {
  try {
    const p = path.join(WORK, 'node_modules', ...name.split('/'), 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version;
  } catch {
    return null;
  }
}

function install() {
  fs.mkdirSync(WORK, { recursive: true });
  const manifest = path.join(WORK, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({
      name: 'ordinate-vendor-build',
      version: '0.0.0',
      private: true,
      description: 'Scratch install for scripts/build-vendor.js. Safe to delete.',
    }, null, 2) + '\n');
  }

  if (installedVersion(VGPLOT) === VGPLOT_VERSION
      && installedVersion('esbuild') === ESBUILD_VERSION) {
    log(`reusing scratch install at ${WORK}`);
    return;
  }

  log(`installing ${VGPLOT}@${VGPLOT_VERSION} + esbuild@${ESBUILD_VERSION} into ${WORK}`);
  // --legacy-peer-deps is REQUIRED, not cosmetic: @uwdata/mosaic-core@0.29.2
  // publishes `"peerDependencies": {"@uwdata/mosaic-duckdb": "workspace:^"}` —
  // a pnpm workspace protocol that leaked into the npm tarball. A plain
  // `npm i` fails outright with EUNSUPPORTEDPROTOCOL.
  execFileSync('npm', [
    'install', '--no-audit', '--no-fund', '--legacy-peer-deps',
    `${VGPLOT}@${VGPLOT_VERSION}`,
    `esbuild@${ESBUILD_VERSION}`,
  ], { cwd: WORK, stdio: 'inherit' }); // args array, never shell:true
}

// ---------------------------------------------------------------------------
// 2. Bundle vgplot to an IIFE exposing window.vg.
// ---------------------------------------------------------------------------

// mosaic-core statically imports @duckdb/duckdb-wasm for its DuckDBWASMConnector.
// Ordinate queries the REAL DuckDB over IPC, so that connector is dead weight —
// and its default bundle loader fetches WASM from cdn.jsdelivr.net, which
// contradicts the local-first promise even though `default-src 'none'` would
// block it. Alias it to a stub that throws if anyone ever reaches for it.
const WASM_STUB = `// Not bundled: Ordinate queries the real DuckDB over IPC.
const unavailable = () => {
  throw new Error(
    'DuckDB-WASM is not bundled into Ordinate. Queries run against the ' +
    'native DuckDB in the main process over IPC.'
  );
};
export function getJsDelivrBundles() { return unavailable(); }
export function selectBundle() { return unavailable(); }
export class AsyncDuckDB { constructor() { unavailable(); } }
export class ConsoleLogger {}
export class VoidLogger {}
`;

// --- Plot's runtime <style> injection, removed at build time ----------------
//
// Observable Plot appends a `<style>` element carrying its base ruleset every
// time it renders (`svg.append("style").text(`…`)` in src/plot.js and
// src/legends/ramp.js; `div.insert("style", "*").text(`…`)` in
// src/legends/swatches.js). Under `style-src 'self'` Chromium REFUSES that
// element — it logs a console error and fires a securitypolicyviolation on
// every single render. Linking plot.css restores the visual result but does
// not stop the attempt, and `npm run smoke` fails on any renderer console
// error, so "renders correctly but shouts" is not shippable.
//
// We generate this bundle ourselves and we ship the identical ruleset as a
// real same-origin file, so the injection is pure redundancy here. Cut it out
// at build time — same treatment as the DuckDB-WASM stub above. The CSP then
// stays BYTE-IDENTICAL, which matters: that CSP is a stated project promise,
// not a default, and coupling it to a third-party library's internals (a
// style-src hash of Plot's ruleset) would be the tail wagging the dog.
//
// Each site is the whole body of a `.call((sel) => …)` whose return value is
// discarded, so replacing the expression with `void 0` is semantically inert.
//
// This transform is ASSERTED, not hoped for: the sites are located by scanning
// Plot's source, the count found must equal the count removed, it must be
// non-zero, and the emitted bundle is re-scanned afterwards. A version bump
// that moves or renames the injection site fails the build loudly instead of
// silently emitting a bundle that resumes violating the CSP.
const STYLE_INJECTION_RE = /[A-Za-z_$][\w$]*\.(?:append|insert)\(\s*"style"(?:\s*,\s*"[^"]*")?\s*\)\s*\.text\(/g;

/**
 * Locate every `X.append("style").text(<template>)` / `X.insert("style", "*")
 * .text(<template>)` expression in `code`. Returns `[start, end)` spans
 * covering the whole expression including the closing paren.
 */
function findStyleInjections(code) {
  const spans = [];
  STYLE_INJECTION_RE.lastIndex = 0;
  let m;
  while ((m = STYLE_INJECTION_RE.exec(code)) !== null) {
    let i = m.index + m[0].length;
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] !== '`') {
      throw new Error(
        'build-vendor: Plot style injection at offset ' + m.index
        + ' no longer takes a template literal — the patch must be re-derived.',
      );
    }
    const lit = scanTemplate(code, i);
    let j = lit.end;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== ')') {
      throw new Error(
        'build-vendor: could not find the closing paren of a Plot style '
        + 'injection at offset ' + m.index + ' — the patch must be re-derived.',
      );
    }
    spans.push([m.index, j + 1]);
    STYLE_INJECTION_RE.lastIndex = j + 1;
  }
  return spans;
}

/** Replace every injection expression with `void 0`. */
function neutralizeStyleInjection(code) {
  const spans = findStyleInjections(code);
  let out = '';
  let prev = 0;
  for (const [start, end] of spans) {
    out += code.slice(prev, start) + '/* ordinate: <style> injection removed */ void 0';
    prev = end;
  }
  out += code.slice(prev);
  return { code: out, count: spans.length };
}

function plotSrcDir() {
  return path.join(WORK, 'node_modules', '@observablehq', 'plot', 'src');
}

// Any expression that builds a <style> element. Deliberately broader than the
// injection pattern above, because the audit's job is to notice code this
// script does NOT already know how to neutralise.
const STYLE_ELEMENT_RE =
  /\.(?:append|insert)\(\s*(['"])style\1|createElement\(\s*(['"])style\2|createElementNS\([^)]*,\s*(['"])style\3/g;

// Files that may still build a <style> element after the transforms, each with
// the reason it is safe or the reason it is being tolerated. Keyed by path
// relative to node_modules. An entry here is a STANDING DECISION — read it
// before adding another.
const STYLE_INJECTION_ALLOWLIST = new Map([
  ['@uwdata/mosaic-inputs/src/Table.js',
    "vg.table() — the interactive data-table INPUT widget, not a chart. Its "
    + "stylesheet is genuinely dynamic (`#<instance-id> tr>:nth-child(n) "
    + "{width:...px}`, built from the runtime schema and measured column "
    + "widths), so unlike Plot's it cannot be pre-extracted into plot.css. It "
    + "is NOT neutralised: if anyone ever renders vg.table() in the hub it will "
    + "log a style-src violation on every update. Ordinate has its own Explore "
    + "grid (src/datasetPage.ts), so nothing should reach for it — but this is a "
    + "known landmine, recorded rather than hidden."],
]);

/**
 * Canonical absolute path. esbuild reports realpaths, while paths built from
 * WORK may go through a symlink (on macOS the OS temp dir is /var/folders/…,
 * a symlink to /private/var/folders/…). Comparing the two forms silently
 * fails every lookup, so normalise both sides through here.
 */
function real(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** Path relative to the scratch node_modules, in forward slashes. */
function pkgKey(abs) {
  const nm = real(path.join(WORK, 'node_modules')) + path.sep;
  const a = real(abs);
  return a.startsWith(nm) ? a.slice(nm.length).split(path.sep).join('/') : a;
}

/**
 * Fail the build if any bundled input can still create a <style> element,
 * unless this script neutralised it or it is explicitly allowlisted above.
 */
function auditStyleInjection(metafile, removedByFile) {
  const offenders = [];
  const tolerated = [];
  let scanned = 0;
  let totalHits = 0;
  // metafile input keys are relative to esbuild's absWorkingDir, which the
  // build sets to WORK. Resolve against it — get this wrong and the audit
  // scans nothing while still "passing", which the guard below catches.
  for (const input of Object.keys(metafile.inputs)) {
    const abs = real(path.resolve(WORK, input));
    if (!fs.existsSync(abs)) continue;
    scanned++;
    const src = fs.readFileSync(abs, 'utf8');
    STYLE_ELEMENT_RE.lastIndex = 0;
    const hits = (src.match(STYLE_ELEMENT_RE) || []).length;
    if (!hits) continue;
    totalHits += hits;
    const key = pkgKey(abs);
    const neutralised = removedByFile.get(abs) || 0;
    if (hits - neutralised <= 0) continue;
    if (STYLE_INJECTION_ALLOWLIST.has(key)) tolerated.push(key);
    else offenders.push(`${key} (${hits - neutralised} site(s) not neutralised)`);
  }
  // The audit must actually have looked at the code it neutralised. If path
  // resolution breaks, this fails instead of quietly reporting all-clear.
  const expectHits = [...removedByFile.values()].reduce((a, b) => a + b, 0);
  if (scanned === 0 || totalHits < expectHits) {
    throw new Error(
      `build-vendor: the <style> audit is inert — scanned ${scanned} bundled `
      + `input(s) and found ${totalHits} style-element site(s), but ${expectHits} `
      + 'were neutralised, so it must have found at least that many. Its path '
      + 'resolution is wrong; fix it before trusting any of its results.',
    );
  }
  log(`<style> audit: scanned ${scanned} bundled inputs, ${totalHits} style-element site(s) found`);
  if (offenders.length) {
    throw new Error(
      'build-vendor: bundled code can still inject a <style> element, which '
      + "style-src 'self' refuses on every render:\n  " + offenders.join('\n  ')
      + '\nNeutralise it, or add it to STYLE_INJECTION_ALLOWLIST with a reason.',
    );
  }
  for (const t of tolerated) {
    log(`allowlisted <style> injector (see STYLE_INJECTION_ALLOWLIST): ${t}`);
  }
}

function header(sourceLine, comment) {
  const open = comment === 'css' ? '/*' : '/*!';
  return [
    open,
    ` * ${sourceLine}`,
    ' * GENERATED FILE — DO NOT EDIT BY HAND.',
    ' * Regenerate with:  npm run build:vendor   (scripts/build-vendor.js)',
    ' */',
    '',
  ].join('\n');
}

async function bundle() {
  const esbuild = require(path.join(WORK, 'node_modules', 'esbuild'));
  const entry = path.join(WORK, 'vendor-entry.js');
  const stub = path.join(WORK, 'duckdb-wasm-stub.js');
  fs.writeFileSync(entry, `export * from ${JSON.stringify(VGPLOT)};\n`);
  fs.writeFileSync(stub, WASM_STUB);

  const vgVersion = installedVersion(VGPLOT);
  const plotVersion = installedVersion('@observablehq/plot');

  // Independent pre-scan of Plot's source: how many injection sites SHOULD the
  // transform remove? Counted here rather than hardcoded, so a site that moves
  // to another file is still found — and a site that disappears entirely
  // (Plot switching to CSSOM, say) trips the `expected === 0` guard below.
  const expectedByFile = new Map();
  let expected = 0;
  for (const f of walkJs(plotSrcDir())) {
    const n = findStyleInjections(fs.readFileSync(f, 'utf8')).length;
    if (n) { expectedByFile.set(f, n); expected += n; }
  }
  if (expected === 0) {
    throw new Error(
      'build-vendor: found NO <style> injection sites in @observablehq/plot@'
      + plotVersion + '. Either Plot stopped injecting styles (then plot.css '
      + 'and this patch are both obsolete) or it now does so by some other '
      + 'means that this build no longer neutralises. Re-derive before shipping.',
    );
  }

  let removed = 0;
  const removedByFile = new Map();
  const stripPlotStyles = {
    name: 'ordinate-strip-plot-style-injection',
    setup(build) {
      build.onLoad({ filter: /[/\\]@observablehq[/\\]plot[/\\]src[/\\].*\.js$/ }, (args) => {
        const src = fs.readFileSync(args.path, 'utf8');
        const { code: patched, count } = neutralizeStyleInjection(src);
        if (count) { removed += count; removedByFile.set(real(args.path), count); }
        return { contents: patched, loader: 'js' };
      });
    },
  };

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName: 'vg',          // → window.vg
    platform: 'browser',
    target: 'chrome120',       // Electron 42 ships Chromium 140+
    minify: true,
    sourcemap: false,          // no inline sourcemap — CSP and size
    legalComments: 'none',
    alias: { '@duckdb/duckdb-wasm': stub },
    plugins: [stripPlotStyles],
    metafile: true,            // exact input list, for the audit below
    absWorkingDir: WORK,       // …whose keys are relative to THIS directory
    write: false,
    banner: {
      js: header(
        `${VGPLOT}@${vgVersion} bundled for Ordinate's hub renderer `
        + `(includes @observablehq/plot@${plotVersion}).`,
      ),
    },
  });

  const code = result.outputFiles[0].text;

  // --- the patch is asserted, not assumed --------------------------------
  if (removed !== expected) {
    const want = [...expectedByFile].map(([f, n]) => `${pkgKey(f)}×${n}`);
    throw new Error(
      `build-vendor: expected to remove ${expected} Plot <style> injection(s) `
      + `(${want.join(', ')}) but removed ${removed}. The bundle would violate `
      + `style-src 'self' at runtime. Re-derive the patch before shipping.`,
    );
  }
  log(`removed ${removed} Plot <style> injection site(s): `
    + [...removedByFile].map(([f, n]) => `${pkgKey(f)}×${n}`).join(', '));

  // Sweep EVERY file esbuild actually pulled in — not just Plot's — for any
  // other code that builds a <style> element. The metafile is the exact input
  // list, so this covers d3 and all of @uwdata too, and it catches a NEW
  // injector appearing in a future version rather than only a moved one.
  auditStyleInjection(result.metafile, removedByFile);

  // The hub CSP has no 'unsafe-eval'. A bundler CAN emit these; shout if so.
  for (const bad of ['eval(', 'new Function(']) {
    if (code.includes(bad)) log(`WARNING: bundle contains ${bad} — the hub CSP forbids it.`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JS, code);
  log(`wrote ${path.relative(REPO, OUT_JS)}  ${kb(OUT_JS)}`);
  return { vgVersion, plotVersion };
}

// ---------------------------------------------------------------------------
// 3. Extract Observable Plot's runtime stylesheet into a real .css file.
// ---------------------------------------------------------------------------

/** Every `.js` file under `dir`, recursively, sorted for determinism. */
function walkJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Read the template literal starting at `src[i] === '`'`. Returns its raw body
 * (with `${...}` left intact) and the index just past the closing backtick.
 * Handles backslash escapes and one level of `${}` nesting — enough for Plot,
 * whose stylesheet literals interpolate only bare identifiers.
 */
function scanTemplate(src, i) {
  let j = i + 1;
  let depth = 0;
  let body = '';
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { body += src.slice(j, j + 2); j += 2; continue; }
    if (depth === 0 && ch === '`') return { body, end: j + 1 };
    if (ch === '$' && src[j + 1] === '{') { depth++; body += '${'; j += 2; continue; }
    if (depth > 0 && ch === '}') { depth--; body += '}'; j++; continue; }
    body += ch; j++;
  }
  return { body, end: -1 }; // unterminated — caller ignores
}

/** Every template literal in `src`, as raw text with `${...}` left intact. */
function templateLiterals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '`') continue;
    const { body, end } = scanTemplate(src, i);
    if (end !== -1) { out.push(body); i = end - 1; }
  }
  return out;
}

/** Apply the placeholder substitutions that turn a Plot literal into CSS. */
function litToCss(lit, className) {
  return lit
    .split('${className}').join(className)
    // swatches.js splices one of two sibling rulesets in here; both are
    // picked up on their own, so drop the placeholder rather than duplicate.
    .split('${extraStyle}').join('')
    .trim();
}

function extractPlotCss() {
  const plotDir = path.join(WORK, 'node_modules', '@observablehq', 'plot');
  const srcDir = path.join(plotDir, 'src');

  // Plot's default class name is a constant it bumps whenever the default
  // styles change (`maybeClassName` in src/style.js). Read it, never hardcode.
  const styleSrc = fs.readFileSync(path.join(srcDir, 'style.js'), 'utf8');
  const m = /name === undefined\)\s*return\s*["']([^"']+)["']/.exec(styleSrc);
  if (!m) throw new Error('build-vendor: could not read Plot default class name from src/style.js');
  const className = m[1];

  // mosaic-plot never passes a `className` option, so this constant is the
  // class every vgplot-rendered SVG actually carries. (Verified by grep: no
  // occurrence of "className" in @uwdata/mosaic-plot/src.)
  const blocks = [];
  const seen = new Set();
  // Every ruleset Plot would have injected must end up in the file, because
  // the bundle no longer injects any of them. Collected separately so it can
  // be asserted against the emitted CSS below.
  const required = [];
  for (const file of walkJs(srcDir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [start] of findStyleInjections(src)) {
      const bt = src.indexOf('`', start);
      required.push({ from: path.relative(plotDir, file), css: litToCss(scanTemplate(src, bt).body, className) });
    }
  }

  for (const file of walkJs(srcDir)) {
    for (const lit of templateLiterals(fs.readFileSync(file, 'utf8'))) {
      if (!lit.includes(':where(.') || !lit.includes('{')) continue;
      const css = litToCss(lit, className);
      if (/\$\{/.test(css)) {
        throw new Error(
          'build-vendor: unhandled interpolation in a Plot stylesheet from '
          + path.relative(plotDir, file) + ' — ' + css.slice(0, 120),
        );
      }
      if (seen.has(css)) continue;
      seen.add(css);
      blocks.push({ from: path.relative(plotDir, file), css });
    }
  }
  if (!blocks.length) {
    throw new Error('build-vendor: found no Plot stylesheet blocks — did Plot change how it injects styles?');
  }
  return { className, blocks, required, version: installedVersion('@observablehq/plot') };
}

function writePlotCss() {
  const { className, blocks, required, version } = extractPlotCss();
  const body = blocks
    .map((b) => `/* from @observablehq/plot ${b.from} */\n${b.css}`)
    .join('\n\n');

  // Since the bundle no longer injects anything, this file is now the ONLY
  // source of Plot's base rules. Every ruleset that used to be injected must
  // be here verbatim, or the patch above has silently removed working styles.
  for (const r of required) {
    if (!body.includes(r.css)) {
      throw new Error(
        'build-vendor: the ruleset Plot injects from ' + r.from + ' is missing '
        + 'from the generated plot.css. The bundle no longer injects it either, '
        + 'so those styles would simply be lost. Re-derive before shipping.\n'
        + r.css.slice(0, 200),
      );
    }
  }
  const text = header(
    `@observablehq/plot@${version} runtime stylesheet, extracted from source.\n`
    + ` * Plot normally appends these rules as an inline <style> at render time,\n`
    + ` * which the hub CSP (style-src 'self') refuses — a console error and a\n`
    + ` * securitypolicyviolation on EVERY render. build-vendor.js removes that\n`
    + ` * injection from the bundle, so this file is the only source of these\n`
    + ` * rules. It MUST be linked wherever vgplot.js is, or plots lose their\n`
    + ` * base styling (max-width, white-space:pre on tick labels).\n`
    + ` * Plot's default class name here is .${className}`,
    'css',
  ) + body + '\n';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_CSS, text);
  log(`wrote ${path.relative(REPO, OUT_CSS)}  ${kb(OUT_CSS)}  (${blocks.length} rulesets, `
    + `${required.length} of them formerly injected, class .${className})`);
}

// ---------------------------------------------------------------------------

async function main() {
  install();
  const { vgVersion, plotVersion } = await bundle();
  writePlotCss();
  log(`done — vgplot ${vgVersion}, plot ${plotVersion}`);
  log('add to renderer/hub/index.html:');
  log('  <link rel="stylesheet" href="vendor/plot.css"/>');
  log('  <script src="vendor/vgplot.js"></script>');
}

main().catch((err) => {
  console.error('[build-vendor] FAILED: ' + ((err && err.message) || err));
  process.exit(1);
});
