## HEADLINE — required early report: chart-type GAPs

**5 of 28 chart types have no vgplot/deck.gl equivalent mark: `pie`, `donut`, `gauge`, `treemap`, `sankey`.**

Of the 5 Chart.js *plugins* the brief flagged as landmine 6.6, the damage splits: `heatmap` (chartjs-chart-matrix) is **DIRECT** (Plot/vgplot `cell`), `boxplot` (@sgratzl) and `candlestick` (chartjs-chart-financial) are **BUILDABLE** from primitives, but `treemap` and `sankey` are **hard GAPs** — no layout algorithm exists in Observable Plot's mark vocabulary. Additionally `pie`/`donut`/`gauge` are GAPs for a well-known reason: **Observable Plot has never shipped an arc/pie mark**, and vgplot inherits that vocabulary. Pie + donut are `SHAPE_CHARTS.part_to_whole[0..1]` (`renderer/hub/renderResult.ts:262`) — the *default* chart for an entire data shape is a GAP.

---

## vizData.ts

### 1. Exported API surface (verbatim — Phase 1 must preserve)

`src/vizData.ts:21-34`:

```ts
export interface ChartData {
  labels: (string | number)[];
  series: { name: string; values: (number | null)[] }[];
}

export interface VizDataResult {
  data: ChartData & {
    geo?: { level: string; items: { name: string; value: number }[] };
    dataShape?: 'time_series';
  };
  recommendedShape: string;
  warnings: string[];
}
```

`src/vizData.ts:81-84`, `205-210`:

```ts
export function recommendChartType(columns: ParsedColumn[], encoding: VizEncoding): { shape: string; type: string }
export function buildVizData(columns: ParsedColumn[], rows: Cell[][], encoding: VizEncoding, filters?: FilterStep[]): VizDataResult
```

Input types (`src/visuals.ts:22-38`):

```ts
export type VizAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none';
export interface VizMeasure { column: string; aggregation: VizAggregation }
export interface VizGeo { level: 'country' | 'us_state' | 'us_county' | 'us_city' | 'us_zip' }
export interface VizEncoding { category: string; values: VizMeasure[]; series?: string; geo?: VizGeo }
```

**Output object, field by field**

| Path | Type | Rule |
|---|---|---|
| `data.labels` | `(string \| number)[]` | `labelVal` (`vizData.ts:51-54`): a `number` cell stays a number; `null`/`undefined` → `''`; else `String(cell)`. **`"007"` stays `"007"`.** |
| `data.series[i].name` | `string` | Path A: `measureLabel` → `"sum of price"`, or the bare column name for `count`/`none`. Path B: `String(splitValue)`. Path C: bare `v.column`. |
| `data.series[i].values` | `(number \| null)[]` | Always exactly `labels.length` long and index-parallel. Only finite JS numbers survive (`numOrNull`, `vizData.ts:45-47`). **Never a string, never `NaN`, never a re-stringified figure.** |
| `data.geo.items[k]` | `{name, value}` | `name = String(labels[k])`; `value = series[0].values[k]` **only when finite** — no-data regions are *omitted*, never zero-filled (`vizData.ts:257-263`). |
| `data.dataShape` | `'time_series' \| undefined` | Set **only** when `encoding.geo` is present *and* `series.length >= 2` (`vizData.ts:265`). |
| `recommendedShape` | `string` | `time_series \| categorical \| part_to_whole \| single_metric \| map_choropleth \| map_bubble` |

**Callers to preserve:** `src/ipc/visuals.ts:85` (`visual:data`) and `src/ipc/copilot.ts:47` (the copilot FACTS block).

### 2. `buildVizData` semantics in full

**Guard rails, in order (`vizData.ts:211-223`)** — each returning `emptyResult` (`{labels:[],series:[]}` + 1 warning + a still-valid `recommendedShape`): non-array inputs → `[]`; `category` missing/not a string → `'No category (dimension) selected.'`; `category` not in `columns` → `` `Unknown category column "…".` ``; `values` empty → `'No measure selected.'`

**Filters first (`vizData.ts:231-235`).** `applyPipeline(table, filters)` runs over the *raw* rows **before any aggregation**; warnings appended.

**Branch selection (`vizData.ts:237-247`).** `hasSplit` → **(B) pivot** (wins even if every aggregation is `none`); else all-`none` → **(C) raw**; else → **(A) aggregated**.

**(A) Aggregated (`vizData.ts:111-137`).** One `group_aggregate` step, `groupBy:[category]`, one aggregation per measure aliased `m0,m1,…`. `aggregation:'none'` is coerced to `'sum'` **and the series is relabelled accordingly** (`vizData.ts:133`) so the label never understates the value.

**Aggregate functions (`transforms.ts:362-400`)** — the one arithmetic implementation, shared with Prepare:
- `count` → number of **non-empty** cells, *text included*; empty = `null` or whitespace-only (`isEmptyCell`, `transforms.ts:117-120`). Returns `0`, never `null`.
- `sum`/`avg`/`min`/`max` → over **finite JS numbers only**; zero qualifying cells → `null` (not `0`, not `NaN`). `min`/`max` use `reduce`, deliberately not `Math.min(...)`, to avoid `RangeError` on large groups.
- Unknown `fn` falls back to `count`; unknown aggregation column → `null` + warning.

**(B) Pivot (`vizData.ts:141-182`).** `groupBy:[category, series]`; **only `encoding.values[0]` is used** — measures 1..n are silently dropped when a split is present. Long→wide: labels and series both in **first-seen order**, grid pre-filled with `null`, sparse writes. **Missing (category, split) combos stay `null`.**

**(C) Raw (`vizData.ts:186-200`).** One point per row; duplicates preserved; unknown measure column → an all-`null` series (index `-1` guard), not a warning.

**Sort order.** There is **no sorting anywhere in `buildVizData`.** Every order is *first-seen insertion order* (from `stepGroupAggregate`'s `groups[]` + `byKey` Map, `transforms.ts:333-345`) or source row order. Sorting is a *renderer* concern: `chartRender.ts:314-322` re-orders by cross-series total when `overrides.sort` is set, and only for the bar/column family and pie/donut.

**Grouping key identity.** `keyOf = JSON.stringify(cell ?? null)` (`vizData.ts:57-59`). So `"007"` and `7` are **different groups**, and `null` and `''` are **different groups** (though both render as the label `''`).

**Limits / truncation / top-N: none.** The only cap is upstream: `MAX_ROWS = 50_000` (`parse.ts:36`) and the join cap (`transforms.ts:597`).

**Values / Periods / small multiples / value labels — NOT in `buildVizData`.** All four are renderer-side transformations of the finished grid, and are the contract Phase 1 output must keep feeding:
- *Periods dropdown*: `seriesCount >= 2 && PERIOD_DROPDOWN_TYPES.has(type)` (`chartRender.ts:34-42`).
- *Small multiples*: `seriesCount >= 2 && SMALL_MULTIPLE_TYPES.has(type)` = `{pie, donut, gauge, treemap, funnel, histogram}` (`chartRender.ts:48-51`).
- *Value labels*: `valueLabelKeys(mode, values)` over the 2-D grid; modes `off|all|max|min|maxmin`. **Single live series → one global max/min; ≥2 live series → per-category max/min; ties to the lowest series index.**
- *Sankey period*: `overrides.periodIdx` defaulting to `series.length - 1`.

**The geo path (`vizData.ts:254-266`).** Geo is not a separate code path — labels/series are built by A/B/C, then region items are derived from `series[0]`. `data.geo.items` carries **only `{name, value}`**; everything else resolves at render time: `mapRender.fillCentroidsFromBoundaries` adds `lat`/`lng` from GeoJSON bounding-box centres; `geoMatch.matchGeoItem` joins names by `normalizeName` → exact → substring (len>4) → iso2 prefix. **A `buildVizData`-produced item never carries `state`/`kind`**, so the workspace region join is pure normalized-name matching.

---

## dashboardFilters.ts

### 1. Exported API surface (verbatim)

`src/dashboardFilters.ts:32-35`:

```ts
export function mergeDashboardFilters(
  dashFilters: FilterStep[] | null | undefined,
  cardFilters: FilterStep[] | null | undefined,
): FilterStep[]
```

Private: `stepKey(s) = JSON.stringify([s.column, s.op, s.value ?? null])`.

### 2. Semantics in full

1. **Coercion.** Non-array (incl. nullish) → `[]` on either side.
2. **Order / precedence.** `dash.concat(card)`. The module's own comment is explicit that this is documentation, not math — `applyPipeline` folds filters left→right and every filter is a pure row predicate, so concatenation is commutative in effect; dashboard-first is the single documented precedence and the hook for future rules (`dashboardFilters.ts:9-13`).
3. **Composition is AND, never override.** Dashboard `region=West` and card `region=East` both survive and intersect to zero rows.
4. **De-dup.** First occurrence wins; `value: undefined` and `value: null` normalize to the same key.
5. **Defensive type gate.** Anything that isn't a filter step is dropped.
6. **It never computes a number and never touches a column.** Pure list algebra over predicate descriptors.

**The "missing-column filters are skipped" rule does NOT live in this file.** It is `transforms.stepFilter`:

```
src/transforms.ts:246   if (ci < 0) return skip(t, `Filter skipped: unknown column "${s.column}"`);
```

**Exact skip condition:** `t.columns.findIndex(c => c.name === s.column) < 0` — exact, case- and whitespace-sensitive, against the table *as it stands at that point in the fold*. On skip the table passes through **unchanged** (a no-op, not a zero-row result) plus a warning. A second condition follows: `!FILTER_OPS.has(s.op)` → same. This is what lets one dashboard filter span heterogeneous datasets.

**Wiring.** Visual cards: the renderer merges then ships the combined list through `visual:data`, re-sanitized in main (`src/ipc/visuals.ts:85`). Metric cards: dashboard filters only, applied via `applyPipeline` before `computeMetric` (`src/ipc/dashboards.ts:64-76`). **There is a renderer-side duplicate of the merge logic** — `renderer/hub/dashboards.ts:707-720` — which must be kept in lockstep; only the main-process module is node-tested.

**Filter predicate semantics Phase 1 must reproduce (`transforms.ts:244-308`):**
- `is_empty`/`not_empty` → `cell == null || (typeof cell === 'string' && cell.trim() === '')`
- `contains` → `String(cell ?? '').includes(String(value ?? ''))`, case-sensitive; a `null` cell becomes `''`
- If the column's **declared** type is `number`: the target is coerced via `coerceValue`; if either side is non-finite the row is **dropped** for *every* operator including `!=`
- Otherwise both sides go through `cellToString`, so `>`/`<` are **JS UTF-16 lexicographic** and a `null` cell compares as `''`

---

## Chart-type parity matrix

Source of truth: `VIZ_LABELS` (`renderer/hub/renderResult.ts:198-208`) = **25 charts + 2 maps + table = 28**. `ALL_CHART_TYPE_IDS` (`:248-255`) = the 25 charts. `SHAPE_CHARTS` (`:260-267`) maps 6 shapes to best-first lists; `eligibleChartTypes` (`:288-297`) additionally filters by `CHART_SERIES_MIN`, `CHART_SERIES_MAX`, `CHART_LABELS_MIN`.

**DIRECT** = a named mark exists · **BUILDABLE** = composable from named primitives · **GAP** = no equivalent. Plot's mark list is well known; *vgplot's exact re-implemented subset* (facets, implicit stacking, box/geo marks) is not — those are marked **NEEDS VERIFICATION** against the installed version.

| # | id | Data shape required | Rendered today by | In `SHAPE_CHARTS`? | vgplot / deck.gl verdict |
|---|---|---|---|---|---|
| 1 | `column` | 1 cat + 1 numeric (max 1 series) | Chart.js core `bar` | ✅ time_series, categorical | **DIRECT** — `barY` |
| 2 | `bar` | as above, `indexAxis:'y'` | core `bar` | ✅ categorical | **DIRECT** — `barX` |
| 3 | `clustered_column` | 1 cat + **≥2** series | core `bar` | ✅ time_series, categorical | **BUILDABLE** — `barY` + `fx` facet/dodge. *NV: vgplot facet channels* |
| 4 | `clustered_bar` | ≥2 series, horizontal | core `bar` | ✅ categorical | **BUILDABLE** — `barX` + `fy`. *NV* |
| 5 | `stacked_column` | ≥2 series | core `bar` + `stacked` | ✅ part_to_whole | **BUILDABLE**. *NV: does vgplot auto-stack like Plot?* |
| 6 | `stacked_bar` | ≥2 series | core `bar` | ✖ | **BUILDABLE** |
| 7 | `pct_stacked_column` | ≥2 series | core `bar`, `opts.pct` | ✅ part_to_whole | **BUILDABLE** — `offset:"normalize"`. *NV* |
| 8 | `pct_stacked_bar` | ≥2 series | core `bar` | ✅ part_to_whole | **BUILDABLE** |
| 9 | `line` | 1 cat/temporal + ≥1 series | core `line` | ✅ time_series | **DIRECT** — `line`/`lineY` |
| 10 | `line_markers` | as line | core `line`, markers | ✅ time_series | **DIRECT** — `line` + `dot` |
| 11 | `area` | as line | core `line`, `fill:true` | ✅ time_series | **DIRECT** — `areaY` |
| 12 | `stacked_area` | ≥2 series | core `line`, fill+stacked | ✅ time_series | **BUILDABLE** |
| 13 | `pie` | 1 series, ≥2 labels | core `pie` | ✅ **part_to_whole[0] (default)** | 🔴 **GAP** — no arc/pie mark in Plot/vgplot |
| 14 | `donut` | 1 series, ≥2 labels | core `doughnut` | ✅ part_to_whole[1] | 🔴 **GAP** — same |
| 15 | `scatter` | **≥2 numeric series** | core `scatter` | ✖ | **DIRECT** — `dot` |
| 16 | `gauge` | 1 numeric value | core `doughnut` half-circle + custom plugin | ✅ **single_metric[0] (default)** | 🔴 **GAP** — but trivially replaceable by an HTML component; it displays one number |
| 17 | `combo` | ≥2 series | core `bar`, `opts.combo` | ✅ time_series | **BUILDABLE** — `barY` + `lineY` |
| 18 | `bubble` | **≥3 numeric series** | core `bubble` | ✖ | **DIRECT** — `dot` with `r` |
| 19 | `treemap` | 1 series, ≥2 labels | 🔌 **chartjs-chart-treemap** | ✅ part_to_whole | 🔴 **GAP** — Plot has `tree`/`cluster` (link diagrams), no squarified layout. Needs d3-hierarchy + a custom mark |
| 20 | `heatmap` | ≥2 series × ≥2 labels | 🔌 **chartjs-chart-matrix** | ✅ time_series, categorical, matrix | **DIRECT** — `cell` mark. *Best-case migration: DuckDB-side binning is Mosaic's core strength* |
| 21 | `funnel` | 1 series, ≥3 labels | core `bar` + transparent spacer stack | ✅ part_to_whole | **BUILDABLE** — `barX` with explicit `x1`/`x2` |
| 22 | `histogram` | 1 numeric series, √n bins clamped 5..12 | core `bar`, `opts.histogram` | ✖ | **DIRECT (upgrade)** — `rectY` + `bin`; binning moves into DuckDB |
| 23 | `sankey` | Synthetic: every label → one `"Total"` node | 🔌 **chartjs-chart-sankey** | ✖ | 🔴 **GAP** — no flow layout. *Mitigating fact: today's sankey isn't real flow data (`chartRender.ts:520-531`), it's a fan-in fake — a candidate for deletion rather than migration* |
| 24 | `candlestick` | 4 series = O/H/L/C | 🔌 **chartjs-chart-financial** | ✖ | **BUILDABLE** — `ruleY` (high–low) + `rect` with `y1`/`y2` (open–close) |
| 25 | `boxplot` | one box per series | 🔌 **@sgratzl boxplot** | ✖ | **BUILDABLE** — Plot ships `boxX`/`boxY`; else compose over DuckDB `quantile_cont`. *NV* |
| 26 | `table` | anything | DOM builder | ✅ every shape (fallback) | **DIRECT** — Mosaic ships a `table` client |
| 27 | `map_bubble` | `geo.items` + centroids | Leaflet | ✖ (geo path) | **DIRECT** — deck.gl `ScatterplotLayer`. *NV: Mosaic↔deck.gl binding maturity* |
| 28 | `map_choropleth` | `geo.items` + boundary GeoJSON | Leaflet + GeoJSON | ✖ (geo path) | **DIRECT** — deck.gl `GeoJsonLayer`. *NV as above* |

**Tally: 11 DIRECT · 12 BUILDABLE · 5 GAP.** Three GAPs (`pie`, `donut`, `treemap`) sit inside `SHAPE_CHARTS.part_to_whole`, whose remaining entries are all BUILDABLE — so the shape survives, but its *default* chart changes.

---

## Test contract — named rules

### `buildVizData`

| Rule | Statement | Assertions | Example |
|---|---|---|---|
| **R-VIZ-01** ⚠️ORDER | Aggregated labels are distinct category values in **first-seen source-row order** — never sorted | `test-vizData.ts:39,73,106-107,135,203` | `Paris,Berlin,Paris,Berlin` → `['Paris','Berlin']` |
| **R-VIZ-02** ⚠️ORDER | The five aggregates are computed by the app over the group's rows | `:41,44,47,50,53` | sum `[15,40]`, avg `[7.5,20]`, count `[2,2]`, min `[5,20]`, max `[10,20]` |
| **R-VIZ-03** | `series[i].values` index-parallel to `labels`; every cell `number \| null` | `:76-80,84-88` | — |
| **R-VIZ-04** | Always a non-empty `recommendedShape` and a `warnings` array | `:81,89,90,168` | — |
| **R-VIZ-05** ⚠️ORDER | N measures → N series **in encoding order**, distinct names | `:97-100` | `[sum,max]` → `[15,40]`, `[10,20]` |
| **R-VIZ-06** | A leading-zero text id is never coerced; it groups by string identity | `:75,106-108,237` | `['007','012']`, values `[4,4]` |
| **R-VIZ-07** ⚠️**ROW ORDER** | All-`none` → raw mode: one point per source row, duplicates preserved, in source order | `:112,113` | `['Paris','Berlin','Paris','Berlin']` |
| **R-VIZ-08** | A non-numeric measure column yields an all-`null` series — never a string | `:117` | `[null,null,null,null]` |
| **R-VIZ-09** ⚠️ORDER | Pivot: first-seen labels and series; missing combos `null` | `:135-138` | `'2024'=[20,null]` |
| **R-VIZ-10** ⚠️ORDER | `geo.items` from `labels` × `series[0]`, in label order, omitting non-numerics | `:146-150` | `[{Paris,15},{Berlin,40}]` |
| **R-VIZ-11** | `dataShape:'time_series'` iff geo present **and** `series.length >= 2` | `:151,160,161` | — |
| **R-VIZ-12** | Degenerate encodings → empty shape + warning, **never throw** | `:165-175,249` | — |
| **R-VIZ-13** ⚠️ORDER | Filters run before aggregation | `:196,201-203,208,213` | `[150,290]` → `[100,250]` |
| **R-VIZ-14** | Unknown filter column → warning naming it, **rows unchanged** | `:218,219` | still `[150,290]` |
| **R-VIZ-15** ⚠️ORDER | Strict-number + string-id rules hold *through* filter+aggregate | `:237-240` | `['007','012']` → `[4,4]` |

### `visual:data` end-to-end (`test-viz-filter.ts`)

| Rule | Statement | Assertions |
|---|---|---|
| **R-VF-01** | A persisted `filters` array round-trips through disk and drives aggregation on reload | `:86-91,98-102` |
| **R-VF-02** | Removing the filter proves the filter shrank the totals | `:111,112` |
| **R-VF-03** | `duplicateVisual` yields an independent copy with a distinct UUID; missing UUID → `null` | `:116-127` |
| **R-VF-04** | `overrides` persist verbatim through save + reload | `:135-139` |
| **✅ Order-safe pattern** | This file reads totals through a `Map<label,value>` instead of by index — **the only file whose value assertions are label-order-independent. It is the template for rewriting the others.** | `:96-97,109-110` |

### `dashboardFilters`

| Rule | Statement | Assertions | Example |
|---|---|---|---|
| **R-FILTER-01** ⚠️LIST ORDER | Concatenation, **dashboard filters first** | `:45,46` | — |
| **R-FILTER-02** | Byte-identical steps collapse to one | `:52` | — |
| **R-FILTER-03** | Steps differing only by `value` both survive (no override) | `:57` | — |
| **R-FILTER-04** | Nullish/empty → `[]`; one-sided passes through | `:59-61` | — |
| **R-FILTER-05** | Non-`filter` steps dropped | `:62-63` | — |
| **R-FILTER-06** | One dashboard filter changes a **visual** card's total | `:76,81` | 650 → 300 |
| **R-FILTER-07** | Dashboard + card filters **compose (AND)** | `:86` | → 100 |
| **R-FILTER-08** | Same filter changes a **metric** card's total | `:95,97` | 650 → 150 |
| **R-FILTER-09** | A filter on a column the dataset lacks is **skipped, not fatal** — the heterogeneous-dataset guarantee | `:101-102` | still 650 |
| **R-FILTER-10** | Text filter on `"007"` matches the string, keeps one row, cell stays `'007'`, column stays `text` | `:110-115` | sum = 100 |

### Renderer-mirror rules

**⚠️ `test-small-multiples.ts`, `test-value-labels.ts`, `test-more-charts.ts` re-declare the helpers rather than importing them** (`hub.js` isn't node-runnable) — **they test copies, not the originals.**

| Rule | Statement | Assertions |
|---|---|---|
| **R-SM-01/02/03** | Small multiples iff `seriesCount>=2` and type ∈ the share set; non-share types never; `boxplot` is controls-only | `:32-43` |
| **R-SM-04** ⚠️INDEX | Visible mini count = series minus hidden **indices** | `:49-51` |
| **R-VL-01/05** | `mode 'off'`/empty → none; `'all'` skips nulls | `:67,68,90` |
| **R-VL-02** ⚠️INDEX | Single live series → one **global** max/min, keyed `"s:c"` | `:71-74` |
| **R-VL-03** ⚠️INDEX+TIE | ≥2 live series → per category column; **ties to the lowest series index** | `:79,81,82` |
| **R-VL-04** | An all-null (hidden) series is excluded from the contest | `:86-87` |
| **R-VL-06** | Period dropdown iff `seriesCount>=2` and type ∈ `PERIOD_DROPDOWN_TYPES` | `:93-98` |
| **R-MC-01/02** | `canRenderType` gates on series/label minimums; maps need geo; `table` always renders; the "needs" message names the requirement verbatim | `:35-50` |
| **R-MC-03** ⚠️LIST ORDER | "+ More" partitions every type into exactly one of Recommended / Selected / Other, preserving pool order | `:65-69` |

**Order-dependence census: 15 of the ~60 substantive assertions are order-coupled** — R-VIZ-01, 02, 05, 06, 07, 09, 10, 13, 15 (label/row order), R-VL-02/03 and R-SM-04 (series index), R-FILTER-01 and R-MC-03 (list order). R-VIZ-07 (raw source-row order) is the hardest to preserve in SQL.

---

## MOSAIC / DUCKDB BREAKAGE TABLE

| Rule / behaviour | Current | Mosaic / SQL | Breaks? | Mitigation |
|---|---|---|---|---|
| **R-VIZ-01 label order** | first-seen via `groups[]` + `byKey` | `GROUP BY` — **unordered**; DuckDB's hash aggregate varies with thread count, morsel size, data volume | 🔴 **YES — guaranteed** | Materialize a monotonic `__ord` at ingest, then `ORDER BY min(__ord)`. Reproduces first-seen order exactly. Do it once in the query builder, for every grouped query |
| **R-VIZ-07 raw row order** | literal source order | unordered; parallel scans reorder | 🔴 **YES** | `ORDER BY __ord` on every un-aggregated query. Defeats streaming for large raw scatters |
| **R-VIZ-09 series order** | first-seen over grouped rows | no canonical order | 🔴 **YES** | `ORDER BY min(__ord)` on pair-groups; or adopt an explicit deterministic order and **rewrite the expectations** |
| **Ties in `overrides.sort`** | `Array.sort` — **stable since ES2019**, so equal totals keep first-seen order | ties arbitrary, can differ between runs | 🟠 **YES (silently)** | Always append `, min(__ord) ASC` |
| **R-VL-03 value-label ties** | tie → lowest **series index** | flips if split order is nondeterministic | 🟠 downstream | Fixed for free once split order is deterministic. Keep `valueLabelKeys` in JS |
| **`count` semantics** | non-**empty**: excludes `null` *and* whitespace-only; text counts; empty group → `0` | `count(col)` excludes NULL **only** | 🔴 **YES** | `count(*) FILTER (WHERE col IS NOT NULL AND trim(CAST(col AS VARCHAR)) <> '')`. Never bare `count(col)` |
| **`sum`/`avg` over no numbers** | `null`, never `0`, never `NaN` | `NULL` | 🟢 **NO — matches** | Guard only against a future `COALESCE(sum(x),0)` "improvement", which would violate number-honesty |
| **`sum` return type** | JS `number` (float64); renderer tests `typeof v === 'number'` everywhere | `SUM(INTEGER)` → `HUGEINT`/`BIGINT`; over Arrow these surface as **`BigInt`** or a decimal object | 🔴 **YES — catastrophic and silent** | `CAST(… AS DOUBLE)` around every aggregate, **plus** keep `numOrNull` as the Arrow→JS gate so a BigInt becomes `null` rather than a broken chart. **Single highest-risk item in the migration** |
| `min`/`max` spread guard | `reduce`, not `Math.min(...)` | native | 🟢 improvement | Delete the JS guard in the translation layer |
| **R-VIZ-09 missing combos → `null`** | wide grid pre-filled with `null` | `GROUP BY` returns **only observed pairs** | 🟠 YES if the wide grid survives | (a) densify via `CROSS JOIN … LEFT JOIN`; (b) **preferred** — stop densifying: vgplot consumes long/tidy data with a `fill` channel. (a) is needed only for retained Chart.js plugin types |
| **`null` vs `''` as a category** | different group keys, **both render as `''`** | same separation; a `COALESCE(cat,'')` merges them | 🟠 minor | Emit `cat` raw, do the `null → ''` in JS (keep `labelVal`) |
| **Mixed-type column** | `Cell[] = (string\|number\|null)[]`; a text cell in a measure → `null`; a numeric cell in a category → a numeric label | a DuckDB column is **typed**; `sum(text_col)` is a **binder error**, not a null series | 🔴 **YES — architectural** | (1) Load with the existing `detectColumnType` decision, not DuckDB's sniffer. (2) **R-VIZ-08 must be preserved by a pre-flight schema check**: if the measure column isn't numeric, don't emit `sum(col)` — short-circuit to an all-`null` series in JS, exactly as today. Otherwise `:117` becomes a query failure instead of `[null,null,null,null]` |
| **`labelVal` numeric-vs-string** | numeric label stays a number; `"007"` stays `"007"` | Arrow returns the column's type | 🟠 partial | Preserve `labelVal` verbatim; its guarantee is only as good as the ingest typing decision |
| **R-FILTER-09 missing-column skip** | table unchanged + warning when `colIndex < 0` | a predicate on a nonexistent column is a **binder error that kills the whole query**; there is no "skip" in SQL and no per-client clause filtering in a Mosaic `Selection` | 🔴 **YES — and it's the load-bearing dashboard feature** | Before assembling a predicate, intersect the merged clause list against the client's **known schema** (`Dataset.columns`), dropping unmatched clauses and emitting the same warning. Lives in the client/query-builder, not in `mergeDashboardFilters` |
| **`contains` on a NULL cell** | `contains ''` matches **every** row including nulls | NULL → excluded | 🟠 **YES** | `contains(COALESCE(CAST(col AS VARCHAR),''), $needle)` |
| **Text `!=` on a NULL cell** | `'' !== 'US'` → **row kept** | NULL → **row dropped** | 🔴 **YES — inverts a row's fate** | `COALESCE(CAST(col AS VARCHAR),'') <> $target` |
| Numeric `!=` on a NULL cell | dropped | dropped | 🟢 **NO** | — |
| Numeric filter, non-numeric target | every row dropped | cast error or zero rows | 🟠 equal outcome, different mechanism | Coerce in JS (`coerceValue`) first; bind as a typed parameter, **never string-interpolate** |
| Text `>`/`<` | JS UTF-16 lexicographic | UTF-8 byte/collation | 🟠 differs for non-ASCII | Low priority; document |
| `is_empty`/`not_empty` | null or whitespace-only | — | 🟢 expressible | `col IS NULL OR trim(CAST(col AS VARCHAR)) = ''` |
| **R-FILTER-01/02/03 merge algebra** | list concat + JSON-key de-dup | a `Selection` already unions/intersects clauses by source | 🟢 **NO — survives** | Keep `mergeDashboardFilters`; add a clause→`Selection` adapter. `stepKey` de-dup stays useful (Mosaic dedups by clause *source*, not predicate identity) |
| Filters-before-aggregation | `applyPipeline` then group | `WHERE … GROUP BY …` | 🟢 **NO — native** | The one thing SQL does more naturally than the current code |
| 50k row cap | `MAX_ROWS` at parse | not needed | 🟢 improvement | But the cap also bounds `buildRaw` output; under Mosaic that becomes an unbounded scatter. **Keep a render-side cap** |
| **Architectural inversion** | main computes a complete `{labels, series}` per request over IPC | the renderer publishes a **declarative query** to a `Coordinator` which cross-filters against DuckDB, optionally via a **data-cube index** | 🔴 **total inversion** | see below |
| Data-cube index vs aggregate choice | all five equally cheap | decomposable aggregates (count/sum/min/max, avg via sum/count) index well; others don't | 🟠 **NEEDS VERIFICATION** | Verify which of the five the installed Mosaic accelerates, and that `avg` is decomposed internally rather than degrading |

### Which parts of `buildVizData` become obsolete, and which must survive

**Obsolete under Mosaic** (replaced by generated SQL): `buildAggregated` (`:111-137`), `buildRaw` (`:186-200`), the `group_aggregate` half of `buildPivot` (`:146-158`), the filter-fold (`:231-235`), and `transforms.aggregate`'s five-function switch *for the viz path* (it stays for Prepare). The long→wide pivot bookkeeping (`:161-181`) goes **only if** the renderers move to vgplot, which consumes long/tidy data natively — it must be retained verbatim for any chart type staying on a Chart.js plugin.

**Must survive as a translation layer — do not delete:**
- `numOrNull` (`:45-47`) — now *more* important: it is the Arrow→JS gate that turns BigInt/Decimal/NaN into `null`
- `labelVal` (`:51-54`) — the `null → ''` and number-preservation contract
- `keyOf` (`:57-59`) — JS-side identity for period matching and hidden-series indexing
- `measureLabel` (`:63-66`) — the `"sum of price"` contract, including the `'none' → 'sum'` relabel
- `recommendChartType` + `SHAPE_DEFAULT_TYPE` (`:72-97`) — **completely unaffected**; pure classification, port verbatim
- The four guard-rail early returns and `emptyResult` — SQL has no equivalent of "return an empty chart with a friendly warning"; a bad encoding must never reach the query builder
- The `warnings: string[]` channel — must now also carry query-builder skips, to keep R-VIZ-14 and R-FILTER-09 alive
- The geo derivation (`:254-266`) — a JS-side projection of the finished grid
- `mergeDashboardFilters` in its entirety, **plus a new schema-aware clause filter next to it**

---

## Open questions / risks for Phase 3

1. **Ingest typing is the crux.** Does DuckDB load datasets via the existing `parse.detectColumnType` decision, or does it sniff? If it sniffs, R-VIZ-06 / R-FILTER-10 break at *load* time, before any query runs, and every leading-zero guarantee dies at once. **Decide this first.**
2. **BigInt/Decimal marshalling.** Confirm what `SUM(INTEGER)` returns through the chosen binding and whether `CAST(… AS DOUBLE)` everywhere suffices. Write a self-check before any chart code.
3. **Where does `__ord` come from?** DuckDB `rowid` is stable only on base tables, not views/CTEs/parquet scans. An explicit `__ord` column costs storage but is portable.
4. **Is first-seen order worth preserving at all?** It is an accident of implementation, yet 9 rules encode it and users have saved dashboards whose reading depends on it. The alternative is an explicit deterministic order plus a one-time visual change. **A product decision, not a technical one.**
5. **The 5 GAPs.** Per type: custom mark, retained Chart.js plugin (dual-stack — and Chart.js still needs the wide grid, so `buildPivot` survives), or cut. `sankey` is the strongest cut candidate (today's is a synthetic fan-in, not real flow data); `gauge` should become an HTML component; `pie`/`donut` are not cuttable — they are the `part_to_whole` defaults.
6. **vgplot vocabulary verification list** (blocks Phase 3 scoping): facet channels `fx`/`fy`; implicit vs explicit stacking in `barY`; `offset:"normalize"`; `boxX`/`boxY`; a `geo` mark and projections; the `table` client's parity with today's DOM table.
7. **deck.gl ↔ Mosaic binding.** Supported client interface, or a hand-written `MosaicClient`? And does replacing Leaflet + OSM change the "one declared external network call" promise? deck.gl basemaps typically imply a tile provider — potentially a *new* external dependency in a local-first, no-telemetry app. **Flag to the security section.**
8. **`geoMatch` under a SQL join.** Fuzzy JS matching (normalize → exact → substring → iso2) becomes a UDF or a pre-normalized lookup table. Substring matching over a cross join is O(n·m) — fine for 50 states, questionable for 3,000 counties or 40,000 zips.
9. **Three test files test copies, not code.** They will keep passing after the originals are deleted. Either export those helpers from a pure module and import them, or delete the mirrors — otherwise they are green-lit dead weight for the whole migration.
10. **`mergeDashboardFilters` is duplicated** at `renderer/hub/dashboards.ts:707-720`; only the main copy is tested.
11. **`buildPivot` drops measures 2..n silently** when a split is present (`:146`) — no warning, no test. Easy to "fix" accidentally, which would change series counts and therefore chart eligibility, small-multiples routing, and value-label mode. Preserve the drop, or make it a deliberate tested change.
12. **Unbounded raw mode.** `buildRaw` is safe today only because `MAX_ROWS` bounds the dataset. With DuckDB the dataset ceiling rises but the renderer's does not.
