# Live data log

Append-only. One entry per task of [the plan](00-plan.md): date, task id, what was measured, what
was decided and why.

## 2026-10-09 — L0.1 Dashboards update themselves after a refresh · L0.2 Every figure says how fresh it is

- **One announcement, every door.** `refreshAsJob` (`src/data/refreshJob.ts`) announces a SUCCESSFUL
  refresh as `hub:dataset-refreshed` through `src/data/refreshEvents.ts` → the scheduler's
  `pushToReaders` (project readers only, every pod over LISTEN/NOTIFY). That covers the dataset
  row's / dashboard's ↻, the scheduler's tick and pipeline runs, and is the door L0.5's hook and
  L3.1's fresh-on-ask will use. The tick's reporter (`src/server/jobs/schedules.ts`) now pushes only
  a FAILED scheduled refresh, so a scheduled success is announced once. **Negative control,
  measured:** with the reporter also pushing successes, `test-jobs-pods` fails — every tab on both
  pods gets the tick's event twice.
- **Also announced:** a SQL dataset re-run downstream of a change (`datasetDependents`) — without it
  a dashboard over a query on the refreshed table (or on an input table just edited) stayed stale.
- **Payload:** the scheduler's `{ projectId, datasetId, name, ok, rowsBefore, rowsAfter }`, minus the
  tick's optional `alertsFired` on a success (counted after the refresh lands; no tab reads it — the
  alerts arrive as `alerts:fired`).
- **Measured, e2e** (`web/e2e/freshness.e2e.ts`, built server, Chromium, dev sign-in): a dashboard
  open in one page, the rows edited in another → the KPI redrawn without a reload in 812–839 ms;
  `dataset:refresh` from the other page → the caption moved in 749–1,189 ms (four runs; both include
  the 500 ms debounce and the refresh job itself). **2 RPCs per redraw** (one `analysis:tiles` batch for every tile on the sheet + one
  `dashboard:asOfStamps`); the dashboard's own load is 10 (budget 25).
- **Measured, two pods** (`test-jobs-pods`, Postgres 16): a manual `dataset:refresh` on pod A reaches
  every reader's tab on A and B exactly once; another org's tabs get nothing.
- **Decided — reconnect re-reads every FIGURE query, not every query.** After a dropped stream the
  events in between are lost, so every query in the invalidation map is re-read; an open editor's
  own document (`analysis:open`, `prepare:get`, staleTime Infinity) is not, or a reconnect would
  re-read the record under the person editing it.
- **`asOf`** (`src/api/asOf.ts`, one shape, types-only on the web): `{ at, mode, cached?, stale?,
  refreshing? }`. An extract is `{ at: lastRefreshedAt, mode: 'extract' }`; never refreshed → the
  rows' `createdAt` (a rename or a prepare edit bumps `updatedAt` without the data being newer); an
  input table or a capture → its last edit. A figure of several datasets is as old as its stalest.
  On `visual:data`/`visual:dataBatch`, `visual:preview`, `dashboard:metric`, `metric:value(s)`,
  `stats:tile`, every `analysis:tiles` tile and `answer:card`; `dashboard:asOfStamps` gains `latest`
  (the sheet's stalest) for the As-of picker's "Latest".
- **Decided — stamped outside the answer cache.** A refresh writes the table, then its markers
  (`markRefresh`), so a cached answer would keep the old time; `test-figureAsOf` moves the marker
  with no data change and the caption follows while the figure is reused. Inside an as-of read the
  stamp is the snapshot's time (the metadata IS the snapshot's).
- **Measured, the stamp's cost** (one metadata read per reply; 1,000 single stamps, 50 batches of
  50 in parallel): records as files — 0.08 ms median, 0.15 ms p95; a 50-tile batch 3.8 ms median.
  Records in Postgres — 0.50 ms median, 5.1 ms p95; a 50-tile batch 22 ms median, 77 ms p95 (50
  reads of one row through the pool). Same order as the `answerKey.keyParts` read each tile already
  makes; a per-request memo is the fix if a 50-tile sheet ever feels it.
- **AI:** the answer facts gain `Data as of: Oct 9, 2026, 1:00 AM UTC.` — UTC and labelled, because
  the server does not know the reader's zone and a model must not convert one. `numberAudit` masks a
  clock time and a month-and-day so a narration repeating it is not accused, and those digits never
  enter the ledger; "March 12 orders", "May 3.5 million" and a figure beside a time are still
  audited (tests in `test-numberAudit`, `test-answerFacts`).
- **UI:** `web/src/ui/asOf.ts` words every variant later phases will set ("As of 1:00 AM", "Live ·
  2:05 AM", "Live · cached 3 min ago", "Stale · as of …", "· refreshing…"); over a day old takes
  `--warn` plus an icon. Shown in each dashboard card's head (charts, KPIs, statistics; Present
  included), on answer cards, beside the builder's preview, and in the As-of picker's "Latest".
- **Not changed:** the published `/p/` page is a snapshot with its own publish time;
  `sanitizeBundle`'s whitelist drops the new field, and nothing was added to it.
- **Environment:** in this sandbox OpenStreetMap tiles are unreachable (`ERR_TUNNEL_CONNECTION_FAILED`),
  so the e2e flows over the sample dashboard's map fail on the base commit and on this branch alike;
  with the tiles stubbed locally (not committed) `dashboards`, `analyses` and `visuals` pass in full.
