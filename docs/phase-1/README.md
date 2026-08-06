# Phase 1 — DuckDB behind the existing APIs

**Status:** built, tested, proven equivalent — and **disabled by default**, for a measured reason.
**Branch:** `feat/phase-1-duckdb` off `develop`.
**Tests:** `npm test` → **1,265 ok / 0 fail** (was 964; +301 new assertions).
**Build:** `npm run build:ts` → 0 errors.

---

## 1. The headline result

The compute swap works and is provably equivalent. **Enabling it today would be a 100–500× regression**, and the reason is structural, not a tuning problem.

Measured on 100,000 rows × 5 columns (Apple M4, DuckDB 1.5.5):

| | time |
|---|---:|
| Load the rows into DuckDB | **1,914 ms** |
| Run the `GROUP BY` | **4 ms** |
| The same work in the existing JS fold | **18 ms** |

The engine is ~4.5× faster than the fold. The **load is 100× slower than the entire fold**. Batch size is irrelevant — 500 rows/statement → 1,914 ms, 5,000 → 2,073 ms, 20,000 → 2,558 ms. The cost is the per-row bridge crossing, not statement count.

End-to-end, with the path forced on, `pipeline.filter` at 100k rows went **4.70 ms → 2,562 ms**.

**What this means for the plan: the phase order in the brief is wrong.** The compute swap cannot pay off while data lives in JS arrays and must be materialized per call. It needs the data to already be resident — which is Phase 2 (Parquet storage). Phase 1's code is the right code; it is waiting on Phase 2 to have anything to stand on.

So `runOnDuckDb` is gated behind `ORDINATE_DUCKDB_PIPELINE=1`. With it off, benchmarks match the pre-change baseline exactly — no regression shipped.

## 2. What was built

| File | Purpose |
|---|---|
| `src/duckdb.ts` + `src/duckdbWorker.ts` | Synchronous DuckDB bridge: worker thread + growable `SharedArrayBuffer` + `Atomics.wait` |
| `src/sqlGen.ts` | Pure `TransformStep[]` → CTE-chain SQL. No I/O, no execution |
| `src/pipelineDuck.ts` | Executor: load → run → map back → TS retype pass |
| `scripts/test-duckdb.ts` | 49 assertions |
| `scripts/test-sqlGen.ts` | 139 assertions, 20 of which execute generated SQL through the real DuckDB CLI |
| `scripts/test-pipelineDuck.ts` | **113 differential assertions** — the load-bearing test |
| `scripts/bench-pipeline.ts` | 10k/100k/1M harness, seeded, before/after diffable |

`applyPipeline`'s signature is unchanged. It tries the SQL path and falls back to the fold whenever that path returns null — which happens for an unexpressible pipeline, an unavailable bridge, a small table, or any error. **The fold remains the reference implementation and is never bypassed silently.**

### The sync bridge — why signatures didn't have to change

Phase 0 flagged "sync vs async" as the blocking question, because DuckDB's Node bindings are async and `applyPipeline` is not. A spike settled it **by measurement inside a real Electron 42.4.0 main process**:

- `Atomics.wait` is permitted on Electron's main thread (blocked 162 ms, returned `ok`)
- `SharedArrayBuffer` works with **no special flags** (COOP/COEP apply to renderers, not the main process)
- `@duckdb/node-api` loads under Electron ABI 146 **with no `electron-rebuild`** — it is a prebuilt N-API module
- Per-call floor: **0.07–0.16 ms**

So the Phase 1 gate ("signatures do not change") is meetable as written, and the ~30 production `await` insertions and 121 test-file changes that Option A would have cost were avoided entirely.

### The differential test is the real deliverable

`scripts/test-pipelineDuck.ts` runs identical input through **both** implementations and compares columns, declared types, row order, every cell's value *and its JS type*, and the warning strings. It covers all 8 step kinds, the guard/skip paths, injection attempts, and a 60,000-row table for order stability.

It immediately earned its keep: it caught a real bug where my result mapper ran cells through `parse.coerceValue`, which maps `''` → `null` (the *ingest* rule, `parse.ts:219`). A legitimately-empty text cell came back as null and diverged from the fold. Unit tests on either side would not have found it — only running both and comparing did.

It also confirms the fix for the order nondeterminism Phase 0 proved: 5 consecutive runs of the same 60k-row `GROUP BY` returned **1 distinct ordering**, via the hidden `__ord` column and `ORDER BY min(__ord)`.

## 3. What is NOT done

- **`calculated_field` returns `sql: null`** — any pipeline containing one falls back to the fold entirely. Formula→SQL needs the AST refactor Phase 0 §F4 describes, and that is its own piece of work.
- **`combineTables`** is untouched; still pure JS.
- **`vizData` / `datasetStats` / `metricValue`** still compute in JS. They gain nothing until the data is resident, for the same reason as above.
- **Packaging is unverified and probably broken.** `@duckdb/node-bindings-*` ships a `.node` binary that needs `asarUnpack`, and the worker path must resolve outside the asar. **Check this before any `dist:mac`/`dist:win`.**
- **Windows and Linux untested** — all measurements are darwin-arm64.
- **No query interrupt.** A slow query freezes the main thread; the bridge self-disables after 120 s and callers fall back.

## 4. Corrections to Phase 0

- **F1's call-site analysis was wrong in a specific way.** It named `visuals.ts`, `dashboards.ts`, and `dashboardExport.ts` as the synchronous callers of `applyPipeline`. **None of those three calls any seed function.** The export path is fully insulated — it consumes a bundle the renderer assembled over already-async IPC. The real sync callers are `vizData.ts` itself, `datasets.ts`, and the `src/ipc/*` handlers. F1's "~8 call sites" was low by roughly 4×; the true count is 30 production sites, 0 of them impossible.
- **`@duckdb/node-api` has no Arrow support.** All 22 Arrow entry points in its `.d.ts` are commented out; results are materialized JS values only. The migration table's "Apache Arrow (zero-copy)" row is **not achievable with this binding today**. The encoder in `duckdbWorker.ts` is deliberately pluggable so Arrow can be swapped in without touching the bridge.
- **The benchmark undercuts "speed" as the migration's rationale, and supports "memory".** At sizes the app can actually load (`parse.ts` caps tables at 50,000 rows) every operation is 1–20 ms. Nobody is waiting on this code. What does break is memory: 1M rows costs **~2 GB RSS** against a 4.3 GB V8 heap limit, because `applyPipeline` deep-copies the source and builds a fresh table per step — a 4-step chain materializes the table 5×. That is the real ceiling, and it is the thing a set-based engine actually fixes.

## 5. Recommended next step

**Do Phase 2 (Parquet storage) before enabling any of this.** The measurements say the compute swap is worthless — actively harmful — until the load step disappears. Once a dataset lives in DuckDB, `runOnDuckDb` becomes "run a query against a resident table" and the 4 ms number is the whole cost.

Concretely, in order:
1. Phase 2: datasets stored as Parquet, loaded once, queried in place.
2. Flip `ORDINATE_DUCKDB_PIPELINE` on and re-run `npm run bench:pipeline` — the same harness produces the AFTER numbers with no rewrite.
3. Then `calculated_field` → SQL via the AST emitter, with `scripts/test-formula.ts` run against both back ends.
