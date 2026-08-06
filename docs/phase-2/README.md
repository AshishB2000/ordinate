# Phase 2 — Parquet storage

**Status:** complete. Gate met.
**Branch:** `feat/phase-2-parquet`, off `feat/phase-1-duckdb` (Phase 2 needs the bridge; this deviates from "one branch per phase off `develop`" and the two should merge in order).
**Tests:** `npm test` → **1,391 ok / 0 fail** (Phase 1 left it at 1,265; +126).
**Gate:** *existing projects open correctly after migration; round-trip tests pass* — both proven by `scripts/test-datasetsMigration.ts`, which plants a real pre-Phase-2 JSON on disk and asserts the upgrade.

---

## 1. Measured result

| rows | v2 (JSON, rows inline) | v3 (Parquet + metadata JSON) | |
|---:|---:|---:|---:|
| 10,000 | 435 KB | 19 KB + 588 B | **21.9× smaller** |
| 50,000 (the app's cap) | 2,220 KB | 36 KB + 588 B | **60.2× smaller** |

`listDatasets` now runs in **~1 ms**. Before, it read and `JSON.parse`d every dataset file *in full* — both the derived table and the immutable source — to produce six scalars for the sidebar. A project with 20 datasets at the row cap parsed roughly 90 MB of JSON to render a list. That is the user-visible win of this phase, and it was found by the audit rather than being on the original plan.

## 2. On-disk format

```
userData/projects/<projectId>/datasets/
  <id>.json            metadata only  (~600 B)  schemaVersion: 3
  <id>.parquet         the derived table
  <id>.source.parquet  the immutable source, when one exists
```

**Every column is stored VARCHAR.** Ordinate's `ColumnType` stays in the JSON; it is never the Parquet type. This is the same decision Phase 1 made and for the same measured reason ([phase-0/06 §2](../phase-0/06-duckdb-verification.md)): a leading-zero value beyond DuckDB's sniffer window silently becomes an integer. Columns are physical `c0..cN` with user-facing names held only in metadata, so duplicate names, empty names, and names containing quotes or newlines all round-trip — and column-name injection is structurally impossible.

Migration is **one-way and lazy**: a v2 record is rewritten on read. It is gated on the bridge being available, so on a machine where the native binding fails to load the app keeps writing v2 inline and behaves exactly as before — it degrades to "as it was", never to "your data is gone".

## 3. Three data-loss bugs caught before they shipped

A read-only audit of `datasets.ts` ran against my intended design and found three things wrong with it. All three would have destroyed user data.

1. **Keying the source Parquet on `steps.length > 0` was wrong.** `updateSteps` snapshots an immutable source even when the step list is *empty*, and `test-datasets.ts:232-238` asserts that source survives clearing every step. Under my plan that dataset's source would never have been written, and after a reload `applyPipeline` would have had nothing to fold. The correct key is `source !== undefined`. Now pinned by an explicit test that adds a step, clears it, and asserts the source rows are byte-identical.

2. **`isValidDataset` requires `Array.isArray(data.rows)`.** A v3 file has no `rows` key, so *every migrated dataset would have failed validation* — `getDataset` returns null, `listDatasets` logs and skips. The entire workspace would have appeared empty while the data sat intact on disk. The predicate is now deliberately relaxed and the reason is in a comment.

3. **`deleteDataset` only removed the `.json`.** Every delete would have orphaned one or two Parquet files forever — invisible, because `listDatasets` filters on `.json`, and never reclaimed.

The audit also insisted the failure mode be *visible*: a v3 record whose Parquet is missing now returns `null` rather than an empty table, and the dataset stays **listed**, so a user sees "this dataset failed to load" instead of silently losing rows. `updateSteps` snapshots whatever rows it is handed, so a silent empty read would have overwritten the immutable source with nothing.

## 4. A real bug found in shipped Phase 1 code

**`src/duckdb.ts` silently drops a leading U+FEFF (BOM) from every returned string.** `SELECT chr(65279) || 'x'` has `length() = 2` inside DuckDB and arrives in JS as `'x'`.

It is not this project's bug: every accessor `@duckdb/node-api` exposes — `getRowsJson`, `getRows`, `getColumnsJS`, `getRowObjects` — strips it identically, so the loss is below the JS layer and cannot be fixed by switching accessor or by post-processing. Once the string reaches JS there is no way to know a BOM was there.

The only correct fix is in SQL at projection time, before the value crosses: double a leading BOM so the transport's strip is an exact inverse. `parquetStore.readTable` does this, because storage fidelity is non-negotiable. **`pipelineDuck` does not**, so a text cell beginning with a BOM would round-trip lossily through the Phase 1 SQL path — which is off by default. Documented at the top of `src/duckdb.ts` and pinned by a test so it stays visible.

## 5. Known limitations

- **Row order from `read_parquet` is empirically stable but not contractually guaranteed.** Measured: 200,000 rows, 3 consecutive runs, order preserved exactly; the test suite pins 60,000. A single-file sequential scan is not the parallel hash aggregate that phase-0/06 proved reorders, so the risk is low — but it is a measured property, not a promise. If it ever bites, the fix is an explicit `__ord` column, exactly as `sqlGen` already does.
- **Migration cost is one full bridge crossing per stored row** (~1 s per 50k table), paid once, on first read. The audit's suggested improvement — have DuckDB read the v2 JSON directly and write Parquet in one statement, with zero per-row crossings — is not implemented.
- **The project folder is no longer plain text.** `CLAUDE.md` sells it as human-readable JSON on disk. It is now JSON plus opaque binaries. Worth a deliberate decision.
- **Packaging is still unverified** (inherited from Phase 1): the `.node` binary needs `asarUnpack`. Check before any `dist:mac`/`dist:win`.
- **Four test files now depend on the native binding** (`test-datasets`, `test-visuals`, `test-viz-filter`, `test-copilot`) because their fixtures call `saveDataset`. A binding failure surfaces there first, confusingly.
- **`-0` becomes `+0`**, unpaired UTF-16 surrogates become U+FFFD, and `NaN`/`±Infinity` in a number column become `null` (matching `parse.coerceCell`). None is reachable through the app's own parsers.

## 6. Does this unlock Phase 1?

Not yet, and it is worth being precise about why. Phase 1 measured the killer as *materialising rows into DuckDB per call* (1,914 ms per 100k rows). Phase 2 puts the data in Parquet, but `getDataset` still hydrates to `Cell[][]` and every consumer still takes `(columns, rows)`.

The payoff needs one more step: consumers querying `read_parquet(...)` **in place** rather than through a materialised array. `parquetStore.relationSql()` exists for exactly that and is tested, but nothing calls it yet. That is the first task of Phase 3, and it is where the 4 ms query number finally becomes reachable.
