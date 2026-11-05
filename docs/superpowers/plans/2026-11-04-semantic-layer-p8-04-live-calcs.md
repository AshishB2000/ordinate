# Semantic layer part 8, step 04: Live calculated fields — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor adds a calculated field to a Live dataset in the formula language, and every chart, KPI, answer, filter, picker, the Assistant and MCP see it as one more column. It is computed in the warehouse by step 03's SQL and gives the same figure as the same formula as a Prepare step on a copy. "Make a copy" and "Copy the data instead" carry the calcs as Prepare steps.
**Architecture:**
- **Record.** 00a's top-level `calculated` key becomes writable through `live:setCalculated`. `applyLive` appends each calc as a typed column to `meta.columns` when the record is read, so every column reader sees it. Nothing writes calc columns into `raw.columns`, which the schema sync rewrites from the warehouse.
- **Compile.** The definitions travel in `LiveSource.calcs`, so they are in every cache key. A statement that names a calc reads its source through one derived table per needed calc, in order. Each layer projects only the columns still needed, base filters sit in the innermost layer, and the outer alias stays `lv_src`. A statement that names no calc is byte-identical to today's.
- **Databricks** is refused at save and at compile (owner's answer 1).
**Tech Stack:** `src/data/liveDataset.ts`, `liveCalcs.ts`, `src/engine/live/` (compile, a new `calcLayers.ts`, liveTarget, schemaSync), `src/ipc/` (a new `liveCalcs.ts`, liveProfile, liveDatasets, modelOverview), `src/api/live.ts`, the parity matrix, and the web Live dataset page and formula editor.
**Spec:** docs/semantic-layer/08-engine.md (D1, D3, D6–D8; Tests "Matrix", "Safety"; owner's answer 1) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p8-00-index.md
**Branch and PR:** `feat/semantic-p8-04-live-calcs` off `origin/develop`, after step 03 and part 1's step 08 (base filters) merge. **Merge gate:** 00a is in a released tag that has rolled out on every pod. Check with `git tag --contains <00a's merge commit>` after fetching tags outside 08:00–18:00, and ask the owner. One PR.

## Global Constraints
- **No calc: byte-identical** statements, params, keys and replies. `test-liveCompile`, `test-liveProfile`, `test-liveParity` and `test-liveBaseFilters` stay green untouched.
- **A calc never skips.** A calc that no longer compiles stays a column, so a filter on it refuses (`calculated`) and never skips as "unknown column". If one of its inputs was dropped, the statements reading it refuse `columnMissing`, and only those.
- Names are unique ignoring case against declared columns and the other calcs, because BigQuery and Databricks names are case-insensitive (D6). The `lv_` and `o_` prefixes are refused, because they are the compiler's aliases (my call).
- **Caps** (left to the builder; my calls): 50 calcs, 4,000-character expressions and 200-character names (00a's constants). A compiled statement over 256 KB refuses (`calcTooLarge`). Layers are not merged in v1.
- **Calcs never read rows.** Profile SQL never names a calc. No new statement builder exists, so step 08's inventory test still counts `compile.ts` ×7 and `profileSql.ts` ×2. `live:checkCalc` makes no warehouse call. A calc has no value list: its control shows the "not sampled" state (`liveProfile.liveDistinct`) and takes typed values (D7).
- **Not a row access column, and not a base filter's column.** A row access column is checked against `raw.columns`, which never holds a calc (`src/ipc/rowPolicy.ts:110 textColumn`). Base filters are adapted against the declared columns only (Task 3).
- **A restricted viewer** (`closedToCaller`) gets a calc's name and type, never its expression (D8): `dataset:liveSchema`, `model:overview`.
- **Size.** `compile.ts` (about 480 after part 1) gets at most 8 lines in `fromItem`/`prepare`/`whereOf`; the layers are a new file. `liveTarget.ts`, `schemaSync.ts`, `liveProfile.ts` and `liveDatasets.ts` get small edits. `src/server/app.ts` gets no line: the module joins the array at :607.
- Sentences go through `t()` in `src/data/liveMessages.ts` and `src/engine/liveRefusals.ts`. Then `node scripts/i18n-extract.js`.

## Old pods (rolling deploy and rollback)
- **`calculated`** (top level, written here): an 00a pod keeps it and refuses every figure on the dataset. A pod older than 00a would skip filters on calcs, which is why the merge gate exists. The residual risk is in `docs/server/upgrade.md` (00a).
- **New contracts** `live:setCalculated` and `live:checkCalc`: an 00a pod answers 404, and the panel shows the error with Retry.
- **New reply fields:** `dataset:liveSchema.calculated` and `FunctionDoc.live`/`liveWhy`. An old browser ignores them, and on an 04 pod it sees calc columns as ordinary columns. No figure differs.
- **A browser on an 04 pod, its dashboard asked of an 00a pod:** that tile refuses (`calculated`) until the rollout finishes.

## Review Focus
- A schema sync on a dataset with calcs: the calcs must not be "removed" in its diff, must not reach `missingColumns`, and must not reach profile SQL. → Task 1
- A later schema sync brings a warehouse column whose name equals a calc's, ignoring case. Statements naming either refuse; nothing silently reads the warehouse column instead. → Task 3
- An edit moves the cache key **without** an epoch bump: the stale fallback must never serve the old formula's answer. → Task 3
- "Copy the data instead" deletes `calculated` from the record in the same write that adds the steps. → Task 4
- Base filters innermost and IR filters (and a row lock) outer: every layer projects the outer filters' columns. → Task 3

---

### Task 1: the record — write, append, declared columns
**Files:** Modify:
- `src/data/liveCalcs.ts` (00a): append `declaredColumns` and `calcColumns`.
- `src/data/liveDataset.ts`: `applyLive` (:193) appends calc columns; `setLiveCalcs` goes after `setMaxCacheAge`.
- `src/engine/live/schemaSync.ts`: :312 and :318 use `declaredColumns(meta)`.
- `src/ipc/liveProfile.ts`: `schemaView` (:184-220) lists declared columns only.

Test: `scripts/test-liveCalcs.ts` § record (new, on `./liveRouteHarness`).
**Interfaces:** Produces
```ts
export function calcColumns(calcs: readonly LiveCalc[]): ParsedColumn[];          // {name, type}
export function declaredColumns(meta: { columns: ParsedColumn[]; live?: { calculated?: readonly LiveCalc[] } }): ParsedColumn[]; // meta.columns minus calc names
export function setLiveCalcs(projectId: string, id: string, calcs: LiveCalc[]): Promise<LiveSettings | false>; // one serialized write; [] deletes the key; no epoch bump
```
- `applyLive` now takes `target.columns`. It drops any existing column named exactly like a calc, then appends `calcColumns(live.calculated)`, so it is idempotent.
- [ ] **Step 1: Write the failing test.**
  ```ts
  await setLiveCalcs(P, L, CALCS);
  ok('meta.columns ends with the calcs, typed; raw.columns has none', show((await meta(L)).columns.slice(-2)) === show([{ name: 'Margin', type: 'number' }, { name: 'Band', type: 'text' }]) && !(await raw(L)).columns.some((c: Reply) => c.name === 'Margin'));
  ok('the write leaves the epoch alone', (await meta(L)).live.epoch === e0);
  const s = await H.as(ORG_A, () => sync.syncLiveSchema(P, L));
  ok('a schema sync keeps the calcs: none removed, none missing, none profiled', s.ok && !s.removed.includes('Margin') && !s.missing.includes('Margin') && !H.fake.calls.at(-1)!.sql.includes('Margin') && show((await meta(L)).live.calculated) === show(CALCS));
  ok('dataset:liveSchema lists warehouse columns only', !(await liveSchema(L)).columns.some((c: Reply) => c.name === 'Margin'));
  ok('NEGATIVE CONTROL: diffColumns over meta.columns would report the calcs removed', diffColumns((await meta(L)).columns, warehouseColumns).removed.includes('Margin'));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveCalcs.js` → `setLiveCalcs` missing.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveCalcs.js && node scripts/test-liveProfileSync.js && node scripts/test-liveDataset.js`.
- [ ] **Step 5: Commit.** `git add src/data/liveCalcs.ts src/data/liveDataset.ts src/engine/live/schemaSync.ts src/ipc/liveProfile.ts scripts/test-liveCalcs.ts` · "Store Live calculated fields and show them as columns, never as warehouse columns"

### Task 2: save and check — `live:setCalculated`, `live:checkCalc`
**Files:** Create `src/ipc/liveCalcs.ts` and `src/engine/live/liveCalcCheck.ts`. Modify:
- `src/api/live.ts`: append two contracts.
- `src/server/app.ts:607`: add `'../ipc/liveCalcs'` to the existing array.
- `src/data/liveMessages.ts`: the save sentences.
- `src/ipc/formula.ts:207` and `src/formula/formulaDocs.ts`: `FunctionDoc.live?` and `liveWhy?`.

Test: `scripts/test-liveCalcs.ts` § save.
**Interfaces:**
```ts
'live:setCalculated': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid,
  calculated: z.array(z.strictObject({ name: z.string().min(1).max(200), expression: z.string().min(1).max(4_000) })).max(50) }), project: byProjectId }),
'live:checkCalc': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, expression: z.string().max(4_000), before: z.number().int().min(0).max(50).optional() }), project: byProjectId }),
// src/engine/live/liveCalcCheck.ts — PURE
export function validateLiveCalcs(declared: LiveColumn[], input: { name: string; expression: string }[], dialect: CompileDialectId):
  { ok: true; calculated: LiveCalc[] } | { ok: false; code: 'calc_invalid' | 'calc_dialect'; index?: number; error: string; at?: SourceSpan };
```
- `live:setCalculated` answers `{ ok: true; calculated }`, or the failure above, or `not_live`. It replaces the whole list. Each calc is checked by `checkCalc(expr, declared, earlier)`, and its stored `type` is the verdict's.
- After the write it runs `queryCache.invalidateDataset` and `announceRefreshed`, as `live:setBaseFilters` does. Both are `write`, so neither joins `rowPolicyReaders`.
- `live:checkCalc` answers the editor's `FormulaCheck` shape (`src/ipc/formula.ts:62-85`): `tokens`, `ok`, `error`, `at`, `refs`, `unknownRefs` with `didYouMean`, and `resultType` from the static type (`logical` for a boolean). It never has sample rows: `sample: { columns: [], rows: [], note: liveCalcNoPreview() }` (my call: a statement per keystroke would spend `LIVE_DAILY_QUERY_LIMIT`).
- `formula:functions` marks each doc `live: LIVE_FUNCTIONS[name].v1`, and gives `liveWhy` the refusal sentence.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const set = (c: unknown[]) => post('live:setCalculated', { projectId: P, datasetId: L, calculated: c });
  ok('saves typed, in order', show((await set(INPUT)).value.calculated.map((c: Reply) => c.type)) === '["number","text"]');
  for (const [why, bad, code] of [['a name equal to a column, ignoring case', { name: 'AMT', expression: '1' }], ['two calcs differing by case', DUP], ['a reserved prefix', { name: 'lv_x', expression: '1' }],
    ['len()', { name: 'L', expression: 'len([cat])' }], ['a later calc', LATER], ['an unknown column', { name: 'U', expression: '[nope] + 1' }]] as const)
    ok(`refused: ${why} (index, sentence, span)`, (await set([...INPUT, bad])).value.ok === false && (await set([...INPUT, bad])).value.index === 2);
  ok('Databricks: refused with its sentence', validateLiveCalcs(COLS, INPUT, 'databricks').ok === false);
  ok('checkCalc: type, no rows, no warehouse call', ((r) => r.resultType === 'number' && r.sample.rows.length === 0)((await post('live:checkCalc', { projectId: P, datasetId: L, expression: '[amt] * 2' })).value) && H.fake.calls.length === n0);
  ok('formula:functions: len is not live and says why', ((d) => d.live === false && /characters/.test(d.liveWhy))((await post('formula:functions')).value.find((d: Reply) => d.name === 'len')));
  ok('access: a viewer may not set them', !(await decide(VIEWER, 'live:setCalculated', 1)).ok);
  ok('NEGATIVE CONTROL: an extract answers not_live', (await post('live:setCalculated', { projectId: P, datasetId: X, calculated: INPUT })).value.code === 'not_live');
  ```
- [ ] **Step 2: Run it to see it fail.** → 404; `node scripts/check-contracts.js` lists two unresolved.
- [ ] **Step 3: Implement.** Then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveCalcs.js && node scripts/check-contracts.js && node scripts/test-formulaDocs.js && node scripts/test-i18n.js && node scripts/test-server-boot.js`.
- [ ] **Step 5: Commit.** `git add src/ipc/liveCalcs.ts src/engine/live/liveCalcCheck.ts src/api/live.ts src/server/app.ts src/data/liveMessages.ts src/ipc/formula.ts src/formula/formulaDocs.ts src/i18n scripts/test-liveCalcs.ts` · "Add live:setCalculated and live:checkCalc"

### Task 3: compile — the calc layers, through the executor
**Files:** Create `src/engine/live/calcLayers.ts`. Modify:
- `src/engine/live/compile.ts`: `LiveSource` (:55) gains `calcs?`; `Prepared` (:89) gains `baseInside?`; `prepare` (:127-144) calls `calcFrom` when the IR names a calc; `whereOf` (:146) skips `p.base` when `baseInside`.
- `src/engine/live/liveSpec.ts`: codes `calcDialect` and `calcTooLarge`.
- `src/engine/liveRefusals.ts`: rewrite `calculated`'s sentence to "The calculated field “{column}” no longer runs on this table. An editor can fix it on the Schema tab."
- `src/engine/live/liveTarget.ts`: remove 00a's guard; `source.calcs`; `liveBaseOf` over `declaredColumns`.
- `scripts/test-liveCompile.ts`: § calc layers, golden fragments per dialect.

Test: `scripts/test-liveCalcs.ts` § doors.
**Interfaces:**
```ts
export type LiveSource = ({ kind: 'table'; parts: string[] } | { kind: 'sql'; sql: string }) & { calcs?: LiveCalc[] };
// src/engine/live/calcLayers.ts
export function namesCalc(names: readonly string[], src: LiveSource): boolean;
export function calcFrom(c: Ctx, d: SqlDialect, src: LiveSource, names: readonly string[], base: readonly LiveFilter[]): string | LiveRefusal;
```
- `calcFrom` takes the needed calcs (those `names` hold, plus what they read, transitively, in list order) and compiles each with `compileCalcSql(expr, { d, b: c.b, columns: declared + earlier, earlier })`.
- Layer 0 is `SELECT <needed declared columns, each lv_src.<ident>> FROM <fromItem> [WHERE <basePredicates>]`.
- Layer k is `SELECT <columns still needed>, <projected calc k> AS <ident(name)> FROM (<layer k−1>) AS lv_src`.
- The FROM item is `(<layer n>) AS lv_src`.
- It refuses:
  - on Databricks, `calcDialect`;
  - on a missing input, `columnMissing`;
  - when a calc no longer compiles, or its type differs from the stored one, `calculated`;
  - when a calc's name equals a declared column's ignoring case, `calculated`;
  - over 256 KB of SQL, `calcTooLarge`.
- The cache key is unchanged in shape. `{ ir, source, dialect, base }` now carries `source.calcs`, and `stableStringify` drops `undefined`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  await set(INPUT);
  for (const [label, enc] of [['sum of a calc', { category: 'cat', values: [M('Margin', 'sum')] }], ['a text calc as the category', { category: 'Band', values: [M('amt', 'sum')] }], ['bins over a calc', { category: 'Margin', values: [M('qty', 'count')] }]])
    ok(`${label}: answered from the warehouse`, (await chart(L, enc)).ok);
  ok('a filter on a calc applies', show(await chart(L, ENC, [F('Band', '=', 'big')])) !== show(await chart(L, ENC)));
  ok('literals are bound: the quote never reaches SQL text', !lastSql().includes("o'k") && lastParams().some((p) => p.value === "o'k"));
  const k1 = H.fake.calls.length; await set(EDITED); await chart(L, ENC);
  ok('an edit moves the cache key with no epoch bump: a new warehouse call', H.fake.calls.length > k1 && (await meta(L)).live.epoch === e0);
  ok('getDataset is never called (the liveRoute spy)', hydrated === 0);
  await dropColumn('qty'); await syncNow();
  ok('a dropped input refuses only what reads the calc', (await chart(L, { category: 'cat', values: [M('Margin', 'sum')] })).reason === 'columnMissing' && (await chart(L, { category: 'cat', values: [M('amt', 'sum')] })).ok);
  ok('a base filter naming a calc is refused at save', (await post('live:setBaseFilters', { projectId: P, datasetId: L, filters: [F('Band', '=', 'big')] })).value.ok === false);
  ok('a row access rule on a calc is refused', (await post('dataset:setRowPolicy', { projectId: P, datasetId: L, policy: { column: 'Band', rules: RULES } })).value.ok === false);
  ok('NEGATIVE CONTROL: a statement naming no calc is byte-identical to before the calcs were saved', lastSqlFor(PLAIN) === sqlBefore);
  ```
  In `test-liveCompile` § calc layers:
  - for each dialect, one layered statement's fragments (`) AS lv_src`, the projected calc, the base predicate in the innermost `WHERE`);
  - Databricks refuses `calcDialect`;
  - every refusal code renders (`all` += `calcDialect`, `calcTooLarge`).
- [ ] **Step 2: Run it to see it fail.** → 00a's guard refuses `calculated`.
- [ ] **Step 3: Implement** as in Interfaces. `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveCalcs.js && for t in liveCompile liveBaseFilters liveQuery liveQueryBudget liveRoute liveRouteAnswers liveSafetyNet liveUsage liveValues rowPolicyLive; do node scripts/test-$t.js || break; done`.
- [ ] **Step 5: Commit.** `git add src/engine/live src/engine/liveRefusals.ts src/i18n scripts/test-liveCompile.ts scripts/test-liveCalcs.ts` · "Compute Live calculated fields in the warehouse, one derived table per calc a statement needs"

### Task 4: copies carry them as Prepare steps
**Files:** Modify `src/ipc/liveDatasets.ts`:
- remove 00a's `calcRefusal` from `copyLiveDataset` (:201) and `setDatasetMode` (:233);
- the steps list becomes `[...baseFilters, ...calcSteps]`, through step 08's `datasets.updateSteps` and `toExtractRecord(…, steps)`.

Also modify `src/data/liveRecord.ts` (`toExtractRecord` :100 deletes `raw.calculated`). Test: `scripts/test-liveCalcs.ts` § copies.
**Interfaces:** Produces `calcSteps(calcs: readonly LiveCalc[]): CalculatedFieldStep[]` in `src/data/liveCalcs.ts`, each `{ type: 'calculated_field', name, expression }`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const live = await kpi(L, 'Margin', 'max'); const copy = (await post('dataset:copyLive', { projectId: P, datasetId: L })).value;
  ok('Make a copy: its Prepare steps are the base filters then the calcs', show((await metaOf(copy.dataset.id)).steps.map((s: Reply) => s.type)) === show([...BASE.map(() => 'filter'), 'calculated_field', 'calculated_field']));
  ok('…and its figures are Live\'s (max and count, Object.is)', Object.is((await kpi(copy.dataset.id, 'Margin', 'max')).value, live.value) && Object.is((await kpi(copy.dataset.id, 'Band', 'count')).value, (await kpi(L, 'Band', 'count')).value));
  await post('dataset:setMode', { projectId: P, datasetId: L, mode: 'extract' });
  ok('Copy the data instead: same id, the steps, no calculated key', (await metaOf(L)).steps.length === BASE.length + 2 && !('calculated' in (await raw(L))));
  ```
- [ ] **Step 2: Run it to see it fail.** → the copy refuses (00a).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveCalcs.js && node scripts/test-liveCopy.js && node scripts/test-liveBaseFilters.js`.
- [ ] **Step 5: Commit.** `git add src/ipc/liveDatasets.ts src/data/liveRecord.ts src/data/liveCalcs.ts scripts/test-liveCalcs.ts` · "Carry Live calculated fields into copies as Prepare steps"

### Task 5: the parity matrix and the pins
**Files:** Create `scripts/liveParityCalcs.ts`. Modify `scripts/test-liveParity.ts` (one call after `runMatrix`), `scripts/test-liveParityPostgres.ts` (the same, `stride: 4`), and `scripts/liveParityPins.ts` (pin 9).
**Interfaces:** Produces `calcCase(x: Extract, run: (q: CompiledQuery, step: LiveStep) => Promise<LiveRows>, typed: CompileEnv, ok: Ok, opts?: { stride?: number }): Promise<void>`.
- It saves the fixture again as an extract whose Prepare steps are `CALC_STEPS`:
  - `Margin = [amt] - [qty]`,
  - `Margin2 = [Margin] * 2`,
  - `Band = IF [amt] > 100 THEN 'high' ELSEIF [amt] > 10 THEN 'mid' ELSE 'low' END`,
  - `Big = [amt] > 100`,
  - `R1 = round([amt], 1)`,
  - `Yr = year([d])`,
  - `RegionU = upper(trim([region]))`,
  - `Either = coalesce([cat], [region])`.
- It compares that copy with `{ ...typed, source: { ...typed.source, calcs }, columns: [...typed.columns, ...calcColumns(calcs)] }` through `parityKit`.
- [ ] **Step 1: Write the failing test.** The cases:
  - every aggregation over `Margin`, `Margin2`, `R1` and `Yr`;
  - `Band`, `Big`, `RegionU` and `Either` as a text category;
  - bins over `Margin`;
  - every operator in `mx.FILTERS`, moved onto `Band` (text) and `Margin` (number);
  - a split by `Band`;
  - the KPI of each;
  - all of it under step 08's `BASE_P` and under the matrix's row-lock step.
  
  Then the pin and the negative control:
  ```ts
  ok('PIN 9: a text calc whose every value reads as a number is a number on a copy (Prepare types by values) and text on Live', copyType("IF [amt] > 10 THEN '1' ELSE '2' END") === 'number' && liveType(sameCalc) === 'text');
  ok('NEGATIVE CONTROL: Live with Margin as [amt] + [qty] disagrees with the copy', (await kit.chartProblems({ category: 'cat', values: [M('Margin', 'sum')] }, [], wrongEnv)).length > 0);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveParity.js` → `liveParityCalcs` is missing.
- [ ] **Step 3: Implement.** A disagreement is fixed in step 03's builder, or becomes a named pin with its own test. Never loosen the comparison.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveParity.js` green; `node scripts/test-liveParityPostgres.js` skips green without a database (CI runs it).
- [ ] **Step 5: Commit.** `git add scripts/liveParityCalcs.ts scripts/test-liveParity.ts scripts/test-liveParityPostgres.ts scripts/liveParityPins.ts` · "Hold Live calculated fields to the same formulas as Prepare steps in the parity matrix"

### Task 6: who sees what, and the docs
**Files:** Modify:
- `src/ipc/liveProfile.ts`: `LiveSchemaView` (:168) gains `calculated`.
- `src/data/liveCalcs.ts`: `redactCalcs`.
- `src/ipc/modelOverview.ts` (part 1 step 10): a Live dataset's `calculated` is its Live calcs, with the same `valuesHidden` rule.
- `scripts/test-rowPolicySafetyNet.ts`: a calc whose literal is `${H.W_CANARY}_c`.
- `docs/server/live-data.md`: a new "## Calculated fields" section.

**Interfaces:** `LiveSchemaView.calculated: { allowed: boolean; why?: string; fields: { name: string; expression: string; type: LiveCalcType; problem?: string; hidden?: true }[] }`.
- `allowed` is false on Databricks, with `why` set.
- `problem` is `checkCalc`'s sentence against the current declared columns.
- `redactCalcs(fields, closed)` empties `expression` and sets `hidden` when the caller is closed.
- [ ] **Step 1: Write the failing test.**
  - REDACT: `east` reads `Margin`'s name and type but not the canary, in `dataset:liveSchema` and in `model:overview`.
  - NEGATIVE CONTROL: the editor's reply holds the canary.
  - A broken calc shows its `problem`.
- [ ] **Step 2: Run it to see it fail.** `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js` → no `calculated` in the reply.
- [ ] **Step 3: Implement**, and write the docs section: v1's functions, the refused ones and why, Databricks, copies, no value list, and the pins.
- [ ] **Step 4: Run it to see it pass.** `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js && node scripts/test-modelOverview.js && node scripts/test-serverDocs.js`.
- [ ] **Step 5: Commit.** `git add src/ipc/liveProfile.ts src/data/liveCalcs.ts src/ipc/modelOverview.ts scripts/test-rowPolicySafetyNet.ts docs/server/live-data.md` · "Show a Live dataset's calculated fields on its Schema reply, names only to restricted viewers"

### Task 7: the editor
**Files:** Create `web/src/features/data/CalculatedFieldsPanel.tsx` and `web/src/features/data/calculatedFields.test.tsx`. Modify:
- `web/src/features/data/liveApi.ts`: `LiveSchema.calculated`, `useSetCalculated`, `checkLiveCalc`.
- `web/src/features/data/LiveDataset.tsx:66`: the panel under step 08's `BaseFiltersPanel`.
- `web/src/features/prepare/FormulaEditor.tsx` (`ColumnFormulaProps` gains `check?` and `live?`) and `FormulaPieces.tsx` (`FormulaSide` greys a doc with `live === false` and puts `liveWhy` in its title).
- `web/src/features/prepare/api.ts`: `FunctionDoc.live?` and `liveWhy?`.
- `web/src/features/calc/CalcDialog.tsx`: the Column kind is on for a Live dataset when `calculated.allowed`, and saves by appending through `live:setCalculated`.
- `web/e2e/live.e2e.ts`: § 2.
- `CHANGELOG.md`.

**Interfaces:** `CalculatedFieldsPanel({ projectId, datasetId })`, a section "Calculated fields · run in the warehouse".
- Each row shows the name, the expression in mono (or "formula hidden"), and a type badge. A broken row is warn-coloured and shows its `problem`.
- An editor gets "Add calculated field", Edit and Delete, through `useColumnFormula` with `check={checkLiveCalc}` and `live`.
- A viewer reads the list only. On Databricks the panel shows `why` and has no Add button.
- The empty state: "No calculated fields. Add one to compute a column in the warehouse, such as [revenue] - [cost]."
- [ ] **Step 1: Write the failing test.**
  - Add `Margin` sends `live:setCalculated` with the old list plus `Margin`.
  - A refusal shows the server's sentence and its underline, and keeps the dialog open.
  - `len` is greyed with its title.
  - A viewer has no Add; a hidden formula reads "formula hidden"; Databricks shows `why`.
  - e2e: add `[amt] - [qty]` as Margin, see it under Calculated fields, chart it in the builder (the category picker lists it), then `screens(page, 'live-calculated-fields')`. The RPC budget stays ≤ 25.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- calculatedFields` → the module is not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run e2e -- live && npm --prefix web run size && npm run lint` → green, light and dark screens written, initial JS ≤ 300 KB, 0 lint findings.
- [ ] **Step 5: Commit.** `git add web/src/features/data web/src/features/prepare web/src/features/calc web/e2e/live.e2e.ts CHANGELOG.md` · "Add and edit a Live dataset's calculated fields on its Schema tab"

**Existing tests that must stay green:** test-liveCompile, test-liveProfile, test-liveProfileSync, test-liveQuery, test-liveQueryBudget, test-liveRoute, test-liveRouteAnswers, test-liveSafetyNet, test-liveUsage, test-liveValues, test-liveCopy, test-liveDataset, test-liveBaseFilters, test-liveParity, test-rowPolicyLive, test-rowPolicySafetyNet, test-modelOverview, test-lineageColumns, test-formulaSql, test-formulaSqlDiff, test-i18n, test-file-size, check-contracts; web live.test.tsx, livePage.test.tsx, baseFilters.test.tsx, prepare.test.tsx, calc.test.tsx; e2e live, liveTiles.

**Not in this step:** real engines (step 05); profiling calcs for a value list (the first follow-up, D7); delete confirmations that say what a calc feeds (step 08).
