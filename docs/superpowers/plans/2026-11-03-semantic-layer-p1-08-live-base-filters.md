# Semantic layer part 1, step 08: Live base filters — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Live dataset's always-applied filters reach every statement Ordinate sends for it, so a Live table answers exactly what a copy with the same Prepare filter steps answers.
**Architecture:** The steps are stored on the dataset record and adapted once per question in `liveTarget` into `CompileEnv.base`; each statement builder in `src/engine/live/` (the compiler's six through `whereOf`, the profile through `sampledFrom`) ANDs them in, and the executor's cache key carries them. A copy made from the dataset gets them as Prepare filter steps. A guard PR (08a) ships first, so a pod that cannot apply them refuses instead of ignoring them.
**Tech Stack:** `src/data/liveDataset.ts`, `src/engine/live/*`, `src/ipc/`, `src/api/live.ts`, `web/src/features/data/`, self-checks on the fake warehouse (`LIVE_FAKE_ID`), the Live parity matrix.
**Spec:** docs/semantic-layer/00-design.md (D13; Constraints "Live", "Contracts", "Sentences") · docs/live-data/00-plan.md (D4, D5, D6) · Index: docs/superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md
**Branch and PR:** two PRs. **08a** `feat/semantic-p1-08a-base-filter-guard` off `origin/develop` at the HEAD of the chain (it depends on nothing; merge it before step 01). **08** `feat/semantic-p1-08-live-base-filters` off `origin/develop` after step 07 merges.

## Global Constraints
- Values only as bound parameters (`ParamSink.bind`); identifiers only from declared columns (live-data D4).
- With no base filters every statement is byte-identical to today, SQL and params: `test-liveCompile`, `test-liveProfile`, `test-liveParity` stay green untouched.
- A base filter never skips. A step that cannot be applied refuses the question (`live_refused`, reason `baseFilter`), as a row lock does (`liveSpec.ts:235`, `:422`).
- Plain `filter` steps only: no terms, no `lock`, no `context`, no `within_km`. At most `MAX_BASE_FILTERS = 20` steps, `values` ≤ 1,000 per step.
- A change bumps `live.epoch` in the same record write (live-data D5).
- `src/data/datasets.ts` is 799 lines (cap 800): not touched. `compile.ts` 455, `liveSpec.ts` 452, `liveQuery.ts` 406, `app.ts` 644: one-line edits only; new code in new files.
- Sentences through `t()` in `src/engine/liveRefusals.ts` and `src/data/liveMessages.ts` (both in `MAIN_FILES`), then `node scripts/i18n-extract.js`.

## Old pods (rolling deploy and rollback)
**Where it is stored:** `baseFilters` at the TOP LEVEL of the dataset record JSON, beside `rowPolicy`, not inside `live`. Every Live writer that exists today (`bumpEpoch`, `setMaxCacheAge`, `writeSchemaSync`, `stampSyncAttempt`, the last two run by the scheduler) rebuilds `raw.live` from `sanitizeLive` and would erase a key inside it. `serialized` (`datasetRecord.ts:256`) leaves other top-level keys alone, and bundles copy the raw file. In memory `applyLive` reads it into `meta.live.baseFilters`. `sanitizeLive` never reads it, so no writer copies it into `raw.live`.
- **Pod older than 08a:** drops it on read and answers WITHOUT it, which is the correctness risk. Its metadata writers keep the key. Its "Make a copy" and "Copy the data instead" make extracts without it.
- **08a pod:** reads it and refuses every Live question, schema sync, copy and switch to extract on that dataset, with a typed sentence. It is loud for the length of the rollout (16 s measured on kind, `docs/server/upgrade.md`) and never wrong.
- **08 pod:** applies it.
- **Why this is enough:** 08a merges first and is in every `:edge` image built during steps 01–07, so every rollout onto 08 starts from pods that refuse. An old pod's cached answers live in its own memory only, and new pods never read them (the epoch and `base` are in the key). **The residual risk:** an upgrade from an image older than 08a straight to 08, or a `helm rollback` past 08a while a Live dataset has base filters, answers unfiltered from those pods for as long as they serve. Task 6 writes this, and the remedy (clear the filters before rolling back past 08a), into `docs/server/upgrade.md`'s limits list and the release note.

## Statement inventory: every statement Ordinate sends for a Live dataset
| # | Builder (today) | Called from | Carries the base filters through |
|---|---|---|---|
| 1 | `compileMetric` compile.ts:175 | evaluate.ts:129 | `whereOf` |
| 2 | `compileLatestDates` compile.ts:205 | evaluate.ts:117 | `whereOf`: the anchor narrows, as a copy's rows do |
| 3 | `compileBinRange` compile.ts:228 | evaluate.ts:91 | `whereOf` |
| 4 | `compileGrainProbe` compile.ts:243 | evaluate.ts:99 | `whereOf` |
| 5 | `compileChart` compile.ts:311 | evaluate.ts:138 | `whereOf` |
| 6 | `compileCaseMatches` compile.ts:437 | ipc/liveAnswers.ts:94 (`liveLookup`) | `whereOf` (its lock is AND-ed after) |
| 7 | `compileProfile` profileSql.ts:138 | schemaSync.ts:147, priced first by `estimateLive` :152 (the same SQL) | `sampledFrom` |
| 8 | `compileSamplingKeyProbe` profileSql.ts:181 | schemaSync.ts:199 | exempt: it reads `system.tables`, no rows |
| 9 | `readLiveSchema` ipc/liveDatasets.ts:71 (`describeTable`, `explainSql`) | create, schemaSync.ts:306 | exempt: column names and types only |
| 10 | `fetchSelection` ipc/liveDatasets.ts:154 (`runConnection`) | `copyLiveDataset` :190, `setDatasetMode` → extract :251 | the extract gets them as Prepare filter steps (D13's rule for copies; the import door binds no values) |
| 11 | `compileKeyCheck` (step 01, appended to compile.ts) | `runKeyCheck` in `src/ipc/tableDocs.ts`, through `liveLookup` (step 01) | its `FROM ${p.from}` gains `whereOf(p, probe)`: the key is checked over the rows a copy would keep |

Line numbers are develop's on 2026-11-03; steps 01–07 shift some of them, and step 01 adds #11.

Value pickers send no statement. `dataset:distinct` → `liveDistinct` (ipc/liveProfile.ts:113) and published controls (publish/dashboardData.ts:224) read the profile (#7). A change queues a schema sync so the list is sampled again.

## Review Focus
- A base filter on a column the warehouse dropped. Every question refuses `baseFilter`, while the sync still syncs columns (sample refused, typed). → Task 3
- A relative-period base filter ("last 2 years") must move at midnight: the resolved range is in the cache key. → Task 3
- The stale fallback must never serve an answer computed under other base filters. → Task 3
- An answer's data-relative period ("last quarter") must be anchored after the base filter. → Task 5 (parity)
- A table wider than `PROFILE_MAX_COLUMNS` (500) whose base column is past the cap. → Tasks 2, 3
- A selective base filter that empties the sample must not be stored as "every column empty". → Task 3
- "Make a copy" and "Copy the data instead" must not silently widen the numbers. → Task 4
- A row-restricted viewer must get no filter values from `dataset:liveSchema` (REDACT). → Task 6

---

### Task 0 (PR 08a): a pod that cannot apply base filters refuses
**Files:** Create `src/data/liveBaseFilters.ts`, `scripts/test-liveBaseFilters.ts`. Modify `src/data/liveDataset.ts` (`LiveSettings` :31–44, `applyLive` :179–189), `src/engine/live/liveSpec.ts` (`LiveRefusalCode` :120–125, `MESSAGES` :148–178), `src/engine/liveRefusals.ts` (append), `src/engine/live/liveTarget.ts` (:77–92), `src/ipc/liveDatasets.ts` (`copyLiveDataset` :190, `setDatasetMode` :251), `scripts/test-liveCompile.ts:273` (add `'baseFilter'` to `all`).
**Interfaces:** Produces `MAX_BASE_FILTERS = 20`, `sanitizeBaseFilters(raw: unknown): FilterStep[]` (rebuilt as `{type, column, op, value?, values?, period?}`; drops non-filter steps, `within_km`, `lock`, `context` and any other key; caps at 20), `LiveSettings.baseFilters?: FilterStep[]` (in memory only), refusal code `'baseFilter'` with `param: 'column'`, and `liveBaseFilterRefused(column: string): string` in liveRefusals.ts, worded in 08a as "This dataset's always-applied filters can't be applied by this server, so it answers nothing. Ask your admin to finish upgrading Ordinate."
- [ ] **Step 1: Write the failing test.** `scripts/test-liveBaseFilters.ts` uses `./liveRouteHarness` (`H.setupOrg(ORG_A)` → `P`, `L`), `BASE = [F('region', 'not in', undefined, { values: ['North', CANARY] })]`, `CANARY = 'zz-base-7c41'`, and plants with `serialized(datasetFilePath(P, L), (raw) => { raw.baseFilters = BASE; })`.
  ```ts
  ok('sanitize keeps plain filter steps only', show(sanitizeBaseFilters([{ ...F('region', '!=', 'x'), context: true, lock: true }, { type: 'term', term: ID }, F('lat', 'within_km'), 7]))
    === show([{ type: 'filter', column: 'region', op: '!=', value: 'x' }]));
  ok('sanitize caps at 20', sanitizeBaseFilters(Array(25).fill(F('region', '!=', 'x'))).length === 20);
  ok('meta.live.baseFilters is read from the top-level key', show((await meta()).live.baseFilters) === show(BASE));
  for (const [name, write] of WRITERS) // bumpEpoch, setMaxCacheAge(60), stampSyncAttempt, writeSchemaSync (live.ts exports)
    ok(`${name} keeps raw.baseFilters and never writes it into raw.live`, show((await raw()).baseFilters) === show(BASE) && !('baseFilters' in (await raw()).live));
  // § guard (08a). Task 3 replaces this section.
  for (const [label, call] of DOORS) { // visual:data, dashboard:metric, answer:card, syncLiveSchema
    const before = fake.calls.length; const r = await call();
    ok(`08a guard: ${label} refuses typed (baseFilter), no warehouse call`, r.ok === false && r.code === 'live_refused' && r.reason === 'baseFilter' && fake.calls.length === before, show(r));
  }
  ok('08a guard: Make a copy refuses and saves nothing', !(await post('dataset:copyLive', { projectId: P, datasetId: L })).value.ok && (await count()) === n0);
  ok('08a guard: Copy the data instead refuses; the record stays Live', !(await post('dataset:setMode', { projectId: P, datasetId: L, mode: 'extract' })).value.ok && isLive(await meta()));
  ok('NEGATIVE CONTROL: the same doors on a Live dataset without base filters answer', (await chartOn(L2)).ok === true);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveBaseFilters.js`: tsc fails on the missing `sanitizeBaseFilters` export.
- [ ] **Step 3: Implement.** `applyLive` sets `live.baseFilters` only when `sanitizeBaseFilters(data.baseFilters)` is non-empty. In `liveTarget`, right after the `isLive` check: `if (meta.live.baseFilters?.length) return { ok: false, kind: 'refused', refusal: refuse('baseFilter', meta.live.baseFilters[0].column) }`. `copyLiveDataset` and `setDatasetMode` (extract branch) return `{ ok: false, code: 'live_refused', reason: 'baseFilter', error }` before `fetchSelection`. Then run `node scripts/i18n-extract.js` and copy the generated key into `MESSAGES`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveBaseFilters.js && node scripts/test-liveCompile.js && node scripts/test-liveDataset.js && node scripts/test-liveSafetyNet.js && node scripts/test-i18n.js`, all green; `npm run lint` reports 0.
- [ ] **Step 5: Commit.** `git add src/data/liveBaseFilters.ts src/data/liveDataset.ts src/engine/live/liveSpec.ts src/engine/liveRefusals.ts src/engine/live/liveTarget.ts src/ipc/liveDatasets.ts src/i18n scripts/test-liveBaseFilters.ts scripts/test-liveCompile.ts` with the message "Refuse Live questions on a dataset whose base filters this pod cannot apply".

### Task 1: the write, and the adapter every builder shares
**Files:** Create `src/engine/live/liveBase.ts`. Modify `src/data/liveDataset.ts` (append `setBaseFilters` after `setMaxCacheAge` :220). Test: `scripts/test-liveBaseFilters.ts` § record.
**Interfaces:** Consumes `sanitizeBaseFilters`, `adaptFilter` (liveSpec.ts:227). Produces `setBaseFilters(projectId: string, id: string, steps: FilterStep[]): Promise<LiveSettings | false>` (one `serialized` write: `raw.baseFilters = steps`, or delete it when `[]`, plus `raw.live = { ...sanitizeLive(raw), epoch: epoch + 1 }`; false when not Live), and `liveBaseOf(steps: readonly FilterStep[] | undefined, columns: LiveColumn[], opts?: AdaptOpts): { ok: true; base: LiveFilter[] } | LiveRefusal`, where a skip (`null`) refuses `baseFilter` with the step's column and a refusal passes through.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const e0 = (await meta()).live.epoch;
  ok('setBaseFilters writes the top-level key and bumps the epoch once', (await setBaseFilters(P, L, BASE)) && show((await raw()).baseFilters) === show(BASE) && (await meta()).live.epoch === e0 + 1);
  ok('[] deletes the key (and bumps again)', (await setBaseFilters(P, L, [])) && !('baseFilters' in (await raw())) && (await meta()).live.epoch === e0 + 2);
  ok('refused on an extract', (await setBaseFilters(P, X, BASE)) === false);
  const cols = H.fx.COLUMNS;
  ok('liveBaseOf adapts', show(liveBaseOf(BASE, cols)) === show({ ok: true, base: [{ kind: 'in', column: 'region', values: ['North', CANARY], negate: true }] }));
  for (const [label, s] of [['unknown column', F('gone', '=', 1)], ['empty in-list', F('region', 'in', undefined, { values: [] })], ['period on text', F('region', 'period', undefined, { period: { preset: 'ytd' } })]])
    ok(`a base filter never skips: ${label} refuses`, !liveBaseOf([s], cols).ok);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveBaseFilters.js`: `setBaseFilters` is not a function.
- [ ] **Step 3: Implement** both functions as specified.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveBaseFilters.js` (record section green).
- [ ] **Step 5: Commit.** `git add src/data/liveDataset.ts src/engine/live/liveBase.ts scripts/test-liveBaseFilters.ts` with the message "Store a Live dataset's base filters and adapt them for the compiler".

### Task 2: every builder ANDs `env.base` in
**Files:** Modify `src/engine/live/compile.ts` (`CompileEnv` :57–62, `Prepared` :89–92, `prepare` :143, `whereOf` :146–154, the comment at :206, and step 01's `compileKeyCheck`, which gains `whereOf`), `src/engine/live/compileFilter.ts` (append), and `src/engine/live/profileSql.ts` (`sampledFrom` :95–111, `compileProfile` :144–151). Test: `scripts/test-liveBaseFilters.ts` § compile (pure).
**Interfaces:** Produces `CompileEnv.base?: LiveFilter[]`; `basePredicates(c: Ctx, base: readonly LiveFilter[] | undefined): string[] | LiveRefusal` in compileFilter.ts; and `profiledColumns(columns: LiveColumn[], base: readonly LiveFilter[] | undefined): LiveColumn[]` in profileSql.ts, which puts base columns first and keeps at most `PROFILE_MAX_COLUMNS`. When `base` is non-empty, the profile's FROM becomes `(SELECT <cols> FROM (SELECT <cols> FROM <table> <clause>) AS lv_src WHERE <base> LIMIT n) AS lv_src` for a table, and `(SELECT <cols> FROM (\n<sql>\n) AS lv_src WHERE <base> LIMIT n) AS lv_src` for a query: the engine samples, then the rows are filtered and capped. With no base the text is today's.
- [ ] **Step 1: Write the failing test.** Over `fx.env({ kind: 'table', parts: ['t'] })` and every `CompileDialectId`:
  ```ts
  const bound = (q: CompiledQuery) => q.params.some((p) => p.value === CANARY);
  for (const [name, build] of BUILDERS) { // the seven compile.ts builders (with step 01's compileKeyCheck) + compileProfile, each with an IR that reaches it
    ok(`${name} (${d}): carries the base filter`, bound(build({ ...env, base })));
    ok(`${name} (${d}): byte-identical without one`, show(build({ ...env, base: [] })) === show(build(env)));
  }
  ok('NEGATIVE CONTROL: the canary check sees a statement without the base', !bound(compileMetric(ir, env).query));
  ok('the latest-date anchor is narrowed by the base, as a lock narrows it', bound(compileLatestDates(latestIr, { ...env, base }).query));
  ok('profile: a base column outside env.columns refuses (unknownColumn)', compileProfile({ ...env, columns: env.columns.slice(0, 1), base }, plan).ok === false);
  const wide = Array.from({ length: 501 }, (_, i) => ({ name: `c${i}`, type: 'text' as const }));
  ok('profiledColumns keeps a base column past the 500 cap', profiledColumns(wide, [{ kind: 'empty', column: 'c500', negate: true }]).some((c) => c.name === 'c500') && profiledColumns(wide, []).length === 500);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveBaseFilters.js`: the compile section fails (no base in the SQL).
- [ ] **Step 3: Implement.** `prepare` sets `Prepared.base = env.base ?? []`. `whereOf` builds predicates for `[...p.base, ...ir.filters]`. `sampledFrom(c, src, plan, base)` takes the shape above, with predicates from `basePredicates`. Update compile.ts:206's comment: "a row lock and the dataset's base filters narrow the anchor".
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveBaseFilters.js && node scripts/test-liveCompile.js && node scripts/test-liveProfile.js && node scripts/test-liveParity.js`, all green.
- [ ] **Step 5: Commit.** `git add src/engine/live/compile.ts src/engine/live/compileFilter.ts src/engine/live/profileSql.ts scripts/test-liveBaseFilters.ts` with the message "AND a Live dataset's base filters into every compiled statement".

### Task 3: the executor sends them (the inventory test)
**Files:** Modify `src/engine/live/liveTarget.ts` (replace the 08a refusal), `src/engine/live/liveQuery.ts:237` (the key), `src/engine/live/schemaSync.ts` (:192–193 env and columns, :215 retry, :294 target), `src/engine/liveRefusals.ts` (rewrite the sentence). Test: `scripts/test-liveBaseFilters.ts` § doors (replaces § guard).
**Interfaces:** Produces `liveTarget(projectId, datasetId, opts?: { base?: 'skip' })`. By default it runs `liveBaseOf(meta.live.baseFilters, columns)`, a refusal becomes `{ kind: 'refused' }`, and a non-empty result sets `env.base`. It also produces `LiveTarget.baseFilters: FilterStep[]` (the stored steps). The `ask` key becomes `{ ir, source, dialect, base: t.env.base }`; `stableStringify` drops `undefined`, so keys without base are unchanged. The schema sync calls `liveTarget(…, { base: 'skip' })` and runs `liveBaseOf(t.baseFilters, next)` against the NEW columns; a refusal is a typed sample outcome (`live_refused`, reason `baseFilter`) and the columns still sync. It profiles `profiledColumns(next, base)`. A 0-row sample is retried LIMIT-only when `plan.percent !== undefined || base.length > 0`. The sentence becomes "The always-applied filter on “{column}” can't be applied any more, so this dataset answers nothing until an editor changes it."
- [ ] **Step 1: Write the failing test.** Plant `BASE` with `setBaseFilters`, then for each entry point record `fake.calls` from a mark:
  ```ts
  const DOORS = [ // label, call, the statement kinds it must send
    ['text chart', () => post('visual:data', { projectId: P, datasetId: L, encoding: { category: 'cat', values: [M('amt', 'sum')] } }), 1],
    ['number chart (bin range + chart)', () => post('visual:data', { …, encoding: { category: 'qty', values: [M('amt', 'sum')] } }), 2],
    ['date chart (grain probe + chart)', () => post('visual:data', { …, encoding: { category: 'd', values: [M('amt', 'sum')] } }), 2],
    ['KPI', () => post('dashboard:metric', { projectId: P, datasetId: L, column: 'qty', aggregation: 'sum' }), 1],
    ['answer (case fix + latest + chart)', () => post('answer:card', { projectId: P, spec: { datasetId: L, category: 'cat', measures: [M('amt', 'sum')], filters: [{ column: 'region', op: 'in', values: ['south'] }, { column: 'd', period: 'last_year' }], chartType: 'bar', title: 't' } }), 3],
    ['schema sync (profile)', () => H.as(ORG_A, () => sync.syncLiveSchema(P, L)), 1],
  ];
  for (const [label, call, n] of DOORS) { queryCache.clear(); const from = fake.calls.length; const r = await call();
    const sent = fake.calls.slice(from);
    ok(`${label}: answers, and every one of its ${n} statements binds the base filter`, okReply(r) && sent.length === n && sent.every((c) => c.params.some((p) => p.value === CANARY)), show(sent.map((c) => c.sql))); }
  ok('NEGATIVE CONTROL: the same doors on Live L2 (no base filters) bind no canary', …);
  // Source scan, the test-liveUsage pattern: every `.finish(` outside sqlParams.ts is a statement builder.
  ok('inventory: the builders are exactly compile.ts ×7 and profileSql.ts ×2', show([...finishers(srcFiles())]) === show([['src/engine/live/compile.ts', 7], ['src/engine/live/profileSql.ts', 2]]));
  ok('inventory NEGATIVE CONTROL: a planted builder is found', finishers(planted('src/engine/live/keyCheckSql.ts', 'return b.finish(sql, d, []);')).has('src/engine/live/keyCheckSql.ts'));
  ok('a dropped base column: every door refuses baseFilter; the sync still syncs columns', …); // drop `region` from live_typed, sync, ask
  ok('a period base filter: the resolved range is in the key (ORDINATE_TODAY moved → a new warehouse call)', …);
  ok('a base change with the warehouse down: live_failed, never the stale answer from before the change', …); // fake.hook fails after setBaseFilters
  ok('a base that matches no sampled row: retried LIMIT-only, never stored as every column empty', …);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveBaseFilters.js`: the doors still refuse (08a guard).
- [ ] **Step 3: Implement** as in Interfaces. Add a DOORS row for step 01's `catalog:checkKey` (one statement, binds the canary). Any other builder the scan finds gets `env.base` and a row before this task is done.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveBaseFilters.js && for t in liveQuery liveQueryBudget liveRoute liveRouteAnswers liveSafetyNet liveUsage liveValues liveProfileSync rowPolicyLive; do node scripts/test-$t.js || break; done`, all green.
- [ ] **Step 5: Commit.** `git add src/engine/live/liveTarget.ts src/engine/live/liveQuery.ts src/engine/live/schemaSync.ts src/engine/liveRefusals.ts src/i18n scripts/test-liveBaseFilters.ts` with the message "Send a Live dataset's base filters with every statement and key the cache on them".

### Task 4: copies keep the filters as Prepare steps
**Files:** Modify `src/ipc/liveDatasets.ts` (`copyLiveDataset` :190–217, `setDatasetMode` :251–256; remove the 08a refusals) and `src/data/liveRecord.ts` (`toExtractRecord` :110–132). Test: `scripts/test-liveBaseFilters.ts` § copies.
**Interfaces:** Produces `toExtractRecord(projectId, id, table, steps: FilterStep[] = [])`. When `steps` is non-empty it writes `source: table`, `steps`, and the output of `applyPipelineAsync(table, steps)` (`./regexOffThread`) in ONE `persist`. `copyLiveDataset` runs `datasets.updateSteps(projectId, saved.id, base)` after the save, and on null deletes the copy and answers `liveCopySaveFailedMessage()`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const live = await kpi(L, 'qty', 'count');
  const copy = (await post('dataset:copyLive', { projectId: P, datasetId: L })).value;
  ok('Make a copy: the copy carries the base filters as its Prepare steps', show((await metaOf(copy.dataset.id)).steps) === show(BASE));
  ok('…and its KPI is the Live KPI (Object.is)', Object.is((await kpi(copy.dataset.id, 'qty', 'count')).value, live.value));
  await post('dataset:setMode', { projectId: P, datasetId: L, mode: 'extract' });
  ok('Copy the data instead: same id, the steps, the same KPI, no baseFilters key left', show((await metaOf(L)).steps) === show(BASE) && Object.is((await kpi(L, 'qty', 'count')).value, live.value) && !('baseFilters' in (await raw())));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveBaseFilters.js`: the copy's `steps` is `[]`.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveBaseFilters.js && node scripts/test-liveCopy.js && node scripts/test-liveDataset.js`, all green.
- [ ] **Step 5: Commit.** `git add src/ipc/liveDatasets.ts src/data/liveRecord.ts scripts/test-liveBaseFilters.ts` with the message "Carry a Live dataset's base filters into its copies as Prepare steps".

### Task 5: the parity case
**Files:** Create `scripts/liveParityBase.ts`. Modify `scripts/test-liveParity.ts` (one call after `runMatrix`) and `scripts/test-liveParityPostgres.ts` (the same call, CI's Postgres).
**Interfaces:** Consumes `parityKit`, `Extract`, `MatrixReport.envs.typed` (liveParityMatrix.ts) and `liveBaseOf`. Produces `baseFilterCase(x: Extract, run: (q: CompiledQuery, step: LiveStep) => Promise<LiveRows>, typed: CompileEnv, ok: Ok): Promise<void>`. It saves the fixture again as an extract, applies `BASE_P` as its Prepare steps (`datasets.updateSteps`), and compares it with `{ ...typed, base: liveBaseOf(BASE_P, typed.columns).base }`.
- [ ] **Step 1: Write the failing test.** Use `BASE_P = [F('region', 'not in', undefined, { values: ['North'] }), F('amt', '>=', 10), F('d', 'period', undefined, { period: { preset: 'custom', from: '2024-01-01', to: '2024-12-31' } })]`.
  ```ts
  for (const enc of [{ category: 'cat', values: [M('amt', 'sum'), M('qty', 'count')] }, { category: 'd', grain: 'month', values: [M('amt', 'avg')] }, { category: 'amt', values: [M('qty', 'sum')] }])
    ok(`base parity: ${show(enc)}`, (p = await kit.chartProblems(enc, [], env)).length === 0, p.join(' | '));
  for (const m of [M('amt', 'sum'), M('bigid', 'count')]) ok(`base parity KPI ${m.aggregation}(${m.column})`, (await kit.metricProblems(m, [], env)).length === 0);
  ok('base parity: an answer "last quarter" is anchored after the base (2024-Q4 on both)', (await kit.answerProblems({ datasetId: x.did, category: 'region', measures: [M('amt', 'sum')], filters: [{ column: 'd', period: 'last_quarter' }], chartType: 'bar', title: 't' }, env)).length === 0);
  ok('NEGATIVE CONTROL: the same live questions without `base` disagree with the filtered copy', (await kit.chartProblems(encs[0], [], typed)).length > 0);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveParity.js`: `liveParityBase` does not exist yet.
- [ ] **Step 3: Implement** `baseFilterCase`; pass the copy's own `did` and stored rows into `parityKit` (as test-liveParity.ts:74 does for its raw copy).
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveParity.js`, green; `node scripts/test-liveParityPostgres.js` skips green without a database.
- [ ] **Step 5: Commit.** `git add scripts/liveParityBase.ts scripts/test-liveParity.ts scripts/test-liveParityPostgres.ts` with the message "Hold a base-filtered Live table to a Prepare-filtered copy in the parity matrix".

### Task 6: `live:setBaseFilters`, the Schema reply, the docs
**Files:** Create `src/ipc/liveBaseFilters.ts`. Modify `src/api/live.ts` (append the contract), `src/server/app.ts:633` (one register line), `src/ipc/liveProfile.ts` (`LiveSchemaView` :169–181, `schemaView` :185–220), `src/data/liveBaseFilters.ts` (`redactBaseFilters`), `src/data/liveMessages.ts` (two sentences), `docs/server/live-data.md` (a new "## Always-applied filters" section), `docs/server/upgrade.md:97–106` (the residual risk). Test: `scripts/test-liveBaseFilters.ts` § channel.
**Interfaces:** The contract `'live:setBaseFilters': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, filters: z.array(BaseFilterStep).max(20) }), project: byProjectId })`, where `BaseFilterStep = z.strictObject({ type: z.literal('filter'), column: z.string().min(1).max(1_000), op: z.string().max(40), value: Cell.optional(), values: z.array(Cell).max(1_000).optional(), period: z.unknown().optional() })` and `Cell` comes from `./datasets`. Produces `setLiveBaseFilters(p): Promise<{ ok: true; baseFilters: FilterStep[]; epoch: number } | { ok: false; code: 'not_live' | 'live_refused'; reason?: string; error: string }>`: not Live → `liveBaseFiltersNotLive()`; a step the sanitizer drops → `liveBaseFilterInvalid()`; `liveBaseOf` refuses → its sentence. Then `setBaseFilters`, `queryCache.invalidateDataset`, `announceRefreshed`, and a queued `startSchemaSync` (lazy require, as `queueSync` :111 does). Also `LiveSchemaView.baseFilters: FilterStep[]`, set to `redactBaseFilters(steps, await closedToCaller(projectId, datasetId))`. The pure `redactBaseFilters(steps: FilterStep[], closed: boolean): FilterStep[]` lives in `src/data/liveBaseFilters.ts` and keeps `{ type, column, op }` only when `closed`, the rule REDACT readers follow (`scripts/rowPolicyReaders.ts:62`).
- [ ] **Step 1: Write the failing test.**
  ```ts
  const set = (filters: unknown[]) => post('live:setBaseFilters', { projectId: P, datasetId: L, filters });
  ok('saves, bumps the epoch, re-asks the warehouse on the next chart', (await set(BASE)).value.ok === true && (await chartCalls()) > 0);
  ok('refused on an extract (not_live), on a within_km step and on an empty in-list, each in a sentence', …);
  ok('a term step is a 400 at the contract', (await set([{ type: 'term', term: ID }])).status === 400);
  ok('dataset:liveSchema returns the steps', show((await post('dataset:liveSchema', { projectId: P, datasetId: L })).value.baseFilters) === show(BASE));
  ok('REDACT: a restricted caller gets column and operator, no value', show(redactBaseFilters(BASE, true)) === show([{ type: 'filter', column: 'region', op: 'not in' }]) && show(redactBaseFilters(BASE, false)) === show(BASE));
  // The test-liveCopy.ts:100–103 pattern: authz.authorize over a one-rank grant table.
  ok('access: a project viewer may not set them; an editor may', !(await decide(VIEWER, 'live:setBaseFilters', 1)).ok && (await decide(EDITOR, 'live:setBaseFilters', 2)).ok);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveBaseFilters.js`: 404, since there is no contract yet.
- [ ] **Step 3: Implement.** Then run `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveBaseFilters.js && node scripts/check-contracts.js && node scripts/test-rowPolicySafetyNet.js && node scripts/test-i18n.js && node scripts/test-serverDocs.js`: green, 0 unresolved.
- [ ] **Step 5: Commit.** `git add src/ipc/liveBaseFilters.ts src/api/live.ts src/server/app.ts src/ipc/liveProfile.ts src/data/liveBaseFilters.ts src/data/liveMessages.ts src/i18n docs/server/live-data.md docs/server/upgrade.md scripts/test-liveBaseFilters.ts` with the message "Add live:setBaseFilters and show a Live dataset's base filters on its Schema reply".

### Task 7: the editor on the Live dataset page
**Files:** Create `web/src/features/data/BaseFiltersPanel.tsx` and `web/src/features/data/baseFilters.test.tsx`. Modify `web/src/features/data/liveApi.ts` (`LiveSchema` :38–50, plus `useSetBaseFilters`), `web/src/features/data/LiveDataset.tsx:66` (render the panel above `<SchemaPanel>`), `web/src/features/visuals/filters/FilterRows.tsx:25–37` (prop `lod?: boolean`, default `true`, passed as `lodToggle={lod}` at :79), and `web/e2e/live.e2e.ts` (§ 2).
**Interfaces:** Consumes `useLiveSchema`, `FilterRows`, `FilterSummary`, `useCanEdit`. Produces `BaseFiltersPanel({ projectId, datasetId }: { projectId: string; datasetId: string })`, a section labelled "Always applied" with the lead "Every chart, KPI, answer and value list on this dataset leaves out the rows these filters exclude. A copy keeps them as Prepare steps." An editor gets `FilterRows lod={false}` plus Save and Cancel while dirty. A viewer gets `FilterSummary` lines. The empty state reads "No always-applied filters. Add one to keep rows such as test accounts or void orders out of every figure." It also produces `useSetBaseFilters(projectId, datasetId)`, which calls `live:setBaseFilters` through `useLiveWrite` (refetching `AFTER`) and toasts the server's sentence on `ok: false`.
- [ ] **Step 1: Write the failing test** (`baseFilters.test.tsx`, mocked rpc as in `livePage.test.tsx`):
  ```tsx
  it('an editor removes a filter and saves the rest', async () => { /* liveSchema.baseFilters = [A, B]; remove A; Save */ expect(rpcCalls('live:setBaseFilters')[0]).toEqual({ projectId: P, datasetId: D, filters: [B] }); });
  it('a refusal shows the server’s sentence and keeps the edit', …);
  it('a viewer reads the filters and gets no Add filter and no Save', …);
  it('empty: the designed empty state, not a blank panel', …);
  ```
  In e2e § 2, after Sync schema: add `region` ≠ `North` through Add filter and the condition dialog, Save, Sync schema, then wait for `Profiled from 180 rows`; North is gone from the region row; `screens(page, 'live-base-filters')`.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- baseFilters`: the module is not found.
- [ ] **Step 3: Implement** the panel and the hook.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run e2e -- live && npm --prefix web run size && npm run lint`: green, the light and dark screens written, initial JS ≤ 300 KB, 0 lint findings.
- [ ] **Step 5: Commit.** `git add web/src/features/data/BaseFiltersPanel.tsx web/src/features/data/baseFilters.test.tsx web/src/features/data/liveApi.ts web/src/features/data/LiveDataset.tsx web/src/features/visuals/filters/FilterRows.tsx web/e2e/live.e2e.ts` with the message "Edit a Live dataset's always-applied filters on its Schema tab".

**Existing tests that must stay green:** test-liveCompile, test-liveProfile, test-liveProfileSync, test-liveQuery, test-liveQueryBudget, test-liveRoute, test-liveRouteAnswers, test-liveSafetyNet, test-liveUsage, test-liveValues, test-liveCopy, test-liveDataset, test-liveParity, test-rowPolicyLive, test-rowPolicySafetyNet, test-i18n, test-file-size, check-contracts; web live.test.tsx, livePage.test.tsx, liveBuilder.test.tsx; e2e live, liveTiles.
