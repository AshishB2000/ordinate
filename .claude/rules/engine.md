---
paths:
  - "src/engine/**"
---

# Engine: DuckDB and the resident-query layer

## DuckDB on the server

- **One locked worker per org** (`src/engine/duckdbPool.ts`, wired by `routeByOrg()` in
  `src/server/main.ts`). It sets `memory_limit`, `threads`, `temp_directory` in the org, and
  `allowed_directories` = the org root (+ its S3 prefix), then `enable_external_access=false` and
  `lock_configuration=true`. LRU past `DUCKDB_MAX_WORKERS`, idle eviction, and a per-query
  timeout; the request's abort signal interrupts.
- **Close a worker through its own queue. Never `terminate()` it, and never exit the process
  around one.** Both abort it (`Napi::Error`) mid native call, sometimes even when the worker is
  idle (`src/engine/duckdbClose.ts`).
- Compute-pool threads borrow the caller's org worker. They never run their own DuckDB.
- **Never block the event loop.** `src/engine/duckdb.ts` keeps a synchronous `query()`/`exec()`
  (Atomics.wait) for workers and self-checks, but `src/server/main.ts` calls
  `forbidSyncOnMainThread()`, and `scripts/test-asyncReach.ts` proves nothing reachable from
  `src/server/*` or `src/ipc/*` calls it. Request paths use `queryAsync`/`execAsync`.
- **User regex never runs on the request thread.** It runs in `src/engine/regexPool.ts` /
  `regexWorker.ts` with a 2 s deadline per call; the thread is replaced on overrun. A sync fold
  that meets a user regex without the worker's answers refuses rather than runs it.
- **User SQL** is one read-only statement, gated once in `compile()` (`src/engine/sqlDatasets.ts`)
  by an allow-list over DuckDB's own parse (`json_serialize_sql`: datasets, CTEs in scope, value
  generators), with the lexer as a pre-filter (`src/engine/sqlGate.ts`). It is the project
  boundary inside an org (threat model R2, F9); the org lock is the org boundary.
- Built, not adopted: `duckdbSidecar.ts`, `sqlGen` and `pipelineDuck`. No server path runs them.

## The resident-query layer

`residentQuery` (metrics + aggregated charts), `statsResident`, `anomaliesResident`,
`datasetPage`, `parquetStore`, `datasetView` and the other `src/engine/*Resident.ts` query the
stored Parquet **in place**: no table is materialised to answer a question.

- Each returns `null` on any failure, and the caller falls back to the pure-JS original.
- **The JS implementations are the reference.** Changing one means changing or re-verifying the
  other. Every module is paired with a differential test comparing the two with `Object.is`.
- A broken fast path is not wrong, only about 600× slower, so `src/engine/residentTrace.ts`
  records `resident`/`skipped`/`failed` per call site (exported on `/metrics`) and warns once per
  op on `failed`.

### SQL rules for this layer

- **Cast on the DECLARED type, never inference.** `TRY_CAST('007' AS DOUBLE)` is `7`. Only
  `number` columns are cast. `sum()` over text must stay a loud binder error, never a wrong figure.
- **Order is never assumed.** A bare `GROUP BY` does not preserve first-seen order, and whether it
  reorders is machine-dependent. Carry an explicit ordinal
  (`read_parquet(…, file_row_number=true)`) and end every `ORDER BY` with it, or paging
  duplicates and drops rows.
- **Empty means `null` OR `''` OR whitespace**, matching JS. DuckDB's `trim()` strips NBSP but not
  tab, and RE2's `\s` does the opposite, so spell the class out explicitly.
- **Prefer `CASE WHEN … THEN v END` over `FILTER (WHERE …)`.** Per-column `FILTER` costs 16× at
  width: a real 57 s regression on a 1,000-column table.
- **Every aggregate is `CAST(… AS DOUBLE)`.** `SUM(INTEGER)` is HUGEINT and reaches JS as a BigInt.
- **The fast path is a cost model, not a flag.** Thresholds live at the call site with the
  measurements that produced them. Anomalies needs a width term as well as a row term.

### Known divergences, pinned by tests

- Parallel float summation differs from a JS left fold by about 1e-13, and quantile interpolation
  by about 1e-15. Neither reaches a rendered figure, but `mean` enters AI prompts unrounded.
- A leading U+FEFF is lost on every string the bridge returns (an upstream `@duckdb/node-api`
  bug). It is worked around in `parquetStore` and in the readers that grep for `FEFF`.
