# Semantic layer part 2, PR 01: viewers never see a source table's name — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project viewer gets no source table name, saved SQL, host, database or user, and no warehouse error text, from any `read` reply. An editor's replies stay byte-identical.
**Architecture:** One rule, `seesSourceNames(projectId)` (true for org admins and project editors: `!restrictedOn`), applied at five reply edges. The lineage trim sits in the shared `loadInput`, so `lineage:get` and `pipelines:get` both get it.
**Tech Stack:** `src/data`, `src/ipc`, `src/app/pipelineView.ts`, a self-check on the real RPC route with real roles (`scripts/rowPolicyHarness.ts`).
**Spec:** docs/semantic-layer/02-source-tables.md (D13, Q1, "Left to the builder": `connections:list` for viewers, `lastRefreshError`) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p2-00-index.md
**Branch and PR:** `feat/semantic-p2-01-viewer-source-names` off `origin/develop`. One PR, in release 1, with no dependencies.

## Global Constraints

- **An editor's reply is unchanged, byte for byte.** Every trim is behind `if (!(await seesSourceNames(p)))`.
- **Fail closed.** If the role lookup throws, trim (`restrictedOn(p).catch(() => true)`).
- **A parallel session may fix `connections:list` first.** Before Task 4, run `grep -n "restrictedOn\|seesSourceNames" src/ipc/connections.ts`. If a viewer trim is already in the handler, keep it, add only this plan's test, and widen the trim to cover every field the test names. Never stack a second trim.
- No new channel, stored field or dependency. No server sentence: the web already says "The last refresh failed." when `lastRefreshError` is absent (`web/src/features/data/DatasetList.tsx:138`, `DatasetPage.tsx:126`).
- No web change is needed. Both Connections pages are `EditorsOnly` (`web/src/features/connections/ConnectionsPage.tsx:51-63`, `WorkbenchPage.tsx:64`), so a viewer's web never calls `connections:list`. Lineage draws `sub` as it comes, and the source line draws `label`.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **The fourth leak.** `pipelines:get` (`read`) builds its source nodes through `loadGraph` (`src/app/pipelineView.ts:83-96`), which calls `loadInput` and then `buildGraph`. `buildGraph` sets `sub: "Table ${o.table}"` (`src/analysis/lineage.ts:183-189`), so a viewer gets the name. Task 2 pins it.
- **Refresh errors quote relations.** A driver says `relation "public.orders" does not exist`. Two replies carry it: `dataset:list` (`src/ipc/datasets.ts:361-372`, which withholds it only for datasets closed by row access rules) and `pipelines:get`'s runs (`src/ipc/pipelines.ts:44-53` `quietRuns`, the same rule). Task 3 pins both.
- **A background job loses names.** Pipeline runs and scheduled refreshes run as the system identity (`role: 'admin'` → `callerOn` returns `UNRESTRICTED`, `src/server/authz/caller.ts:87-89`), so they see names. Task 2's control.
- **`sourceView` keeps "a query".** "Connection · Warehouse · a query" names nothing, so it stays for a viewer.

## Rolling deploys

No stored field changes. During the rollout an old pod still answers viewers untrimmed until it is replaced. That is what we have today, and it ends when the release is everywhere. Replies only lose fields for viewers, and every web reader of them already handles the field being absent.

---

### Task 1: The rule, and `dataset:source`

**Files:** Create `src/data/sourceNames.ts`, `scripts/test-sourceNamesHidden.ts`. Modify `src/data/datasetOrigin.ts:268-302` (`sourceView`), `src/ipc/datasetViews.ts:96-104` (`dataset:source`).
**Interfaces:** Consumes `restrictedOn` (`src/data/rowAccess.ts:274`). Produces:
```ts
// src/data/sourceNames.ts — the "can open the connection" rule (spec D13); later parts reuse it
export async function seesSourceNames(projectId: string): Promise<boolean> // !(await restrictedOn(p).catch(() => true))
// src/data/datasetOrigin.ts
export function sourceView(sourceKind: string, origin: DatasetOrigin | undefined, connName: (id: string) => string | undefined, opts?: { hideTable?: boolean }): SourceView
```
`hideTable` drops `origin.table` from the `connection` label. Nothing else changes.

- [ ] **Step 1: Write the failing test.** Build `scripts/test-sourceNamesHidden.ts` on `H.world('source names')` from `scripts/rowPolicyHarness.ts` (it skips without `DATABASE_URL`). Inside `W.as('boss', …)`, save the following:
  - A connection: `connections.saveConnection(P, { name: 'Warehouse', connectorId: 'postgres', values: { host: 'canary-host-9f3.internal', database: 'canary_db_9f3', user: 'canary_user_9f3' }, table: 'public.canary_tbl_9f3', query: 'select * from canary_tbl_9f3' })`.
  - A saved query: `connections.saveQuery(P, connId, { name: 'Q', sql: 'select 1 from canary_tbl_9f3' })`.
  - A dataset: `datasets.saveDataset(P, { name: 'Orders', sourceKind: 'postgres', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'connection', connId, table: 'public.canary_tbl_9f3' } })`.
  - A refresh error: `datasets.markRefresh(P, D, 'error', 'relation "public.canary_tbl_9f3" does not exist')`.

  The project's viewer with no rules on `D` is `nobody`, and `ed` is its editor. Then add these asserts:
  ```ts
  const CANARY = /canary_(tbl|db|user|host)/;
  const src = (who: string) => W.call(who, 'dataset:source', { projectId: P, id: D });
  ok('dataset:source: a viewer reads the connection, not the table', (await src('nobody')).body.label === 'Connection · Warehouse');
  ok('NEGATIVE CONTROL: the editor still reads the table', (await src('ed')).body.label === 'Connection · Warehouse · public.canary_tbl_9f3');
  ok('sourceView: hideTable keeps "a query"', sourceView('postgres', { kind: 'connection', connId, sql: 'select 1' }, () => 'W', { hideTable: true }).label === 'Connection · W · a query');
  ```
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts && DATABASE_URL=… node scripts/test-sourceNamesHidden.js`. Expect `FAIL dataset:source: a viewer reads the connection, not the table`.
- [ ] **Step 3: Implement.** Write the signatures above. The handler passes `{ hideTable: !(await seesSourceNames(str(projectId))) }`.
- [ ] **Step 4: Run it to see it pass.** Run the same command, plus `node scripts/test-dataViews.js` (it runs as admin, and its `'Connection · a deleted connection · orders'` assert must stay green unchanged) and `node scripts/test-dataset-origin.js`.
- [ ] **Step 5: Commit.** `git add src/data/sourceNames.ts src/data/datasetOrigin.ts src/ipc/datasetViews.ts scripts/test-sourceNamesHidden.ts`. Message: "Show a viewer a dataset's connection, never its source table".

### Task 2: Lineage and pipelines: the source node says the connector's kind

**Files:** Modify `src/ipc/lineage.ts:29-52` (`loadInput`). Test: extend `scripts/test-sourceNamesHidden.ts`.
**Interfaces:** Consumes `seesSourceNames`. `loadInput` keeps its signature. When the caller does not see names, each dataset meta whose origin is `connection` reaches `buildGraph` as `{ ...meta, origin: { ...meta.origin, table: undefined } }`. `buildGraph` then falls back to `c.kind` (the connector id, as `loadInput` already passes `kind: c.connectorId`). `lineage.ts` and `pipelineView.ts` are unchanged.

- [ ] **Step 1: Write the failing test.**
  ```ts
  const lin = (who: string) => W.call(who, 'lineage:get', { projectId: P, type: 'dataset', id: D });
  const pipe = (who: string) => W.call(who, 'pipelines:get', { projectId: P });
  const srcNode = (r: H.Reply) => r.body.nodes.find((n: { kind: string }) => n.kind === 'source');
  ok('lineage:get: a viewer reads the connector kind', srcNode(await lin('nobody')).sub === 'postgres' && !CANARY.test((await lin('nobody')).text));
  ok('pipelines:get: a viewer reads no table on the source node', !CANARY.test((await pipe('nobody')).text));
  ok('NEGATIVE CONTROL: the editor reads "Table public.canary_tbl_9f3"', srcNode(await lin('ed')).sub === 'Table public.canary_tbl_9f3' && CANARY.test((await pipe('ed')).text));
  ok('an editor and an org admin get the same bytes', (await lin('ed')).text === (await lin('boss')).text);
  ```
- [ ] **Step 2: Run it to see it fail.** Expect `FAIL lineage:get: a viewer reads the connector kind`.
- [ ] **Step 3: Implement.** In `loadInput`, `const hide = !(await seesSourceNames(projectId));` runs alongside the `Promise.all`, then the map above. Add a one-line comment: "the one input lineage:get and pipelines:get share; a job (system admin) still sees names".
- [ ] **Step 4: Run it to see it pass.** Run the suite, then `node scripts/test-lineage.js scripts/test-pipelines.js scripts/test-liveProfile.js` (each with `node`).
- [ ] **Step 5: Commit.** `git add src/ipc/lineage.ts scripts/test-sourceNamesHidden.ts`. Message: "Name a lineage and pipeline source by its connector for a viewer".

### Task 3: No warehouse error text for a viewer

**Files:** Modify `src/ipc/datasets.ts:361-372` (`dataset:list`), `src/ipc/pipelines.ts:44-53` (`quietRuns`). Test: extend `scripts/test-sourceNamesHidden.ts`.
**Interfaces:** For a restricted caller, `dataset:list` drops `lastRefreshError` from every summary with `originConnId`, the same `const { lastRefreshError: _e2, ...rest } = d` shape it uses for a closed dataset. It adds no `scoped` flag unless the dataset is closed. `quietRuns` blanks the runs of a dataset node when `closedToCaller` is true, or when the caller is restricted and the node's dataset has `originConnId`. It reads `datasets.listDatasets(projectId)` once, and only for a restricted caller.

- [ ] **Step 1: Write the failing test.** As `boss`, `pipelineStore.appendRuns(P, [{ nodeId: 'dataset:' + D, id: 'r1', runId: 'r1', trigger: 'manual', status: 'failed', startedAt: T, finishedAt: T, durationMs: 1, attempts: 1, warnings: [], errors: ['relation "public.canary_tbl_9f3" does not exist'] }])`.
  ```ts
  const list = async (who: string) => (await W.call(who, 'dataset:list', { projectId: P })).body.find((d: { id: string }) => d.id === D);
  ok('dataset:list: a viewer gets the failure, not its text', (await list('nobody')).lastRefreshStatus === 'error' && !('lastRefreshError' in (await list('nobody'))));
  ok('pipelines:get: no run error text for a viewer', !CANARY.test((await pipe('nobody')).text));
  ok('NEGATIVE CONTROL: the editor reads the text', /canary_tbl_9f3/.test((await list('ed')).lastRefreshError));
  // U: a second dataset saved with origin { kind: 'url', url: 'https://api.example.com/x' }, marked 'error', 'HTTP 500'
  ok('a dataset not from a connection keeps its text for a viewer', (await listOf('nobody', U)).lastRefreshError === 'HTTP 500');
  ```
- [ ] **Step 2: Run it to see it fail.** Expect `FAIL dataset:list: a viewer gets the failure, not its text`.
- [ ] **Step 3: Implement.** Use the shapes above.
- [ ] **Step 4: Run it to see it pass.** Run the suite, then `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js` and `node scripts/test-pipelines.js`.
- [ ] **Step 5: Commit.** `git add src/ipc/datasets.ts src/ipc/pipelines.ts scripts/test-sourceNamesHidden.ts`. Message: "Withhold warehouse error text from a viewer".

### Task 4: `connections:list` for a viewer

**Files:** Modify `src/ipc/connections.ts:253-264`. Do not add lines past 503: write `viewerConnection` as a one-line arrow inside the handler, or put it in `src/data/sourceNames.ts`. Test: extend `scripts/test-sourceNamesHidden.ts`.
**Interfaces:** For a caller who does not see names, each entry is `{ id, name, connectorId, lastStatus, datasetCount }`. That means no `values`, `table`, `query`, `queries`, `lastError`, `secretSet`, `kind`, `host`, `database`, `user`, `url` or dates. The editor's entry is today's `{ ...withSecretSet(c), datasetCount, … }`.

- [ ] **Step 1: Write the failing test.**
  ```ts
  const conns = (who: string) => W.call(who, 'connections:list', { projectId: P });
  const v = (await conns('nobody')).body[0];
  const HIDDEN = ['values', 'table', 'query', 'queries', 'lastError', 'secretSet', 'host', 'database', 'user', 'url'];
  ok('connections:list: a viewer gets no address, selection or SQL', HIDDEN.every((k) => !(k in v)) && !CANARY.test((await conns('nobody')).text));
  ok('connections:list: a viewer still gets the card', v.id === connId && v.name === 'Warehouse' && v.connectorId === 'postgres' && v.datasetCount === 1);
  ok('NEGATIVE CONTROL: the editor gets host, the saved SQL and the table', ((e) => e.values.host === 'canary-host-9f3.internal' && e.queries[0].sql.includes('canary_tbl_9f3') && e.table === 'public.canary_tbl_9f3')((await conns('ed')).body[0]));
  ```
- [ ] **Step 2: Run it to see it fail.** Expect `FAIL connections:list: a viewer gets no address, selection or SQL`. If the parallel fix already landed, this goes green at once: check that its whitelist passes every assert, and skip to Step 4.
- [ ] **Step 3: Implement.** `const sees = await seesSourceNames(projectId);` goes before the map, and `sees ? <today's entry> : viewerConnection(c, count)`.
- [ ] **Step 4: Run it to see it pass.** Run the suite, then `DATABASE_URL=… node scripts/test-connections-server.js`, `node scripts/test-file-size.js` and `npm run lint`. Run `DATABASE_URL=… npm --prefix web run e2e -- view-only-routes connections`: the viewer walk of `/connections` still shows "Connections are for editors".
- [ ] **Step 5: Commit.** `git add src/ipc/connections.ts src/data/sourceNames.ts scripts/test-sourceNamesHidden.ts`. Message: "Give a viewer a connection's name and status only".

### Task 5: Say it in the changelog

**Files:** Modify `CHANGELOG.md` (`[Unreleased]` → `### Security`).
- [ ] **Step 1:** Add one bullet: "Project viewers no longer see a connection's host, database, user, saved queries or source table names, or a refresh's warehouse error text, in Data, Lineage or Pipelines."
- [ ] **Step 2: Commit.** `git add CHANGELOG.md`. Message: "Note the viewer source-name fix in the changelog".

## Existing tests that must stay green

`test-dataViews`, `test-dataset-origin`, `test-lineage`, `test-pipelines`, `test-liveProfile`, `test-connections-server` (DB), `test-rowPolicySafetyNet` (DB), `test-file-size`, `test-asyncReach`, `check-contracts`; web `data.test.tsx`, `rowAccess.test.tsx`, `connections.test.tsx`; e2e `connections`, `data`, `view-only-routes`.
