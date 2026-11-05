# Semantic layer part 2, PR 08: per-table lineage, linked tables, and the dataset Guide's source block — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A source table's **Lineage** shows the table, the datasets built from it, and their metrics, charts and dashboards. A dataset that runs a query can name the tables it reads. Each dataset's Guide shows its source tables' notes read-only, under **From the source table**, to editors only.
**Architecture:** `sourceTable:lineage` builds the same `buildGraph` input and rewrites its one-node-per-connection sources into one node per (connection, table), beside `buildGraph`. `lineage:get` is untouched. `sourceTable:forDataset` resolves a dataset's tables with PR 03's `sourceTablesOf`. `dataset:setSourceTables` writes `origin.readsTables`, which release 1's sanitizer keeps, through the dataset record's own lock. `dataset:sourceTableChoices` is the link picker: it lists the connection's tables on a click, sorted on the server by the query-word rule. The web adds the Lineage tab and the Guide block.
**Tech Stack:** `src/analysis`, `src/data`, `src/ipc`, `src/api`, self-checks on `liveRouteHarness`, React, Vitest, Playwright.
**Spec:** docs/semantic-layer/02-source-tables.md (D9, D10, D11, the dataset Guide block in "What you will see", D13 for viewers, "Tests that prove it": lineage, resolution) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p2-00-index.md
**Branch and PR:** `feat/semantic-p2-08-lineage-and-links` off `origin/develop` after PR 07 merges. Release 1 (PR 02) must be on every pod first. One PR, in release 2.

## Global Constraints

- **`lineage:get` is byte-identical** for an editor before and after this PR, whatever docs or links exist. Lineage nodes carry no table name in an `id`: `source:st:<connId>:<docId>`, or `source:st:<connId>:u<n>` for an undocumented table (`n` is its index in that connection's sorted undocumented names). The `name` may hold the table, because the reply is `write`, so editors only.
- **`readsTables` is a label.** Writing it changes no refresh (`selectionForDataset`, `src/ipc/connections.ts:138-145`), no Live target (`liveSourceOf`, `src/engine/live/liveTarget.ts:65-75`) and no `dataset:source` label. It is at most 16 names, each ≤ 1,000 characters (PR 02's `sanitizeReadsTables`). It is written only for a dataset whose origin is `connection`, and an empty list removes it.
- **The dataset record is written through its own lock** with `serialized(datasetFilePath(p, id), …)` (`src/data/datasetRecord.ts:256-268`, exported), as `markRefresh` does. Touch nothing in `src/data/datasets.ts` (799 lines).
- **The query-word sort is an order, never a link** (D11): a table ranks first when its last name part appears as a whole word (case-insensitive) in `origin.sql`. The SQL never leaves the server.
- **No warehouse** except `dataset:sourceTableChoices` (a click). `:lineage` and `:forDataset` read records only.
- **The web gates on editing.** The Guide block and its read call render only when `useCanEdit(projectId)`, so a viewer's web never calls `sourceTable:forDataset`. `LineageDrawer.tsx`'s `Graph` becomes `export function LineageGraph` (a rename and an export only; part 1 keeps `LineageView` on top of it).
- File caps: new server files stay under 250 lines, and `src/ipc/lineage.ts` is unchanged.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **`add` keeps the first node per id** (`src/analysis/lineage.ts:120-123`), so the per-connection node's `sub` names whichever table came first. The rewrite must take its edges from `origin`, never from that `sub`. Task 1.
- **Two linked tables, one shared column name.** That only matters to PR 09. Here, a dataset linked to A and B is a child of both nodes, and a lineage of A does not show B (upstream of a downstream node is not in `focus`). Task 1.
- **A Live view and its copy show one doc** in their Guide blocks: the same `docId`. Task 2.
- **The block for a dataset with no doc** offers **Write them**, which creates the doc (PR 07's `documentTable`). It never shows a guide for an undocumented table. Task 4.

## Rolling deploys

| New stored field | A pod of the previous release reads and re-saves it | Why it is safe |
|---|---|---|
| `origin.readsTables` (a dataset record) | Release 1 or later: kept (PR 02). Older: dropped. | Release 1 is required on every pod before this PR ships (index). Even when dropped, it is a label: no figure, refresh or Live statement reads it. |

A new browser on a pod without this PR gets "unknown channel" from `sourceTable:lineage` and `:forDataset`. The Lineage tab and the Guide block each show their own `ErrorState` with Retry, and the rest of the panel draws.

---

### Task 1: Per-table lineage

**Files:** Create `src/analysis/sourceLineage.ts`, `scripts/test-sourceLinks.ts`. Test it on `scripts/liveRouteHarness.ts`.
**Interfaces:** Consumes `buildGraph` and `focus` (`src/analysis/lineage.ts:116`, `:325`), `loadInput` (`src/ipc/lineage.ts:29`, unchanged), `sourceTablesOf`. Produces:
```ts
export interface TableLink { connId: string; table: string; docId?: string }
export const tableNodeId = (connId: string, docId: string | undefined, undocumentedIndex: number): string;
/** Each `source:conn:<connId> → dataset:<id>` edge becomes one edge per linked table; a connection node left with no edge goes. */
export function perTableGraph(g: LineageGraph, links: ReadonlyMap<string, TableLink[]>, connName: (connId: string) => string): LineageGraph;
```
A table node is `{ id, kind: 'source', name: table, sub: connName(connId) }` and has no `ref`. A dataset with no links keeps its per-connection edge.

- [ ] **Step 1: Write the failing test.** On the fake warehouse:
  - load `wh_a` and `wh_b` with `fakeMod.loadWarehouseTable`;
  - create Live views A and B over them on one connection `C`, a visual and a metric on each, and a dashboard on A's visual;
  - create a doc for `wh_a` only;
  - create a third Live view Q, `{ sql: 'select * from wh_a join wh_b using (k)' }`.
  ```ts
  const before = (await post('lineage:get', { projectId: P, type: 'dataset', id: A })).body;
  const g = (await post('sourceTable:lineage', { projectId: P, connId: C, docId: DA })).value;
  const ids = g.nodes.map((n: Reply) => n.id);
  ok('lineage: rooted at the table, its datasets and what is built on them', g.focus === `source:st:${C}:${DA}` && ids.includes(`dataset:${A}`) && ids.includes(`visual:${visA}`) && ids.includes(`dashboard:${dashA}`));
  ok('lineage: the other table\'s dataset is not shown', !ids.includes(`dataset:${B}`));
  ok('lineage: no node id holds a table name', ids.every((id: string) => !/wh_[ab]/.test(id)));
  await post('dataset:setSourceTables', { projectId: P, datasetId: Q, tables: ['wh_a', 'wh_b'] });
  ok('lineage: a linked query is a child of each table it names', (await post('sourceTable:lineage', { projectId: P, connId: C, docId: DA })).value.nodes.some((n: Reply) => n.id === `dataset:${Q}`));
  ok('lineage:get is byte-identical after docs and links', (await post('lineage:get', { projectId: P, type: 'dataset', id: A })).body === before);
  ok('perTableGraph: a connection node left without edges is gone; one with an unlinked dataset stays', /* pure fixture */ PURE_OK);
  ok('opening lineage reads no warehouse and hydrates nothing', H.fake.catalogCalls === n0 && !hydratedAny);
  ```
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts`. Expect tsc's "Cannot find module '../src/analysis/sourceLineage'".
- [ ] **Step 3: Implement.** Write `perTableGraph` (pure). The handler is in Task 3.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-sourceLinks.js scripts/test-lineage.js` (each with `node`) once Task 3's channel exists. Until then, run the pure part only.
- [ ] **Step 5: Commit.** `git add src/analysis/sourceLineage.ts scripts/test-sourceLinks.ts`. Message: "Draw lineage with one node per source table, beside the connection graph".

### Task 2: Linking a dataset's tables

**Files:** Create `src/data/datasetSourceTables.ts`. Modify `src/app/sourceTableMessages.ts` (`notLinkable()`: "Only a dataset built from a connection names its source tables."). Test: extend `scripts/test-sourceLinks.ts`.
**Interfaces:** Consumes `serialized`, `datasetFilePath` (`src/data/datasetRecord.ts`) and `sanitizeReadsTables` (PR 02). Produces:
```ts
/** Writes origin.readsTables on a connection origin, or removes it for []. Null: not a connection dataset. */
export async function setReadsTables(projectId: string, datasetId: string, tables: string[]): Promise<string[] | null>;
/** The connection's tables (one listTables, through connectionRun) sorted: names whose last part is a word of origin.sql first, by name; then the rest by name. */
export function choiceOrder(tables: string[], sql: string): string[];
```
- [ ] **Step 1: Write the failing test.**
  ```ts
  const metaBefore = await H.as(H.ORG_A, () => H.datasets.getDatasetMeta(P, Q));
  ok('link: stored as given, order kept', JSON.stringify(await H.as(H.ORG_A, () => setReadsTables(P, Q, ['wh_b', 'wh_a']))) === '["wh_b","wh_a"]');
  const after = (await H.as(H.ORG_A, () => H.datasets.getDatasetMeta(P, Q)))!; const def = getConnector(LIVE_FAKE_ID)!;
  ok('link: the refresh and the Live target are unchanged', JSON.stringify(selectionForDataset(after.origin)) === JSON.stringify(selectionForDataset(metaBefore!.origin)) && JSON.stringify(liveSourceOf(after.origin!, def, 'duckdb')) === JSON.stringify(liveSourceOf(metaBefore!.origin!, def, 'duckdb')));
  ok('link: dataset:source does not print it', !(await post('dataset:source', { projectId: P, id: Q })).value.label.includes('wh_'));
  ok('link: [] removes it', !('readsTables' in (await H.as(H.ORG_A, async () => { await setReadsTables(P, Q, []); return (await H.datasets.getDatasetMeta(P, Q))!.origin!; }))));
  ok('link: refused for a CSV dataset', (await H.as(H.ORG_A, () => setReadsTables(P, CSV, ['t']))) === null);
  ok('choiceOrder: words in the query first, never a substring', JSON.stringify(choiceOrder(['wh_z', 'PUBLIC.WH_B', 'wh_a', 'wh_ab'], 'select * from wh_b join wh_a using (k)')) === '["PUBLIC.WH_B","wh_a","wh_ab","wh_z"]');
  ```
- [ ] **Step 2: Run it to see it fail.** Run `node scripts/test-sourceLinks.js`. Expect "Cannot find module '../src/data/datasetSourceTables'".
- [ ] **Step 3: Implement.** Use the interfaces above.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-sourceLinks.js scripts/test-dataset-origin.js`.
- [ ] **Step 5: Commit.** `git add src/data/datasetSourceTables.ts src/app/sourceTableMessages.ts src/i18n scripts/test-sourceLinks.ts`. Message: "Let a query dataset name the source tables it reads".

### Task 3: The four channels

**Files:** Create `src/ipc/sourceTableLinks.ts`. Modify `src/api/sourceTables.ts`, `src/ipc/sourceTables.ts` (`register()` calls it), `scripts/test-sourceNamesHidden.ts` (four `PAYLOAD` entries). Test: extend `scripts/test-sourceLinks.ts`.
**Interfaces:**
```ts
'sourceTable:lineage': rpc({ access: 'write', input: z.strictObject(Doc), project: byProjectId }),               // → FocusedLineage & { upstream: number } | { ok: false, error }
'sourceTable:forDataset': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
'dataset:setSourceTables': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, tables: z.array(Table).max(16) }), project: byProjectId }),
'dataset:sourceTableChoices': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
```
- `:forDataset` returns `{ ok: true, linkable, byQuery, tables: SourceBlock[] }`. `linkable` means the origin is `connection`, and `byQuery` means it has `sql`. Each block is `SourceBlock { connId; connName; table; docId?; owner; refresh; requiredFilters; guide; primaryKey?; partition?; updatedBy?; updatedAt? }` (in `sourceTablesOf` order, ≤ 16). A block with no `docId` has empty strings. The reply never holds `facts.columns`, `dismissed` or the SQL.
- `:lineage` replies like `lineageFor` (`src/ipc/lineage.ts:54-59`): `{ ...focus(perTableGraph(buildGraph(input), links, name), tableNodeId(...)), upstream }`.
- `dataset:setSourceTables` returns `{ ok: true, tables }` or `{ ok: false, error: notLinkable() }`.
- `dataset:sourceTableChoices` returns `{ ok: true, tables: choiceOrder(names, sql), linked: sourceTablesOf(origin, conn) }`, or the `listTables` error.

- [ ] **Step 1: Write the failing test.**
  ```ts
  const fd = async (id: string) => (await post('sourceTable:forDataset', { projectId: P, datasetId: id })).value;
  ok('guide block: a Live view and its copy show one doc', (await fd(A)).tables[0].docId === DA && (await fd(copyOfA)).tables[0].docId === DA);
  ok('guide block: a query with no link says so', ((r) => r.byQuery === true && r.tables.length === 0)(await fd(Q0)));
  ok('guide block: no columns, no dismissals, no SQL', !/"columns"|dismissed|select \*/.test(JSON.stringify(await fd(A))));
  ok('guide block: a file dataset is not linkable', (await fd(CSV)).linkable === false);
  const c = (await post('dataset:sourceTableChoices', { projectId: P, datasetId: Q0 })).value;
  ok('choices: one warehouse call, words of the query first', H.fake.catalogCalls === n0 + 1 && c.tables.slice(0, 2).join() === 'wh_a,wh_b');
  ok('setSourceTables: 17 names refused at the door', (await post('dataset:setSourceTables', { projectId: P, datasetId: Q0, tables: Array(17).fill('t') })).status === 400);
  ```
  The DB suite's `PAYLOAD` gains the four channels, so the 403 loop covers them.
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts && node scripts/test-sourceLinks.js`. Expect `No handler for sourceTable:forDataset`.
- [ ] **Step 3: Implement.** Use the interfaces above. The handlers use try/catch → `{ ok: false, error }`.
- [ ] **Step 4: Run it to see it pass.** Run:
  - `node scripts/test-sourceLinks.js scripts/test-sourceTables.js scripts/test-lineage.js` (each with `node`)
  - `DATABASE_URL=… node scripts/test-sourceNamesHidden.js`
  - `node scripts/check-contracts.js`
  - `node scripts/test-i18n.js`
  - `npm run lint`
- [ ] **Step 5: Commit.** `git add src/ipc/sourceTableLinks.ts src/ipc/sourceTables.ts src/api/sourceTables.ts scripts/test-sourceLinks.ts scripts/test-sourceNamesHidden.ts`. Message: "Serve a source table's lineage, a dataset's source notes and its table links".

### Task 4: The web: the Lineage tab, the Guide block, Link tables

**Files:** Create `web/src/features/model/sources/SourceLineage.tsx`, `web/src/features/model/datasets/SourceNotes.tsx`, `LinkTablesDialog.tsx`, `sourceNotes.test.tsx`. Modify:
- `web/src/features/data/LineageDrawer.tsx:66` (`function Graph` → `export function LineageGraph`, and its one caller);
- `web/src/features/model/sources/SourcePanel.tsx` (the `lineage` panel, icon `lineage`);
- part 1's `web/src/features/model/datasets/DatasetPanel.tsx` Guide tab (`<SourceNotes>` under the guide, editors only).

**Interfaces:**
- `SourceLineage({ projectId, connId, docId })` draws `useSourceLineage` with `LineageGraph`, under the group "Lineage graph". Its empty text is "No dataset is built from this table yet."
- `SourceNotes({ projectId, datasetId })` returns null unless `useCanEdit`. For each block it draws a `region` named "From the source table". The head reads `FROM THE SOURCE TABLE · <table> on <conn>` with a link "Open in Source tables ↗" (to `?tab=sources&conn=…&doc=…`, or `&conn=` alone when there is no doc). Then comes one line, `Owner X · refreshes Y · filter on Z · key K` (only the parts that are set), then the guide as `MarkdownView`, read-only.
  - No doc: "No notes on <table> yet." and **Write them** (`documentTable`).
  - `byQuery` with no tables: "This dataset runs a query. Link the tables it reads so their notes show here." and **Link tables**.
  - `byQuery` with tables: a small **Change linked tables** button.
- `LinkTablesDialog` calls `dataset:sourceTableChoices` **on open**. It lists checkboxes with `linked` pre-ticked, and allows at most 16 ("16 at most" once full). Saving sends `dataset:setSourceTables` and invalidates `['sourceTable:forDataset']`, `['sourceTable:list']` and `['sourceTable:lineage']`.

- [ ] **Step 1: Write the failing test.** `sourceNotes.test.tsx`:
  - As an editor, the region "From the source table" shows `ANALYTICS.ORDERS on Warehouse`, the line `Owner Data platform · refreshes Hourly at :15 · filter on ORDER_DATE · key LINE_ID`, the guide heading, and the link href with `doc=`.
  - An undocumented block shows **Write them**, and clicking it saves and navigates.
  - `byQuery` with no tables shows **Link tables**. The dialog makes one `dataset:sourceTableChoices` call when it opens, and none when it is not opened. It ticks `linked`, and Save sends the ticked names.
  - NEGATIVE CONTROL: as a viewer, no region and no `sourceTable:forDataset` call.
  - The Lineage panel shows the group "Lineage graph" from a stubbed `sourceTable:lineage`.
  - A 404 on `:forDataset` shows "The source notes could not be loaded", with Retry, and the guide above it still renders.
- [ ] **Step 2: Run it to see it fail.** Run `npm run test:web -- sourceNotes`.
- [ ] **Step 3: Implement.** Use the interfaces above.
- [ ] **Step 4: Run it to see it pass.** Run `npm run test:web` (all, including part 1's `panel.test.tsx` and the `LineageDrawer` users), `npm run lint` and `npm --prefix web run size`.
- [ ] **Step 5: Commit.** `git add web/src/features/model web/src/features/data/LineageDrawer.tsx`. Message: "Show a source table's lineage, and its notes in each dataset's Guide".

### Task 5: E2e and the viewer walk

**Files:** Modify `web/e2e/source-tables.e2e.ts` (PR 07), `web/e2e/viewerRoutes.ts`.
- [ ] **Step 1:** Add the test **`source tables: lineage and the dataset guide`**:
  - On `live_fake_orders`' doc, Lineage shows "Orders (live)" in the group "Lineage graph".
  - At `/model/${pid}?dataset=${liveId}&panel=guide`, the region "From the source table" shows the guide written in PR 07's test.
  - Shot `model-dataset-source-notes`.
- [ ] **Step 2:** Add the viewerRoutes case `{ pattern: '/model/:projectId', url: (s) => `/model/${s.pid}?dataset=${s.did}&panel=guide`, editor: { role: 'region', name: 'From the source table' } }`. The viewer must not have it.
- [ ] **Step 3: Run** `npm run build:web && npm --prefix web run e2e -- source-tables model` and `DATABASE_URL=… npm --prefix web run e2e -- view-only-routes`.
- [ ] **Step 4: Commit.** `git add web/e2e`. Message: "Cover source lineage and the dataset Guide's source notes end to end".

## Existing tests that must stay green

`test-lineage`, `test-pipelines`, `test-dataset-origin`, `test-liveCopy`, `test-liveRoute`, `test-sourceTables`, `test-sourceNamesHidden` (DB), `test-rowPolicySafetyNet` (DB), `check-contracts`, `test-i18n`, `test-file-size`; web `panel.test.tsx` and `model.test.tsx` (part 1), `sources.test.tsx`, every `LineageDrawer` user; e2e `model`, `data`, `source-tables`, `view-only-routes`.
