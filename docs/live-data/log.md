# Live data log

Append-only. One entry per task of `00-plan.md`: date, task id, what was measured, what was decided
and why.

## 2026-10-09 — L2.1 The Live record and the safety net

- **Built:** `Dataset.mode` / `live: {maxCacheAgeSec, epoch, schemaSyncedAt}` in the record
  (`src/data/liveDataset.ts`, no migration); declared types per dialect (`liveSchema.ts`); the
  record writers (`liveRecord.ts`); `connection:import {mode:'live'}` and the new `dataset:setMode`
  (`src/ipc/liveDatasets.ts`, contract in `src/api/live.ts`); `runBound` on Redshift (`$n`,
  `postgres.ts`), ClickHouse and Databricks SQL (`liveHttp.ts`); the `live` flag in the connector
  catalog; `dataset:source` gains `live`, `maxCacheAgeSec`, `canGoLive`.
- **http.ts made room, then shrank:** the transport, JSON, accessors, base URL, row cap and the two
  response shapes moved to `httpShared.ts` (re-exported, so `http.httpRequest` / `MAX_BYTES` and
  the self-check are untouched). http.ts 1,035 → 744 lines, so its `test-file-size` ALLOWED entry is
  removed rather than lowered. The transport gained an optional `signal` (abort = socket destroyed).
- **Safety net, measured by `test-liveSafetyNet`:** every row-reading channel enumerated from the
  `src/api/` contracts that take a dataset refuses a Live dataset, typed; the first run found the
  refusal silent in 9 places and fixed each — `dataset:distinct` (`{values:[], total:0}`),
  `insights:list` (`[]`), `metric:values` (a bare `ok:false`), `quality:run` (no rules → `ok`),
  `prepare:get`, `sql:run` (a wrong "saved before Parquet" message), `snapshots:*`, the alert
  periods/anomaly readers (`null`/`[]` → drivers said "fewer than two periods"), and the
  project-wide walks that broke instead of skipping (value search, privacy scan; Home insights and
  bundles skip too). The MCP `datasets.list/describe` report `rows: null` and `mode: 'live'`
  instead of a zero.
- **Decided — typed refusal without editing 137 catch sites:** most handlers turn any throw into
  `{ok:false, error: err.message}`. The RPC route walks a reply for the refusal's exact sentence and
  adds `code: 'live_dataset'` (per item in a batch, so one Live tile never fails a dashboard), but
  only when a `LiveDatasetError` was constructed during the call (a process counter) — zero cost on
  every other request. An uncaught one is 409 `{code:'live_dataset', message}`.
- **Decided — Databricks submits asynchronously (`wait_timeout: 0s`) and polls** (100 → 200 → 400 →
  800 → 1,000 ms) so an abort or a blown budget can POST `…/statements/<id>/cancel`; the synchronous
  `run` path cannot name a statement it is still waiting on. Costs one extra round trip per query.
- **Decided — Redshift keeps `run`'s row-cap wrapper** (`select * from (\n…\n) limit n+1`): the
  compiled ORDER BY's order survives a plain projection in Postgres (pinned below) — L2.8 re-checks
  it on Redshift. Cancel is `pg_cancel_backend(pid)` from a second session on the same pinned address.
- **Measured (local Postgres 16 standing in for Redshift, `test-liveConnectors`):** 11 adversarial
  literals round-trip byte-for-byte through `$n`; a NUL is the server's refusal; the cap clips 10
  rows to 3 in order and reports it; an abort 400 ms into `pg_sleep(20)` answers "Cancelled"
  10–13 ms later (5 runs) and leaves nothing in `pg_stat_activity`. A bound round trip — connect,
  the read-only + statement_timeout guards, one `$1` query, close — is 5.7 ms (mean of 20, local).
- **Not done here (by plan):** the compiler (L2.2), executor and cache (L2.3), routing charts / KPIs /
  answers (L2.4 — until then they refuse, as the suite asserts), the full Live UI (L2.6).
