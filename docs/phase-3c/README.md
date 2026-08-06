# Phase 3c — Mosaic + vgplot, behind a flag

**Status:** shipped, default off (`localStorage 'scMosaic' === '1'`).
**Branch:** `feat/phase-3c-mosaic`, off `develop`.
**Tests:** `npm test` → **3,198 ok / 0 fail** (develop left it at 2,991; +207). `npm run smoke` now drives the vgplot path in the real app.

[Phase 3](../phase-3/README.md) §5 said *"do not do Phase 3 as specified"* and split it. 3a (resident queries) and 3b (async bridge + typed views) shipped. This is **3c**: the rendering half, gated on the two build-level blockers 3b left open — B1 (vgplot is 1,039 ESM modules in a project with no bundler) and B2 (Observable Plot injects an inline `<style>` the hub CSP refuses).

Both are closed. **The CSP was not modified** — not a hash, not a nonce, not a relaxed directive.

---

## 1. B1 — the vendor bundle, and the thing that nearly shipped with it

`scripts/build-vendor.js` installs pinned `@uwdata/vgplot@0.29.2` + `esbuild` into a **scratch dir outside the repo**, bundles to an IIFE exposing `window.vg`, and emits two committed artifacts:

| file | bytes |
|---|---:|
| `renderer/hub/vendor/vgplot.js` | 608,767 |
| `renderer/hub/vendor/plot.css` | 2,125 |

Committing them is deliberate: it is what keeps CI and `electron-builder` from ever needing the **181 MB** dependency tree (143 MB of which is `@duckdb/duckdb-wasm`). Nothing was added to `dependencies` or `devDependencies`. Phase 3's `EUNSUPPORTEDPROTOCOL` trap is **still present** — `@uwdata/mosaic-core` still publishes `"peerDependencies": {"@uwdata/mosaic-duckdb": "workspace:^"}`, so `--legacy-peer-deps` is required.

### A naive bundle cannot run in this app at all

`mosaic-core` statically imports `@duckdb/duckdb-wasm` for `DuckDBWASMConnector`. Bundled as-is, the output:

- contains **`new Function(`**, which `script-src 'self'` forbids outright — no `'unsafe-eval'`; and
- embeds **`cdn.jsdelivr.net`** URLs, because that connector's default loader fetches its WASM from a CDN.

This is the same defect [phase-3](../phase-3/README.md) §3 used to *reject* deck.gl (`@loaders.gl` defaults to fetching workers from unpkg.com) — present in the library §5 recommended adopting, and not mentioned there. The build aliases that package to a throwing stub. The shipped bundle contains no `jsdelivr`, no `cdn.`, no `new Function(`, no `eval(`, and is 812 KB → 595 KB as a side effect. **That is a correctness fix, not a size optimisation.**

## 2. B2 — Plot's injected `<style>`, removed at build time

Phase 3 proposed mirroring Plot's ruleset into `hub.css` by hand. That restores fidelity but leaves the injection happening and **blocked**, which emits a `console.error` on every render — and `npm run smoke` fails on any renderer console error. A CSP hash was the other option, and would couple a stated project promise to a third-party library's internals, per-ruleset, per-version.

Instead, an esbuild `onLoad` plugin rewrites the injection sites to `void 0`. There are exactly three in `@observablehq/plot@0.6.17`, all static template literals:

| file | expression |
|---|---|
| `src/plot.js` | `svg.append("style").text(…)` — base SVG ruleset |
| `src/legends/ramp.js` | `svg.append("style").text(…)` — continuous colour legend |
| `src/legends/swatches.js` | `div.insert("style","*").text(…)` — categorical legend |

Their rules are extracted programmatically from the same source into `vendor/plot.css` and `<link>`ed. `writePlotCss` **asserts every formerly-injected ruleset appears verbatim** in the generated file — because the bundle no longer injects them, a gap is now a silent loss of styling rather than a duplicate.

**Four failure modes were forced and all exit 1:** the plugin filter stops matching; Plot changes *how* it injects; a new injector appears anywhere in the bundled graph; an injected ruleset is missing from the CSS. That is the reason to prefer a build patch over a hash — a version bump breaks the **build**, loudly, instead of the running app, silently.

### Two bugs the guards caught

- **The audit was inert.** esbuild's metafile keys are relative to `absWorkingDir`, which defaulted to the repo, so the sweep resolved nothing and reported all-clear having read **zero** files. Caught by a "scanned 0 inputs" self-check.
- **macOS `/var` vs `/private/var`.** esbuild reports realpaths; `os.tmpdir()` goes through a symlink, so every lookup missed and a *cold* build failed. It passed initially only because the scratch dir happened to already be a real path.

### The one case that cannot be fixed this way

`@uwdata/mosaic-inputs`'s `vg.table()` builds a `<style>` whose rules are **genuinely dynamic** — per-instance element id, per-column `nth-child` index, pixel widths from the runtime schema. There is no static file to substitute, and rewriting it to CSSOM untested would be worse than the disease. It is in `STYLE_INJECTION_ALLOWLIST` with its reason, so any *other* injector still fails the build.

**`vg.table()` must never render in the hub.** It would violate `style-src` on every update. Ordinate has its own Explore grid (`src/datasetPage.ts`); nothing should want it. Nothing in `plotRender.ts` reaches `@uwdata/mosaic-inputs`.

## 3. The connector — and a fact about the bridge worth knowing

`src/ipc/mosaic.ts` implements Mosaic's one-method contract over IPC:

- **`mosaic:view`** `(projectId, datasetId)` → ensures a typed, user-named `VIEW` over the stored Parquet (`src/datasetView.ts`) and returns its identifier plus `viewColumns()` — **never `DESCRIBE`**, which loses a leading U+FEFF (phase-3b §3).
- **`mosaic:query`** `({sql, type})` → one statement on `queryAsync`/`execAsync`. `type: 'arrow'` is **rejected explicitly**; a silent downgrade to JSON is what produces `TypeError: data.select is not a function` and a blank chart.

**Every call uses the async bridge.** A sync call blocks the main thread on `Atomics.wait` — 0 event-loop ticks for its duration — and Mosaic queries at animation-frame rate.

### phase-3b §4's "B3 gone" was incomplete

3b delivered an async *bridge* and a *view layer* and never connected them. `datasetView.ensureView()` calls the **synchronous** `duck.exec`, and `datasets.residentSource()` → `parquetStore.isSupported()` → `duck.isAvailable()` **blocks ~115 ms on the cold-bridge handshake**. So neither was usable from an interactive caller as shipped. `resolveView` builds the view from the pure `viewSql()` + `execAsync`, and calls `ensureHardened()` *before* `residentSource` so the non-blocking handshake has already promoted the bridge to `ready`. **That ordering is load-bearing.**

### No view cache, measured rather than assumed

A dataset's Parquet is rewritten on any row/step change and its column list can change shape, so a stale view is silently *wrong*, not slow. Every candidate key is a proxy. Measured: `CREATE OR REPLACE VIEW` over 200k × 20 through `execAsync` is **4.78 ms** against a **4.41 ms** floor for `SELECT 1` on the same path — the DDL is ~0.4 ms; the rest is the round trip a validity check would also pay. And `mosaic:view` runs once per chart setup; the per-frame path is `mosaic:query`. Paying 0.4 ms to be unconditionally right.

## 4. Security — multi-statement SQL executes

Re-verified on DuckDB v1.5.5 via `@duckdb/node-api`:

```
query('SELECT 1 AS one; DROP VIEW sentinel;')  →  []   and the sentinel view is GONE
query("SELECT 'first' AS v; SELECT 'second' AS v;")  →  [{v:'second'}]
```

**Only the last statement's rows come back**, so `[]` is the entire visible evidence that a `DROP` ran. Anything treating `query(sql)` as one statement is wrong.

**`allowed_directories` alone enforces nothing.** With it set and `lock_configuration=true`, `read_csv /etc/hosts`, `COPY TO` outside, `INSTALL httpfs`, `LOAD httpfs` and `ATTACH` **all still succeeded**. The order is load-bearing and non-obvious:

```
allowed_directories → enable_external_access=false → lock_configuration=true
```

The reverse is refused (`Cannot change allowed_directories when enable_external_access is disabled`). With that applied, every escape above becomes a `Permission Error`, and `SET enable_external_access=true` is refused because the configuration is locked. `disabled_filesystems='LocalFileSystem'` also works and is **unusable** — it kills `read_parquet` on our own files.

Defence in depth is `statementCount()`, a lexer modelling `'…'`/`''`, `E'…'`, `"…"`/`""`, `$$`/`$tag$`, `--`, and **nested** `/* */`, each measured against this build. It **fails closed**: an unmodelled construct can only end a quoted region early, producing a rejection, never a bypass. It is a lexer, not DuckDB's parser, and is **not claimed airtight**.

**Blast radius, stated plainly:** one connection serves the whole process, so hardening applies to `residentQuery`/`statsResident`/`parquetStore`/`pipelineDuck` too, and is irreversible for the process life. Safe today because every DuckDB file access in this app is under `userData`. **A future feature where DuckDB reads a user-picked file must register its directory before the first Mosaic call.**

Still possible with hardening on: reading any dataset in any project (that is the feature), writing under `userData` via `COPY … TO`, catalog churn, and an arbitrarily expensive query (no statement timeout — DoS, not leak). Not possible: anything outside `userData`, extensions, `ATTACH`, network.

## 5. What actually renders

Verified by driving the **real app** and counting SVG mark elements — not asserted from the export list.

**16 through vgplot:** `column`, `bar`, `clustered_column`, `clustered_bar`, `stacked_column`, `stacked_bar`, `pct_stacked_column`, `pct_stacked_bar`, `line`, `line_markers`, `area`, `stacked_area`, `scatter`, `bubble`, `heatmap`, `histogram`.

**12 fall back to Chart.js:** the 5 documented GAPs (`pie`, `donut`, `gauge`, `treemap`, `sankey`) plus `combo`, `funnel`, `candlestick`, `boxplot`, `table`, `map_bubble`, `map_choropleth`.

Encoding-level declines, deliberate and tested: any filters; ≥2 measures on anything but scatter/bubble (N sibling marks don't stack or cluster, and drawing measure 0 while dropping the rest is a *wrong chart*); an aggregated histogram (Chart.js bins group totals, `bin()` bins rows); `column`/`bar` with a split; geo; a non-numeric measure.

### Two defects found by rendering

- **Stack order was unstable.** Plot stacks in input order; `GROUP BY` returns groups in hash order, so a channel landed at a different height every render. `order: 'sum'`/`'appearance'`/`'inside-out'` did not fix it (Plot can't infer `z` from a Mosaic fill channel), and `sort`/`order` given a channel *name* is pushed into the SQL by Mosaic as a column reference and fails to bind. Only `z: <splitColumn>` + `order: 'z'` held.
- **Heatmap ran a continuous fill through the categorical brand palette**, producing a non-monotone ramp. Now `colorScheme('blues')` when the colour channel is an aggregate.

### phase-3 §4, one refinement

**Mosaic intercepts Plot option names it treats as channels and pushes them into SQL as column references.** So Plot documentation saying "pass a channel name" (`sort: 'fill'`, `z: 'fill'`) yields `Binder Error: Referenced column "fill" not found` or a silently empty mark. Plot's docs are not transferable to vgplot at the option level.

§4.2 suggested `waffleX`/`waffleY` as the `part_to_whole` replacement for pie/donut. **Not adopted** — a waffle is not a pie, and swapping the mark under an unchanged "Pie" chip would be a different chart under the same name.

## 6. The seam

`renderVizInArea(container, data, type, entry, turnIdx, source?)` — one optional trailing parameter carrying `{projectId, datasetId, encoding, filters}`. It is the single choke point for all nine call sites.

`visuals.ts` and `dashboards.ts` pass it. The capture surface (no dataset), `reportExport` (captures a `<canvas>`; an SVG has none) and the five `chartControls` re-renders omit it and stay on Chart.js unchanged. The Chart.js ladder moved verbatim into `renderChartJsInArea`; teardown and `innerHTML = ''` stay put. A per-container token guards out-of-order async renders.

Any failure — `mosaicView` not ok, a query error, an unsupported type, `window.vg` missing — falls back to Chart.js. That is the same safety property the resident-query layer uses and carries the same hazard: **a silently broken fast path is not wrong, just absent.** So the fallback is observable via `console.debug` (never `console.error`, which would fail smoke), and `scripts/test-plotSpec.ts` executes the **real emitted `plotRender.js`** in a `vm` sandbox rather than mirroring it, so it cannot rot into agreement with a stale copy.

`vg.createAPIContext({coordinator})` per card works and is not a singleton — a dashboard page renders several cards concurrently, and one shared `clear()` on teardown would wipe another live card's clients.

## 7. Known limitations

- **A Mosaic card has no `⋯` menu.** `addChartControls` is wired only into the Chart.js path, so Values/Periods/Customize/export are unavailable on a vgplot card. Style overrides are not mapped to Plot.
- **Filters always fall back**, including dashboard cross-filters. Ordinate's filter semantics live in `transforms.ts`/`sqlGen.ts` in main, where they are tested; re-deriving them in renderer SQL risks a chart quietly filtered differently from the Chart.js one. **This means Phase 3's original headline goal — interactive cross-filtering — is still not delivered**, and on current numbers it is not the bottleneck: queries are ~12 ms at 1M rows.
- **Category order differs.** Ordinate preserves first-seen order; Plot sorts ordinal domains ascending. Same values, different sequence — confirmed in the differential (identical sums, `North,South,East,West,Central` vs `Central,East,North,South,West`).
- Thresholds and measurements here are from an Apple M4.

## 8. Why it is default-off

`CLAUDE.md` lists Mosaic as out of scope, argued from measurements in [phase-3](../phase-3/README.md): queries are already ~12 ms, Chart.js drawing 40 bars was never the bottleneck, and 5 of 28 chart types have no equivalent mark. Nothing here refutes that. What this phase establishes is that the *blockers* were real and are now gone, at a known cost — a 595 KB committed bundle, a build-time patch of a third-party library, a dual chart stack, and a card that loses its `⋯` menu.

Shipping it dark keeps that finding available without making anyone pay for it. Flip `localStorage 'scMosaic' = '1'` to evaluate.
