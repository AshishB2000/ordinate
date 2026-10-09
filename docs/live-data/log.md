# Live data — task log

Measurements and decisions per task of [00-plan.md](00-plan.md). Newest last.

## 2026-10-09 — L1.1 Room for warehouse keys, L1.2 Snowflake (+ the Snowflake halves of L1.4, L1.5)

**Built.** `src/connectors/snowflake.ts` (the family: fields, the SQL API protocol, run, listTables,
describeTable, `live.runBound`), split by job into `snowflakeAuth.ts` (account → host, JWT, the JWT
cache), `snowflakeShape.ts` (rowType → ColumnType, value decoding), `snowflakeSql.ts` (the F3 cap,
bindings) and `snowflakeHttp.ts` (the socket). Registered in `FAMILY_MODULES`; logo `siSnowflake`.
`incrementalSql.ts` gains the `snowflake` dialect. Web: `SecretTextarea`, the masked multi-line
secret control (new-connection form, and the rail's "Key saved" → Replace).

**Decisions (and where they depart from the plan's wording).**

- **One secret field for the key or the PAT** (`token`, a textarea), not two. Both would land in the
  same `token` slot (`connectionSecrets.ts`: everything but `password` shares it, first writer wins),
  and `secretStatus` would show both as "Set" when only one is. The `auth` select says which it is; a
  PEM in PAT mode is refused before a socket opens, so a private key can never go out as a bearer.
- **FIXED wider than 15 digits is not declared a number.** Snowflake's `INTEGER` is `NUMBER(38,0)`:
  "precision > 15 → text" would make every integer column unsummable, and "→ number" would turn a
  20-digit id into null (parse.ts refuses a lossy number). It is left undeclared, so parse.ts decides
  from the values, as for a CSV or a Postgres `bigint`: a 16+ digit id keeps the column text
  (`test-connectorsSnowflake`: `ORDER_ID` → text), small values make it a number (`ID` → number).
- **REAL for an extract is printed at 15 significant digits** (DBL_DIG; Postgres's default before
  v12), because `0.30000000000000004` would otherwise be nulled by parse.ts's strict rule. `runBound`
  (live) keeps the exact double.
- **DATE / TIMESTAMP_NTZ bindings use the API's documented value formats**, epoch milliseconds and
  epoch nanoseconds, converted from the ISO string a `LiveParam` carries, rather than the ISO string
  itself. The session runs with `TIMEZONE = 'UTC'`.
- **A transport of its own over `safeFetch`, not `httpRequest`.** The SQL API gzips result partitions
  after the first; `httpRequest` decodes every body as UTF-8 text, which destroys gzip bytes, and has no
  abort signal. `http.ts` cannot grow, so `snowflakeHttp.ts` (111 lines) adds the clock, the byte
  ceiling, bounded gunzip and the signal over the same SSRF guard.
- **Sync submit, cancel when the handle lands.** The submit is sent without `async=true`, as the
  plan says. A submit still in flight when the caller gives up has no handle yet, so the caller is
  answered at once, and the statement is cancelled as soon as its 202 arrives. The statement's own
  `timeout` stops it on Snowflake's side in any case.
- **Test connection warnings.** `ConnectorTables` gains an optional `warnings` (a compatible change to
  `types.ts`), which `connectionRun` passes through and `connection:testAndSave` /
  `connection:listTables` / `connection:replaceSecret` return. The one sentence so far
  (`adminRoleWarning`) is in `src/connectors/connectorMessages.ts`, a new `MAIN_FILES` sentence file.

**Measured** (4 vCPU container, Node 22, medians):

| What | Result |
|---|---|
| Key-pair JWT, 2048-bit key, AES-256-CBC PKCS#8: sign (decrypt + sign) / cache hit | 1.43 ms / 0.006 ms (21 runs) |
| Shaping 100k values of one type (`shapeFirst`, extract) | FIXED 17–33 ms, TEXT 14.5, REAL 110, DATE 156, TIMESTAMP_TZ 158, TIMESTAMP_NTZ 181 |
| Gzip bomb (64 MB of zeros, 64 KB on the wire) against a 1 MB ceiling | stopped, reported truncated, in < 3 s |

Timestamp shaping costs what `toISOString()` costs, which the Postgres path already pays per cell in
`connectionRun` (a `Date` → ISO string). Removing BigInt from the epoch arithmetic changed nothing
measurable (626 → 678 ms for 100k × 8 columns, within noise), so the cost is the formatting.

**Tests.** `test-connectorsSnowflake` (88 checks: the account guard with 2,000 fuzzed inputs and a
negative control, request/JWT/QUERY_TAG, `crypto.verify` of the JWT, the JWT cache per org, every
binding type, 13 adversarial literals, every rowType incl. TZ offsets and U+FEFF, partitions,
truncation at the cap, 202 polling, cancel on abort in a poll and mid-submit, cancel on timeout,
listTables/describeTable, and the secret canary over every result, error, request and printed line),
`test-connectorsSnowflakeHttp` (9: SSRF refusal with a negative control, redirect refused, gzip,
gzip bomb, byte ceiling, timeout and abort tear the socket down), `test-incrementalRefresh` §8 (the
cursor predicate pushed to a fake SQL API through a real refresh), `test-connections-server` (the key
and passphrase through `testAndSave` into the encrypted store, `secretSet` booleans only, the
admin-role warning, and the existing dump/disk/reply/log greps extended to the new canaries),
Vitest for the masked control and the rail's Replace, and the connections e2e.

**Not done here.** BigQuery (L1.3, a sibling task). The real-account nightly
(`test-warehouseLive`, `warehouse-nightly.yml`) and the README / CLAUDE.md counts belong to the
reconciliation after both connectors merge.


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
