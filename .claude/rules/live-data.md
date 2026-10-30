---
paths:
  - "src/engine/live/**"
  - "src/ipc/**"
  - "src/data/live*.ts"
  - "src/connectors/live*.ts"
  - "web/src/features/live/**"
  - "scripts/test-live*.ts"
  - "scripts/liveFakeConnector.ts"
---

# Live datasets

Design and log: `docs/live-data/`. A Live dataset is queried in the source warehouse on each
question; we store no rows for it.

## The record

- **The mode is in the record:** `Dataset.mode` (`'extract'` when absent) and
  `live: {maxCacheAgeSec, epoch, schemaSyncedAt}`, with `maxCacheAgeSec` from 0 s to 30 days
  (default 300). No SQL migration (`src/data/liveDataset.ts`).
- **A Live dataset is schema only:** columns DECLARED from the warehouse catalog
  (`liveSchema.ts`), no Parquet, no row cap.
- Only a connector with `ConnectorDef.live` (a dialect + `runBound`) offers it. Values ALWAYS go
  as bind parameters, never SQL text. The catalog sends a `live` boolean, no dialect.

## The safety net (D6)

- `getDataset` throws `LiveDatasetError` on a Live dataset. A reader not yet routed refuses
  loudly: RPC 409 `live_dataset`, or `{ok:false, code:'live_dataset'}` per item in a batch (the
  route tags a caught refusal).
- Never compute on zero rows. A catch that turns errors into `[]`/`null` rethrows it. A metadata
  path never hydrates. A walk over every dataset skips Live (`isLive`).
- `scripts/test-liveSafetyNet.ts` calls every row-reading channel. **Add a new one there.**

## Compile, bind, cache (`src/engine/live/`, L2.2–L2.4)

- A validated spec compiles per dialect, runs through `runBound`, and is cached under `orgKey()`
  with the record's `epoch` (Refresh bumps it) and `maxCacheAgeSec`.
- **There is no JS fallback** (D7). Correctness rests on the parity tests: the compiler's DuckDB
  dialect against the extract path with `Object.is` (`test-liveParity`), then real engines (L2.8).

## The executor (`src/engine/live/liveQuery.ts`, L2.3)

`liveVizData`, `liveMetric` and `liveAnswer` work in this order:

1. The cache. An expired entry is kept as the stale fallback.
2. ONE warehouse call per question, however many ask, cancelled only when every asker hangs up.
3. `warehouse()` (`liveWarehouse.ts`): the ONE door every Live statement takes (`test-liveUsage`
   checks). It applies `liveBudget`: `LIVE_MAX_CONCURRENT`, and from L2.7 `LIVE_DAILY_QUERY_LIMIT`
   counted per statement in `live_usage` across pods, plus the `/p/` cache floor
   `LIVE_MIN_CACHE_AGE_PUBLIC_SEC`.
4. `connectors/liveRun.ts`: the SSRF guard, `costTag 'live'`, `LIVE_QUERY_TIMEOUT_MS`, the row
   cap, and the warehouse's billed bytes back to the count.

A failure is the stale answer (`asOf.stale`) or a typed error in a catalog sentence. Warehouse text
goes to the log only (R-L6). `live:<dialect>` outcomes are on `/metrics`. CI's warehouse is
`scripts/liveFakeConnector.ts` (DuckDB dialect; tests or `ORDINATE_TEST_LIVE_FAKE` only, never
listed).

## The doors (`src/ipc/liveRoute.ts`, `liveAnswers.ts`, L2.4)

- `vizDataFor`, `computeCardMetric` and `computeCard` send a Live dataset to the executor FIRST:
  before the extract's answer cache, never through `getDataset`. So every batch, tile, publish,
  export, alert and copilot fact that funnels into them is live.
- A KPI failure THROWS `LiveFigureError` (an `ok:false` would read as "dataset gone"). A handler's
  catch keeps it typed with `liveCodeOf`; the route answers an uncaught one 409 with its code.
- The live `asOf` is kept by `stampAsOf`.
- **A new figure path goes through one of the three doors**, never `buildVizData` on hydrated rows
  (`test-liveRoute` spies on `getDataset`).

## OLTP sources are Live only by opt-in (L3.2, D8)

- The PostgreSQL family declares `live.optIn`: the "This is a read replica or a warehouse"
  checkbox. `isLiveOffered(def, values)` decides per CONNECTION; create, `dataset:setMode`,
  `dataset:source` and every executor question ask it.
- The catalog's `live` means "can be Live"; `liveOptIn` names the box.
- A Postgres or Redshift live session runs in UTC.

## In the web (L2.6, `web/src/features/live/`)

- A screen that reads rows never asks its channel for a Live dataset. It gates on `mode: 'live'`
  from the list or header it already has and shows why, with **"Make a copy"**.
- "Make a copy" is `dataset:copyLive`: a NEW extract of the same selection through the import door.
  The Live record is never written.
- A typed refusal from any figure renders through `liveRefusalOf` + `<LiveRefusal>`: the server's
  sentence, never a retry.
