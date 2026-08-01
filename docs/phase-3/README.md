# Phase 3 — resident queries, and why Mosaic is blocked as specified

**Status:** the performance half is **done and measured**. The Mosaic/WebGL half is **not shippable as written**, for four concrete reasons. This document is the "report parity gaps as you find them" the brief asks for.
**Branch:** `feat/phase-3-mosaic`, off `feat/phase-2-parquet`.
**Tests:** `npm test` → **1,748 ok / 0 fail** (Phase 2 left it at 1,391; +357).

---

## 1. The payoff finally arrived

Phase 1 built the compute path and measured why it was worthless (loading rows cost 1,914 ms per 100k; the query cost 4 ms). Phase 2 moved tables to Parquet but kept hydrating them into `Cell[][]`. `src/residentQuery.ts` closes the loop: it computes **directly against the Parquet file**, with no materialisation.

Medians, Apple M4. Column (a) is what the app does today. Column (a2) is compute-only with the table *already* hydrated — the best case the current architecture could ever reach.

| rows | case | (a) hydrate + compute | (a2) compute only | (b) resident | **b vs a** |
|---:|---|---:|---:|---:|---|
| 100k | sum | 105 ms | 0.64 ms | 1.87 ms | **56×** |
| 100k | agg, 7 groups | 116 ms | 12.7 ms | 2.54 ms | **46×** |
| 100k | agg + 3 filters | 126 ms | 16.8 ms | 3.55 ms | **36×** |
| 1M | sum | 1,110 ms | 9.28 ms | 4.00 ms | **277×** |
| 1M | count | 1,104 ms | 5.61 ms | 1.75 ms | **630×** |
| 1M | agg, 7 groups | 1,366 ms | 179 ms | 6.62 ms | **206×** |
| 1M | agg + 3 filters | 1,532 ms | 275 ms | 7.45 ms | **206×** |

`readTable` alone is 11.5 / 107 / 1,173 ms, so column (a) is *almost entirely hydration* — exactly what Phase 2 predicted. Phase 1's 4 ms number is now real: 1M-row aggregates land at 6–7 ms.

**The one negative result, stated plainly:** a *scalar metric on a small table* is slower resident than in JS — 0.56 ms vs 0.06 ms at 10k rows. The ~0.5 ms is the SharedArrayBuffer handshake, not the engine. So metric cards want a row-count threshold; aggregates should go resident unconditionally.

All 357 assertions are **differential** — the resident answer is compared to the real `metricValue.computeMetric` / `vizData.buildVizData` with `Object.is`, so `''` can never equal `null`.

### The ordinal question, settled by measurement

Parquet stores no ordinal, so first-seen order had to be derived. Three candidates on a 60k × 3 fixture with 997 groups, deliberately reversed so lexical ≠ first-seen order:

| | result |
|---|---|
| bare `GROUP BY` | stable per run, but **not first-seen order** — the reordering phase-0 warned about, reproduced |
| `row_number() OVER ()` | correct, stable *by observation* |
| `read_parquet(..., file_row_number=true)` | correct, stable **by construction** |

`file_row_number` won: it is a physical property of the stored file, independent of scan parallelism. `row_number()` remains an automatic downgrade if a DuckDB build rejects the option.

### Two divergences that cannot be fixed in SQL

- **Float summation order.** JS folds left-to-right in row order; DuckDB sums in vectorised parallel chunks. On 200,000 pseudo-random doubles: JS `99080170.38345873`, DuckDB `99080170.38345982` — ~49 ULP, ~1.1e-14 relative. Integer data is exact. Pinned as a *bounded* divergence (`relErr < 1e-12`) so a real arithmetic bug still fails loudly. **This refines phase-0/06 §1**, which refuted Kahan on a 3-row aggregate — correct for that probe, but parallel reduction at scale does diverge.
- **String collation on ordering comparisons.** JS compares UTF-16 code units, DuckDB UTF-8 bytes. Identical across the BMP, inverted for astral characters. `=`, `!=`, `contains` and all numeric comparisons are exact.

### A bug fixed in Phase 1 code

`sqlGen.ts` emitted bare `avg(...)`. Measured on `(0.1 … 0.7)`: DuckDB's `avg` gives `0.4`; both JS and `sum/count` give `0.39999999999999997`. It now emits `sum/nullif(count,0)`. The existing differential test passed only because its fixture is integer-valued — the assertion pinning bare `avg()` has been **deliberately rewritten**, with the reason in a comment beside it.

---

## 2. Mosaic + vgplot: four blockers

A spike installed the real packages and ran them in **Electron 42.4.0 under the byte-exact hub CSP**. Good news first: **the connector works.** Mosaic's entire contract is one method —

```ts
query(q: {type?: 'arrow'|'exec'|'json', sql: string}): Promise<Table | void | Record<string,unknown>[]>
```

— which maps onto `ipcRenderer.invoke` directly. A real grouped bar chart rendered end to end over an Electron IPC connector with `contextIsolation: true`, returning **plain JSON rows, no Arrow**. Arrow is not required (everything funnels through `toDataColumns`, which duck-types arrays) **provided** the Coordinator is constructed with `{ consolidate: false }` — consolidation is on by default and calls a flechette-only `data.select`, which fails as `TypeError: data.select is not a function` with a blank chart.

That matters because Phase 1 established `@duckdb/node-api` has no Arrow support at all. The JSON fallback is not a preference here; it is the only option. It costs N queries per update instead of 1.

Now the blockers:

**B1 — A bundler is mandatory.** The lean vgplot graph is **1,039 ESM modules across 49 packages**, all importing bare specifiers, which browsers cannot resolve. `CLAUDE.md` states "no bundler — `tsc` only". The two bundler-free escapes were both tested and both fail: an `<script type="importmap">` is inline script and is blocked by `script-src 'self'`; rewriting bare specifiers by hand across 1,039 files *is* a bundler. **Mitigating detail:** only a *vendor* bundle is needed. Renderer app code keeps its global-scope-script model, and the output behaves exactly like the existing `chart.umd.js` tag — one new `<script src>`, ~621 KB minified.

**B2 — Observable Plot injects an inline `<style>`, violating `style-src 'self'`.** Charts still draw (SVG presentation attributes carry the marks), but Plot's base rules are dropped, so plots overflow and tick labels collapse whitespace. **Workaround with no CSP change:** Plot's class name is the constant `plot-d6a7b5`, so its ruleset can be mirrored into `hub.css` — verified to restore full fidelity. Version-coupled, so it needs a re-check on each Plot bump.

**B3 — the synchronous bridge makes Mosaic's interactivity unusable.** This is the sharpest one and it is self-inflicted. `src/duckdb.ts` blocks the Electron **main thread** on `Atomics.wait` — by design, and documented as such. Mosaic's value is high-frequency interactive queries: a brush drag issues queries every animation frame, and with `consolidate: false` that is N queries per mark per frame. **Every one freezes the main process** — all five windows, the menu bar, the global hotkey. Phase 3's gate says *"cross-visual filtering is interactive on 1M rows."* With a blocking bridge that gate cannot be met. Either the bridge gains an async path for Mosaic, or Mosaic ships for static rendering only.

**B4 — Parquet-as-stored is not queryable by Mosaic.** `parquetStore` deliberately writes **all columns VARCHAR with positional `c0..cN` names**, with the JSON record as the only source of truth for names and types. Mosaic generates `SELECT "region", sum("revenue") … GROUP BY "region"` against user-facing names and relies on `DESCRIBE` for real types. Against the stored files, `sum("c1")` over VARCHAR fails and every column describes as VARCHAR, so every scale becomes ordinal. A typed, user-named `VIEW` per dataset is a hard prerequisite — buildable from existing `sqlGen` machinery, but unbudgeted, and it re-opens the type decision Phase 2 deliberately deferred.

## 3. deck.gl: recommend dropping it

It is technically clean under the CSP — it loads, compiles GLSL, and renders pixels with **no directive relaxed** (shader compilation goes through `gl.shaderSource`, which CSP does not govern). That was a genuinely good result. But:

- **`@loaders.gl` defaults to fetching worker scripts from `https://unpkg.com` at runtime**, then instantiating them via `new Worker(URL.createObjectURL(blob))`. `default-src 'none'` blocks it, so nothing leaks — but shipping a library whose default is "phone a CDN" contradicts the local-first promise even when CSP catches it.
- **It ships no basemap.** Any real map means MapLibre (which adds blob workers, forcing `script-src`/`worker-src` open, plus a style-JSON fetch) or a tile host — either way **a second declared external fetch** beside OSM.
- **45 MB / 32 packages minimum**; the full meta-package is 189 MB / 152 packages.

Leaflet already covers `map_bubble`/`map_choropleth` in 144 KB with the OSM fetch already declared and CSP-whitelisted. Adopting deck.gl trades a working, cheap, constraint-compliant map stack for an expensive one that breaks a core promise, for no capability the current chart list needs.

## 4. Chart parity — phase-0 verified correct, with three refinements

`@uwdata/vgplot@0.29.2` exports exactly **65 marks**. There is no `pie`, `donut`, `arc`, `gauge`, `treemap`, or `sankey`. (`arrow` is a directional-arrow mark, not an arc.) **The 5 GAPs in [phase-0/05](../phase-0/05-vizdata-dashboardfilters-charts.md) are confirmed.** Three things that document got slightly wrong or missed:

1. **vgplot is a re-implemented *subset* of Plot, not a superset.** It does not re-export `boxX`/`boxY`, `tip`, `crosshair`, `bollinger`, `tree`/`cluster`, or `auto`. Phase-0 rated `boxplot` BUILDABLE — still true, but it is genuinely build-it-yourself, not a swap.
2. **`waffleX`/`waffleY` exist** and phase-0 missed them. They are the strongest in-vocabulary replacement for the `part_to_whole` default that pie/donut currently hold.
3. **`treemap` is closer than phase-0 implied.** `d3-hierarchy` is already in the dependency closure via Plot (18 KB in the bundle) — compute the squarified layout with it, render with Plot's `rect`. Sankey has no equivalent shortcut, and phase-0's point that today's sankey is a synthetic fan-in makes cutting it the right call.

Also found: a packaging trap. `@uwdata/mosaic-core@0.29.2` publishes `"peerDependencies": {"@uwdata/mosaic-duckdb": "workspace:^"}` — an unresolved pnpm workspace protocol that leaked into the tarball, so plain `npm i` fails with `EUNSUPPORTEDPROTOCOL`. And the full `@uwdata/vgplot` install is **171 MB, of which 142 MB is `@duckdb/duckdb-wasm`** — three WASM binaries this app would never execute, which `electron-builder`'s current `files: ["**/*"]` would ship into the DMG. Making these devDependencies and bundling at build time avoids that entirely.

## 5. Recommendation

**Do not do Phase 3 as specified.** Split it:

- **3a (done):** resident queries. Shipped, measured, 206–630× at 1M rows.
- **3b (next, and it is a prerequisite for everything else):** an **async** path on the DuckDB bridge, plus a typed user-named `VIEW` layer over the Parquet store. B3 and B4 both dissolve here, and 3b is useful on its own regardless of Mosaic.
- **3c:** Mosaic + vgplot behind a build-time vendor bundle, static rendering first, interactors only after 3b. Keep Chart.js for the 5 GAPs — a dual-stack period is unavoidable, so plan it rather than treating it as debt.
- **3d:** drop deck.gl. Keep Leaflet.

The honest summary: the *engine* half of this migration is now proven and delivering. The *rendering* half is gated on an architectural decision (sync vs async bridge) that Phase 1 deferred by choosing the synchronous route — which was right then, and is the thing to revisit now.
