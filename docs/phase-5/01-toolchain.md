# Phase 5 · 01 — Toolchain spike: getting Svelte into a repo with no bundler

**Status:** shipped as a working spike on `feat/phase-5`. The hub renders one real Svelte
component alongside the existing vanilla UI.
**CSP verdict:** **RESOLVED, not relaxed.** The hub CSP is byte-identical to `develop` — no hash,
no nonce, no `'unsafe-inline'`.
**Verified:** `npm run build` ✓ · `npm test` (all self-checks, unchanged) ✓ · `npm run smoke`
(real Electron, fails on *any* renderer console error) ✓ · `electron-builder --mac dir` ✓ ·
a dedicated island harness with 16 assertions ✓ (§8).

---

## 0. The problem, stated exactly

`npm run build:ts` is plain `tsc` with **in-place sibling emit**: `foo.ts` → `foo.js` in the same
directory, loaded by `<script src>`. Every renderer file is a **classic script**, so all 23 of them
share one global scope and resolve each other's symbols at call time. There is no bundler, and
[phase 3](../phase-3/README.md) treated that as a feature, not an accident.

Svelte cannot live there. A `.svelte` file is not JavaScript, and what the compiler emits imports
`svelte/internal/client` by **bare specifier**, which a browser cannot resolve. The two
bundler-free escapes are the same two [phase 3c](../phase-3c/README.md) already ruled out for
vgplot: an inline `<script type="importmap">` is inline script (`script-src 'self'` blocks it), and
rewriting bare specifiers by hand *is* a bundler.

So a bundler is not optional. The question is which one, and how it coexists with the 23 scripts
for the duration of a phased migration.

---

## 1. Bundler: **esbuild**

Not Vite. Not Rollup.

### Why not Vite

Vite's entire value proposition is the dev server: native-ESM serving plus HMR. Ordinate's renderer
loads from `file://` under `default-src 'none'`. To point the hub at a Vite dev server you would
need, in the shipped `index.html`:

- `script-src http://localhost:5173` — a second origin, and a *network* origin, in an app whose
  README promises no surprise network calls;
- `connect-src ws://localhost:5173` for the HMR socket;
- an allowance for Vite's injected client (`@vite/client` is a module script Vite adds to the
  document).

That is a dev-only CSP that differs from the shipped one. Maintaining two CSPs is precisely how
`'unsafe-inline'` ends up in a release: the dev copy is the one people iterate against, and drift
is invisible until something breaks in production. Given that [phase 3c §2](../phase-3c/README.md)
went to the length of patching a third-party library's source rather than add a single hash to this
CSP, spending it on developer ergonomics is not a trade this repo makes.

And Vite's *production* build is Rollup + esbuild anyway. Using `build.lib` with
`formats: ['iife']` would produce the same artifact this spike produces — via a larger dependency
tree, a config file, and a framework plugin, to reach an identical output. HMR is the only thing
you actually buy, and it is the one thing the CSP will not let you have.

### Why not Rollup

Rollup would work and would emit the same IIFE. It needs `@rollup/plugin-node-resolve`,
`rollup-plugin-svelte`, and a CSS-emit plugin to do what **40 lines** of hand-written esbuild
plugin do here (`scripts/build-svelte.js`), i.e. three more third-party build dependencies for a
repo whose stated policy is "ask before adding runtime dependencies — prefer stdlib". Its one real
advantage over esbuild — better tree-shaking — is worth nothing on a 50 KB bundle.

### Why esbuild

1. **The repo already trusts it.** `scripts/build-vendor.js` bundles vgplot with esbuild today. Same
   tool, same `format: 'iife'` + `globalName` contract, same `metafile`-driven audits, same
   `target: 'chrome120'`. A reviewer who understands one understands the other.
2. **Its natural output is exactly the artifact this repo already loads.** One IIFE assigning one
   global, dropped in as `<script src>` next to `chart.umd.js` and `vendor/vgplot.js`. No
   `type="module"`, so the classic-script world around it is undisturbed.
3. **The Svelte plugin is ours.** `svelte/compiler`'s `compile()` is a pure function; wiring it to
   an `onLoad` hook is ~40 lines. That keeps the CSS-extraction decision (§3), which is the
   CSP-critical one, in this repo rather than inside `esbuild-svelte`/`rollup-plugin-svelte`, where
   a minor version bump could silently switch it back to injected styles.
4. **Speed.** Full cold bundle: **82 ms** (unminified) / **17 ms** (minified), measured on an M4.
   That is small enough to bolt onto `prestart` without anybody noticing.

### Cost, measured

| | |
|---|---|
| new **devDependencies** in `package.json` | `svelte@^5.56.8` (5.x is **required** — see §3), `esbuild@^0.25.12` |
| packages physically added to `node_modules` | **23** (svelte + 20 transitive, esbuild + 1 platform binary) |
| disk | ~15 MB, of which **9.5 MB is `@esbuild/darwin-arm64`** (one binary per platform; only the host's installs) |
| new **runtime** dependencies | **none** — the Svelte runtime is compiled into the bundle; neither package is shipped (§6) |
| bundle emitted | `renderer/hub/svelte/bundle.js` **162 KB** (52 KB minified, 20 KB gzipped) + `bundle.css` 2.4 KB |

The bundle is deliberately **not minified**: it is our own source, a readable stack trace in
devtools is worth more than 110 KB inside an asar, and there is no network transfer. Flip
`minify: true` in `scripts/build-svelte.js` if that ever stops being true.

---

## 2. Coexistence: islands over a shared global scope

The bundle publishes **exactly one global**, `window.OrdinateSvelte`, from
`renderer/hub/svelte/main.ts`. Everything crosses at that seam or at `window.hub` (the existing
preload bridge). There is no event bus and no shared store — those would be a second migration to
undo later.

`renderer/hub/index.html` grows exactly three lines: a `<link>` for `svelte/bundle.css`, an empty
host `<div id="svelte-island-host">`, and `<script src="svelte/bundle.js">` **last**, after
`hub.js`. Nothing else about the hub changed. **No existing renderer `.ts` file was touched.**

### vanilla → Svelte

`window.OrdinateSvelte.mountIsland(hostElOrId, props)` mounts a component and returns the
component's **instance exports** (Svelte 5's `mount()` returns them), so a classic script can call
into a live component:

```js
window.OrdinateSvelte.mountIsland('svelte-island-host').setNote('hello');   // verified
```

`unmountIsland(host)` tears it down. Idempotent both ways: a second `mountIsland` on the same host
returns the existing handle rather than double-mounting.

### Svelte → vanilla — and the one fact that will bite someone

There are **three** kinds of "global" in this renderer, and they do not behave the same:

| what | example | reachable from the bundle as | on `window`? |
|---|---|---|---|
| preload bridge | `window.hub.listProjects()` | `window.hub.*` | yes |
| a script's explicit assignment | `normalizeName` (geoMatch.js assigns it inside an IIFE) | `window.normalizeName` **or** bare | yes |
| a script's top-level `const`/`let`/`class` | `VIZ_LABELS`, `SHAPE_CHARTS`, `VIZ_ICONS` (renderResult.ts) | **bare identifier only** | **no** |

The third row is the trap. A classic script's top-level `const` goes into the **global lexical
environment**, which is in the scope chain of every script in the realm — including code inside the
bundle's IIFE — but is *not* a property of `window`. So `VIZ_LABELS` resolves and
`window.VIZ_LABELS` is `undefined`. The spike renders both facts on screen and the harness asserts
them:

```
VIZ_LABELS: 28 chart types (on window: false)
normalizeName("Roanoke County") -> "roanoke"
```

Two consequences for anyone porting a panel:

- **Read globals at call time, never at module init.** The global lexical environment is
  TDZ-sensitive: a bare read before the defining `<script>` has executed throws `ReferenceError`,
  not `undefined`. This is the same call-time-resolution discipline the classic scripts already
  follow among themselves, so it is not a new rule — but a bundled module *looks* like it should be
  able to hoist, and it cannot.
- **`<script src="svelte/bundle.js">` must stay last in `index.html`.** That is what makes call-time
  and init-time equivalent in practice. It is a property of the HTML, not of Svelte, so `main.ts`
  also guards on `document.readyState`.

Neither direction gives you *reactivity* across the boundary. A Svelte rune does not observe a
mutation made by `hub.js`, and vice versa. Passing state across the seam is deliberately out of
scope here — see `03-state-ipc.md`.

### The honest cost of this model

- **Two mental models in one window, for the whole phase.** A reviewer reading `renderer/hub/` sees
  files where `import` is forbidden and files where it is mandatory, distinguished only by
  directory. The `tsconfig.renderer.json` `exclude` is the only thing enforcing it.
- **Three TypeScript configs** where there were two, and the new one (`tsconfig.svelte.json`) emits
  nothing, which is unlike everything else in this repo.
- **Two build steps** (`build:ts`, `build:svelte`), so ten `package.json` scripts had to learn about
  the second. Miss one and you ship a stale bundle silently — the only reason this is survivable is
  that `npm run smoke` boots the real app and fails on any console error.
- **The seam is not type-checked end to end.** `window.OrdinateSvelte` has no ambient declaration in
  `renderer/hub/globals.d.ts`, and the bundle's view of `VIZ_LABELS` is `any`. Both worlds compile;
  neither checks the other.
- **A partially-migrated panel is worse than either end state.** Half a panel in Svelte and half in
  `dashboards.ts` means two owners of the same DOM subtree. Port at panel granularity, and pick
  panels whose DOM no vanilla file reaches into.

---

## 3. CSP: resolved at build time, exactly like phase 3c

**The blocker is real.** Svelte's default is to append the component's scoped `<style>` at runtime.
Forced, and measured in the running app:

```
console error : Applying inline style violates the following Content Security Policy directive
                'style-src 'self''. … The action has been blocked.
securitypolicyviolation : style-src-elem <- inline
computed style : border-radius 0px, padding 0px      (the component renders UNSTYLED)
```

That is a console error **on every mount**, which alone fails `npm run smoke`.

**The fix is one compiler option.** `scripts/build-svelte.js` compiles with `css: 'external'`, so
the compiler *returns* the scoped CSS instead of emitting the injection. The build concatenates it
into `renderer/hub/svelte/bundle.css`, which `index.html` `<link>`s as a real same-origin file.
Nothing is injected, so nothing is refused, so the CSP needs no change.

**This result is specific to Svelte 5, and not by luck.** Svelte 4's
`internal/client/dom/style_manager.js` installs transition keyframes with `sheet.insertRule(...)`,
which `style-src 'self'` also refuses — `css: 'external'` would *not* be sufficient there. Svelte 5
animates through the Web Animations API instead. `package.json` pins `^5`, and the build throws on
any other major (§3.2), so a downgrade cannot silently re-open the blocker.

This is the same resolution phase 3c reached for Observable Plot — extract to a static file at build
time — but **strictly cheaper**: Plot had to have three injection sites patched out of a third-party
library's source by a regex-driven esbuild transform, guarded against version drift. Svelte supports
external CSS as a first-class option. There is no third-party source patching in this phase.

**Verified in the real app** (§8): zero `securitypolicyviolation` events, zero console errors,
`document.querySelectorAll('style').length === 0`, and `bundle.css` present in
`document.styleSheets` with the scoped rules actually applied (`border-radius: 8px`,
`padding: 10px 11px` on `.island.svelte-2hxy45`). `npm run smoke` independently asserts the same
`0 <style> elements` invariant it added in phase 3c.

### 3.1 The guard

Following house style, the promise is re-checked against the **output**, not assumed.
`scripts/build-svelte.js` fails the build (exit 1) if the emitted bundle contains:

- any `<style>`-element construction — `createElement("style")`, Svelte's own
  `create_element("style")`, `createElementNS(…, "style")`, `.append("style")` / `.insert("style")`;
- CSSOM sheet injection — `.insertRule(` or `adoptedStyleSheets` (this is the Svelte-4 shape above,
  and would also catch a dependency that hand-rolls a stylesheet);
- `eval(` or `new Function(` (`script-src 'self'` has no `'unsafe-eval'`);
- CSS compiled from a component that did not make it into `bundle.css` (which would be a *silent*
  loss of styling now that nothing injects);
- an output that never assigns `window.OrdinateSvelte`.

Forced and confirmed: flipping `css: 'external'` → `'injected'` fails with
`the emitted bundle can build a <style> element … 1 site(s): create_element("style"`. A Svelte
version bump that changes this breaks the **build**, loudly, instead of the running app, silently.

### 3.2 A guard that was itself wrong — recorded, not hidden

The first version of `STYLE_ELEMENT_RE` matched the **helper name** `append_styles`, copying the
shape of `build-vendor.js`'s Plot guard. That was a defect, and a nasty one:

> **Svelte 5.56.8 contains two unrelated functions called `append_styles`.**
> `internal/client/dom/css.js` → the real injector (`create_element('style')` + append to
> `document.head`), reachable only with `css: 'injected'`.
> `internal/shared/attributes.js` → a private **string builder** for the `style:` directive. It
> concatenates `"key: value;"` and the caller writes it through CSSOM (`element.style`), which the
> CSP does not govern at all.

Reproduced: adding a single `style:opacity={…}` to the component pulls the string builder in and the
guard failed a perfectly CSP-clean bundle with `3 site(s): append_styles` — a confident, authoritative,
**wrong** CSP error that the first person to write a `style:` directive would have hit.

The guard now matches **structurally** — the DOM/CSSOM call actually being made — and never a
helper name. And `Island.svelte` deliberately keeps a `style:` directive so the string builder stays
in the bundle: the regression cannot come back without the build proving it is fine.

Two lessons, both cheap to state and expensive to rediscover: an audit written against
*third-party names* is only as stable as those names, and **a guard needs its own negative control
in both directions** — one input it must reject (`css: 'injected'`) and one it must accept
(`style:` directives). The first version had only the former, which is exactly why it passed review
in my own head.

### 3.3 The version pin, enforced

`build-svelte.js` throws if `svelte` is not `5.x`, quoting the Svelte-4 `insertRule` reason. The
caret range in `package.json` expresses the same intent; the build assertion is what makes it a
gate rather than a preference.

### Things that are *not* CSP problems, checked

- Svelte 5 sets style directives via `element.style.setProperty` — a JS property write, which the
  CSP does not govern (and which `CLAUDE.md` already documents as allowed).
- Svelte's static-markup fast path uses `<template>.innerHTML`. CSP does not block `innerHTML`;
  only Trusted Types would, and this app does not set `require-trusted-types-for`.
- No `blob:`, no worker, no `wasm-unsafe-eval`, no new host. The bundle is same-origin `file:`
  under the existing `script-src 'self'`.

---

## 4. What was built

```
renderer/hub/svelte/
  Island.svelte        the spike component (source, committed)
  main.ts              entry — publishes window.OrdinateSvelte (source, committed)
  svelte-shims.d.ts    `declare module '*.svelte'` for tsc (source, committed)
  bundle.js            GENERATED, gitignored
  bundle.css           GENERATED, gitignored
scripts/build-svelte.js  the build (hand-written .js, no .ts sibling — same
                         exception as scripts/build-vendor.js)
tsconfig.svelte.json     type-check only, emits nothing
```

`Island.svelte` is not decoration. Each thing it renders is a probe that the harness asserts:

| probe | proves |
|---|---|
| it renders at all, with `.island.svelte-2hxy45` styling | compiled component + external CSS under the real CSP |
| `Tick → 3 (odd)` | `$state`/`$derived` runes, no dev runtime |
| `Count projects → 0` | Svelte → main over `window.hub`, under `contextIsolation: true` |
| `VIZ_LABELS: 28 chart types (on window: false)` | the global-lexical-scope rule in §2 |
| `normalizeName("Roanoke County") -> "roanoke"` | a window-assigned vanilla global |
| `from vanilla: …` | vanilla → Svelte via the instance export returned by `mount()` |
| the marker dot's `style:opacity` | keeps Svelte's `append_styles` **string builder** in the bundle, so the §3.2 guard regression cannot return unnoticed |

It is hosted on the **home view** (`#svelte-island-host`, above the project gallery) because that is
the first screen `npm start` shows. That placement is spike scaffolding, not a design decision —
the real migration targets the workspace panels. **Replace this component with the first ported
panel, but keep the six probes somewhere until the migration is done.**

---

## 5. Emit and `.gitignore`

The bundler emits **two** files, both into `renderer/hub/svelte/`, both generated on every build,
both carrying a `GENERATED FILE — DO NOT EDIT BY HAND` banner.

`.gitignore` gained four lines:

```gitignore
!/scripts/build-svelte.js          # hand-written build tool, no .ts sibling — same
                                   # exception as scripts/build-vendor.js
/renderer/hub/svelte/bundle.js
/renderer/hub/svelte/bundle.css
```

Notes:

- `bundle.js` was **already** covered by the blanket `renderer/**/*.js`; it is listed explicitly
  because this repo's convention is one explicit entry per emitted file.
- `bundle.css` genuinely needed a new entry. Until now **every `.css` file in this repo was
  hand-written source**, so no rule existed for generated CSS. This is the first.
- `scripts/build-svelte.js` needs the **negation**, because `scripts/**/*.js` assumes every `.js`
  under `scripts/` is tsc output. It is not: like `build-vendor.js`, it must run without a
  TypeScript build already existing.
- Unlike `vendor/vgplot.js`, the bundle is **not committed**. That was right for vgplot — committing
  it keeps CI off a 181 MB dependency tree that is in nobody's `package.json`. It is wrong here:
  `bundle.js` is our own source recompiled on every change, so committing it would put a 158 KB
  binary-ish diff in every PR and guarantee it goes stale.

Also added: `.prettierignore` entries for the two generated files and for `*.svelte` (Prettier
cannot parse `.svelte` without `prettier-plugin-svelte`, which this phase did not install;
`lint.yml` is `continue-on-error`, so this is tidiness, not a gate).

### `package.json` scripts

```jsonc
"build:ts":         "tsc -p tsconfig.main.json && tsc -p tsconfig.renderer.json",  // UNCHANGED
"typecheck:svelte": "tsc -p tsconfig.svelte.json",
"build:svelte":     "npm run typecheck:svelte && node scripts/build-svelte.js",
"build":            "npm run build:ts && npm run build:svelte",
```

`build:ts` is **untouched**, so main-process compilation cannot regress. Everything that produces
or runs the app moved to `build`: `prestart`, `pretest`, `postinstall`, `smoke`, `predist:mac`,
`predist:mac:unsigned`, `predist:win`. `bench:*` stayed on `build:ts`, since the benchmarks time
main-process query paths and have nothing to do with the renderer.

`pretest` was initially left on `build:ts` — the self-checks are pure main-process logic, so making
`npm test` depend on a renderer bundler looked like the wrong coupling. That was wrong in practice:
it means `npm test` runs against **whatever `bundle.js` happens to be on disk**, including none at
all on a clean checkout, so the moment a self-check touches the island path it would pass or fail
for reasons unrelated to the commit. One build entry point, always current, is worth the ~100 ms.

`typecheck:svelte` is folded into `build:svelte` rather than added to `ci.yml`, so it runs wherever
the bundle is built (including `npm ci` → `postinstall`) without this phase editing a workflow file
that other work may also be touching. CI therefore type-checks and builds the islands in **both**
jobs today. An explicit step in `ci.yml` would be clearer and is worth adding later.

### `tsconfig.renderer.json`

One line: `"exclude": ["renderer/hub/svelte/**"]`. Without it, `tsc` compiles the island sources
into stray sibling `.js` files, and — worse — their `import` statements turn those files into
modules inside the program that every classic renderer file relies on being script-scoped.

---

## 6. Packaging

**Verified by actually packaging:** `electron-builder --mac dir` (ad-hoc signed, `afterPack` and
`afterSign` hooks ran), then listing the asar.

| in `app.asar` | |
|---|---|
| `renderer/hub/svelte/bundle.js` | ✅ present |
| `renderer/hub/svelte/bundle.css` | ✅ present |
| `Island.svelte`, `main.ts`, `svelte-shims.d.ts` | ❌ excluded (source) |
| `node_modules/svelte`, `node_modules/esbuild`, `@esbuild/*` | ❌ **0 entries** |

One line was added to `build.files`: `"!**/*.svelte"`. The existing list already excluded `**/*.ts`
and `tsconfig*.json` (which covers `tsconfig.svelte.json`), and `**/*` already picked up the two
generated files with no change.

Nothing was needed to keep `svelte`/`esbuild` out: electron-builder prunes `devDependencies` from
`node_modules` unconditionally, and the Svelte **runtime is compiled into `bundle.js`** — there is
no runtime package to ship. That is the payoff of `format: 'iife'` over an ESM build.

The one hard requirement is ordering: **`bundle.js` must exist before `electron-builder` runs**,
because it is gitignored and therefore absent from a clean checkout. That is why all three
`predist:*` scripts now call `npm run build` instead of `npm run build:ts`. Get this wrong and the
symptom is a shipped app with a 404 on `svelte/bundle.js` — no build error, just a missing island.

---

## 7. Known gaps, stated rather than hidden

1. **The `<script>` block inside a `.svelte` file is not type-checked.** esbuild strips types
   without checking them, and `tsc` cannot read `.svelte`. `tsconfig.svelte.json` checks only the
   `.ts` glue; `svelte-shims.d.ts` types every `*.svelte` import as a component with `any` props.
   Closing this needs `svelte-check` (+ `svelte2tsx` + the language server) — a further dependency
   this phase did not take. **It should be taken before the first non-trivial panel is ported**,
   because until then a typo inside a component surfaces at runtime, not at build.
2. **No hot reload.** Edit a component, re-run `npm run build:svelte` (~100 ms), reload the window.
   This is the cost of the Vite decision in §1 and it is accepted deliberately.
3. **`.svelte.js` / `.svelte.ts` rune modules are not wired up.** They need `compileModule()`, not
   `compile()`. Trivial to add when something needs one; not added speculatively.
4. **No source map.** An inline map is a `data:` URL the CSP would have to allow; an external `.map`
   is already excluded from the packaged `files`. The bundle ships unminified instead, which gives
   readable stack traces without either.
5. **Nothing stops a second bundle appearing.** The one-global rule is a convention enforced by an
   assertion in the build, not by the type system.
6. **`window.OrdinateSvelte` has no ambient declaration** in `renderer/hub/globals.d.ts`. Adding one
   means editing a file this spike deliberately did not touch; it belongs in the first real port.

---

## 8. The other four windows

**They stay vanilla, and that is sustainable — indefinitely.**

| window | renderer | size |
|---|---|---|
| overlay | `overlay.ts` + `overlay.css` | drag-box selector over a frozen frame |
| status | `status.ts` + `status.css` | a few lines of state text |
| about | `about.ts` + `about.css` | static content |
| permission | `permission.ts` + `permission.css` | one explanatory panel with two buttons |

Each is a single `.ts` file with its own CSP, its own preload bridge, and effectively no state.
There is nothing for a component framework to earn there: no lists, no derived values, no
cross-file DOM ownership. The reason to move the **hub** is that `dashboards.ts` is 67 KB and
`hub.ts` is 86 KB of manual DOM bookkeeping; none of that applies to a 5 KB status readout.

The toolchain does not force the issue either way. Each window's `index.html` is independent, so a
second entry point in `scripts/build-svelte.js` and one more `<script src>` would island-ify any of
them later — but doing it now would add a bundle to four windows that do not need one, and every
one of them would need the `<link>` for its own generated CSS or silently render unstyled.

The one thing to keep an eye on: the **overlay** is on the capture hot path and is deliberately
minimal. Do not put a 50 KB runtime in front of a hotkey.

---

## 9. Verification

Reproduce:

```bash
npm install          # svelte + esbuild are devDependencies
npm run build        # tsc (unchanged) + the svelte bundle
npm start            # the island renders on the Projects screen
npm test             # unchanged — main-process self-checks, still on build:ts only
npm run smoke        # real Electron; fails on ANY renderer console error
```

A dedicated harness drove the real app and asserted, all passing:

```
ok   global exposed
ok   global api  version=5.56.8
ok   island rendered  "island svelte-2hxy45"
ok   scoped class applied
ok   external CSS applied  {"r":"8px","p":"10px 11px"}
ok   bundle.css is a real stylesheet  [theme.css, hub.css, maplibre-gl.css, plot.css, bundle.css]
ok   no <style> elements injected into the document  count=0
ok   runes reactivity  text="3 (odd)"
ok   svelte -> preload IPC  projects=0
ok   bare global lexical const readable  VIZ_LABELS: 28 chart types (on window: false)
ok   ...and it is NOT on window
ok   window-assigned global callable  normalizeName("Roanoke County") -> "roanoke"
ok   vanilla -> svelte instance export  from vanilla: called from a classic script
ok   vanilla hub intact
ok   zero CSP violations  []
ok   zero renderer console errors  []
```

Negative controls, forced in **both** directions:

- **Must reject:** compiling with `css: 'injected'` fails the build
  (`… can build a <style> element … 1 site(s): create_element("style"`). Bypassing that guard and
  running the app reproduces `style-src-elem <- inline`, a console error, and an unstyled component
  — confirming the blocker was real and that `css: 'external'` is what removes it.
- **Must accept:** a component using `style:opacity={…}`, which pulls Svelte's same-named string
  builder into the bundle, builds clean and renders with zero violations (§3.2).

`npm test` and `npm run build:ts` were re-run from a **cold cache** (`node_modules/.cache/tsc`
deleted along with three emitted `.js` files) to rule out a stale-incremental false positive: all
three were re-emitted and every self-check passed.

The island harness itself is not committed: it duplicates `scripts/smoke-app.js`'s launch machinery,
and these assertions belong **in** `smoke-app.js`. Folding them in is the obvious next commit; that
file was outside this spike's scope.

Measurements are from an Apple M4.

### Environment note

This worktree's `node_modules` began as a **symlink** to the main checkout's. Both tsconfigs write
`tsBuildInfoFile` under `node_modules/.cache/tsc/`, so a shared symlink means a shared incremental
cache whose recorded paths point at the *other* repo — `build:ts` can then report success while
emitting nothing. Installing `svelte` and `esbuild` replaced the symlink with a real directory
(npm: `reify Removing non-directory …/node_modules`), which incidentally removed the hazard: the
cache is now worktree-local, confirmed by the cold-cache run above. If anyone re-creates the
symlink, the hazard comes straight back — the durable fix is to move `tsBuildInfoFile` out of
`node_modules` entirely.

---

## 10. Verdict

Svelte can be added to this repo without weakening anything it promises. The CSP is unchanged, the
`tsc` in-place-emit build for main-process code is unchanged, `npm test` is unchanged, and the
packaged app contains two new generated files and no new runtime dependency.

What it costs is **two renderer worlds for the length of the migration**, plus a second build step
that ten scripts must remember. Both are tolerable *only* because `npm run smoke` boots the real app
and fails on any console error — that is the check standing between this design and a stale bundle
shipping unnoticed. Whatever else phase 5 does, do not let it stop covering the island path.
