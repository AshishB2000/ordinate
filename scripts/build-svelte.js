'use strict';
// Build the hub's Svelte islands into ONE classic <script src> + ONE stylesheet.
//
//   node scripts/build-svelte.js        (or: npm run build:svelte)
//
// WHY THIS EXISTS (phase 5, docs/phase-5/01-toolchain.md)
// ------------------------------------------------------
// This repo has no bundler by design: `npm run build:ts` is plain `tsc` with
// in-place sibling emit, and every renderer file is a classic global-scope
// <script>. Svelte cannot live there — a `.svelte` file is not JavaScript, and
// the compiler's output imports `svelte/internal/client` by BARE SPECIFIER,
// which a browser cannot resolve. The two bundler-free escapes both fail under
// the hub CSP, exactly as they did for vgplot in phase 3c: an inline
// <script type="importmap"> is inline script (`script-src 'self'` blocks it),
// and rewriting every bare specifier by hand IS a bundler.
//
// So: bundle at build time into a single IIFE that behaves precisely like the
// existing `chart.umd.js` / `vendor/vgplot.js` tags, exposing ONE global
// (`window.OrdinateSvelte`). The vanilla scripts keep loading exactly as before.
//
// WHY bundle.css (the CSP blocker)
// --------------------------------
// A `<style>` block inside a .svelte component is, by default, injected as an
// inline <style> element at runtime. `style-src 'self'` REFUSES that element:
// a console error plus a securitypolicyviolation on every mount — and
// `npm run smoke` fails on any renderer console error, so "renders but shouts"
// is not shippable. This is the same wall phase 3c hit with Observable Plot.
//
// Plot needed its injection sites patched out of a third-party library. Svelte
// does not: `css: 'external'` is a first-class compiler option that RETURNS the
// component CSS instead of emitting the injection. This script collects it and
// writes one real same-origin file the hub <link>s. The hub CSP is therefore
// BYTE-IDENTICAL to before this phase — no hash, no nonce, no relaxed directive,
// and specifically no 'unsafe-inline'.
//
// Both halves are ASSERTED, not hoped for (see audit() below): the emitted
// bundle is re-scanned for any surviving <style>-element construction and for
// `eval(` / `new Function(`, and every component that produced CSS must have
// its CSS present in the emitted stylesheet. A Svelte version bump that changes
// how styles are emitted breaks the BUILD, loudly, rather than the running app,
// silently.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO, 'renderer', 'hub', 'svelte');
const ENTRY = path.join(SRC_DIR, 'main.ts');
const OUT_JS = path.join(SRC_DIR, 'bundle.js');
const OUT_CSS = path.join(SRC_DIR, 'bundle.css');

// The one global the bundle publishes. Vanilla hub scripts reach Svelte through
// this and nothing else; see docs/phase-5/01-toolchain.md §3.
const GLOBAL_NAME = 'OrdinateSvelte';

// Electron 42 ships Chromium 140+. Same target as scripts/build-vendor.js.
const TARGET = 'chrome120';

function log(...args) { console.log('[build-svelte]', ...args); }

function kb(file) {
  return (fs.statSync(file).size / 1024).toFixed(1) + ' KB';
}

function need(name) {
  try {
    return require(name);
  } catch {
    throw new Error(
      `build-svelte: cannot load '${name}'. It is a devDependency of this repo — `
      + 'run `npm install`. (A production-only install cannot build the renderer; '
      + 'run this before packaging, which is what the predist:* scripts do.)',
    );
  }
}

function header(what, comment) {
  const open = comment === 'css' ? '/*' : '/*!';
  return [
    open,
    ` * ${what}`,
    ' * GENERATED FILE — DO NOT EDIT BY HAND.',
    ' * Regenerate with:  npm run build:svelte   (scripts/build-svelte.js)',
    ' */',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The esbuild plugin: compile .svelte, keep the CSS out of the JS.
// ---------------------------------------------------------------------------

/**
 * @param {Map<string, string>} cssByFile  filled in with each component's CSS
 * @param {{svelte: any, version: string}} sv
 */
function sveltePlugin(cssByFile, sv) {
  return {
    name: 'ordinate-svelte',
    setup(build) {
      build.onLoad({ filter: /\.svelte$/ }, (args) => {
        const source = fs.readFileSync(args.path, 'utf8');
        let out;
        try {
          out = sv.svelte.compile(source, {
            filename: path.relative(REPO, args.path),
            generate: 'client',
            // THE CSP-CRITICAL OPTION. 'injected' (the other value) makes the
            // component append a <style> element at runtime, which
            // `style-src 'self'` refuses. 'external' hands the CSS back here
            // instead, and this script writes it to a real file.
            css: 'external',
            dev: false,
          });
        } catch (err) {
          return {
            errors: [{
              text: (err && err.message) || String(err),
              location: err && err.start
                ? { file: args.path, line: err.start.line, column: err.start.column }
                : null,
            }],
          };
        }
        if (out.css && out.css.code && out.css.code.trim()) {
          cssByFile.set(args.path, out.css.code.trim());
        }
        return {
          contents: out.js.code,
          loader: 'js',
          resolveDir: path.dirname(args.path),
          warnings: (out.warnings || []).map((w) => ({
            text: `${w.code}: ${w.message}`,
            location: w.start
              ? { file: args.path, line: w.start.line, column: w.start.column }
              : null,
          })),
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Audits. Everything this build promises is re-checked against the OUTPUT.
// ---------------------------------------------------------------------------

// Any expression that installs a stylesheet the CSP would refuse. Matched
// STRUCTURALLY — by the DOM/CSSOM call actually being made — never by the name
// of a helper. Mirrors scripts/build-vendor.js: same threat, same shape of guard.
//
// DO NOT ADD `append_styles` HERE. Svelte 5.56.8 has TWO unrelated functions by
// that name and only one of them injects anything:
//
//   internal/client/dom/css.js       append_styles(anchor, css)
//       the real injector — `create_element('style')` + `head.appendChild`.
//       Only reachable when compiling with css: 'injected', and caught below by
//       the create_element("style") arm.
//   internal/shared/attributes.js    append_styles(styles, important)
//       a private STRING BUILDER for the `style:` directive. It concatenates
//       "key: value;" and the caller writes the result through CSSOM
//       (element.style), which the CSP does not govern. Perfectly legal.
//
// Matching the bare name made the FIRST `style:foo={bar}` in any component fail
// the build with a confident, wrong CSP error (reproduced: 3 sites, all the
// string builder, in an otherwise CSP-clean bundle).
const STYLE_ELEMENT_RE = new RegExp([
  // document.createElement("style") — and Svelte's own create_element("style").
  'create_?[eE]lement\\(\\s*["\'`]style["\'`]',
  // document.createElementNS(ns, "style")
  'createElementNS\\([^)]*,\\s*["\'`]style["\'`]',
  // d3 / Observable Plot style: selection.append("style") / .insert("style","*")
  '\\.(?:append|insert)\\(\\s*["\'`]style["\'`]',
  // CSSOM sheet injection. Svelte 4's style_manager.js installed keyframes with
  // insertRule(); Svelte 5 animates through the Web Animations API and must not
  // need either of these. If one appears, the css:'external' guarantee no longer
  // covers everything — re-derive before shipping.
  '\\.insertRule\\(',
  '\\badoptedStyleSheets\\b',
].join('|'), 'g');

// CSP has no 'unsafe-eval'. A bundler or a runtime CAN emit these.
const EVAL_RE = /\beval\(|new Function\(/g;

function audit(code, cssByFile, cssText) {
  STYLE_ELEMENT_RE.lastIndex = 0;
  const styleHits = code.match(STYLE_ELEMENT_RE) || [];
  if (styleHits.length) {
    throw new Error(
      "build-svelte: the emitted bundle can build a <style> element, which the hub CSP "
      + `(style-src 'self') refuses on every render — ${styleHits.length} site(s): `
      + [...new Set(styleHits)].join(', ')
      + "\nThe compiler is supposed to be emitting external CSS (css: 'external'). "
      + 'Either a Svelte version bump changed that, or a component/dependency '
      + 'injects styles by hand. Fix it — do NOT relax the CSP.',
    );
  }

  EVAL_RE.lastIndex = 0;
  const evalHits = code.match(EVAL_RE) || [];
  if (evalHits.length) {
    throw new Error(
      "build-svelte: the emitted bundle contains " + [...new Set(evalHits)].join(', ')
      + ", which `script-src 'self'` forbids (no 'unsafe-eval'). It would throw at "
      + 'runtime, not degrade. Find the source and remove it.',
    );
  }

  // Because the bundle no longer injects anything, bundle.css is the ONLY
  // source of component styles. A component whose CSS went missing here loses
  // its styling silently, so assert every collected block landed in the file.
  for (const [file, css] of cssByFile) {
    if (!cssText.includes(css)) {
      throw new Error(
        'build-svelte: the CSS compiled from ' + path.relative(REPO, file)
        + ' is missing from the generated bundle.css. The bundle does not inject '
        + 'it either, so those styles would simply be lost.',
      );
    }
  }

  if (!code.includes(`${GLOBAL_NAME} =`) && !code.includes(`${GLOBAL_NAME}=`)) {
    throw new Error(
      `build-svelte: the bundle never assigns window.${GLOBAL_NAME}. The vanilla `
      + 'hub scripts reach Svelte through that global and nothing else, so this '
      + 'bundle is unreachable.',
    );
  }
}

// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`build-svelte: no entry point at ${path.relative(REPO, ENTRY)}`);
  }

  const esbuild = need('esbuild');
  const svelte = need('svelte/compiler');
  const svelteVersion = require(path.join(REPO, 'node_modules', 'svelte', 'package.json')).version;

  // The "no CSP change needed" result is specific to Svelte 5, and not by luck:
  // Svelte 4's internal/client/dom/style_manager.js installs transition keyframes
  // with `sheet.insertRule(...)`, which `style-src 'self'` refuses — so
  // css: 'external' would NOT be sufficient there. Svelte 5 animates through the
  // Web Animations API instead. package.json pins ^5, and this makes a downgrade
  // (or a future major) fail loudly instead of quietly re-opening the blocker.
  const major = Number(String(svelteVersion).split('.')[0]);
  if (major !== 5) {
    throw new Error(
      `build-svelte: svelte@${svelteVersion} is not 5.x. The CSP analysis in `
      + 'docs/phase-5/01-toolchain.md was measured against Svelte 5 specifically '
      + "(Svelte 4 injects transition keyframes via CSSOM insertRule, which "
      + "style-src 'self' refuses). Re-verify against the real app before "
      + 'changing this pin.',
    );
  }

  const cssByFile = new Map();

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    // An IIFE assigning one global — byte-for-byte the same loading contract as
    // chart.umd.js and vendor/vgplot.js. No <script type="module">, so the
    // classic-script world around it is undisturbed.
    format: 'iife',
    globalName: GLOBAL_NAME,
    platform: 'browser',
    target: TARGET,
    // Not minified on purpose: this is OUR source, and a readable bundle in
    // devtools is worth more than ~40 KB. Revisit if the island count grows.
    minify: false,
    // No sourcemap: an inline one is a data: URL the CSP would have to allow,
    // and an external .map is excluded from the electron-builder `files` list.
    sourcemap: false,
    legalComments: 'none',
    conditions: ['browser'],
    mainFields: ['browser', 'module', 'main'],
    // The island renders the compiler version it was built with, so the running
    // app is self-evidencing about which toolchain produced it.
    define: { __SVELTE_VERSION__: JSON.stringify(svelteVersion) },
    plugins: [sveltePlugin(cssByFile, { svelte })],
    metafile: true,
    absWorkingDir: REPO,
    write: false,
    banner: {
      js: header(
        `Ordinate hub Svelte islands, bundled from renderer/hub/svelte/ `
        + `(svelte@${svelteVersion}).`,
      ),
    },
  });

  for (const w of result.warnings) log('warning:', w.text);

  const code = result.outputFiles[0].text;

  const components = [...cssByFile.keys()].map((f) => path.relative(SRC_DIR, f)).sort();
  const cssBody = [...cssByFile]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([file, css]) => `/* ${path.relative(SRC_DIR, file)} */\n${css}`)
    .join('\n\n');
  const cssText = header(
    `Scoped component styles compiled out of renderer/hub/svelte/*.svelte.\n`
    + ` * Svelte would normally inject these as an inline <style> at mount time,\n`
    + " * which the hub CSP (style-src 'self') refuses — a console error and a\n"
    + ' * securitypolicyviolation on EVERY mount. The build compiles with\n'
    + " * css: 'external' so nothing is injected, which makes this file the only\n"
    + ' * source of these rules. It MUST be linked wherever bundle.js is.',
    'css',
  ) + cssBody + (cssBody ? '\n' : '');

  audit(code, cssByFile, cssText);

  fs.mkdirSync(SRC_DIR, { recursive: true });
  fs.writeFileSync(OUT_JS, code);
  fs.writeFileSync(OUT_CSS, cssText);

  const inputs = Object.keys(result.metafile.inputs).length;
  log(`svelte ${svelteVersion}, ${inputs} modules bundled`);
  log(`wrote ${path.relative(REPO, OUT_JS)}   ${kb(OUT_JS)}`);
  log(`wrote ${path.relative(REPO, OUT_CSS)}  ${kb(OUT_CSS)}`
    + (components.length ? `  (${components.join(', ')})` : '  (no component styles)'));
}

main().catch((err) => {
  console.error('[build-svelte] FAILED: ' + ((err && err.message) || err));
  process.exit(1);
});
