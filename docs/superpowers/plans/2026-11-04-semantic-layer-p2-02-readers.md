# Semantic layer part 2, PR 02: release-1 readers for source docs and `readsTables` — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one release in which every pod keeps a dataset's `origin.readsTables` on every re-save, imports a bundle that holds source docs, and deletes source docs with their connection, before any pod writes either.
**Architecture:** Three small readers and nothing that writes. `sanitizeOrigin` keeps a capped `readsTables`. `ENTRY_RULES` admits the two new record paths, which the existing UUID remap already renames. `deleteConnection` removes the index and the doc folder.
**Tech Stack:** `src/data/datasetOrigin.ts`, `src/app/bundleRules.ts`, `src/connectors/connections.ts`, self-checks.
**Spec:** docs/semantic-layer/02-source-tables.md (D1 store paths, D9/D11 `readsTables`, "a bundle round trip keeps every lookup") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p2-00-index.md
**Branch and PR:** `feat/semantic-p2-02-readers` off `origin/develop`. One PR, in release 1, independent of PR 01. PRs 03 and 08 must not reach a release before this one has.

## Global Constraints

- **Reader only.** No contract, no handler, no writer of `readsTables` and no doc writer.
- `readsTables`: at most `MAX_READS_TABLES = 16` names. Each is a string, trimmed, 1–1,000 characters (the contracts' `Table` cap, `src/api/connections.ts:21`), deduped by exact string (never case-folded, spec D2), first order kept. Anything else is dropped. An empty result means the field is absent, so a record without it writes the same bytes.
- `readsTables` is a **label**. `selectionForDataset` (`src/ipc/connections.ts:138-145`) and `liveSourceOf` (`src/engine/live/liveTarget.ts:65-75`) never read it, and `sourceView` never prints it.
- The bundle paths are exactly `connections/<uuid>.tables.json` and `connections/<uuid>/tables/<uuid>.json`. They have no `count` key, so the manifest's counts stay as they are.
- `src/connectors/connections.ts` is 662 lines and gets 2 lines at most. `src/data/datasetOrigin.ts` is 302 lines.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **An old pod erases a link.** A pod without this PR runs `sanitizeOrigin` on every load (`normalize`). The `connection` case (`src/data/datasetOrigin.ts:147-160`) keeps only `table`, `queryId` and `sql`, so the next refresh, rename or step edit that rewrites the record drops `readsTables`. Task 1's "a refresh keeps it" test pins the cure.
- **An old pod refuses a new bundle.** Import refuses a whole bundle when any entry is outside `ENTRY_RULES` (`src/app/bundleRules.ts:31-61`, `importFrom`). Task 2.
- **The remap must follow both names and the body.** A connection id is always remapped on import (`src/app/bundleImport.ts:239-242`), and `swap` rewrites every UUID in every name and JSON body, so `<connId>.tables.json`, the `<connId>/` folder and the index's `docId` all follow. Task 2.
- **Orphans.** Without Task 3, an old pod's `connection:delete` leaves both records behind. They are harmless (nothing lists them once the connection is gone), but a bundle would carry them.

## Rolling deploys

This PR is the cure. A pod running it reads and keeps everything release 2 writes. A pod without it is the reason release 1 must be everywhere before PR 03 ships: it would drop `readsTables` on re-save, refuse a release-2 bundle, leave docs out of its own exports, and leave orphans when it deletes a connection.

---

### Task 1: `sanitizeOrigin` keeps `readsTables`

**Files:** Modify `src/data/datasetOrigin.ts:53` (the `connection` member gains `readsTables?: string[]`) and `:147-160` (the `connection` case). Test: extend `scripts/test-dataset-origin.ts`.
**Interfaces:** Produces `export const MAX_READS_TABLES = 16;` and `export function sanitizeReadsTables(raw: unknown): string[]` (pure; the rules are in Global Constraints). The `connection` case sets `out.readsTables` only when the result is non-empty.

- [ ] **Step 1: Write the failing test.** Add this to `scripts/test-dataset-origin.ts`, in a new section:
  ```ts
  const conn = (extra: object) => san({ kind: 'connection', connId: UUID_A, table: 'public.orders', ...extra });
  ok('readsTables: kept, trimmed, deduped exactly, order kept', JSON.stringify(conn({ readsTables: [' A.ORDERS ', 'a.orders', 'A.ORDERS', '', 7, 'x'.repeat(1001)] })?.readsTables) === '["A.ORDERS","a.orders"]');
  ok('readsTables: at most 16', conn({ readsTables: Array.from({ length: 20 }, (_, i) => `t${i}`) })!.readsTables!.length === 16);
  ok('readsTables: absent when empty, so the bytes match today', !('readsTables' in conn({ readsTables: [] })!) && !('readsTables' in conn({})!));
  ok('readsTables: never on another kind', !('readsTables' in (san({ kind: 'url', url: 'https://a.example/x', readsTables: ['t'] }) as object)));
  ok('sourceView never prints it', !datasets.sourceView('postgres', conn({ readsTables: ['SECRET_T'] }), () => 'W').label.includes('SECRET_T'));
  const conns: typeof import('../src/ipc/connections') = require('../src/ipc/connections');
  ok('a refresh runs the table, never readsTables', JSON.stringify(conns.selectionForDataset(conn({ readsTables: ['b'] }))) === '{"table":"public.orders"}');
  // a stored origin with readsTables survives the refresh path's re-save
  const linked = await datasets.saveDataset(proj.id, { name: 'Linked', sourceKind: 'postgres', columns, rows, origin: { kind: 'connection', connId: UUID_A, sql: 'select 1', readsTables: ['A.ORDERS', 'A.LINES'] } });
  await datasets.updateDatasetData(proj.id, linked!.id, { columns, rows });
  ok('a refresh keeps readsTables', JSON.stringify((await datasets.getDatasetMeta(proj.id, linked!.id))!.origin) === JSON.stringify({ kind: 'connection', connId: UUID_A, sql: 'select 1', readsTables: ['A.ORDERS', 'A.LINES'] }));
  ```
  Use `datasets.sourceView` only if `datasets.ts` re-exports it. Otherwise import it from `../src/data/datasetOrigin`.
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts && node scripts/test-dataset-origin.js`. Expect `FAIL readsTables: kept, trimmed, deduped exactly, order kept`.
- [ ] **Step 3: Implement.** Write the signatures above. Add a one-line comment on the field: "a label (spec D11): which source tables an editor says a query reads; nothing runs it".
- [ ] **Step 4: Run it to see it pass.** Run the same command, plus `node scripts/test-datasets.js scripts/test-liveDataset.js scripts/test-liveTarget.js` (each with `node`; skip any suite that does not exist).
- [ ] **Step 5: Commit.** `git add src/data/datasetOrigin.ts scripts/test-dataset-origin.ts`. Message: "Keep a connection origin's linked source tables through every save".

### Task 2: Bundles carry the source docs

**Files:** Modify `src/app/bundleRules.ts:44` (two rules beside `connections/<uuid>.json`). Test: extend `scripts/test-bundle.ts` (new section 5).
**Interfaces:** Produces two `ENTRY_RULES` entries:
```ts
{ re: new RegExp(`^connections/${UUID}\\.tables\\.json$`, 'i') },          // a connection's source table index (part 2)
{ re: new RegExp(`^connections/${UUID}/tables/${UUID}\\.json$`, 'i') },    // one source table doc
```

- [ ] **Step 1: Write the failing test.** On the sample project `pid` the suite already builds, with its first connection `C` (create one with `connections.saveConnection` if the sample has none), write the following by hand:
  - The index: `fs.writeFileSync(path.join(dir, 'connections', `${C}.tables.json`), JSON.stringify([{ table: 'ANALYTICS.ORDERS', docId: DOC, owner: 'Data', hasGuide: true }]))`.
  - The doc: `connections/<C>/tables/<DOC>.json`, holding `{ table: 'ANALYTICS.ORDERS', owner: 'Data', refresh: '', requiredFilters: '', guide: '# g', updatedBy: 'a', updatedAt: 'b', schemaVersion: 1, dismissed: { [D0]: { table: 'abc' } } }`, where `D0` is a sample dataset id.

  Then add these asserts:
  ```ts
  const out = await bundle.exportProject(pid);
  const names = bundle.readZip(out.bytes).map((e) => e.name);
  ok('export: the index and the doc travel', names.includes(`connections/${C}.tables.json`) && names.includes(`connections/${C}/tables/${DOC}.json`));
  const res = await bundle.importBundle(out.bytes); // same machine: every id collides and is remapped
  const nd = projectDir(res.project.id); const [idx] = fs.readdirSync(path.join(nd, 'connections')).filter((n) => n.endsWith('.tables.json'));
  const C2 = idx.slice(0, 36); const entry = JSON.parse(fs.readFileSync(path.join(nd, 'connections', idx), 'utf8'))[0];
  ok('import: the connection id is new in both names', C2 !== C && fs.existsSync(path.join(nd, 'connections', C2, 'tables', `${entry.docId}.json`)));
  ok('import: the index points at the remapped doc, and the doc names the new dataset id', entry.docId !== DOC && !fs.readFileSync(path.join(nd, 'connections', C2, 'tables', `${entry.docId}.json`), 'utf8').includes(D0));
  ok('NEGATIVE CONTROL: a doc whose name is not a UUID is still refused', !(await bundle.importBundle(bundle.writeZip([...bundle.readZip(out.bytes), { name: `connections/${C}/tables/notes.json`, data: Buffer.from('{}') }]))).ok);
  ```
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts && node scripts/test-bundle.js`. Expect `FAIL export: the index and the doc travel`.
- [ ] **Step 3: Implement.** Add the two rules.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-bundle.js scripts/test-bundleMemory.js` (each with `node`).
- [ ] **Step 5: Commit.** `git add src/app/bundleRules.ts scripts/test-bundle.ts`. Message: "Let a project bundle carry source table docs".

### Task 3: Deleting a connection deletes its source docs

**Files:** Modify `src/connectors/connections.ts:653-662` (`deleteConnection`, two lines after the `rm` of the record). Test: extend `scripts/test-connectors.ts` if it already exercises the store; otherwise create `scripts/test-sourceTablesReader.ts` (temp `ORDINATE_LOCAL_DIR`, as `test-dataset-origin.ts` does).
**Interfaces:** `deleteConnection` also runs `recordFs.rm(path.join(connectionsDir(projectId), id + '.tables.json'), { force: true })` and `recordFs.rm(path.join(connectionsDir(projectId), id), { recursive: true, force: true })`. `recordFs.rm` with `recursive` drops every record row under the folder on Postgres (`src/app/recordFs.ts:548-571`).

- [ ] **Step 1: Write the failing test.** Make two connections A and B, each with a hand-written index and one doc, as in Task 2. Then:
  ```ts
  await connections.deleteConnection(P, A.id);
  ok('delete: the index and the docs go with the connection', !fs.existsSync(path.join(dir, `${A.id}.tables.json`)) && !fs.existsSync(path.join(dir, A.id)));
  ok('NEGATIVE CONTROL: another connection\'s docs stay', fs.existsSync(path.join(dir, `${B.id}.tables.json`)) && fs.existsSync(path.join(dir, B.id, 'tables')));
  ok('listConnections skips the index and the folder, silently', (await connections.listConnections(P)).map((c) => c.id).join() === B.id);
  ```
  For the last assert, wrap `logger.error` and assert it was not called with "Skipping corrupt". `listConnections` already skips both: `<id>.tables` fails `isValidId`, and the folder is not a file (`src/connectors/connections.ts:455-458`).
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts && node scripts/test-sourceTablesReader.js`. Expect `FAIL delete: the index and the docs go with the connection`.
- [ ] **Step 3: Implement.** Add the two `rm` lines inside the existing `try`.
- [ ] **Step 4: Run it to see it pass.** Run the same command, then `DATABASE_URL=… node scripts/test-connections-server.js` (the Postgres path: `rm` with `recursive` on records) and `node scripts/test-file-size.js`.
- [ ] **Step 5: Commit.** `git add src/connectors/connections.ts scripts/test-sourceTablesReader.ts`. Message: "Delete a connection's source table docs with it".

### Task 4: Say why this release comes first

**Files:** Modify `docs/server/upgrade.md`: add a section after part 1's 05a section, "Source table docs are read before they are written (part 2, release 1)".
- [ ] **Step 1:** Write one paragraph. The release that adds source table docs and linked tables needs this release, or later, on every pod first. Either upgrade through it, or stop every pod before starting the new ones (Compose: `up -d`; Helm: `kubectl -n ordinate scale deploy/ordinate --replicas=0`, then `helm upgrade`). Never `helm rollback` below it once source docs exist: an older pod drops a dataset's linked tables when it saves the dataset, and leaves the docs out of its exports.
- [ ] **Step 2: Run** `node scripts/test-serverDocs.js`. Expect `ok`.
- [ ] **Step 3: Commit.** `git add docs/server/upgrade.md`. Message: "Document the reader release source tables need first".

## Existing tests that must stay green

`test-dataset-origin`, `test-datasets`, `test-bundle`, `test-bundleMemory`, `test-connectors`, `test-connections-server` (DB), `test-liveDataset`, `test-serverDocs`, `test-file-size`, `check-contracts`; every `__golden__` fixture.
