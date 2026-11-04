# Semantic layer part 7, step b1: the engine asks a semantic layer (IR, plan, door, fake bench) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Live engine can answer a chart, a KPI and an answer from a semantic layer instead of SQL: the IR names a layer metric, one neutral plan turns an IR into the questions D16 allows ("Other" is a second question, never a sum), the one warehouse door carries that question (slotted, counted, timed out, cancelled, shared in flight), and a test-only fake layer over DuckDB proves the plan and the shaping agree with the extract path under `Object.is`. No record, connector or screen yet.
**Architecture:** `LiveMeasure` gains `{ metric }` (D12). A neutral `SemanticQuery` (dimensions with a grain, metric names, filters, order, limit, an exclusion list) is what every backend later encodes. `evaluateSemantic` (new, beside `evaluateLive`) builds those questions and reads the answers back into the exact row layout `shapeChart`/`shapeMetric` already label (`o_g`, `o_s`, `o_cr`, `o_sr`, `o_m{i}v`, `o_nc`), so labels still come from `analysis/categoryKey`. `warehouse()` takes a `SemanticRequest` beside a `CompiledQuery` and sends it through a new `runSemanticBound`, the twin of `runLiveBound`. `ConnectorDef` gains an optional `semantic` capability (D14), typed here, implemented by c1/e1/d1.
**Tech Stack:** `src/engine/live/`, `src/connectors/`, self-checks.
**Spec:** docs/semantic-layer/07-portability.md (D12, D14, D15, D16, D17, D18; Tests "Layer parity", "Refusals and guards") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-b1-semantic-engine` off `origin/develop` after b0 merges. One PR. Release 1 (it stores nothing).

## Global Constraints

- **The IR.** `LiveMeasure = { column: string; aggregation: LiveAgg } | { metric: string }` (`src/engine/live/liveSpec.ts:65`), `isMetricMeasure(m)`. The relational compiler refuses a metric measure (`metricOnTable`) in `prepare` (`src/engine/live/compile.ts:127`), and the semantic plan refuses a column measure (`columnOnLayer`): aggregating a dimension ourselves goes around the layer (D12, my call in the spec). `Part` gains `'v'` (a layer's value): `partsOf({ metric })` is `['v']`, `measureValue` returns `parts.v`, `measureName` returns the metric name (b2 relabels series with the Ordinate metric's name).
- **The neutral question** (my call): `interface SemanticQuery { dimensions: Array<{ name: string; grain?: DateGrain }>; metrics: string[]; where: SemanticFilter[]; order: Array<{ by: string; desc: boolean }>; limit?: number; exclude?: { dimension: string; values: Cell[] } }`, with `SemanticFilter` = `LiveFilter` minus `latest` and minus `binary`. Answers come back as `{ columns: string[]; rows: unknown[][] }` named by layer member; the backend adapter maps them to positions.
- **What a layer can answer (D16), refused typed otherwise:** a text axis (top 50 by the first measure, then `exclude` the 50 and ask once more for "Other" only when a 51st came back); a date axis at a grain the layer lists for that dimension (no automatic grain: `autoGrain`; a retail week calendar rolled up from days: `weekRollup`; `day` is fine); a split (one question for category ranks, one for series ranks, one for the cells of the kept categories, and "Other" by series when needed: up to four, each counted); a KPI (no dimension); an answer's ranked top N. Refused: number bins (`bins`), a non-additive table calculation (`nonAdditiveCalc`, via part 1 step 02's check, which reads `additive` from the synced list in b2), a formula metric over a layer metric (`formulaOverLayer`, b2), a lock step (`binary: true`, the row lock) unless the backend declares `binaryCompare` (`layerRowPolicy`, D17), the latest-date and spelling lookups when the backend lacks `lookups` (`layerLookup`).
- **Refusals name the layer.** New codes join `LiveRefusalCode` with sentences in a new `src/engine/live/semantic/semanticRefusals.ts` (`refuseLayer(code, { dataset, layer, metric? })`), so `liveSpec.ts`'s `MESSAGES` (one-parameter sentences) is untouched: `MESSAGES` becomes `Record<Exclude<LiveRefusalCode, LayerRefusalCode>, Sentence>`. The existing row-needing codes (`pivot`, `cohort`, `funnel`, `drivers`, `facet`, `map`, `raw`, `related`) keep their code on a semantic dataset and take a layer-naming sentence (`liveRefusals.layer_pivot`, …), e.g. "A pivot table can't be drawn from {dataset}: {layer} computes its metrics and returns totals, not rows."
- **One door (D18).** `warehouse(t, query: CompiledQuery | SemanticRequest, shared)` (`src/engine/live/liveWarehouse.ts:109`): the same slot, daily count, timeout, signal, `noteCall` and logging. The semantic branch calls `runSemanticBound(def, values, secrets, request, opts)` (new `src/connectors/semanticRun.ts`: `guardHost`, `safeError` with the secrets, `LIVE_ROW_LIMIT`, `costTag 'live'`). `test-liveUsage`'s one-door scan holds both functions to `warehouse()`.
- `SemanticRequest = { kind: 'semantic'; body: unknown; columns: readonly string[] }`: `body` is what the backend sends; `columns` are the layer member names the rows must come back with.
- `ConnectorSemantic` (typed here, `src/connectors/types.ts:238` beside `live`): `{ backend: SemanticBackendId; caps: { lookups: boolean; binaryCompare: boolean }; listModels(ctx): Promise<{ ok: true; models: Array<{ name: string; label?: string; description?: string }> } | ConnectorError>; describeModel(ctx, model: string): Promise<{ ok: true; dimensions: Array<{ name: string; type: ColumnType; grains?: DateGrain[] }>; metrics: Array<{ name: string; additive: boolean; description?: string }> } | ConnectorError>; run(ctx, body: unknown): Promise<ConnectorRows | ConnectorError> }`. `type SemanticBackendId = string` (`/^[a-z][a-z0-9-]{0,31}$/`; the shipped ones are `snowflake`, `cube`, `dbt`, and the tests' `fake`), with `layerLabel(id)` giving Snowflake, Cube, dbt, or the label a test adapter registers, else "another tool". `run` is called only by `runSemanticBound`.
- **No JS fallback (live D7).** Correctness rests on the parity suite: the fake layer answers by running, in DuckDB, the SQL the fixture's metric definitions expand to. It proves our plan and shaping, not a vendor's math.
- Files: `liveSpec.ts` 457 and `compile.ts` 455 grow by a few lines each (the type, the refusal, the `Part`); everything else is new under `src/engine/live/semantic/`. `shape.ts` 341 takes the `'v'` part only.
- No dependency, no migration, no stored field, no contract. Sentences through `t()` (`semanticRefusals.ts` in `MAIN_FILES`), then `node scripts/i18n-extract.js`.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **"Other" is the layer's.** With 60 categories and a ratio-like metric (an average), the "Other" figure equals the extract's "Other" (a true average over those rows), and it came from a question, never a sum of returned rows. Negative control: summing the returned rows' averages gives a different number. Task 3.
- **Ranks come from the answers' order, then a tie-break by key**, never the order rows arrived in (`shape.ts:215-221` says why). Task 3.
- **Counted.** A chart with "Other" is two counted statements; a split with "Other" four. Task 4.
- **Plain Live is unchanged.** `test-liveParity` and its goldens are byte-identical; a `{ metric }` reaching the relational compiler refuses. Task 1.

---

### Task 1: `{ metric }` in the IR, and the refusals
**Files:** Modify `src/engine/live/liveSpec.ts` (`LiveMeasure` l.65, `LiveRefusalCode` l.121, `MESSAGES` l.149), `src/engine/live/compile.ts` (`Part`, `partsOf` l.75-86, `prepare` l.127), `src/engine/live/shape.ts` (`emptyParts`, `measureValue` l.93, `measureName` l.104) · Create `src/engine/live/semantic/semanticRefusals.ts`, `scripts/test-semanticPlan.ts` · Modify `scripts/i18n-extract.ts:346`
**Interfaces:** Produces `isMetricMeasure(m: LiveMeasure): m is { metric: string }`; `type LayerRefusalCode = 'bins' | 'weekRollup' | 'autoGrain' | 'nonAdditiveCalc' | 'formulaOverLayer' | 'columnOnLayer' | 'metricOnTable' | 'metricMissing' | 'layerRowPolicy' | 'layerLookup' | 'layerFilter'` (`layerFilter`: a filter the layer's API cannot express, with the column's name; e1 and d1 raise it); `refuseLayer(code: LayerRefusalCode | 'pivot' | 'cohort' | 'funnel' | 'drivers' | 'facet' | 'map' | 'raw' | 'related', p: { dataset: string; layer: string; metric?: string; column?: string }): LiveRefusal`.
- [ ] **Step 1: Write the failing test.**
```ts
const ir = { kind: 'metric', measures: [{ metric: 'revenue' }], filters: [], order: 'natural', weekCal: null } as LiveIR;
ok('the relational compiler refuses a metric measure', !compileMetric(ir, ENV).ok && (compileMetric(ir, ENV) as LiveRefusal).code === 'metricOnTable');
ok('a metric measure reads its one part', measureValue({ metric: 'revenue' }, { s: null, c: null, n: null, x: null, v: 12 }) === 12);
const r = refuseLayer('pivot', { dataset: 'Sales', layer: 'Snowflake' });
ok('a row-needing refusal keeps its code and names the layer', r.code === 'pivot' && r.message === 'A pivot table can\'t be drawn from Sales: Snowflake computes its metrics and returns totals, not rows.');
ok('metricMissing names the metric and the layer', refuseLayer('metricMissing', { dataset: 'Sales', layer: 'dbt', metric: 'Revenue' }).message === 'Revenue is no longer defined in dbt.');
ok('NEGATIVE CONTROL: plain refusals are byte-identical', refuse('pivot').message === livePivotRefused());
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` → `isMetricMeasure` missing.
- [ ] **Step 3: Implement.** Every `LiveMeasure` reader `tsc` names narrows with `isMetricMeasure`; relational paths refuse.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-semanticPlan.js && node scripts/test-liveCompile.js && node scripts/test-liveParity.js && node scripts/i18n-extract.js && node scripts/test-i18n.js` → all `ok`; `test-liveParity` unchanged.
- [ ] **Step 5: Commit.** `git add src/engine/live scripts/i18n-extract.ts src/i18n scripts/test-semanticPlan.ts` · "Let the Live IR name a layer metric, and refuse it on a table"

### Task 2: The plan: IR → semantic questions
**Files:** Create `src/engine/live/semantic/semanticQuery.ts` (types), `src/engine/live/semantic/semanticPlan.ts` · Test `scripts/test-semanticPlan.ts`
**Interfaces:** Produces `SemanticQuery`, `SemanticFilter`, `interface SemanticEnv { dataset: string; layer: string; columns: LiveColumn[]; metrics: ReadonlyMap<string, { additive: boolean }>; grains: ReadonlyMap<string, readonly DateGrain[]>; caps: { lookups: boolean; binaryCompare: boolean } }`; `planChart(ir: LiveIR, env: SemanticEnv): { ok: true; ranks: SemanticQuery; seriesRanks?: SemanticQuery; cells?: (kept: Cell[]) => SemanticQuery; other: (kept: Cell[]) => SemanticQuery } | LiveRefusal` and `planMetric(ir, env)`, `planLatest(ir, env)`, each refusing per Global Constraints. A metric not in `env.metrics` → `metricMissing`.
- [ ] **Step 1: Write the failing test.** One `ok` per rule: a text axis → `ranks` is `{ dimensions: [{ name: 'region' }], metrics: ['revenue'], order: [{ by: 'revenue', desc: true }, { by: 'region', desc: false }], limit: 51 }`; a date axis with `grain: 'month'` listed → no limit, ordered by the dimension; with no grain → `autoGrain`; with a grain the layer lacks → `autoGrain`; with `weekCal` and `month` → `weekRollup`, with `weekCal` and `day` → planned; bins → `bins`; a `binary: true` filter → `layerRowPolicy`, and planned when `caps.binaryCompare`; an `in` filter becomes a `SemanticFilter` verbatim; `other(kept)` carries `exclude: { dimension: 'region', values: kept }` and no `limit`; a column measure → `columnOnLayer`; an unknown metric → `metricMissing`; `planLatest` without `caps.lookups` → `layerLookup`.
- [ ] **Step 2: Run it to see it fail.** → `planChart` missing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-semanticPlan.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/engine/live/semantic scripts/test-semanticPlan.ts` · "Plan the questions a semantic layer can answer, refusing what needs our arithmetic"

### Task 3: `evaluateSemantic`, the fake layer, and parity with the extract
**Files:** Create `src/engine/live/semantic/evaluateSemantic.ts`, `scripts/semanticFake.ts` (test-only: the fake backend over DuckDB, registered with `registerTestConnector` as `semantic-fake`, never listed), `scripts/test-semanticParity.ts` (on `scripts/liveParityFixture.ts`'s seed)
**Interfaces:** Produces `type SemanticRunner = (q: SemanticQuery, step: LiveStep | 'other' | 'seriesRanks') => Promise<{ columns: string[]; rows: unknown[][] }>`; `evaluateSemantic(ir: LiveIR, env: SemanticEnv, run: SemanticRunner): Promise<LiveOutcome>` (the same `LiveOutcome` as `evaluateLive`, `src/engine/live/evaluate.ts:111`). It resolves `latest` periods through `planLatest` + `resolvePeriods` (`evaluate.ts:57`), runs the plan, assigns `o_cr`/`o_sr` from each answer's row order (ties broken by key), appends the "Other" row under `OTHER_LABEL` with `o_nc = CATEGORY_CAP + 1`, and hands a synthetic `{ sql: '', params: [], columns }` to `shapeChart`/`shapeMetric`. A date dimension's value (an ISO date or timestamp at the grain's start) becomes the numeric bucket key `shapeChart`'s `gregorianBucketLabel` reads. `semanticFake` exports `FAKE_METRICS = { revenue: 'SUM(amount)', orders: 'COUNT(*)', avg_amount: 'AVG(amount)', max_amount: 'MAX(amount)' }` (additive: the first two) and `runFake(table, q): Promise<{ columns; rows }>`, which compiles a `SemanticQuery` to DuckDB SQL (test code, values bound) and runs it.
- [ ] **Step 1: Write the failing test.** The seed is loaded as an extract with Ordinate metrics equal to `FAKE_METRICS` and as the fake layer's table. For each case ask the extract door (`vizDataFor` / `computeCardMetric` / `computeCard`) and `evaluateSemantic` with `runFake`:
```ts
for (const c of MATRIX) { // text 60 categories × {revenue, orders, avg_amount, max_amount}; date × {day, month, quarter, year}; split by region; filters =, !=, in, not in, range, empty, contains; KPI; answer top 5
  const a = await extract(c); const b = await semantic(c);
  ok(`${c.name}: labels equal`, JSON.stringify(a.labels) === JSON.stringify(b.labels));
  ok(`${c.name}: every cell Object.is (sum/avg within the pinned 1e-13 only)`, cellsAgree(a, b, PINS));
  ok(`${c.name}: the Other note matches`, JSON.stringify(a.category) === JSON.stringify(b.category));
}
ok('"Other" was asked, not summed: a question with exclude of the 50', otherAsked(fakeLog, 'avg_amount'));
ok('NEGATIVE CONTROL: summing the returned rows\' averages would differ', sumOfAverages(fakeLog) !== otherValue('avg_amount'));
ok('NEGATIVE CONTROL: a broken exclude (keep 49) fails the Other cell', !cellsAgree(await extract(TEXT60), await semantic(TEXT60, { breakExclude: true }), PINS));
ok('order comes from ranks, not arrival: reversed rows shape the same', JSON.stringify(await semantic(TEXT60, { reverseRows: true })) === JSON.stringify(await semantic(TEXT60)));
```
- [ ] **Step 2: Run it to see it fail.** → `evaluateSemantic` missing.
- [ ] **Step 3: Implement.** Divergences are pinned by name in the suite's `PINS`, never by loosening the comparison.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-semanticParity.js && node scripts/test-liveParity.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/engine/live/semantic scripts/semanticFake.ts scripts/test-semanticParity.ts` · "Answer charts and KPIs from a semantic layer, held to the extract by Object.is"

### Task 4: One door for every layer question
**Files:** Modify `src/engine/live/liveWarehouse.ts:109-157`, `src/connectors/types.ts` (`ConnectorSemantic`, `ConnectorDef.semantic?`), `scripts/test-liveUsage.ts` (§ one door, l.360-380) · Create `src/connectors/semanticRun.ts` · Test `scripts/test-liveUsage.ts`, `scripts/test-semanticParity.ts` (§ door)
**Interfaces:** Produces `SemanticRequest`; `runSemanticBound(def: ConnectorDef, values: Record<string, unknown>, secrets: Record<string, string>, req: SemanticRequest, opts: LiveRunOpts): Promise<ConnectorRows | ConnectorError>` (no `semantic` → "This source cannot answer semantic-layer questions."); `warehouse` returns `LiveRows` for SQL and the rows reordered to `req.columns` for a semantic request (a missing column → `rowShape`).
- [ ] **Step 1: Write the failing test.**
```ts
ok('one door: runSemanticBound is called once in src/, from warehouse()', calls('runSemanticBound').size === 1 && calls('runSemanticBound').get('src/engine/live/liveWarehouse.ts') === 1);
ok('NEGATIVE CONTROL: a planted caller is found', scanWith('src/engine/live/semantic/x.ts', 'runSemanticBound(d, v, s, r, o)').size === 2);
const t = fakeSemanticTarget(); await lq.warehouse(t, REQ, new AbortController().signal);
ok('a semantic request is counted like a statement', (await usageRow()).queries === q0 + 1);
ok('a hang-up while queued sends nothing', (await queuedThenAbort(t, REQ)).sent === false);
ok('the timeout aborts the layer call', (await slowFake(t, REQ)).kind === 'timeout');
ok('a layer error reaches the log, never the reply', logged(/fake layer said: secret-x/) && !JSON.stringify(reply).includes('secret-x'));
```
- [ ] **Step 2: Run it to see it fail.** → `warehouse` rejects a non-SQL query.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveUsage.js && node scripts/test-liveQuery.js && node scripts/test-semanticParity.js && npm run lint` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/engine/live/liveWarehouse.ts src/connectors/types.ts src/connectors/semanticRun.ts scripts/test-liveUsage.ts scripts/test-semanticParity.ts` · "Send semantic-layer questions through the one Live door"

**Before the PR:** `npm test`, `npm run lint`, `node scripts/test-file-size.js`.
