# Semantic layer part 2, PR 03: the source table store and its channels — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor can create, read, edit and delete a source table doc (owner, refresh, required filters, guide) per connection and table. The tab's list and its "To fill in next" strip come from records only, joined with the tables datasets are built from. No warehouse is read yet.
**Architecture:** An index per connection plus one doc per table, through `recordFs`. A save is the edit-conflict `lockedUpdate` on the doc, with the index updated in a nested lock (doc, then index, always). D9 resolution is a pure function over a dataset's origin and its connection. Four `write` contracts.
**Tech Stack:** `src/app`, `src/connectors` (types only), `src/data`, `src/api`, `src/ipc`, self-checks on `scripts/liveRouteHarness.ts`, the DB viewer suite from PR 01.
**Spec:** docs/semantic-layer/02-source-tables.md (D1, D2, D4, D5 strip, D9, D14, D15) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p2-00-index.md
**Branch and PR:** `feat/semantic-p2-03-store` off `origin/develop`, after PRs 01 and 02 are **released**. One PR, in release 2.

## Global Constraints

- **Records.** `connections/<connId>.tables.json` holds `SourceIndexEntry[]` (at most `MAX_SOURCE_DOCS = 2000`). `connections/<connId>/tables/<docId>.json` holds one `SourceTableDoc` (the spec's D1 shape, plus `dismissed?` for PR 09). `docId` is `randomUUID()`. Validate `projectId`, `connId` and `docId` with `UUID_RE` before building any path, and read through `recordFs` only. A corrupt doc or index reads as missing, and it is logged, never fatal.
- **Name.** `table` is the exact string `listTables` gives (`qualify`, `web/src/features/connections/api.ts:129`). It is trimmed at the ends only, 1–1,000 characters, and never case-folded (D2). Two docs never share an exact name on one connection: a create with an existing name returns that doc.
- **Lock order** is doc, then index, and never the reverse. A create writes its new doc outside any lock, then takes the index lock. An update or delete holds the doc's lock (`lockedUpdate`) and nests the index lock inside it, so on Postgres both land in one transaction.
- **The edit tag** covers the human fields only: `SAVE_KEYS.sourceTable = ['owner', 'refresh', 'requiredFilters', 'guide']`. A read (facts) or a dismissal never 409s an open editor.
- **`updatedBy`** is `osUser()` (`src/app/catalog.ts:286`), stamped in main, never read off the payload.
- **Replies are rebuilt key by key.** `dismissed` never leaves the server. There is no cache: everything is read per request, the same on any pod.
- Every channel is `write` and project-scoped. A viewer's call is refused 403 before a handler runs (`src/server/app.ts:419-443`: zod, then `authorize`).
- No `getDataset`, no connector call and no `connectionRun` import in these handlers.
- File caps: `src/server/app.ts` (652) gets the module name inside the array at `:570`. Each new file stays under 300 lines.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **The crash between doc and index.** A create whose index write fails leaves an unlisted doc and returns an error. A retry creates a fresh doc. Task 2 pins it.
- **Two editors save one guide.** A stale `base` is refused 409 `record_changed` and the stored doc is unchanged. Task 2.
- **The union.** A Live dataset and "Make a copy" of it (`copyLiveDataset` keeps the origin, `src/ipc/liveDatasets.ts:201-220`) are one row with two datasets. A `sql` origin with no `readsTables` is in no row. Task 3.
- **The fallback row.** A dataset saved before the workbench (`origin: { kind: 'connection', connId }`) uses the connection's own `table`, unless the connection has a `query`, because `selectionSql` prefers the query (`src/connectors/connectionRun.ts`, `selectionSql`). Task 3.

## Rolling deploys

These are new record kinds. A release-1 pod never reads them: `listConnections` skips both, and the ⌘K index matches `connections/<uuid>.json` only (`src/app/searchSources.ts:17`). It exports them, imports them and deletes them with the connection (PR 02). Its `recordDiff` has no `sourceTable` kind, and it needs none, because it serves none of these channels. A new browser on an old pod gets "unknown channel" from `sourceTable:*`, but the tab that calls them ships in PR 07. Within release 2, PRs 03–09 may reach pods in different cuts, so this PR's doc sanitizer already keeps `facts` (written from PR 04) and `dismissed` (written from PR 09). A pod with PR 03 that re-saves a guide then drops neither.

---

### Task 1: Types, sanitizers and D9 resolution

**Files:** Create `src/connectors/tableFacts.ts`, `src/app/sourceTables.ts` (types + sanitizers only in this task), `src/data/sourceTableOf.ts`, `scripts/test-sourceTables.ts`. Modify `src/connectors/types.ts` (add `tableFacts?` and `factsWake?` to `ConnectorDef`; types only, no implementation yet), `src/analysis/recordDiff.ts:42-60` (`SaveKind` += `'sourceTable'`, `SAVE_KEYS.sourceTable`).
**Interfaces:** Produces:
```ts
// src/connectors/tableFacts.ts — pure; the spec's D6 shape and its caps
export interface TableFacts { comment?: string; columns: FactColumn[]; primaryKey?: { columns: string[]; enforced: boolean };
  partition?: { columns: string[]; method?: string; required?: boolean }; clusterBy?: string[]; sortKey?: string[];
  distribution?: { style: string; columns: string[] }; indexes?: { name: string; columns: string[]; unique: boolean; kind?: string }[];
  rowEstimate?: number; bytes?: number; lastModified?: string }
export interface FactColumn { name: string; type: string; nullable?: boolean; comment?: string; key?: true }
export const MAX_FACT_COLUMNS = 2000, MAX_COMMENT = 2000, MAX_INDEXES = 50, MAX_KEY_COLUMNS = 32;
export function sanitizeFacts(raw: unknown): TableFacts | null   // null: no columns array. Drops a bad field, clips strings, finite non-negative numbers only, ISO-parsable lastModified only
// src/connectors/types.ts (ConnectorDef)
tableFacts?(ctx: ConnectorContext, table: string): Promise<({ ok: true } & TableFacts) | ConnectorError>;
/** Reading facts runs on the warehouse's compute and can start it (Databricks): the button says so. */
factsWake?: true;
// src/app/sourceTables.ts
export interface SourceTableDoc { table: string; owner: string; refresh: string; requiredFilters: string; guide: string;
  facts?: TableFacts & { readAt: string; readBy: string }; dismissed?: Record<string, Dismissed>;
  updatedBy: string; updatedAt: string; schemaVersion: 1 }
export interface Dismissed { table?: string; key?: string; columns?: Record<string, string> } // short hashes (PR 09)
export interface SourceIndexEntry { table: string; docId: string; owner: string; hasGuide: boolean; readAt?: string }
export const MAX_SOURCE_DOCS = 2000, MAX_TABLE = 1000, MAX_OWNER = 80, MAX_REFRESH = 200, MAX_REQUIRED = 500, MAX_SOURCE_GUIDE = 8000;
export function sanitizeSourceDoc(raw: unknown): SourceTableDoc | null   // null without a non-empty table; KEEPS `facts` (sanitizeFacts) and `dismissed` (valid dataset ids → { table?, key?, columns? } of /^[A-Za-z0-9_-]{12}$/ hashes, ≤ 500 datasets, ≤ 2,000 columns each), so a pod without PR 04 or PR 09 never drops either when it re-saves a doc
export function sanitizeIndex(raw: unknown): SourceIndexEntry[]           // valid docIds, first entry per exact name wins, ≤ 2000
// src/data/sourceTableOf.ts — spec D9; the only place a dataset's source tables are decided
export function sourceTablesOf(origin: DatasetOrigin | undefined, conn: { table?: string; query?: string } | undefined): string[]
```
`sourceTablesOf` returns `origin.readsTables` when that is non-empty, else `[origin.table]`, else `[]` for an `sql` origin. For an origin with neither, it returns `[conn.table]` when the connection has a table and no query. Every non-connection kind gives `[]`.

- [ ] **Step 1: Write the failing test.** Add part "shape" to `scripts/test-sourceTables.ts`:
  ```ts
  const of = (o: object, c?: object) => JSON.stringify(sourceTablesOf(sanitizeOrigin({ kind: 'connection', connId: C, ...o }), c));
  ok('D9: a table import', of({ table: 'ANALYTICS.ORDERS' }) === '["ANALYTICS.ORDERS"]');
  ok('D9: a query with no link reads none', of({ sql: 'select 1' }) === '[]');
  ok('D9/D11: linked tables win over table', of({ table: 'orders', readsTables: ['PUBLIC.ORDERS'] }) === '["PUBLIC.ORDERS"]');
  ok('D9: before the workbench, the connection\'s table', of({}, { table: 'public.t' }) === '["public.t"]' && of({}, { table: 'public.t', query: 'select 2' }) === '[]');
  ok('D9: a file, a combine, a SQL dataset: none', ['file', 'combined', 'sql', 'notebook'].every((k) => sourceTablesOf({ kind: k } as never, undefined).length === 0));
  ok('facts: strings clipped, a NaN estimate dropped, 2,001 columns cut', ((f) => f!.comment!.length === 2000 && !('rowEstimate' in f!) && f!.columns.length === 2000)(sanitizeFacts({ comment: 'x'.repeat(3000), rowEstimate: NaN, columns: Array.from({ length: 2001 }, (_, i) => ({ name: `c${i}`, type: 'int' })) })));
  ok('doc: no table, no doc', sanitizeSourceDoc({ owner: 'a' }) === null);
  ok('doc: facts and dismissals survive a read (a later PR writes them)', ((d) => d!.facts!.columns.length === 1 && d!.dismissed![DS].columns!.discount === 'AbCdEf012345')(sanitizeSourceDoc({ table: 'T', facts: { columns: [{ name: 'a', type: 'int' }], readAt: 'x', readBy: 'y' }, dismissed: { [DS]: { columns: { discount: 'AbCdEf012345', bad: 'the comment text' } }, 'not-an-id': { table: 'AbCdEf012345' } } })));
  ok('doc: a dismissal that is not a short hash is dropped', !('bad' in sanitizeSourceDoc({ table: 'T', dismissed: { [DS]: { columns: { bad: 'the comment text' } } } })!.dismissed![DS].columns!));
  ok('index: a second entry for one exact name is dropped, case kept', sanitizeIndex([{ table: 'T', docId: U1 }, { table: 'T', docId: U2 }, { table: 't', docId: U3 }]).map((e) => e.docId).join() === `${U1},${U3}`);
  ```
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts`. Expect tsc's "Cannot find module '../src/data/sourceTableOf'".
- [ ] **Step 3: Implement.** Write the signatures above.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-sourceTables.js`, then `node scripts/test-editConflicts.js scripts/test-metricTimeReader.js scripts/test-rowPolicyLabels.js` (each with `node`; these pin `SAVE_KEYS`).
- [ ] **Step 5: Commit.** `git add src/connectors/tableFacts.ts src/connectors/types.ts src/app/sourceTables.ts src/data/sourceTableOf.ts src/analysis/recordDiff.ts scripts/test-sourceTables.ts`. Message: "Add the source table doc, its facts and how a dataset finds its source tables".

### Task 2: The store

**Files:** Modify `src/app/sourceTables.ts` (store functions), `src/connectors/connections.ts:256` (`export` on `connectionsDir`, 0 lines). Test: extend `scripts/test-sourceTables.ts` (part "store").
**Interfaces:** Consumes `lockedUpdate`, `readTagged`, `contentTag` (`src/app/editConflict.ts`), `recordFs.locked`, `connections.getConnection`. Produces:
```ts
export const docPath = (projectId: string, connId: string, docId: string): string;   // throws on a non-UUID part
export const indexPath = (projectId: string, connId: string): string;
export async function listSourceIndex(projectId: string, connId: string): Promise<SourceIndexEntry[]>;
export async function readSourceDoc(projectId: string, connId: string, docId: string): Promise<Tagged<SourceTableDoc> | null>;
export interface SourcePatch { owner?: string; refresh?: string; requiredFilters?: string; guide?: string }
export async function createSourceDoc(projectId: string, connId: string, table: string, patch: SourcePatch): Promise<{ ok: true; docId: string; created: boolean } | { ok: false; error: string }>;
export async function saveSourceDoc(projectId: string, connId: string, docId: string, patch: SourcePatch, base?: string): Promise<Tagged<SourceTableDoc> | null>; // throws ERECORDCHANGED
export async function deleteSourceDoc(projectId: string, connId: string, docId: string): Promise<boolean>;
/** Under the doc's lock, then the index's: for PR 04's facts and PR 09's dismissals. Never touches the tag's keys. */
export async function updateSourceDoc(projectId: string, connId: string, docId: string, fn: (d: SourceTableDoc) => SourceTableDoc): Promise<SourceTableDoc | null>;
```
Every write re-derives the doc's index entry: `{ table, docId, owner, hasGuide: guide.trim() !== '', readAt: facts?.readAt }`. `createSourceDoc` refuses the 2,001st name with `sourceTablesFull()`. When it finds the name already indexed, it removes its own new doc (best effort) and returns `{ created: false }` with the existing `docId`.

- [ ] **Step 1: Write the failing test.**
  ```ts
  const a = await H.as(H.ORG_A, () => createSourceDoc(P, C, 'ANALYTICS.ORDERS', { owner: 'Data platform' }));
  ok('create: a doc and its entry', a.ok && (await H.as(H.ORG_A, () => listSourceIndex(P, C)))[0].docId === a.docId);
  ok('create: the same exact name returns that doc', ((b) => b.ok && b.docId === a.docId && b.created === false)(await H.as(H.ORG_A, () => createSourceDoc(P, C, 'ANALYTICS.ORDERS', {}))));
  ok('create: another case is another table (D2)', ((b) => b.ok && b.docId !== a.docId)(await H.as(H.ORG_A, () => createSourceDoc(P, C, 'analytics.orders', {}))));
  const t0 = (await H.as(H.ORG_A, () => readSourceDoc(P, C, a.docId)))!.tag;
  await H.as(H.ORG_A, () => saveSourceDoc(P, C, a.docId, { guide: '# Filter on ORDER_DATE' }, t0));
  let stale: unknown = null; try { await H.as(H.ORG_A, () => saveSourceDoc(P, C, a.docId, { guide: 'lost' }, t0)); } catch (e) { stale = e; }
  ok('save: a stale base is refused and nothing changes', isRecordChanged(stale) && (await H.as(H.ORG_A, () => readSourceDoc(P, C, a.docId)))!.rec.guide === '# Filter on ORDER_DATE');
  ok('save: the index follows (hasGuide)', (await H.as(H.ORG_A, () => listSourceIndex(P, C))).find((e) => e.docId === a.docId)!.hasGuide === true);
  ok('save: updatedBy is the caller, stamped here', (await H.as(H.ORG_A, () => readSourceDoc(P, C, a.docId)))!.rec.updatedBy === H.ORG_A.user.email);
  // the crash: the index write fails once
  const realRename = recordFs.rename; (recordFs as { rename: typeof realRename }).rename = async (f, t) => { if (t.endsWith('.tables.json')) { (recordFs as { rename: typeof realRename }).rename = realRename; throw new Error('crash'); } return realRename(f, t); };
  const crashed = await H.as(H.ORG_A, () => createSourceDoc(P, C, 'ANALYTICS.CRASH', {}).catch(() => ({ ok: false })));
  ok('crash between doc and index: an error, an unlisted doc, never a dangling entry', !crashed.ok && !(await H.as(H.ORG_A, () => listSourceIndex(P, C))).some((e) => e.table === 'ANALYTICS.CRASH') && docsOnDisk(C).length === 3);
  ok('NEGATIVE CONTROL: the retry lists it', (await H.as(H.ORG_A, () => createSourceDoc(P, C, 'ANALYTICS.CRASH', {}))).ok);
  ok('delete: doc and entry go', (await H.as(H.ORG_A, () => deleteSourceDoc(P, C, a.docId))) && !(await H.as(H.ORG_A, () => listSourceIndex(P, C))).some((e) => e.docId === a.docId));
  ok('a corrupt doc reads as missing', /* write '{' at docPath */ (await H.as(H.ORG_A, () => readSourceDoc(P, C, corruptId))) === null);
  ```
  Add a cap case too: with `MAX_SOURCE_DOCS` monkeypatched to 3 through a test-only setter, or with 2,000 entries written straight into the index file, the next create answers `sourceTablesFull()`.
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts && node scripts/test-sourceTables.js`. Expect tsc's "has no exported member 'createSourceDoc'".
- [ ] **Step 3: Implement.** Write the signatures above. A crash leaves the unlisted doc behind, and that is fine, because nothing lists it. `sourceTableMessages.ts` (new; added to `MAIN_FILES` at `scripts/i18n-extract.ts:346`) gets `sourceTablesFull()`: "This connection already documents 2,000 tables."
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-sourceTables.js`, then `node scripts/i18n-extract.js && node scripts/test-i18n.js`.
- [ ] **Step 5: Commit.** `git add src/app/sourceTables.ts src/app/sourceTableMessages.ts src/connectors/connections.ts src/i18n scripts/i18n-extract.ts scripts/test-sourceTables.ts`. Message: "Store source table docs per connection, with an index and edit conflicts".

### Task 3: The list, the strip and the four channels

**Files:** Create `src/api/sourceTables.ts`, `src/ipc/sourceTables.ts`, `src/app/sourceTableList.ts`. Modify `src/api/index.ts` (append `import { sourceTables } from './sourceTables'` and `...sourceTables,`), `src/server/app.ts:570` (add `'../ipc/sourceTables'`). Test: extend `scripts/test-sourceTables.ts` (part "channels"), and `scripts/test-sourceNamesHidden.ts` from PR 01 (viewer 403).
**Interfaces:** Consumes `connections.listConnections`/`getConnection`, `datasets.listDatasets` (`originConnId`) and `getDatasetMeta` (`origin`), `sourceTablesOf`, `getConnector`. Produces:
```ts
// src/api/sourceTables.ts
const Table = z.string().trim().min(1).max(1_000);
const Patch = z.strictObject({ owner: z.string().max(80).optional(), refresh: z.string().max(200).optional(),
  requiredFilters: z.string().max(500).optional(), guide: z.string().max(8_000).optional() });
const Doc = { projectId: Uuid, connId: Uuid, docId: Uuid };
export const sourceTables = {
  'sourceTable:list': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'sourceTable:get': rpc({ access: 'write', input: z.strictObject(Doc), project: byProjectId }),
  // No docId: create (table required, idempotent by exact name). docId: edit, with the open copy's tag as base.
  'sourceTable:save': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, connId: Uuid, docId: Uuid.optional(), table: Table.optional(), patch: Patch, base: z.string().max(100).optional() }), project: byProjectId }),
  'sourceTable:delete': rpc({ access: 'write', input: z.strictObject(Doc), project: byProjectId }),
} as const;
// src/app/sourceTableList.ts
export type SourceTodoKind = 'used_no_doc' | 'never_read' | 'no_owner' | 'no_guide' | 'stale_read'; // also the rank
export interface SourceRow { docId?: string; table: string; owner: string; hasGuide: boolean; readAt?: string; datasetIds: string[] }
export interface SourceConn { connId: string; name: string; connectorId: string; readsFacts: boolean; factsWake?: true; rows: SourceRow[] }
export interface SourceTodo { connId: string; docId?: string; table: string; kind: SourceTodoKind }
export const SOURCE_TODO_SHOWN = 4, STALE_DAYS = 30;
export function readsFactsOf(def: ConnectorDef | null): boolean // tableFacts or describeTable
export function sourceTodoOf(conns: SourceConn[], now: number): { todo: SourceTodo[]; more: number }
export async function usedTables(projectId: string, conns: Connection[]): Promise<Map<string, Map<string, string[]>>> // connId → table → datasetIds, metadata only
export async function sourceList(projectId: string): Promise<{ connections: SourceConn[]; todo: SourceTodo[]; more: number }>
```
- A row is the union of the index and `usedTables`. Documented rows come first in index order, then used rows with no doc, by name.
- Connections come in `listConnections` order, and only those with at least one row. An empty tab is `connections: []`.
- `sourceTodoOf` follows part 1's `todoOf`: every row's gaps, ordered by kind rank and then row order. It keeps the first 4 and counts the rest in `more`.
- `never_read` and `stale_read` apply only where `readsFacts` is true, and `stale_read` means `readAt` is more than 30 days old.
- Replies: `:list` gives `{ ok: true, connections, todo, more }`. `:get` gives `{ ok: true, doc: { docId, table, owner, refresh, requiredFilters, guide, facts?, updatedBy, updatedAt }, tag, connection: { connId, name, connectorId, readsFacts, factsWake? }, datasets: { id, name }[] }`, with no `dismissed`. `:save` gives `{ ok: true, docId, created?, tag }`, where `tag` is the stored doc's new content tag: the web's `useEditGuard` adopts it as the next `base` (`web/src/features/editConflicts/useEditGuard.ts:39`). `:delete` gives `{ ok: true }`. A failure gives `{ ok: false, error }`. The route turns `ERECORDCHANGED` into 409.

- [ ] **Step 1: Write the failing test.** The setup builds the following:
  - `H.liveOver(P, { table: 'live_fake_orders' }, cols)` (a Live view, connection `C`).
  - `post('dataset:copyLive', …)` (its copy).
  - A second Live view `{ sql: 'select 1 as x' }` on `C`.
  - A documented `ANALYTICS.ONLY_DOC` with no dataset.
  - A connection `C0` with `table: 'public.legacy'`, and a dataset saved with `origin: { kind: 'connection', connId: C0 }`.

  Then add these asserts:
  ```ts
  const L = (await post('sourceTable:list', { projectId: P })).value;
  const rowsOf = (c: string) => L.connections.find((x: Reply) => x.connId === c).rows;
  ok('list: a Live view and its copy are one row', ((r) => r.datasetIds.length === 2 && r.docId === undefined)(rowsOf(C).find((r: Reply) => r.table === 'live_fake_orders')));
  ok('list: a query with no link is in no row', !rowsOf(C).some((r: Reply) => r.datasetIds.includes(sqlLiveId)));
  ok('list: documented first, then used', rowsOf(C).map((r: Reply) => r.table).join() === 'ANALYTICS.ONLY_DOC,live_fake_orders');
  ok('list: the pre-workbench fallback', rowsOf(C0)[0].table === 'public.legacy');
  ok('strip: a used table with no doc leads', L.todo[0].kind === 'used_no_doc' && L.todo[0].table === 'live_fake_orders');
  ok('sourceTodoOf: four by rank, then how many more', JSON.stringify(sourceTodoOf(SIX_GAPS, NOW).todo.map((t) => t.kind)) === '["used_no_doc","never_read","no_owner","no_guide"]' && sourceTodoOf(SIX_GAPS, NOW).more === 2);
  ok('NEGATIVE CONTROL: nothing missing, no strip', sourceTodoOf(ALL_FILLED, NOW).todo.length === 0);
  const s = await post('sourceTable:save', { projectId: P, connId: C, table: 'live_fake_orders', patch: { owner: 'Data' } });
  const g = (await post('sourceTable:get', { projectId: P, connId: C, docId: s.value.docId })).value;
  ok('get: built from it, in dataset order', g.datasets.map((d: Reply) => d.id).join() === [liveId, copyId].join());
  ok('get: rebuilt key by key, no dismissed', JSON.stringify(Object.keys(g.doc).sort()) === '["docId","guide","owner","refresh","requiredFilters","table","updatedAt","updatedBy"]');
  ok('save: a stale base answers 409', (await post('sourceTable:save', { projectId: P, connId: C, docId: s.value.docId, patch: { guide: 'x' }, base: 'stale' })).status === 409);
  ok('metadata only: nothing hydrated, no warehouse statement', !(await hydrates(liveId, () => post('sourceTable:list', { projectId: P }))).hydrated && H.fake.calls.length === calls0);
  ok('a connection of another project is refused', (await post('sourceTable:save', { projectId: P2, connId: C, table: 't', patch: {} })).value.ok === false);
  ```
  In `scripts/test-sourceNamesHidden.ts` (DB), add:
  ```ts
  const PAYLOAD: Record<string, object> = { 'sourceTable:list': { projectId: P }, 'sourceTable:get': { projectId: P, connId, docId: U }, 'sourceTable:save': { projectId: P, connId, table: 't', patch: {} }, 'sourceTable:delete': { projectId: P, connId, docId: U } };
  const channels = Object.keys(require('../src/api/sourceTables').sourceTables);
  ok('every source table channel has a viewer case here', channels.every((ch) => ch in PAYLOAD), channels.filter((ch) => !(ch in PAYLOAD)).join());
  for (const ch of channels) ok(`${ch}: a viewer is refused 403`, (await W.call('nobody', ch, PAYLOAD[ch])).status === 403);
  ok('NEGATIVE CONTROL: the editor is answered', (await W.call('ed', 'sourceTable:list', { projectId: P })).status === 200);
  ```
  PRs 04, 08 and 09 add their channels to the same contract file and their payloads to `PAYLOAD`. The coverage assert makes them do it.
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts && node scripts/test-sourceTables.js`. Expect `No handler for sourceTable:list`. `node scripts/check-contracts.js` lists the four as unresolved.
- [ ] **Step 3: Implement.** Write the signatures above. Each handler wraps its body in try/catch and returns `{ ok: false, error }`, as `catalog:list` does (`src/ipc/catalog.ts:62-72`), except `ERECORDCHANGED`, which it rethrows so the route answers 409. A missing connection answers `connectionGone()` ("That connection is gone."), and a missing doc answers `sourceDocGone()` ("Those notes are gone."), both in `sourceTableMessages.ts`.
- [ ] **Step 4: Run it to see it pass.** Run:
  - `node scripts/test-sourceTables.js`
  - `node scripts/check-contracts.js` (0 unresolved)
  - `DATABASE_URL=… node scripts/test-sourceNamesHidden.js`
  - `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js` (coverage: no new `read` contract)
  - `node scripts/test-server-boot.js scripts/test-asyncReach.js scripts/test-i18n.js scripts/test-file-size.js`
  - `npm run lint`
- [ ] **Step 5: Commit.** `git add src/api/sourceTables.ts src/api/index.ts src/ipc/sourceTables.ts src/app/sourceTableList.ts src/app/sourceTableMessages.ts src/server/app.ts src/i18n scripts/test-sourceTables.ts scripts/test-sourceNamesHidden.ts`. Message: "List, open, save and delete source table docs, with what to fill in next".

## Existing tests that must stay green

`test-dataset-origin`, `test-connectors`, `test-connections-server` (DB), `test-bundle`, `test-liveCopy`, `test-rowPolicySafetyNet` (DB), `test-liveSafetyNet`, `test-editConflicts`, `test-server-boot`, `test-asyncReach`, `test-i18n`, `test-file-size`, `check-contracts`.
