# Semantic layer part 7, step f1: import dbt definitions as a copy — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor uploads dbt's `semantic_manifest.json` (or a small `manifest.json`) to **Import…**, confirms which dataset each semantic model is, and the dry run shows dbt's simple, ratio and derived metrics on one model as Ordinate metrics, with every metric it cannot compute skipped and named; the apply is a3's.
**Architecture:** A pure translator (`src/app/dbtImport.ts`) turns the manifest into a2's `ParsedModel` (keys, field docs, metrics, `timeColumn`, snapshots, filter steps), tagging each metric `importedFrom: { kind: 'dbt', name }` (b0 keeps it on every pod). The plan and apply are a2's and a3's, with one addition: a `datasetMap` input, so the person can say which dataset a semantic model is. No AI anywhere in the mapping: a dbt shape the translator cannot read exactly is skipped, never guessed (anti-goal).
**Tech Stack:** `src/app`, `src/ipc`, `src/api`, React (`web/src/features/model`), self-checks, Vitest.
**Spec:** docs/semantic-layer/07-portability.md (D10, D4, D5; Non-goals; Tests "dbt translation") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-f1-dbt-import` off `origin/develop` after a3 merges. One PR. Release 2. **Merge gate:** b0 is in a deployed release (`git tag -l 'v*' --no-contains <b0 merge sha>` prints nothing), because `importedFrom` is a new stored field.

## dbt's field names are (to verify)

Read from dbt's published `semantic_manifest.json` schema for the dbt version the fixture is built with (Task 1 records the version and links): `semantic_models[].{name, model, defaults.agg_time_dimension, entities[] {name, type, expr}, dimensions[] {name, type, expr, type_params.time_granularity, description, label}, measures[] {name, agg, expr, agg_time_dimension, non_additive_dimension {name, window_choice, window_groupings}}}` and `metrics[].{name, type, type_params {measure, numerator, denominator, expr, metrics[] {name, alias, offset_window, offset_to_grain, filter}}, filter.where_filters[].where_sql_template}`. Any key the fixture's version lacks is not read.

## Global Constraints

- **Input.** One JSON file through `POST /api/files`, read with `parseBounded` (`src/app/jsonBudget.ts:86`, `MAX_JSON_VALUES` 1,000,000) and a 32 MiB cap. A `manifest.json` over either is refused with "Upload target/semantic_manifest.json instead: it holds only the semantic layer." The file kind is told by its content (`semantic_models` and `metrics` present), never its name.
- **Datasets.** A semantic model maps to an existing dataset: `datasetMap[model]` if given, else the exact name, else a case- and underscore-blind name (`orders` ↔ "Orders"), shown as "matched by name: check it". No match → `dataset_missing` with its dependents (a2). Datasets are never created. `datasetMap` (`z.record(z.string().max(256), Uuid).max(500)`) joins `model:importPlan` and `model:importApply` and the plan hash.
- **Mapping (D10), exact shapes only; anything else is skipped with its reason:**
  - primary entity whose `expr` (or name) is a column → table `key`; other entities are not imported.
  - dimension whose `expr` (or name) is a column → field doc (`description`, `label` → `displayName`); a time dimension's column must be a date column.
  - simple metric on a measure with `agg` `sum`, `count`, `average`, `min`, `max` over a plain column → `{ column, aggregation }` (`average` → `avg`); `count_distinct` → `{ column, aggregation: 'countd' }` (part 5's aggregation, `AGGREGATIONS` in `src/data/aggregations.ts`, step 01) once part 5 step 04, its first `countd` writer and the holder of 5A's rollout gate, has merged; before that `skipped: needs_part5`; `sum_boolean`, `median`, `percentile` and unknown aggregations → skipped.
  - measure `agg_time_dimension` (or the model default) → `timeColumn`.
  - `non_additive_dimension` with no `window_groupings` → `snapshot: { column, take: window_choice === 'max' ? 'last' : 'first' }` (part 1 D8 was built to match); with groupings → skipped.
  - metric filters: only `{{ Dimension('<model's entity>__<dim>') }} <op> <literal>` with `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`, `IN (…)`, `NOT IN (…)`, `IS NULL`, `IS NOT NULL`, joined by `AND`, parsed by a closed grammar into part 1 filter steps; any other text → skipped.
  - ratio → formula `[numerator] / [denominator]`; derived → formula from `expr` with `+ − * /` and brackets over its inputs' aliases, each input imported in the same file and on the same semantic model; an input with `offset_window`, `offset_to_grain` or its own filter → skipped.
  - Skipped and named (D10): cumulative, conversion, time offset, cross-model, window groupings, unknown types. f2 (after part 5 step 08; index row 14) later maps the exact shapes of cumulative, conversion, time offset and window groupings onto part 5's kinds; f1 keeps skipping them.
- **Names and ids.** Ordinate name = dbt `label` if present, else `name`. A translated metric's id is a fresh one at apply (a3); matching on a re-import: `importedFrom.name`, then exact name. The dry run says "A copy: dbt stays the source of truth only through a live dbt connection."
- **Same gates as the editor** (a2 Task 4): names unique with terms and metrics, formulas compiled, `timeColumn` and snapshot checked.
- **The figures are proven, not trusted:** a checked-in fixture (`scripts/fixtures/dbt/`: `seed.csv`, `semantic_manifest.json`, `expected.json` from MetricFlow, and `README.md` with the exact `dbt` and `mf query` commands and versions run). MetricFlow runs **offline on a developer machine**, never in CI or at run time (it is Python; not a dependency of Ordinate). If the implementer cannot run it, the owner records `expected.json` once.
- Sentences in `src/app/modelFileMessages.ts`; `node scripts/i18n-extract.js`. No dependency, no migration beyond b0's field.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Every skipped dbt metric is named with its reason**, none silently missing. Task 2.
- **Figures agree with MetricFlow** on the seed, `Object.is`, float divergences pinned by name. Task 3.
- **A re-import updates**, matched by `importedFrom` even after a rename in Ordinate. Task 3.

---

### Task 1: The fixture
**Files:** Create `scripts/fixtures/dbt/seed.csv`, `semantic_manifest.json`, `expected.json`, `README.md`
- [ ] **Step 1:** A dbt-duckdb project (outside the repo) over `seed.csv` (orders: id, customer_id, region, amount, status, order_date, stock_date, units), with one semantic model per table and one metric of each kind: sum, count, average, min, max, count_distinct, a filtered simple metric, ratio, derived, a non-additive balance without groupings, one with groupings, cumulative, conversion, an offset derived metric, a cross-model ratio.
- [ ] **Step 2:** `mf query` each importable metric by total, by `region` and by `metric_time__month`, saving the figures to `expected.json`; record every command and version in `README.md`.
- [ ] **Step 3: Commit.** `git add scripts/fixtures/dbt` · "Add a dbt fixture whose figures MetricFlow computed offline"

### Task 2: The translator
**Files:** Create `src/app/dbtImport.ts`, `src/app/dbtFilter.ts` (the closed filter grammar), `scripts/test-dbtImport.ts`
**Interfaces:** Produces `translateDbt(json: unknown, datasets: Array<{ id: string; name: string; columns: ParsedColumn[] }>, datasetMap: Record<string, string>): { model: ParsedModel; skipped: Array<{ name: string; kind: 'metric' | 'dimension' | 'entity' | 'semanticModel'; reason: DbtSkip }> }`, `type DbtSkip = 'cumulative' | 'conversion' | 'time_offset' | 'cross_model' | 'window_groupings' | 'unknown_aggregation' | 'not_a_column' | 'filter_shape' | 'needs_part5' | 'no_dataset'`; `parseDbtWhere(text: string, entity: string): FilterStep[] | null`.
- [ ] **Step 1: Write the failing test.**
```ts
const { model, skipped } = translateDbt(MANIFEST, DATASETS, {});
ok('a simple sum', isDeepStrictEqual(metricNamed(model, 'Revenue').definition, { column: 'amount', aggregation: 'sum' }));
ok('average becomes avg', metricNamed(model, 'Avg order').definition.aggregation === 'avg');
ok('agg_time_dimension becomes timeColumn', metricNamed(model, 'Revenue').timeColumn === 'order_date');
ok('a non-additive balance becomes a snapshot', isDeepStrictEqual(metricNamed(model, 'Stock').definition.snapshot, { column: 'stock_date', take: 'last' }));
ok('a filtered metric gets filter steps', isDeepStrictEqual(metricNamed(model, 'EU revenue').filters, [{ type: 'filter', column: 'region', op: '=', value: 'EU' }]));
ok('ratio and derived become formulas', metricNamed(model, 'AOV').definition.formula === '[Revenue] / [Orders]' && metricNamed(model, 'Net').definition.formula === '([Revenue] - [Refunds])');
for (const [name, why] of [['Cumulative revenue', 'cumulative'], ['Visit to buy', 'conversion'], ['Revenue vs last year', 'time_offset'], ['Revenue per visit', 'cross_model'], ['Stock by store', 'window_groupings'], ['Median order', 'unknown_aggregation']]) ok(`${name}: skipped, ${why}`, skipped.some((s) => s.name === name && s.reason === why));
ok('every metric in the manifest is either translated or named in skipped', allMetricNames(MANIFEST).every((n) => !!metricNamed(model, n) || skipped.some((s) => s.name === n)));
for (const t of ["{{ Dimension('order__region') }} = 'EU' OR 1=1", "{{ Dimension('order__region') }} LIKE 'E%'", "{{ TimeDimension('order__day', 'month') }} > '2024-01-01'", "lower({{ Dimension('order__region') }}) = 'eu'"]) ok(`filter shape refused: ${t}`, parseDbtWhere(t, 'order') === null);
ok('importedFrom carries the dbt name', metricNamed(model, 'Revenue').importedFrom?.name === 'revenue');
ok('a manifest over the value budget is refused with the sentence', (await readDbtUpload(HUGE)).error === dbtUseSemanticManifest());
```
- [ ] **Step 2–4:** red → implement → `npm run build:ts && node scripts/test-dbtImport.js` green.
- [ ] **Step 5: Commit.** `git add src/app/dbtImport.ts src/app/dbtFilter.ts scripts/test-dbtImport.ts` · "Translate dbt's simple, ratio and derived metrics, naming everything skipped"

### Task 3: Through the plan and apply, and against MetricFlow
**Files:** Modify `src/ipc/modelFiles.ts` (a JSON upload goes to `translateDbt`, then `planImport`/`applyImport`), `src/api/model.ts` (`datasetMap` on both inputs), `src/app/modelPlan.ts` (a2: `datasetMap`, the dbt source line, `importedFrom` matching, `SkipReason` gains the `DbtSkip` members), `src/app/modelApply.ts` (a3: writes `importedFrom`) · Test `scripts/test-dbtImport.ts` (§ route, § figures)
- [ ] **Step 1: Write the failing test.**
```ts
const plan = await post('model:importPlan', { projectId: P, fileToken: await uploadJson(MANIFEST) });
ok('the dry run lists the skipped dbt metrics with reasons', plan.plan.items.filter((i) => i.status === 'skipped').length === EXPECTED_SKIPS);
ok('a semantic model matched loosely is marked for checking', plan.plan.items.find((i) => i.kind === 'dataset' && i.name === 'orders')!.changes?.[0].field === 'matchedByName');
const done = await post('model:importApply', { projectId: P, fileToken: await uploadJson(MANIFEST), planHash: plan.plan.hash });
for (const [metric, group, want] of EXPECTED) ok(`${metric} by ${group || 'total'}: equals MetricFlow (Object.is)`, Object.is(await figure(P, metric, group), want) || PINNED.has(`${metric}:${group}`));
await post('metric:update', { projectId: P, id: idOf('Revenue'), patch: { name: 'Revenue (net)' } });
const again = await post('model:importPlan', { projectId: P, fileToken: await uploadJson(MANIFEST) });
ok('a re-import matches by importedFrom after a rename', itemFor(again, 'revenue').targetId === idOf('Revenue (net)') && itemFor(again, 'revenue').status !== 'new');
ok('datasetMap points a model at another dataset, and moves the hash', (await planWithMap({ orders: OTHER })).hash !== plan.plan.hash);
```
- [ ] **Step 2–4:** red → implement → `node scripts/test-dbtImport.js && node scripts/test-modelPlan.js && node scripts/test-modelApply.js && node scripts/check-contracts.js` green.
- [ ] **Step 5: Commit.** `git add src/ipc/modelFiles.ts src/api/model.ts src/app scripts/test-dbtImport.ts` · "Import dbt definitions through the model files merge, held to MetricFlow's figures"

### Task 4: The dialog takes a dbt file
**Files:** Modify `web/src/features/model/ImportDialog.tsx` (a3: accept `.json`; a "Datasets" section with a select per semantic model; the copy notice), `web/src/features/model/importDialog.test.tsx`, `docs/server/model-files.md` (a "From dbt" section with the mapping table and what is skipped), `CHANGELOG.md`
- [ ] **Step 1: Write the failing test.** Picking a `.json` uploads it; the Datasets section shows `orders → Orders (matched by name: check it)`; changing the select re-plans with `datasetMap`; skipped dbt metrics are listed with their reasons in words; the copy notice shows.
- [ ] **Step 2–4:** red → implement → `npm run test:web && npm run build:web && npm run lint` green.
- [ ] **Step 5: Commit.** `git add web/src/features/model docs/server/model-files.md CHANGELOG.md` · "Let Import take dbt's semantic manifest, with the datasets confirmed"

**Before the PR:** `npm test`, `npm run test:web`, `npm run lint`; check the merge gate with `git tag`.
