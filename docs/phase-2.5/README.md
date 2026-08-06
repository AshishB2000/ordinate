# Phase 2.5 — wiring the engine up

**Status:** complete.
**Branch:** `feat/phase-2.5-rewire`, off `develop`.
**Tests:** `npm test` → **2,411 ok / 0 fail** (was 1,913; +498).

Phases 1–3b built a DuckDB engine that was **inert**. Every IPC handler still called `getDataset`, which hydrates the whole table into `Cell[][]`, then computed in JS. The 206–630× resident-query numbers existed in `residentQuery.ts` and nothing called it.

This phase connects them. No new dependencies, no new architecture — the fast paths already existed.

---

## Measured, through the real IPC handlers

### `dashboard:metric`

| rows | before | after | |
|---:|---:|---:|---|
| 1,000 | 1.97 ms | 0.57 ms | 3.5× |
| 10,000 | 12.71 ms | 0.63 ms | **20×** |
| 100,000 | 112.77 ms | 1.21 ms | **93×** |
| 1,000,000 | 1,257 ms | 2.30 ms | **546×** |
| 100k, 4 cards on one dataset | 112 ms | 8.0 ms | 14× |
| 1M, 4 cards on one dataset | 1,208 ms | 16.5 ms | 73× |

### `visual:data` — the hot chart path (2 measures + a filter, 40 groups)

| rows | before | after | |
|---:|---:|---:|---|
| 10,000 | 22.0 ms | 1.9 ms | 12× |
| 100,000 | 143.7 ms | 6.3 ms | 23× |
| 1,000,000 | 1,393.7 ms | 12.4 ms | **113×** |

Outputs byte-identical at every size.

### `dashboard:draft` — metadata only

It loaded **every dataset in the project** — both the derived table and the immutable source — to build a prompt listing column names. 8 datasets × 50,000 rows:

| | |
|---|---:|
| before (`getDataset`) | 391 ms |
| after (`getDatasetMeta`) | **1 ms** |

`visuals.saveVisual` had the same shape: a full table hydrated to answer "does this dataset exist".

---

## What was added

Two APIs in `src/datasets.ts`:

```ts
getDatasetMeta(projectId, id)  // one small JSON read; no rows, no hydration, no migration
residentSource(projectId, id)  // { parquetPath, columns } | null — null means "fall back"
```

`getDatasetMeta` deliberately does **not** migrate a v2 record. Migration is a write, and a metadata read must stay a read — otherwise opening a column picker could trigger a table rewrite.

The stored `.parquet` holds the table **after** the prepare pipeline, so a resident query needs no step replay. That is what made this rewire small.

## What falls back, and why

Every rewired path keeps the JS implementation as its reference and falls back silently on `residentSource` null, a resident `null` result, or any throw.

- **`visual:data` rewires branch (A) — aggregated — only.** Split/pivot, all-`none` raw mode, and geo all fall back to `buildVizData`. A narrow correct rewire beats a broad one that changes a chart.
- **The warnings gate.** `aggregateResident` returns numbers, not warnings, so the fast path is taken only when a warning is *structurally impossible* — unknown filter column, unknown category, and unknown measure are all checked against column metadata first, with zero rows read. That is what makes the rewire provably equivalent rather than probably.
- **A resident `null` is never trusted.** `computeMetricResident` returns `null` for both a legitimate answer (text column, all-empty column) and a failure, and the two are indistinguishable. So `null` always falls through. Cost: a metric card showing "—" on a 1M-row dataset still pays the full 1.2 s.

## Two things I got wrong, corrected by measurement

**1. The row-count threshold.** I told the implementer to use ~10,000 rows, citing the phase-3 benchmark where a scalar metric was slower resident below that. That number came from a column measuring **compute only, with the table already hydrated** — but this handler starts from a dataset id, so its real cost includes hydration. Re-measured end to end:

| rows | 100 | 1,000 | 10,000 |
|---|---:|---:|---:|
| JS | 1.02 ms | 1.85 ms | 10.73 ms |
| resident | 0.41 ms | 0.45 ms | 0.68 ms |

**There is no crossover** — resident is 2.5× ahead at 100 rows. A 10,000 threshold would have left 2.5–16× on the table across the range where most personal-BI data sits. The shipped threshold is 1,000, chosen so the multi-card path (hydrate once, N cards) does not regress.

**2. Branch (A) is not a minority path.** I asked whether it was worth rewiring only the aggregated branch. It is the default: `renderer/hub/visuals.ts` defaults every new measure to `sum`, and both the split select and the geo level are opt-in and empty by default. Branch (A) is the chart that re-fires on every cross-filter change.

## One semantic that genuinely changed

`sum`/`avg` over **non-integer** floats can differ in the last ULPs — JS folds left-to-right, DuckDB combines parallel partial sums. Observed at 1M rows: `487417204.09997433` (JS) vs `487417204.1000064` (resident), a **6.6e-14** relative difference, roughly five orders of magnitude below anything a formatted metric card renders. Integer-valued data is exact. Documented in `residentQuery.ts` and pinned at `relErr < 1e-12`.

## Still hydrating, deliberately

- `visual:suggest` → `computeColumnSummary` genuinely needs rows. Not on the hot path; a candidate for `datasetView` rather than this rewire.
- `dashboard:explainAnomalies` → `detectAnomalies(columns, rows)` needs the table.
- `captureDataset` append → needs the immutable source rows.
- `dataset:stats` / `explain` / `suggestSteps` / `suggestCalcField` → all need full column summaries.

Those are the next candidates, and they want `datasetView` (typed SQL views) rather than `residentQuery`.

## Tests

498 new assertions, all **differential**: the rewired handler's output is compared against the pure `metricValue.computeMetric` / `vizData.buildVizData` over the same post-Parquet-round-trip rows, with `Object.is` so `null` can never pass as `0`.

Both suites also assert **which path ran** — `datasets.getDataset` is spied on, so "resident was used" is verified as "the table was never hydrated". A rewire that silently stopped firing would fail loudly instead of passing green and inert.
