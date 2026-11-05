# Semantic layer part 2, PR 04: read facts from the warehouse (door, BigQuery, the Postgres family) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor's **Read from warehouse** stores a table's columns, types, comments, keys, partition, sort and distribution, size and estimate in its doc, with who read it and when. It is bounded, read-only, through the SSRF guard, never with a secret in the reply, and at most 60 times per connection per hour across pods. BigQuery and the eleven Postgres-wire sources read real facts. Every other connector with `describeTable` stores columns and types.
**Architecture:** One door, `readTableFacts` (`src/connectors/tableFactsRun.ts`), built like `connectionRun.describeTable`. It calls `def.tableFacts` when the connector has one, else `def.describeTable`, never both. Each family's reader lives in its own file and is wired with one line. `sourceTable:read` takes the cross-pod counter, then the door, then writes the facts under the doc's lock. The fake warehouse gets a reader over DuckDB's own comments, and a counter of every catalog call.
**Tech Stack:** `src/connectors`, `src/server/counters.ts`, `src/ipc`, self-checks (the recording `pg` fake in `test-connectorsPostgres`, `scripts/bigqueryFake.ts`, a real Postgres in a `-db` suite).
**Spec:** docs/semantic-layer/02-source-tables.md (D6, D7 rows BigQuery, PostgreSQL family, Redshift, the pgwire engines; D8, D15) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p2-00-index.md
**Branch and PR:** `feat/semantic-p2-04-facts-door` off `origin/develop` after PR 03 merges. One PR, in release 2.

## Global Constraints

- **One door.** No handler calls a driver or `def.tableFacts` directly. The door does the following, in order:
  1. Builds `buildContext(values, secrets, { rowLimit: FACTS_ROWS = 2_000 })`, with its 30 s cap.
  2. Runs `guardHost(def, ctx)` (the SSRF guard, `src/connectors/connectionRun.ts:76-84`).
  3. Calls the connector inside try/catch, passing every error through `safeError(err, ctx.secrets)`.
  4. Runs `sanitizeFacts`.
  5. Runs `redactSecrets` over every string in the facts.
- `connectionRun.ts` is 500 lines (503 on develop) and gets no lines: the door is its own file.
- **No Live statement.** The door does not take `warehouse()`, touches no `live_usage`, and never calls `runLiveBound` or `.runBound(`: `test-liveUsage`'s one-door ratchet must stay green as is.
- **Every statement is limited** (`limit N`, `TOP`, `FETCH FIRST`), and the name is bound or whitelisted and quoted, as that family's `describeTable` does today. A sub-read that fails costs its field, never the read. Only the column read is required.
- **Rate limit:** `counters.take(org, [{ key: `sourceRead:${connId}`, limit: 60, windowMs: 3_600_000 }])` runs before the door. A refused take charges nothing, and a failed read still counts.
- **Only on a click.** `sourceTable:read` is the only caller of the door. No refresh, view, schedule or job calls it.
- Family files near the cap get one wiring line each: `src/connectors/postgres.ts` 737 lines, `src/connectors/bigquery.ts` 479 (the shared GET helper is the only reshuffle). Readers are new files.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **BigQuery makes one GET.** `tableFacts` replaces `describeTable` for a connector that has it (an index call), so `tables.get` is fetched once. Task 4 asserts the fake transport saw one call.
- **A secret in a comment.** A warehouse can echo a password in an error or store one in a comment. Every string in the stored facts and the reply goes through `redactSecrets`. Task 1's canary.
- **Redshift is not Postgres.** It has no `pg_get_partkeydef`, its keys are informational (`enforced: false`), and `SVV_TABLE_INFO` leaves out empty tables. Task 5 pins each.
- **The pgwire engines** (CockroachDB, YugabyteDB, Materialize, QuestDB, RisingWave) keep whatever answers. When the `pg_attribute` read fails, the columns come from `information_schema` (today's `COLUMNS_SQL`). This is UNVERIFIED, like their `listTables`.
- **Opening is free.** `fake.catalogCalls` counts `listTables`, `describeTable` and `tableFacts`. It stays flat across `sourceTable:list` and `:get`, and goes up by one on `:read`. Task 3.

## Rolling deploys

`facts` lives inside the new doc record, which a release-1 pod never reads. The index gains `readAt`, which PR 03's sanitizer already reads. The channel is new: on an old pod it answers "unknown channel", and the tab ships in PR 07.

---

### Task 1: The door

**Files:** Create `src/connectors/tableFactsRun.ts`, `scripts/test-tableFacts.ts`. Modify `src/connectors/types.ts` (split `safeError`'s two passes into an exported `redactSecrets(msg, secrets)`; `safeError` calls it, then cuts to 500 characters).
**Interfaces:** Consumes `getConnector`, `buildContext`, `guardHost`, `sanitizeFacts` (PR 03). Produces:
```ts
export const FACTS_ROWS = 2_000;
/** null: this connector can read neither facts nor columns (SaaS, Trino, Presto, Elasticsearch, OpenSearch, Druid). */
export async function readTableFacts(connectorId: unknown, values: Record<string, unknown>, secrets: Record<string, string>, table: string): Promise<{ ok: true; facts: TableFacts } | { ok: false; error: string } | null>;
```
When the door falls back to `describeTable`, it maps the result to `{ columns, rowEstimate? }`.

- [ ] **Step 1: Write the failing test.** `scripts/test-tableFacts.ts` registers three test connectors with `registry.registerTestConnector`:
  - `facts-both`: it has `tableFacts` and `describeTable`, each counting its calls.
  - `facts-describe`: it has `describeTable` only.
  - `facts-none`: it has neither.

  `facts-both`'s `tableFacts` returns `{ ok: true, comment: 'pw=' + ctx.secrets.password, columns: [{ name: 'a', type: 'int', comment: ctx.secrets.password }] }` unless `table === 'boom'`, which returns `{ ok: false, error: 'login failed for ' + ctx.secrets.password }`.
  ```ts
  const S = { password: 'pw-canary-71ab' };
  const r = await readTableFacts('facts-both', {}, S, 't');
  ok('the reader wins: describeTable never runs', r!.ok && calls.tableFacts === 1 && calls.describe === 0);
  ok('a secret in any string is redacted', !JSON.stringify(r).includes(S.password) && JSON.stringify(r).includes('***'));
  ok('…and in an error', ((e) => e!.ok === false && !e!.error.includes(S.password))(await readTableFacts('facts-both', {}, S, 'boom')));
  ok('no reader: describeTable\'s columns and estimate', JSON.stringify(await readTableFacts('facts-describe', {}, {}, 't')) === '{"ok":true,"facts":{"columns":[{"name":"a","type":"int"}],"rowEstimate":5}}');
  ok('neither: null, not an error', (await readTableFacts('facts-none', {}, {}, 't')) === null);
  ok('the row bound reaches the connector', seenCtx.rowLimit === 2000 && seenCtx.timeoutMs === 30_000);
  // SSRF, in server mode with a `host` field resolving to 10.0.0.5 (as test-ssrf does)
  ok('a private host is refused before the reader runs', ((x) => x!.ok === false && calls.tableFacts === before)(await readTableFacts('facts-host', { host: 'internal.test' }, {}, 't')));
  ok('NEGATIVE CONTROL: SSRF_ALLOW lets it through', /* process.env.SSRF_ALLOW = '10.0.0.0/8' */ (await readTableFacts('facts-host', { host: 'internal.test' }, {}, 't'))!.ok === true);
  ```
  Copy the SSRF setup (`enterServerMode`, a stub resolver) from `scripts/test-ssrf.ts`, the same way `test-connections-server.ts` drives `guardHost`.
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts`. Expect tsc's "Cannot find module '../src/connectors/tableFactsRun'".
- [ ] **Step 3: Implement.** Write the signatures above. The string walk is a small recursive map over arrays and objects, used for facts only.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-tableFacts.js scripts/test-connectors.js scripts/test-ssrf.js scripts/test-liveUsage.js` (each with `node`).
- [ ] **Step 5: Commit.** `git add src/connectors/tableFactsRun.ts src/connectors/types.ts scripts/test-tableFacts.ts`. Message: "Read a table's facts through one bounded, guarded, redacted door".

### Task 2: The fake warehouse reads DuckDB's own comments

**Files:** Modify `scripts/liveFakeConnector.ts`:
- Add `tableFacts` to `def()`.
- Add `fake.catalogCalls` (+1 in `listTables`, `describeTable` and `tableFacts`, after each one's name check) and `fake.factsHook`. `resetFake` clears both.
- `ensureFixture` adds `COMMENT ON TABLE live_fake_orders IS 'Orders, one row per line'` and `COMMENT ON COLUMN live_fake_orders.amount IS 'Order amount in USD'`. Both are idempotent.

Test: extend `scripts/test-tableFacts.ts`.
**Interfaces:** `tableFacts(ctx, table)` uses the following, each with `$1` = the table name (after `TABLE_RE`) and a `LIMIT`:
- `duckdb_tables()` for `comment` and `estimated_size`.
- `duckdb_columns()` for name, `data_type`, `is_nullable` and `comment`.
- `duckdb_constraints()` for `constraint_type = 'PRIMARY KEY'` with `constraint_column_names`, `enforced: true`.

A `fake.factsHook(ctx, table)` may answer instead.

- [ ] **Step 1: Write the failing test.**
  ```ts
  await H.warehouseExec(H.ORG_A, "CREATE OR REPLACE TABLE wh_keys (id INTEGER PRIMARY KEY, note VARCHAR); COMMENT ON COLUMN wh_keys.note IS 'Free text'");
  const read = (t: string, values = {}) => H.as(H.ORG_A, () => readTableFacts(LIVE_FAKE_ID, values, {}, t));
  const f = await read('live_fake_orders', { fixture: 'orders' });
  ok('fake: the table and column comments', f!.ok && f!.facts.comment === 'Orders, one row per line' && f!.facts.columns.find((c) => c.name === 'amount')!.comment === 'Order amount in USD');
  const k = await read('wh_keys');
  ok('fake: a declared key', k!.ok && JSON.stringify(k!.facts.primaryKey) === '{"columns":["id"],"enforced":true}');
  ok('fake: a hostile name is refused before DuckDB', (await read('x"; drop table wh_keys; --'))!.ok === false);
  ok('fake: counted (the hostile name never reached the reader)', H.fake.catalogCalls === n0 + 2);
  ```
- [ ] **Step 2: Run it to see it fail.** Run `node scripts/test-tableFacts.js`. Expect `FAIL fake: the table and column comments` (the door answers from `describeTable`, which has no comment).
- [ ] **Step 3: Implement.** Use the interfaces above.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-tableFacts.js scripts/test-liveRoute.js scripts/test-liveCopy.js scripts/test-liveSafetyNet.js` (each with `node`). Their `fake.calls` counts are unchanged, because `fake.calls` records `runBound` only.
- [ ] **Step 5: Commit.** `git add scripts/liveFakeConnector.ts scripts/test-tableFacts.ts`. Message: "Give the fake warehouse a facts reader and count its catalog calls".

### Task 3: `sourceTable:read` and the rate limit

**Files:** Create `src/ipc/sourceTableRead.ts`. Modify:
- `src/api/sourceTables.ts`: add `'sourceTable:read': rpc({ access: 'write', input: z.strictObject(Doc), project: byProjectId })`.
- `src/ipc/sourceTables.ts`: `register()` calls the new module's `register()`.
- `src/app/sourceTableMessages.ts`: `factsReadLimit(minutes)` and `factsNotReadable()`.

Test: extend `scripts/test-sourceTables.ts` (part "read") and `scripts/test-sourceNamesHidden.ts` (the `PAYLOAD` entry, plus the cross-pod check).
**Interfaces:** Consumes `readTableFacts`, `loadSecrets` (`src/ipc/connectionSecrets.ts:59`), `counters.take`, `updateSourceDoc`, `osUser`, `estimateLabel` (`src/connectors/bigqueryShape.ts:413`). The reply is `{ ok: true, doc }` (`:get`'s doc view, with `facts` holding `readAt` and `readBy`), or `{ ok: false, error, retryAfterSec? }`. Both `:get` and `:read` build their doc view through one function, which adds `facts.sizeLabel = estimateLabel(bytes)` when `bytes` is set: the server formats the size, and the web never divides it. The sentences are:
- `factsReadLimit(minutes)`: "This connection's tables were read 60 times in the last hour. Try again in {minutes} min."
- `factsNotReadable()`: "This source has no catalog Ordinate can read. Write its notes by hand."

- [ ] **Step 1: Write the failing test.**
  ```ts
  const read = () => post('sourceTable:read', { projectId: P, connId: C, docId: D });
  const n0 = H.fake.catalogCalls; const live0 = H.liveCounts(); const runs0 = H.fake.calls.length;
  await post('sourceTable:list', { projectId: P }); await post('sourceTable:get', { projectId: P, connId: C, docId: D });
  ok('opening reads no warehouse', H.fake.catalogCalls === n0);
  const r = (await hydrates(liveId, read));
  ok('read: facts stored with who and when', r.value.value.ok && r.value.value.doc.facts.readBy === H.ORG_A.user.email && typeof r.value.value.doc.facts.readAt === 'string');
  ok('read: one catalog call, no Live statement, nothing hydrated', H.fake.catalogCalls === n0 + 1 && H.fake.calls.length === runs0 && JSON.stringify(H.liveCounts()) === JSON.stringify(live0) && !r.hydrated);
  ok('read: the index carries readAt (the strip drops never_read)', !(await post('sourceTable:list', { projectId: P })).value.todo.some((t: Reply) => t.docId === D && t.kind === 'never_read'));
  ok('read: the human fields and the tag are untouched', ((g) => g.doc.guide === GUIDE && g.tag === tagBefore)((await post('sourceTable:get', { projectId: P, connId: C, docId: D })).value));
  for (let i = 1; i < 60; i++) await read();
  const refused = (await read()).value;
  ok('the 61st read in an hour is refused, with the wait', refused.ok === false && /Try again in \d+ min/.test(refused.error) && H.fake.catalogCalls === n0 + 60);
  ok('NEGATIVE CONTROL: another connection is not limited', (await post('sourceTable:read', { projectId: P, connId: C2, docId: D2 })).value.ok);
  ok('no catalog: the sentence', (await post('sourceTable:read', { projectId: P, connId: SAAS, docId: D3 })).value.error === factsNotReadable());
  ```
  In the DB suite, `W` runs on Postgres, so the counter is `shared_counters`. Make 60 `counters.take(...)` calls on that key through a **second** `Pool` on the same database (`counters.useCounterDb(poolB)`, then put `W.pool` back). Then `ok('the limit holds across pods', (await W.call('ed', 'sourceTable:read', …)).body.error matches factsReadLimit)`.
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts && node scripts/test-sourceTables.js`. Expect `No handler for sourceTable:read`.
- [ ] **Step 3: Implement.** The order is: the doc, then the connection, then `take`, then `loadSecrets`, then the door, then `updateSourceDoc`. Then run `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** Run:
  - `node scripts/test-sourceTables.js`
  - `DATABASE_URL=… node scripts/test-sourceNamesHidden.js`
  - `node scripts/test-liveUsage.js` (the one-door ratchet)
  - `node scripts/test-sharedCounters.js`
  - `node scripts/check-contracts.js`
  - `node scripts/test-i18n.js`
  - `npm run lint`
- [ ] **Step 5: Commit.** `git add src/ipc/sourceTableRead.ts src/ipc/sourceTables.ts src/api/sourceTables.ts src/app/sourceTableMessages.ts src/i18n scripts/test-sourceTables.ts scripts/test-sourceNamesHidden.ts`. Message: "Read a source table's facts on an editor's click, 60 times an hour at most".

### Task 4: BigQuery, from the one `tables.get`

**Files:** Create `src/connectors/bigqueryFacts.ts`. Modify `src/connectors/bigquery.ts:410-425`: move `describeTable`'s body up to the GET into `tableJson(ctx, table)`; `describeTable` and the new `tableFacts` both use it, and the def gains `tableFacts`. Test: extend `scripts/test-connectorsBigquery.ts`.
**Interfaces:** Produces `export function bigqueryFacts(json: unknown): TableFacts`. It is pure, and it reads:
- `description` → `comment`.
- `describeColumns(json)` (`src/connectors/bigqueryShape.ts:380`), with each top-level field's `description` → column `comment`.
- `tableConstraints.primaryKey.columns` → `{ columns, enforced: false }`, with `key: true` on those columns.
- `timePartitioning` `{ type, field }` → `partition: { columns: [field ?? '_PARTITIONTIME'], method: type }`, or `rangePartitioning.field` → `method: 'RANGE'`.
- `requirePartitionFilter` (top-level, or the older one under `timePartitioning`) → `required`.
- `clustering.fields` → `clusterBy`.
- `numRows` → `rowEstimate`, `numBytes` → `bytes`, and `lastModifiedTime` (epoch ms) → ISO `lastModified`.

- [ ] **Step 1: Write the failing test.** Build a `tables.get` reply holding each field above. With `fakeTransport` (`scripts/bigqueryFake.ts`), run `readTableFacts('bigquery', values, { keyJson }, 'ds.orders')`:
  ```ts
  ok('bigquery: one GET for the whole read', t.calls.filter((c) => c.method === 'GET' && /\/tables\//.test(c.url.pathname)).length === 1);
  ok('bigquery: partition required, clustering, key, comments', JSON.stringify([f.partition, f.clusterBy, f.primaryKey, f.columns[1].comment]) === '[{"columns":["order_date"],"method":"DAY","required":true},["region"],{"columns":["line_id"],"enforced":false},"Discount in USD, after tax"]');
  ok('bigquery: a malformed name never reaches the network', /* 'a`b.c' */ t.calls.length === before && r.ok === false);
  ok('NEGATIVE CONTROL: describeTable still answers the workbench unchanged', JSON.stringify(await def.describeTable!(ctx, 'ds.orders')) === DESCRIBE_BEFORE);
  ```
- [ ] **Step 2: Run it to see it fail.** Run `node scripts/test-connectorsBigquery.js`. Expect `FAIL bigquery: partition required, …`.
- [ ] **Step 3: Implement.** Use the interface above.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-connectorsBigquery.js scripts/test-liveConnectors.js scripts/test-file-size.js` (each with `node`).
- [ ] **Step 5: Commit.** `git add src/connectors/bigqueryFacts.ts src/connectors/bigquery.ts scripts/test-connectorsBigquery.ts`. Message: "Read BigQuery's descriptions, key, partitioning and clustering from the table's own GET".

### Task 5: The Postgres family, with Redshift

**Files:** Create `src/connectors/pgFacts.ts`, `scripts/test-pgFacts-db.ts`. Modify `src/connectors/postgres.ts`: `export` on `COLUMNS_SQL` (`:592`, 0 lines; it has no `limit`, so the fallback appends ` limit ${FACTS_ROWS}`), and one `tableFacts:` line in `define()` (`:720-733`). `queryArray` is already exported by `src/connectors/pgRows.ts`. Test: extend `scripts/test-connectorsPostgres.ts`.
**Interfaces:** Produces:
```ts
// src/connectors/tableFacts.ts (added here; every family's reader takes it, so no reader imports its driver module)
export type FactsQuery = (sql: string, params: (string | number | null)[]) => Promise<unknown[][]>;
export type FactsReply = ({ ok: true } & TableFacts) | ConnectorError;
export type OpenFacts = (read: (q: FactsQuery) => Promise<FactsReply>) => Promise<FactsReply>;
// src/connectors/pgFacts.ts
/** Parses `table` first (≤ 2 parts, none empty): a bad name never opens a socket. */
export function pgTableFacts(table: string, open: OpenFacts, opts: { redshift: boolean; columnsSql: string }): Promise<FactsReply>;
```
The wiring is `tableFacts: (ctx, t) => pgTableFacts(t, (read) => withClient(v, ctx, (c) => read(async (s, vals) => (await queryArray(c, s, vals)).rows)), { redshift: v.id === 'amazon-redshift', columnsSql: COLUMNS_SQL })`. The ladder below binds schema and name as `$1`/`$2` and the oid as `$1::oid`, and each statement ends in `limit N`:

1. The relation (required): `pg_class` joined to `pg_namespace` on the same match as `describeTable`. It gives the `oid`, `obj_description(oid, 'pg_class')` and `reltuples` (≥ 0 → `rowEstimate`).
2. Columns (required): `pg_attribute` for `attname`, `format_type(atttypid, atttypmod)`, `not attnotnull` and `col_description(attrelid, attnum)`, with `attnum > 0 and not attisdropped`. On failure, use `columnsSql` with no comments.
3. Primary key: `pg_constraint` where `contype = 'p'`, its `conkey` mapped to names. `enforced` is `!redshift`. It sets `key: true` on those columns.
4. Indexes (not on Redshift): `pg_index` joined to `pg_class` and `pg_am` for name, columns, `indisunique` and `amname` (≤ 50).
5. Partition: `pg_get_partkeydef($1::oid)`. Parse `RANGE (order_date)` into `{ method: 'RANGE', columns: ['order_date'] }`.
6. Size: `pg_total_relation_size($1::oid)` → `bytes`.
7. Redshift only: `svv_table_info` where `"schema" = $1 and "table" = $2`. It gives `diststyle` (`KEY(customer_id)` → `{ style: 'KEY', columns: ['customer_id'] }`), `sortkey1` → `sortKey`, `size` (1 MB blocks) → `bytes`, and `tbl_rows` → `rowEstimate`.

- [ ] **Step 1: Write the failing test.** In `test-connectorsPostgres.ts`, on the recording fake:
  ```ts
  const pg = byId('postgres'); const rs = byId('amazon-redshift');
  await pg.tableFacts!(ctx, 'public.x"; drop table y; --');
  ok('pg facts: a hostile name is a bound value, never text', recorded.every((r) => !/drop table/i.test(r.text)) && recorded[0].values!.includes('x"; drop table y; --'));
  ok('pg facts: three parts are refused before a socket', ((n) => clients.length === n)(clients.length, await pg.tableFacts!(ctx, 'a.b.c')));
  ok('pg facts: every statement is limited', recorded.filter(isFactsSql).every((r) => /\blimit \d+\s*$/i.test(r.text.trim())));
  queryImpl = failWhen(/pg_get_partkeydef/);
  ok('pg facts: a failing sub-read keeps the rest', ((f) => f.ok && f.columns.length === 2 && f.primaryKey && !('partition' in f))(await pg.tableFacts!(ctx, 'public.orders')));
  queryImpl = failWhen(/pg_attribute/);
  ok('pg facts: columns fall back to information_schema, with no comments', ((f) => f.ok && f.columns.every((c) => !('comment' in c)))(await pg.tableFacts!(ctx, 'public.orders')));
  ok('redshift: distribution, sort key and an informational key', ((f) => JSON.stringify([f.distribution, f.sortKey, f.primaryKey.enforced]) === '[{"style":"KEY","columns":["customer_id"]},["order_date"],false]')(await rs.tableFacts!(ctx, 'public.orders')));
  ok('every pgwire variant has tableFacts', CONNECTORS.every((d) => typeof d.tableFacts === 'function'));
  ```
  `scripts/test-pgFacts-db.ts` (skips without `DATABASE_URL`) works on a scratch database. It creates `public.orders (line_id bigint, order_date date not null, amount numeric(12,2), primary key (line_id, order_date)) partition by range (order_date)` with one partition, `COMMENT ON TABLE` and `COMMENT ON COLUMN amount IS 'Discount in USD, after tax'`, then runs `readTableFacts('postgres', { host, port, database, user }, { password }, 'public.orders')` out of server mode:
  ```ts
  ok('real pg: comments, key, partition', f.ok && f.facts.comment === 'Orders' && f.facts.columns.find((c) => c.name === 'amount')!.comment === 'Discount in USD, after tax' && JSON.stringify(f.facts.primaryKey) === '{"columns":["line_id","order_date"],"enforced":true}' && JSON.stringify(f.facts.partition) === '{"columns":["order_date"],"method":"RANGE"}');
  ok('real pg: a hostile name reads nothing and drops nothing', (await readTableFacts('postgres', v, s, 'public.orders"; drop table public.orders; --'))!.ok === false && (await client.query("select to_regclass('public.orders') is not null as t")).rows[0].t === true);
  ```
- [ ] **Step 2: Run it to see it fail.** Run `node scripts/test-connectorsPostgres.js`. Expect `FAIL pg facts: …` (no `tableFacts`).
- [ ] **Step 3: Implement.** Use the interface above. Put an `// UNVERIFIED` comment on the pgwire engines and Redshift's view names, as `listTables` has.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-connectorsPostgres.js`, `DATABASE_URL=… node scripts/test-pgFacts-db.js`, `node scripts/test-file-size.js` (`postgres.ts` ≤ 740) and `npm run lint`.
- [ ] **Step 5: Commit.** `git add src/connectors/tableFacts.ts src/connectors/pgFacts.ts src/connectors/postgres.ts scripts/test-connectorsPostgres.ts scripts/test-pgFacts-db.ts`. Message: "Read comments, keys, partitions and Redshift's distribution for the Postgres family".

## Existing tests that must stay green

`test-connectors`, `test-connectorsPostgres`, `test-connectorsBigquery`, `test-connectorsWire`, `test-liveConnectors`, `test-liveUsage`, `test-sharedCounters`, `test-ssrf`, `test-connections-server` (DB), `test-liveRoute`, `test-liveCopy`, `test-liveSafetyNet`, `test-sourceTables`, `test-file-size`, `test-asyncReach`, `test-i18n`, `check-contracts`.
