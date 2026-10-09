# Live data — task log

Measurements and decisions per task of [00-plan.md](00-plan.md), newest last. Re-litigate with
numbers.

## 2026-10-09 — L1.3 BigQuery connector (+ the BigQuery halves of L1.4 and L1.5)

### The read-only scope spike: NOT RUN

The plan's first step for L1.3 is a spike: does `jobs.query` accept the `bigquery.readonly` scope,
and does Google then refuse a write? There is no GCP account to run it against, so it is
**unverified**. What was checked instead is Google's own machine-readable API description — the
BigQuery v2 discovery document, revision `20260922`, fetched 2026-10-09 from
`https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest`:

| Method | Scopes the discovery document accepts |
|---|---|
| `jobs.query`, `jobs.getQueryResults`, `jobs.get`, `datasets.list`, `tables.list`, `tables.get` | `bigquery`, `cloud-platform`, `cloud-platform.read-only` |
| `jobs.insert` | `bigquery`, `cloud-platform`, `devstorage.*` — **no read-only scope** |
| `jobs.cancel` | `bigquery`, `cloud-platform` — **no read-only scope** |

Two further facts from the same document:

- **`bigquery.readonly` is not in the API's scope list any more** (it lists `bigquery`,
  `bigquery.insertdata`, `cloud-platform`, `cloud-platform.read-only`, `devstorage.*`). The read-only
  scope the document names for `jobs.query` is `cloud-platform.read-only`.
- **`QueryResponse` now carries `statementType`**, so a `jobs.query` dry run says what a statement
  is, under the same scopes as the query itself. The plan assumed the dry run needed `jobs.insert`,
  which no read-only scope covers.

### What the code does instead — safe whichever way the spike comes out

1. **The query token asks for `bigquery.readonly` AND `cloud-platform.read-only`.** Both are
   read-only; the second is the one the discovery document lists for `jobs.query`.
2. **Every statement `run` sends is dry-run first** (`jobs.query` with `dryRun: true`, free) and
   refused unless `statementType` is `SELECT` — and refused when the field is missing. The dry run
   is of the exact text that then runs, the row-cap wrapper included. `live.runBound` skips it: its
   SQL is compiled by the app, never typed, and a dry run would double each chart's latency.
3. **`jobs.cancel` gets its own token with the `bigquery` scope**, minted only when a job must be
   cancelled and used for that URL only. Every query also carries `jobTimeoutMs`, so BigQuery stops
   the job itself if the cancel never arrives.
4. **A 403 "insufficient authentication scopes" is reported as exactly that**, naming the two scopes
   and `docs/server/live-data.md`. Ordinate does not widen the scope to work around it.

| If the spike finds… | Then |
|---|---|
| the read-only scopes work and Google refuses a write | Read-only is enforced by Google; the dry run is defence in depth. |
| they work but a write goes through | The dry-run gate and the IAM roles (Data Viewer + Job User) hold. |
| Google refuses them for `jobs.query` | Every BigQuery query fails with the scope sentence. Decide with the owner: drop to the `bigquery` scope and rely on the dry run + IAM. |

To close it with an account: mint a token with the two scopes, `jobs.query` `SELECT 1` (expect 200),
then a `CREATE TABLE … AS SELECT 1` into a dataset the account may write (expect 403); record the
result here. `scripts/test-warehouseLive.ts` (L1.5, not built here) is where that belongs.

### Decisions

- **Number columns keep BigQuery's strings.** `INT64`, `NUMERIC`, `BIGNUMERIC` and `FLOAT64` arrive
  as strings; the cells stay those strings and the column declares `columnType: 'number'` only when
  every value passes `parse.ts`'s `isFiniteNumber`. One id over 15 significant digits makes the
  whole column text, as the CSV detector would — declaring `number` regardless would have the
  dispatch's `coerceValue` turn that id into `null`. Keeping the string also keeps `-0.0` as `-0`
  through the dispatch (a float round trip prints `0`).
- **TIMESTAMP is converted exactly.** BigQuery sends epoch seconds, often in E notation
  (`1.7044176E9`); the digits are shifted as a decimal (BigInt), never multiplied as a float, to a
  millisecond UTC ISO string like every other connector's `Date`. Differential check: 2,000 random
  instants between years 1 and 9999, in decimal and E forms, equal `new Date(ms).toISOString()`.
- **The incremental cursor literal differs from the plan's `TIMESTAMP('…')`.** BigQuery refuses to
  compare a `DATE` or `DATETIME` column with a `TIMESTAMP` (no implicit coercion), and `DATE` is the
  usual partition column — a typed literal would turn every such incremental refresh into a full
  scan. An untyped string literal *is* coerced to the column's own type, so the pushed predicate is
  `` `col` >= 'YYYY-MM-DD' `` (the bound's day: one more day of superset, which the JS cut absorbs),
  and the bare column keeps partition pruning.
- **The editor's estimate** is a new channel, `connection:estimate` (access `write`, like explain),
  answered from `live.estimate`; the catalog reports `estimates: true|false` so the web editor only
  calls it for a source that can price a statement. The "~1.2 GB" label is formatted server-side.
- **Explain still bills on BigQuery**: `connection:explain` runs the statement bounded to one row,
  which BigQuery bills as a full scan. A dry-run explain (its `schema`) is a follow-up; the estimate
  next to Run shows the size first.
- **The abort signal**: `ctx.signal` when the caller sets one, else the request's own (a closed tab),
  read from the request context. An abort while `jobs.query` is still in flight cancels the job when
  its id arrives.

### Tests

No live service was measured. Off recorded REST-shaped fixtures (`scripts/fixtures/bigquery/`) and an
injected transport: `test-connectorsBigquery` (104 checks), `test-bigqueryBounds` (51),
`test-incrementalMerge` (+4: the BigQuery dialect), `test-incrementalRefresh` (+6: an end-to-end
incremental run that pushes the predicate), `test-connectors` / `test-icons` (the registry, 39
connectors), and `estimate.test.tsx` (3, Vitest).

The editor estimate was looked at in both themes against the built server, booted in-process with
the fake transport injected (an ad-hoc script, not committed): "~1.2 GB" by Run for a SELECT, a muted
"No estimate" carrying the refusal for a DELETE. `connections.e2e`'s picker spec passes and shows the
BigQuery tile in both themes; its main flow cannot run on this machine, because it signs in to the
source Postgres with a canary password that only a `trust` pg_hba (as in CI) accepts.
