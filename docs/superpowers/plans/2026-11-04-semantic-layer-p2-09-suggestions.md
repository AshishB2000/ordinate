# Semantic layer part 2, PR 09: the warehouse's comments and keys as suggestions — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In **Data model → Datasets**, an editor sees what the warehouse already says as suggestions:
- a column comment, where the dataset's column of the same exact name has no meaning;
- the table comment, where the dataset has no description;
- a single-column primary key, where the dataset has no key.

Each one becomes the dataset's own only on **Use**. **Dismiss** keeps it away until the warehouse's text changes. The strip gains one chip, "N suggested meanings".
**Architecture:** A pure rule, `suggestionsFor` (`src/analysis/sourceSuggestions.ts`), runs over the dataset's columns, its catalog docs, part 1's table doc and its linked source docs' stored facts. Two `write` channels serve it: `catalog:suggestions` (records only) and `catalog:dismissSuggestion`, which stores a 12-character hash in the source doc. **Use** goes through today's writers (`catalog:setColumn`, `catalog:set`, part 1's `catalog:setTable`), so nothing new writes a dataset's docs.
**Tech Stack:** `src/analysis`, `src/ipc`, `src/api`, self-checks on `liveRouteHarness` with the fake warehouse, React, Vitest, Playwright.
**Spec:** docs/semantic-layer/02-source-tables.md (D12, the Fields mockup in "What you will see", anti-goal "a field meaning that appears without an editor's click", "Tests that prove it": never silent) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p2-00-index.md
**Branch and PR:** `feat/semantic-p2-09-suggestions` off `origin/develop` after PR 08 **and part 1's step 01** (`TableDoc.key`, `catalog:setTable`, `getTableDoc`) merge. One PR, in release 2.

## Global Constraints

- **Never silent.** No code path in this PR writes `catalog.json` or a table doc. `catalog:suggestions` reads records only, and the only writes are the existing channels on an editor's **Use**. `sourceTable:read` changes nothing in the dataset's catalog.
- **Exact names only.** A column matches a warehouse column of the same exact string. A renamed column gets nothing. A name two linked tables share with **different** comments gets nothing, and the same comment twice counts as one. The same rule covers two different table comments and two different single-column keys.
- **Composite keys stay a fact:** a `primaryKey` of 2 or more columns suggests nothing (a part 1 non-goal). A key whose column the dataset lacks suggests nothing.
- **Dismiss stores a hash, never the text.** `hashOf(text) = sha256(text) → base64url → first 12 characters`, kept in the source doc's `dismissed[datasetId]` as `{ table?, key?, columns?: { [column]: hash } }` (shape and caps from PR 03's sanitizer). A changed comment has a new hash, so it is offered again. The catalog never holds a dismissal, so `catalog:columns`, which viewers read, is unchanged.
- **Use on a key** runs part 1's key check (`catalog:setTable` on an extract checks before replying; on Live, Check now runs it, part 1 D2). The copy may differ from an enforced warehouse key.
- Suggestion text is warehouse text, and it reaches only editors: both channels are `write`. Part 1's `model:overview` (a `read`) gets no suggestion field.
- A server file stays under 250 lines, and so does each web file. Part 1's `FieldsPanel.tsx` gets one element.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **The planted auto-apply.** The "never silent" check compares `catalog.json`'s bytes before a read, after the read, and after `catalog:suggestions`. Its negative control shows the same comparison catches a `setColumn` planted into the path. Task 2.
- **Ambiguity is per kind and per name.** One shared column with different comments must not hide the other columns' suggestions. Task 1's matrix.
- **The strip chip** draws the server's `total`, never a count made in the browser. It shows only for editors, so no viewer calls `catalog:suggestions`. Task 3.
- **A dismissal on one dataset** does not dismiss the same comment on another dataset built from the same table: dismissals are keyed by `datasetId`. Task 2.

## Rolling deploys

`dismissed` lives in the source doc. PR 03's sanitizer already keeps it, so a pod with PRs 03–08 that re-saves a guide does not drop a dismissal. The two channels are new: on a pod without them the web's suggestion block and chip show nothing. The query errors and the block renders `null`, logging no console error (`retry: false`, `throwOnError: false`), and the strip draws the server's own items.

---

### Task 1: The rule

**Files:** Create `src/analysis/sourceSuggestions.ts`, `scripts/test-sourceSuggestions.ts`.
**Interfaces:** Consumes `SourceTableDoc` (PR 03) and `ColumnDoc` (`src/app/catalog.ts`). Produces:
```ts
export type SuggestionKind = 'column' | 'table' | 'key';
export interface Suggestion { datasetId: string; kind: SuggestionKind; column?: string; text: string; hash: string; connId: string; docId: string; table: string }
export const hashOf = (text: string): string; // 12 chars, base64url
export interface SuggestionInput {
  datasetId: string; columns: string[]; columnDocs: Record<string, { description?: string }>;
  description: string; key: string;                                   // the catalog record doc's, part 1's TableDoc.key
  docs: { connId: string; docId: string; table: string; doc: SourceTableDoc }[]; // the dataset's linked, documented tables, in sourceTablesOf order
}
export function suggestionsFor(i: SuggestionInput): Suggestion[]; // columns in dataset column order, then table, then key
```
For a key suggestion, `text` is the column name. Docs with no `facts` are skipped. A suggestion whose `hash` equals the dismissal stored for its kind and column is left out.

- [ ] **Step 1: Write the failing test.** This part is pure.
  ```ts
  const doc = (facts: object, dismissed?: object) => ({ connId: C, docId: D1, table: 'T', doc: { ...EMPTY_DOC, facts: { readAt: 'x', readBy: 'y', ...facts }, ...(dismissed ? { dismissed: { [DS]: dismissed } } : {}) } });
  const F = { comment: 'Order lines', columns: [{ name: 'discount', type: 'double', comment: 'Discount in USD, after tax' }, { name: 'region', type: 'text', comment: 'Sales region' }, { name: 'line_id', type: 'int', key: true }], primaryKey: { columns: ['line_id'], enforced: true } };
  const base = { datasetId: DS, columns: ['line_id', 'discount', 'region'], columnDocs: { region: { description: 'Region of sale' } }, description: '', key: '' };
  const kinds = (s: Suggestion[]) => s.map((x) => `${x.kind}:${x.column ?? ''}:${x.text}`).join('|');
  ok('a column with no meaning, the table comment, the key', kinds(suggestionsFor({ ...base, docs: [doc(F)] })) === 'column:discount:Discount in USD, after tax|table::Order lines|key::line_id');
  ok('a column that has a meaning gets none', !suggestionsFor({ ...base, docs: [doc(F)] }).some((s) => s.column === 'region'));
  ok('a renamed column gets none', !suggestionsFor({ ...base, columns: ['line_id', 'disc'], docs: [doc(F)] }).some((s) => s.kind === 'column'));
  ok('two tables, different comments for one name: none for that name only', ((s) => !s.some((x) => x.column === 'discount') && s.some((x) => x.kind === 'table'))(suggestionsFor({ ...base, docs: [doc(F), { ...doc({ columns: [{ name: 'discount', type: 'double', comment: 'Share of list price' }] }), docId: D2 }] })));
  ok('two tables, the same comment: one suggestion', suggestionsFor({ ...base, docs: [doc(F), { ...doc(F), docId: D2 }] }).filter((s) => s.column === 'discount').length === 1);
  ok('a composite key suggests nothing', !suggestionsFor({ ...base, docs: [doc({ ...F, primaryKey: { columns: ['line_id', 'region'], enforced: true } })] }).some((s) => s.kind === 'key'));
  ok('a dataset with a key gets no key suggestion', !suggestionsFor({ ...base, key: 'line_id', docs: [doc(F)] }).some((s) => s.kind === 'key'));
  ok('a dismissal holds while the text is the same', !suggestionsFor({ ...base, docs: [doc(F, { table: hashOf('Order lines') })] }).some((s) => s.kind === 'table'));
  ok('NEGATIVE CONTROL: a changed comment is offered again', suggestionsFor({ ...base, docs: [doc({ ...F, comment: 'Order lines (net)' }, { table: hashOf('Order lines') })] }).some((s) => s.kind === 'table'));
  ok('hashOf: 12 url-safe chars, stable', /^[A-Za-z0-9_-]{12}$/.test(hashOf('x')) && hashOf('x') === hashOf('x') && hashOf('x') !== hashOf('y'));
  ```
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts`. Expect tsc's "Cannot find module '../src/analysis/sourceSuggestions'".
- [ ] **Step 3: Implement.** Write the signatures above.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-sourceSuggestions.js`.
- [ ] **Step 5: Commit.** `git add src/analysis/sourceSuggestions.ts scripts/test-sourceSuggestions.ts`. Message: "Suggest field meanings, a description and a key from a source table's facts".

### Task 2: The two channels

**Files:** Create `src/ipc/sourceSuggestions.ts`. Modify `src/api/sourceTables.ts`, `src/ipc/sourceTables.ts` (`register()`), `scripts/test-sourceNamesHidden.ts` (two `PAYLOAD` entries). Test: extend `scripts/test-sourceSuggestions.ts` (part "channels") on `scripts/liveRouteHarness.ts`.
**Interfaces:** Consumes:
- `datasets.listDatasets` and `getDatasetMeta` (metadata only);
- `sourceTablesOf`, `listSourceIndex`, `readSourceDoc` and `updateSourceDoc` (PR 03);
- `catalog.getColumns` and `catalog.getDoc(p, `dataset:${id}`)` (`src/app/catalog.ts:329`, `:299`);
- part 1's `getTableDoc(p, id).key`.

Produces:
```ts
'catalog:suggestions': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid.optional() }), project: byProjectId }),
// → { ok: true; suggestions: Suggestion[]; total: number; datasets: number } — the project, or one dataset; total counts every suggestion, datasets how many have one
'catalog:dismissSuggestion': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, connId: Uuid, docId: Uuid,
  kind: z.enum(['column', 'table', 'key']), column: z.string().min(1).max(256).optional(), hash: z.string().regex(/^[A-Za-z0-9_-]{12}$/) }), project: byProjectId }),
// → { ok: true } | { ok: false, error } — writes doc.dismissed[datasetId] under the doc's lock (updateSourceDoc), the tag unchanged
```
- [ ] **Step 1: Write the failing test.**
  - Setup:
    - `H.warehouseExec(H.ORG_A, "CREATE OR REPLACE TABLE wh_orders (line_id INTEGER PRIMARY KEY, discount DOUBLE, region VARCHAR); COMMENT ON TABLE wh_orders IS 'Order lines'; COMMENT ON COLUMN wh_orders.discount IS 'Discount in USD, after tax'")`;
    - Live views L, L2 and L3 over `wh_orders`;
    - `catalog:setColumn` gives `region` the meaning 'Region of sale';
    - document `wh_orders` and `sourceTable:read` it.
  ```ts
  // the stored catalog record, through recordFs, so the check holds on files and on Postgres
  const bytes = () => H.as(H.ORG_A, () => recordFs.readFile(path.join(appPaths.userData(), 'projects', P, 'catalog.json'), 'utf8'));
  const c0 = await bytes(); await post('sourceTable:read', READ); const c1 = await bytes();
  const s = (await post('catalog:suggestions', { projectId: P, datasetId: L })).value; const c2 = await bytes();
  ok('never silent: the catalog is byte-identical after a read and after suggestions', c0 === c1 && c1 === c2);
  ok('suggestions: discount, the table comment, the key', s.suggestions.map((x: Reply) => x.kind + ':' + (x.column ?? '')).join() === 'column:discount,table:,key:');
  // the planted auto-apply: run on a SECOND dataset L3 (same table) so L's later asserts stay clean
  const p0 = await bytes(); await H.as(H.ORG_A, () => catalog.setColumn(P, L3, 'discount', { description: s.suggestions[0].text }));
  ok('NEGATIVE CONTROL: a planted setColumn in the path is caught by the same comparison', p0 !== (await bytes()));
  await post('catalog:setColumn', { projectId: P, datasetId: L, column: 'discount', patch: { description: s.suggestions[0].text } }); // Use
  ok('Use: the meaning is the dataset\'s own, and the suggestion is gone', (await post('catalog:columns', { projectId: P, datasetId: L })).value.discount.description === 'Discount in USD, after tax' && !(await sug(L)).some((x: Reply) => x.column === 'discount'));
  await post('catalog:dismissSuggestion', { projectId: P, datasetId: L, connId: C, docId: D, kind: 'table', hash: tableSug.hash });
  ok('Dismiss sticks, for this dataset only', !(await sug(L)).some((x: Reply) => x.kind === 'table') && (await sug(L2)).some((x: Reply) => x.kind === 'table'));
  ok('Dismiss stores the hash, never the text', ((raw) => raw.includes(tableSug.hash) && !JSON.stringify(JSON.parse(raw).dismissed).includes('Order lines'))(docFileText(C, D)));
  await H.warehouseExec(H.ORG_A, "COMMENT ON TABLE wh_orders IS 'Order lines (net)'"); await post('sourceTable:read', READ);
  ok('a changed comment returns', (await sug(L)).some((x: Reply) => x.kind === 'table' && x.text === 'Order lines (net)'));
  ok('the project total is the server\'s', (await post('catalog:suggestions', { projectId: P })).value.total === (await sug(L)).length + (await sug(L2)).length + (await sug(L3)).length);
  ok('records only: no warehouse call, nothing hydrated', H.fake.catalogCalls === n0 && !hydratedAny);
  ok('a hash that is not 12 url-safe chars is refused at the door', (await post('catalog:dismissSuggestion', { …, hash: 'the text itself' })).status === 400);
  ```
  The DB suite's `PAYLOAD` gains both channels, so the viewer 403 loop covers them.
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts && node scripts/test-sourceSuggestions.js`. Expect `No handler for catalog:suggestions`.
- [ ] **Step 3: Implement.** For one dataset: its meta, then `sourceTablesOf` with its connection, then each table's index entry. Undocumented tables are skipped. Then `readSourceDoc`, then `suggestionsFor`. For the project: the same over every dataset with `originConnId`, with the index and docs read once per connection or doc.
- [ ] **Step 4: Run it to see it pass.** Run:
  - `node scripts/test-sourceSuggestions.js scripts/test-catalog.js scripts/test-tableDocs.js` (each with `node`)
  - `DATABASE_URL=… node scripts/test-sourceNamesHidden.js`
  - `node scripts/check-contracts.js`
  - `npm run lint`
- [ ] **Step 5: Commit.** `git add src/ipc/sourceSuggestions.ts src/ipc/sourceTables.ts src/api/sourceTables.ts scripts/test-sourceSuggestions.ts scripts/test-sourceNamesHidden.ts`. Message: "Serve a dataset's suggested meanings and keep a dismissal as a hash".

### Task 3: The web: Fields and the strip

**Files:** Create `web/src/features/model/datasets/SuggestedMeanings.tsx`, `suggestions.test.tsx`, and `web/src/features/model/sources/suggestApi.ts`. Modify part 1's `web/src/features/model/datasets/FieldsPanel.tsx` (one element above the column notes) and `DatasetsTab.tsx` (the chip).
**Interfaces:**
- `useSuggestions(projectId, datasetId?, on)` uses the key `['catalog:suggestions', projectId, datasetId ?? '*']`, `retry: false`.
- `SuggestedMeanings({ projectId, datasetId, header })` renders `null` unless `useCanEdit` and there is at least 1 suggestion. Otherwise it renders a `region` "Suggested by the warehouse" with one row per suggestion:
  - **Column:** `<column>` (mono) · Meaning — · `The warehouse says: "<text>"` · **Use** · **Dismiss**. **Use** sends `catalog:setColumn { column, patch: { description: text } }`.
  - **Table:** Description — · the text · **Use** · **Dismiss**. **Use** sends `catalog:set { ref: 'dataset:<id>', patch: { description } }`.
  - **Key:** `The warehouse's primary key is <column>` · **Use** · **Dismiss**. **Use** sends part 1's `catalog:setTable { patch: { key } }`, and the key line then shows the server's check.
  - Each row names its table: "from ANALYTICS.ORDERS".
  - After **Use** or **Dismiss**, invalidate `catalog:suggestions`, `catalog:columns`, `catalog:get`, `catalog:getTable` and `model:overview`.
- `DatasetsTab` (editors only) adds one chip after the server's strip items: `"${formatNumber(total)} suggested meaning(s)"`, from `useSuggestions(projectId)`. Clicking it sets `?dataset=<first suggestion's datasetId>&panel=fields`. The strip shows when either source has items.
- [ ] **Step 1: Write the failing test.** `suggestions.test.tsx`:
  - Fields for Orders shows the region with `discount`, `The warehouse says: "Discount in USD, after tax"`, and `from ANALYTICS.ORDERS`.
  - **Use** sends `catalog:setColumn` with exactly `{ column: 'discount', patch: { description: 'Discount in USD, after tax' } }`, and then `catalog:suggestions` again.
  - **Dismiss** sends `catalog:dismissSuggestion` with the row's `hash` and `docId`.
  - The key row's **Use** sends `catalog:setTable` with `{ key: 'line_id' }`.
  - The strip shows `3 suggested meanings` (from `total: 3`) after the server's items. Clicking it lands on `panel=fields` for the first dataset.
  - NEGATIVE CONTROL: as a viewer, no region, no chip and no `catalog:suggestions` call.
  - A 404 on `catalog:suggestions` (an old pod) leaves Fields and the strip as part 1 draws them, with no console error.
- [ ] **Step 2: Run it to see it fail.** Run `npm run test:web -- suggestions`.
- [ ] **Step 3: Implement.** Use the interfaces above.
- [ ] **Step 4: Run it to see it pass.** Run `npm run test:web` (all, including part 1's `model.test.tsx` and `panel.test.tsx`), `npm run lint` and `npm --prefix web run size`.
- [ ] **Step 5: Commit.** `git add web/src/features/model`. Message: "Offer the warehouse's comments and key as suggestions in a dataset's Fields".

### Task 4: E2e and the changelog

**Files:** Modify `web/e2e/source-tables.e2e.ts` and `CHANGELOG.md`.
- [ ] **Step 1:** Add the test **`source tables: a suggested meaning`**:
  - After PR 07's read of `live_fake_orders`, open `/model/${pid}?dataset=${liveId}&panel=fields`.
  - The region "Suggested by the warehouse" shows `amount` with `Order amount in USD`. Click **Use**. Its row goes, and the column notes show the meaning.
  - Reload: the meaning stays and no suggestion returns.
  - Shot `model-suggestions`.
- [ ] **Step 2:** Add the changelog line: "A dataset built from a documented warehouse table gets the warehouse's column comments, table comment and primary key as suggestions in Data model → Fields. Nothing changes until an editor clicks Use."
- [ ] **Step 3: Run** `npm run build:web && npm --prefix web run e2e -- source-tables model` and `DATABASE_URL=… npm --prefix web run e2e -- view-only-routes`.
- [ ] **Step 4: Commit.** `git add web/e2e CHANGELOG.md`. Message: "Cover suggested meanings end to end".

## Existing tests that must stay green

`test-catalog`, `test-tableDocs` (part 1), `test-sourceTables`, `test-sourceLinks`, `test-sourceNamesHidden` (DB), `test-rowPolicySafetyNet` (DB), `test-copilot` (no suggestion reaches facts), `check-contracts`, `test-file-size`; web `model.test.tsx`, `panel.test.tsx`, `sources.test.tsx`, `sourceNotes.test.tsx`; e2e `model`, `source-tables`, `view-only-routes`.
