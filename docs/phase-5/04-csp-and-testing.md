# Phase 5 — CSP risk and test strategy

**Owner:** CSP + testing. **Verdict: SAFE**, with named settings and two conditions.
Every claim below was produced by running code, not by reading documentation. The
experiments live in the session scratchpad, not the repo; the reproductions are
described inline so they can be re-run.

---

## 0. Baselines — verified before anything landed

| check | `develop` @ `b811700` | `feat/phase-5` base @ `69609df` |
|---|---:|---:|
| `npm test` | **3,267 ok / 0 fail** | **3,263 ok / 0 fail** |
| `npm run smoke` | **28 ok / 0 fail** | 23 assertions defined; not runnable as-shipped (B1) |
| `npm run build:ts` | green | green *only* with an isolated `tsBuildInfoFile` (B1) |

Both suites are green on `develop`. Phase 5 must not close below **3,267** and **28**.

### B1 — BLOCKER, environment: the worktree cannot build or test

`/Users/ashishb/Projects/ordinate-phase5/node_modules` is a **symlink to
`/Users/ashishb/Projects/ordinate/node_modules`**. Both `tsconfig.main.json` and
`tsconfig.renderer.json` put their incremental cache at
`node_modules/.cache/tsc/*.tsbuildinfo`, so the two checkouts **share one cache**, and
the paths recorded in it (`../../../renderer/hub/…`) resolve through the symlink to the
**main repo**. `tsc` therefore sees "everything up to date", emits **zero** `.js` into the
worktree, and exits 0. `npm test` then dies on the first line:

```
Error: Cannot find module '../renderer/hub/geoMatch'
```

`npm run build:ts` **reports success while doing nothing.** That is the same failure
shape this project keeps writing tests to prevent — a green check that proves nothing.

Fix (pick one, in order of preference):

1. `rm /Users/ashishb/Projects/ordinate-phase5/node_modules && npm ci` in the worktree —
   a real, independent `node_modules`.
2. Failing that, override the cache per invocation:
   `npx tsc -p tsconfig.renderer.json --tsBuildInfoFile <scratch>/renderer.tsbuildinfo`
   (this is how the 3,263 baseline above was obtained).

Do **not** "fix" it by deleting the shared cache; it grows back on the next build in
either checkout and the failure returns intermittently.

### B2 — the branch base is behind `develop` and would revert Phase 4 coverage

`feat/phase-5` is based on `69609df`, which is **two commits behind** `develop`:

```
68efc0d  chore: retire Leaflet, and cover the map path in the smoke test
b811700  test: let the smoke test get a WebGL context under xvfb
```

The worktree's `scripts/smoke-app.ts` carries **23** assertions against `develop`'s **28**:
it has **no map assertions** (map opens, MapLibre rendered, GL canvas has pixels, no
fallback message, choropleth markers) and no `--enable-unsafe-swiftshader`, without which
the map assertions fail under xvfb on CI while passing on any developer machine. Merging
Phase 5 from this base **deletes the Phase 4 MapLibre smoke coverage and un-retires
Leaflet.** Rebase onto `develop` before any further work.

---

## 1. The CSP verdict — SAFE, and why

The hub CSP is
`default-src 'none'; style-src 'self'; script-src 'self'; connect-src <3 OSM hosts>;
img-src data: file: <3 OSM hosts>`. **It needs no change.** No hash, no nonce, no
`'unsafe-inline'`, no `'unsafe-eval'`, no new directive.

### 1.1 The setting that does it

`compilerOptions.css: 'external'` (Svelte 5). This is not a workaround — it is the
compiler's default posture for a bundled build, and it *returns* the scoped CSS to the
build script instead of teaching the component to inject it. `scripts/build-svelte.js`
already sets it (line 112), writes the collected blocks to
`renderer/hub/svelte/bundle.css`, and that file is `<link>`ed like any other stylesheet.

This is structurally the **same solution Phase 3c used for Observable Plot** — move the
rules to a real same-origin file at build time so nothing is injected at runtime — but
strictly cheaper. Plot had to be *patched* (three `svg.append("style")` sites rewritten
to `void 0`, with four forced failure modes to prove the patch still applies). Svelte
needs no patch: it is a supported compiler option.

### 1.2 Measured, with a working negative control

A component exercising every runtime-style risk — scoped `<style>`, `transition:fade`,
`transition:slide`, `animate:flip` on a keyed `{#each}`, and a `style:` directive — was
bundled both ways and loaded in **real Electron** under the **exact hub CSP**, with a
`securitypolicyviolation` listener registered before the first byte:

| | `css: 'external'` | `css: 'injected'` *(control)* |
|---|---|---|
| mounted | yes | yes |
| scoped CSS applied (`padding`) | **4px** | **0px** — silently unstyled |
| `style:` directive | applied | applied |
| `<style>` elements in document | **0** | **1** |
| CSP violations | **0** | **1** — `style-src-elem <- inline` |
| console errors | **0** | 1 |

The control is the point: it fails loudly and in the expected way, so the `external`
column is evidence rather than an absence of evidence. This is the trap Phase 3c hit
twice (an audit that "scanned 0 inputs"; a screenshot of a splash screen).

### 1.3 Runtime injection: none remains, and the reason is version-specific

**Svelte 5 animates with the Web Animations API.** The bundle contains
`element.animate(keyframes, …)` and **zero** occurrences of `insertRule`,
`createElement('style')`, or `createElementNS(…, 'style')`. WAAPI is not governed by
CSP at all. Confirmed live: during a transition `document.getAnimations()` returned
**2**, during `animate:flip` **4** — the animations genuinely ran, they were not
skipped.

**Svelte 4 would not be safe by this route.** Its
`src/runtime/internal/style_manager.js` creates a `<style>` element and calls
`insertRule` for every CSS transition. That is CSP-legal in the letter (an empty
`<style>` plus CSSOM), but it would put a `<style>` element in the document and break
the invariant the smoke test already asserts. **Pin Svelte to 5.x and treat a major
bump as a CSP review.** The toolchain agent's `^5.56.8` matches the version tested here.

### 1.4 Everything else that could have needed a directive — checked, all absent

Scanned in the shipped bundle: `new Function(` **0**, `eval(` **0**, `blob:` **0**,
`WebAssembly` **0**, `new Worker` **0**, `importScripts` **0**,
`data:text/javascript` **0**, `setAttribute('style'` **0**. Verified in both
`dev: false` and `dev: true` builds. `svelte/compiler` itself also contains no
`new Function` — but it is build-time only and **must never be bundled into the
renderer** (runtime compilation would need `'unsafe-eval'` and is an instant BLOCKED).

The `style:` directive writes through `dom.style.cssText` and
`dom.style.setProperty(...)` — CSSOM, which `CLAUDE.md` already documents as allowed
(`element.style.x` IS allowed and used).

### 1.5 One live defect in `scripts/build-svelte.js` — a false positive that will stop the build

`STYLE_ELEMENT_RE` (line 151) treats the identifier **`append_styles`** as proof of
style injection. In Svelte 5.56.8 it is not. `append_styles` lives in
`svelte/internal/shared/attributes.js` and is a **string builder for the `style:`
directive** — it concatenates a style *string*, which `set_style` then assigns via
`dom.style.cssText`.

Demonstrated: the lab bundle that produced **0 `<style>` elements and 0 CSP violations
at runtime** contains `append_styles` **3 times**, purely because one component uses
`style:color={…}`. Run the repo's own audit regex against it and it reports 3 hits and
throws.

The current `renderer/hub/svelte/bundle.js` scores 0 only because no component uses a
`style:` directive **yet**. The first one that does will fail the build with an
authoritative-sounding CSP error that is wrong.

**Recommendation:** drop `append_styles` from `STYLE_ELEMENT_RE` and rely on the three
element-construction alternatives (which are the real signal), plus the runtime
assertion in §4. If a belt-and-braces static check is wanted, match
`append_styles(` **as a call whose result is appended to the DOM** rather than the bare
identifier — but the runtime `<style>`-count assertion already covers this correctly and
cannot produce a false positive. Keep `EVAL_RE` exactly as it is; it is right.

### 1.6 Conditions on the SAFE verdict

1. `css: 'external'` stays, Svelte stays on 5.x, and `svelte/compiler` never reaches the
   renderer bundle.
2. `bundle.css` is `<link>`ed on **every** page that loads `bundle.js`. Missing it is the
   `css:'injected'` column of §1.2 minus the violation: the app mounts, looks plausible,
   and is unstyled. **Nothing in the current test suite would catch that** — see §4.

---

## 2. Test strategy — no framework needed

Svelte components **are** node-runnable in this repo's plain-`assert` style. Two
mechanisms, both verified in bare Node with `typeof document === 'undefined'`:

### 2.1 SSR rendering — components, no DOM, no jsdom, no framework

`compile(src, { generate: 'server' })` + `render()` from `svelte/server` returns an HTML
string. Verified end to end: a `Card.svelte` taking `{rows, name}` rendered
`<div class="card svelte-70yxyu"><h3>Sales</h3><span class="rows">1,000,000 rows</span></div>`
— props, formatting and scoping all assertable with `assert.strictEqual`.

This covers the largest real risk in a port: **that a component renders the wrong text
for given inputs.** It needs zero new dependencies — `svelte` is already a devDependency.

### 2.2 Runes in bare Node

`compileModule()` on a `.svelte.js`/`.svelte.ts` module makes `$state`/`$derived` run
outside a browser. Verified: a `makeCounter(5)` with two `inc()` calls reported
`value === 7`, `doubled === 14`, with no DOM. **Shared UI state is directly testable.**

### 2.3 What genuinely cannot be tested this way

Event handlers, effects (`$effect`), lifecycle, focus/scroll, transitions actually
running, `window.hub` IPC round trips, and anything depending on layout. These need a
live DOM plus Svelte's scheduler. **That is the smoke test's job**, and it is already the
right tool — the repo's own history says so (a CSP violation survived 2,400 assertions
because nothing rendered the page).

### 2.4 Does this phase justify a test framework? No.

Nothing above needs Vitest, jsdom, or `@testing-library/svelte`. The smallest thing that
works is **three new plain-Node self-checks**, consistent with the existing 3,267:

| file | what it does | why |
|---|---|---|
| `scripts/test-svelteRender.ts` | `compile(generate:'server')` + `render()` over each component with fixture props | catches wrong output per props |
| `scripts/test-svelteState.ts` | `compileModule()` over each `.svelte.ts` state module | catches state-logic regressions |
| `scripts/test-svelteBundle.ts` | re-runs `build-svelte`'s CSP audits against the **emitted** `bundle.js`/`bundle.css` | catches a Svelte upgrade reintroducing injection |

Add each to the `npm test` chain. Total new dependencies: **zero**.

### 2.5 The generated-bundle wiring — one real gap

Unlike `vendor/vgplot.js`, the Svelte bundles are **generated and gitignored**, not
committed. That is the better choice here (vgplot's input is a pinned external package
that moves on a deliberate version bump; these bundles' inputs are first-party `.svelte`
files that change every working day, and a committed artifact would go stale silently).
It does mean the build wiring *is* the correctness guarantee.

`npm run build` = `build:ts && build:svelte` is already wired into `prestart`,
`predist:mac`, `predist:win`, `smoke` and `postinstall`. **`pretest` is the exception —
it still runs `build:ts` only.** So `npm test` executes with a stale or entirely absent
Svelte bundle. That is harmless today and stops being harmless the moment
`test-svelteBundle.ts` exists, since it would audit a file the test run never built.
**Point `pretest` at `npm run build`.**

The failure mode this creates is worth stating plainly, because it is measured and it is
invisible. With `bundle.js` present and `bundle.css` missing or stale, the app:

- mounts the component — **yes**
- renders the correct text — **yes**
- logs a console error — **no**
- raises a CSP violation — **no** (a `<link>` to an absent same-origin file fails quietly;
  `default-src 'none'` is not involved)
- adds a `<style>` element — **no**
- **is unstyled** — `padding` measured as `0px` where the component specifies `4px`

**Every assertion in the current smoke test passes in that state.** Only a
`getComputedStyle` check catches it, which is why §4.3 item 3 is non-negotiable.

---

## 3. The mirror-test trap

Phase 0 §5 named three. **Five renderer mirrors now exist**, and the situation is worse
than "they re-declare the helper" — for two of them the function under test **does not
exist anywhere in the source tree**.

Verified with `git grep` over tracked `renderer/`, `src/`, `main.js`:

| test file | asserts | helpers re-declared inline | real implementation |
|---|---:|---|---|
| `scripts/test-value-labels.ts` | 17 | `valueLabelKeys`, `chartHasPeriodDropdown` | `chartRender.ts`, `mapRender.ts`, `chartControls.ts` |
| `scripts/test-small-multiples.ts` | 18 | `chartIsSmallMultiple` | `chartControls.ts`, `chartRender.ts`, `renderResult.ts` |
| | | `visibleMiniCount` | **nowhere — already dead** |
| `scripts/test-more-charts.ts` | 19 | `canRenderType`, `needsText` | `renderResult.ts` |
| `scripts/test-palette.ts` | 15 | `paletteFromSeed`, `interpolatePalette` | `chartRender.ts` |
| `scripts/test-map-capture.ts` | 5 | `captureBox` | **nowhere — already dead** |
| | **74** | | |

**74 of the 3,267 assertions — 2.3% of the suite — are testing nothing but themselves**,
and 69 of those shadow helpers that still exist and are about to be ported.

`scripts/test-readiness-gate.ts` is a sixth mirror (6 asserts; `executionReady`,
`byokConnected` shadow `src/config.ts`) but its subject is main-process and **survives
this phase untouched**. Worth fixing; not Phase 5's problem.

**Why Phase 5 makes it acute:** the three live mirrors shadow helpers in
`chartRender.ts`, `chartControls.ts` and `renderResult.ts` — precisely the files a
renderer port rewrites or deletes. Those 69 assertions will stay green through the
entire phase no matter what happens to their subjects, and today a `.ts` helper is at
least *theoretically* importable. Once it moves inside a `.svelte` file it is
**permanently** un-importable from Node, and the mirror becomes the only surviving
description of the behaviour — indistinguishable from a real test.

### 3.1 The three patterns that do work — copy these, don't invent

- **Dual export** (`renderer/hub/geoMatch.ts`): an IIFE ending in
  `if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.x = x;`.
  Node `require()`s it, the hub loads it as a `<script>`. This is why
  `test-geo-match.ts` and `test-geoLevels.ts` are honest tests. With a bundler in the
  tree, a plain ESM `export` is simpler and equivalent.
- **`vm` sandbox over the real emitted file** (`scripts/test-plotSpec.ts`): reads the
  actual emitted `plotRender.js` and executes it in a sandbox with stub browser globals.
  The house pattern for DOM-adjacent renderer code that cannot be imported.
- **Source-text assertion** (`scripts/test-viz-icons.ts`): `readFileSync` on
  `renderer/hub/renderResult.js` and regex-parses it. This one **rots loudly** — the
  moment `renderResult` becomes a component the read throws `ENOENT` and `npm test`
  fails. That is the correct behaviour. **Do not "fix" it by pointing the regex at a
  `.svelte` file**; convert it to §3.2 instead.

### 3.2 The structural rule for the port

> **A `.svelte` file must contain no logic worth testing.**

Anything with a branch, a threshold, a format, or a name-mapping goes in a sibling plain
`.ts` (or `.svelte.ts` for runed state) that the component imports. The component keeps
markup, wiring and event handlers. Then:

- logic module → plain-Node `require()`, exactly like `geoMatch.ts`;
- component output → SSR `render()` (§2.1);
- interaction → smoke test (§4).

**Concretely, before any of these files is ported:** extract `valueLabelKeys`,
`chartHasPeriodDropdown`, `chartIsSmallMultiple`, `canRenderType`, `needsText`,
`paletteFromSeed` and `interpolatePalette` into an importable module, repoint the five
mirror tests at it, and **fix any assertion that then fails** — a mirror that has drifted
from its subject is exactly what this exercise is for. Delete the two dead ones
(`visibleMiniCount`, `captureBox`) or write the function they describe. Do this
**first**, as its own commit, while the vanilla implementations are still present to
diff against. After the port there is nothing left to check the mirrors against.

---

## 4. How the smoke test must grow

`scripts/smoke-app.ts` is the only check that runs the app, and for a hybrid
vanilla+Svelte hub it is the only thing standing between a broken mount and a release.

### 4.1 Fix the listener-ordering gap first — measured, not theoretical

Lines 43–52 attach the error listeners **after** `firstWindow()` and
`waitForLoadState('domcontentloaded')`. **Console errors and CSP violations from the
first page load are silently dropped.** Demonstrated: the same violating page reported
**0** console errors with listeners attached in that order, and **1** with them attached
before the load.

The file survives this today only because it later calls `win.reload()` (line 175) with
listeners live, and because of the explicit `<style>`-count assertion. Neither is
guaranteed to cover a Svelte mount failure at first paint.

**Fix, verified working with `_electron`:** register a collector with
`win.addInitScript()`, which runs before any page script and re-runs on every
navigation:

```ts
await win.addInitScript(() => {
  (window as any).__csp = [];
  document.addEventListener('securitypolicyviolation', (e) =>
    (window as any).__csp.push(e.violatedDirective + ' ' + (e.sample || '').slice(0, 60)));
});
```

Verified: survives navigation and captured the first-byte `style-src-elem` violation that
`win.on('console')` missed. Also move the `win.on('console')`/`win.on('pageerror')`
attachment up to immediately after `firstWindow()`, and assert
`window.__csp.length === 0` at the end alongside the existing `errors.length === 0`.

### 4.2 Promote the `<style>`-count assertion out of the Mosaic block

Line 283 asserts `document.querySelectorAll('style').length === 0`, but only inside the
Phase 3c section. It is now a **whole-app invariant** covering two independent stacks.
Assert it after **every** navigation, not once.

### 4.3 Per-ported-screen assertions

For each screen, in this order. Use `waitForFunction`, never a fixed sleep — the lesson
already paid for at line 257.

1. **The island mounted.** Its root exists and is non-empty.
2. **A compiled Svelte component rendered it** — an element carrying a
   `class*="svelte-"` scope hash. This is the exact analogue of
   `svg[class*="plot-"]` proving vgplot drew rather than Chart.js, and it distinguishes
   a real mount from leftover vanilla markup or a fallback.
3. **The scoped CSS actually applied** — `getComputedStyle` on a known property that the
   component's own stylesheet sets and `hub.css` does not. **This assertion is
   non-negotiable and has no substitute.** §2.5 measured the failure it catches: with
   `bundle.css` absent or stale, the component mounts, renders correct text, throws
   nothing, logs nothing, and is unstyled. Every other check on this list passes.
4. **Real content, not an empty shell** — the screen's actual data reached the DOM (the
   `marks > 0` idea: a mounted-but-empty component is the Svelte version of a blank
   canvas).
5. **The vanilla neighbours still work** — during a hybrid port the regression risk is
   coexistence: duplicated event listeners, a global clobbered by the bundle's IIFE,
   `hub.css` and `bundle.css` fighting over specificity. Re-assert at least one
   pre-existing vanilla element on the same page after the island mounts.
6. **No console error and no CSP violation** for that screen (§4.1).

### 4.4 Keep the existing 28

None of the current assertions should be relaxed. If a ported screen makes one
unreachable (e.g. a selector changes), **repoint it — do not delete it.** Phase 0's
"never delete a failing assertion" rule applies with full force here, because a Svelte
port gives a plausible-sounding excuse to drop almost any DOM assertion.

---

## 5. Rollback

Rollback must work at three grains, because a packaged-build regression is discovered
after the fact and usually on one screen.

**Per screen — the one that matters.** Each island is mounted from exactly one call
site. Keep those in a **single registry module** mapping screen → mount function, and
keep the **vanilla implementation in the tree, not deleted**, until the phase is verified
in a packaged build. Reverting one screen is then a one-line change in the registry plus
`npm run build:svelte` — no unwinding, no conflict with the other ported screens. This is
the whole reason to prefer the island architecture over a big-bang port, and it only
holds if the mount sites stay centralised and the vanilla code stays present.

**Per screen at runtime.** Follow the repo's established idiom — `localStorage 'scMosaic'`,
`'scAllCharts'` — with a per-screen key and a global kill switch
(e.g. `scSvelte = '0'` forces every screen back to vanilla). Costs nothing, and lets a
user or a bug report isolate a regression without a rebuild. Note this is a *diagnostic*
lever, not a release lever: a shipped build still needs the code change above.

**Per commit.** One commit per ported screen, each independently revertable, each
carrying its own smoke assertions from §4.3. Do **not** batch screens. Reverting is clean
here precisely because the bundles are gitignored and regenerated (§2.5) — a revert
touches only source, and the next `npm run build` produces a matching bundle. That
property holds **only** while every entry point that runs the app runs `npm run build`
first; `pretest` currently does not.

**Whole phase.** Phase 3c's precedent — ship dark, default off — applies. Default each
screen off, flip it on only after that screen passes §4.3 in a *packaged* build
(`npm run dist:mac`), not just `npm start`. The asar path differences that bit MapLibre's
worker are exactly the class of bug that only appears there.

---

## 6. Summary

- **CSP: SAFE.** `css: 'external'` + Svelte 5.x. The current CSP is untouched — no hash,
  no nonce, no `'unsafe-inline'`, no new directive. Measured in real Electron against the
  real CSP with a negative control. Svelte 5's WAAPI transitions are what makes this
  true; Svelte 4 would not qualify.
- **Two blockers, both environmental, both outside my remit to fix:** the worktree's
  symlinked `node_modules` breaks `build:ts` silently (B1), and the branch base is two
  commits behind `develop` and would revert Phase 4's map smoke coverage (B2).
- **Two live defects in landed Phase 5 work:** `build-svelte`'s `append_styles` check is
  a false positive that will stop the build on the first `style:` directive (§1.5), and
  `pretest` runs `build:ts` rather than `build`, so `npm test` executes without a Svelte
  bundle (§2.5).
- **No test framework needed.** SSR `render()` and `compileModule()` make components and
  runed state testable in bare Node; three new plain-assert self-checks and zero new
  dependencies.
- **Five mirror tests — 74 assertions, 2.3% of the suite — will rot silently** unless
  their helpers are extracted *before* the files they live in are ported (§3.2).
- **The smoke test needs a listener-ordering fix, a promoted `<style>` assertion, and a
  computed-style check per screen** — that last one catches the only Svelte failure mode
  that is otherwise completely silent.
