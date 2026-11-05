# Semantic layer part 5, step 04: offer "Count distinct" everywhere an aggregation is picked — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People, the Assistant and agents can pick a distinct count: the chart, KPI, metric and Prepare group pickers offer "Count distinct", a metric formula takes `countd(col)`, the Assistant reads "unique customers", and MCP tools accept `countd`. This is part 5's first writer.
**Architecture:** The contracts and the pickers read the one list step 01 made (`src/data/aggregations.ts`; the web keeps its own copy, as it does today). `metricFormula`'s token rewrite (`rewriteAggregations`, `src/analysis/metricFormula.ts:98-140`) already folds `fn(col)` into an aggregate operand for any name in its list, so adding `countd` to the list is the change.
**Tech Stack:** zod contracts (`src/api`), `src/analysis`, `src/ai`, `src/automation`, React (`web/src/features`), Vitest, Playwright.
**Spec:** docs/semantic-layer/05-metrics-depth.md (D1 "offered wherever an aggregation is", D3 "the editor suggests count", build step 4) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p5-00-index.md
**Branch and PR:** `feat/semantic-p5-04-countd-editors` off `origin/develop` after step 03 merges. **Merge gate: release 5A (step 01) has rolled out on every pod** (`git tag --contains <01's merge commit>` names a release the owner says is everywhere). Release 5B.

## Rolling deploy

The writes this PR enables are `countd` in a metric definition, a chart measure, a pivot value, a KPI card, an alert rule, a stored answer spec, a Prepare group step and a metric formula string. A 5A pod keeps each (step 01) and shows no figure or a sentence for it; a pod older than 5A turns the first six into `sum` or drops them, which is why the gate holds. A formula string `countd(col)` is kept verbatim by any pod; an older pod's formula compile does not know it and gives no figure (step 01 pins it), never a wrong one. A browser tab from before this PR keeps a stored `countd` through a save (its select holds the value it was given).

## Global Constraints

- The Prepare **pivot** step and its form never offer `countd` (`src/data/stepsSanitize.ts:21`, `web/src/features/prepare/FormsReshape.tsx:50`); key drivers (`DriversPage.tsx:23`), rebuild (`RebuildTile.tsx:35`, `rebuildPlan.ts:66`) and maps (`publish/sanitize.ts:39`) do not either. They read `PLAIN_AGGREGATIONS`, and say nothing.
- Label everywhere: **"Count distinct"**. Words in sentences (`metricFormat.ts` `AGG_WORDS`): "count distinct of customer_id".
- The React UI is English-only; server sentences through `t()`. No new contract, so `scripts/rowPolicyReaders.ts` is untouched; `node scripts/check-contracts.js` 0 unresolved.
- `web/src/features/analyses/metrics/MetricEditor.tsx` is 297 lines: the key hint is a new component in `metrics/parts.tsx` (89) or its own file.
- One e2e per screen, RPC budget 25. Initial JS ≤ 300 KB gzip.
- Commits carry no Co-Authored-By or AI trailer. "Exported as `count_distinct`" (D1) is part 7's export; nothing here writes that name.

## Review Focus

- **The Assistant must not call a distinct count additive.** `answers.ts:187` and `liveAnswers.ts:185` test `sum || count`; `countd` stays out (step 02 classified them `countOnly`). Pinned in Task 2.
- **A model saying "count"** still means `count`. Only "count distinct", "distinct", "unique" and `countd` map to `countd`. Pinned in Task 2.
- **The key hint reads the table doc a restricted viewer may not see.** It needs only `key` and `keyCheck.repeatedKeys`, which part 1's `readableTableDoc` strips for a restricted caller; with no `keyCheck` there is no hint. Pinned in Task 3.

---

### Task 1: Contracts, formulas and words

**Files:** Modify `src/api/metrics.ts:12` (`z.enum(AGGREGATIONS)`), `src/api/visuals.ts:47` (`z.enum([...AGGREGATIONS, 'none'])`), `src/api/analyses.ts:25`, `src/analysis/metricFormula.ts:46` and `src/analysis/userTemplateRefs.ts:54` (`AGGREGATIONS`), `src/analysis/metricFormat.ts` (`AGG_WORDS`: `countd: 'count distinct'`). Test: create `scripts/test-countdWriters.ts` (harness: `scripts/test-snapshotReader.ts:10-40` plus `handlers`).
**Interfaces:** No new names. `compileMetricFormula('countd(customer_id)', cols).program.aggregates[0]` is `{ column: 'customer_id', aggregation: 'countd' }`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  ok('contract: a countd metric', api.metrics['metric:save'].input.safeParse({ projectId: P, input: { name: 'C', datasetId: D, definition: { column: 'customer_id', aggregation: 'countd' } } }).success);
  ok('contract: a countd chart measure', api.visuals['visual:data'].input.safeParse({ projectId: P, datasetId: D, encoding: { category: 'day', values: [{ column: 'customer_id', aggregation: 'countd' }] } }).success);
  ok('NEGATIVE CONTROL: median is still refused', !api.metrics['metric:save'].input.safeParse({ ..., definition: { column: 'x', aggregation: 'median' } }).success);
  const cust = (await post('metric:save', { projectId: P, input: { name: 'Customers', datasetId: D, definition: { column: 'customer_id', aggregation: 'countd' } } })).value.metric;
  const per = (await post('metric:save', { projectId: P, input: { name: 'Orders per customer', datasetId: D, definition: { formula: 'count(order_id) / countd(customer_id)' } } })).value.metric;
  ok('countd(col) in a formula is the distinct count', Object.is((await kpi(per)), (await kpi(orders)) / (await kpi(cust))));
  ok('[Customers] in a formula is the same figure', Object.is(await kpi(await saveFormula('[Customers] * 1')), await kpi(cust)));
  ok('words', describeDefinition(cust) === 'count distinct of customer_id');
  ok('a formula over countd is not additive', !additivityOf(per, COLS, byName).categories);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-countdWriters.js` → "contract: a countd metric" fails.
- [ ] **Step 3: Implement** as listed. Update `src/analysis/templates.ts:40`'s "NO COUNT-DISTINCT" note: a template may still not name one (its picker is plain); say why.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-countdWriters.js scripts/test-metrics.js scripts/test-metricCheck.js scripts/test-metricMeasures.js scripts/check-contracts.js scripts/test-aggregationList.js`.
- [ ] **Step 5: Commit.** `git add src/api src/analysis scripts/test-countdWriters.ts && git commit -m "Accept a distinct count in the contracts and in metric formulas"`

### Task 2: The Assistant and agents

**Files:** Modify `src/ai/answerSpec.ts:149-155` (`AGG_ALIASES`) and `:384` (the measure's words), `src/ai/prompts.ts:52,94` (add `countd` to the group and visual lists; **not** `:61`, the pivot step), `src/automation/registry.ts:137` (the enum), then `node scripts/gen-automation-docs.js` (commit `docs/automation.md`). Test: `scripts/test-answerSpec.ts`, `scripts/test-countdWriters.ts` section "agents".
**Interfaces:** `AGG_ALIASES` gains `countd`, `count_distinct`, `'count distinct'`, `distinct`, `unique` → `'countd'`. `:384` gives `distinct ${m.column}` for `countd`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  for (const said of ['countd', 'count distinct', 'distinct', 'unique', 'COUNT_DISTINCT'])
    ok(`"${said}" is a distinct count`, validateAnswerSpec({ dataset: DS.name, category: 'region', measures: [{ column: 'customer_id', aggregation: said }] }, [DS], {}).spec.measures[0].aggregation === 'countd');
  ok('NEGATIVE CONTROL: "count" is a count', validateAnswerSpec({ ..., measures: [{ column: 'customer_id', aggregation: 'count' }] }, [DS], {}).spec.measures[0].aggregation === 'count');
  const card = await answers.computeCard(P, SPEC_COUNTD_BY_REGION);
  ok('an answer card computes it, and never says the regions add up', card.ok && Object.is(card.data.series[0].values[0], refRegion0) && !/in total|add up/.test(card.facts ?? ''));
  ok('MCP create_visual takes it', registry.find((t) => t.name === 'create_visual')!.input.properties.values.items.properties.aggregation.enum.includes('countd'));
  ```
  The facts field name is `computeCard`'s (`answers.ts`), as `scripts/test-answerSpec.ts` reads it.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-answerSpec.js scripts/test-countdWriters.js` → "countd" reads as an unknown aggregation.
- [ ] **Step 3: Implement** as listed.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-answerSpec.js scripts/test-countdWriters.js scripts/test-liveRouteAnswers.js scripts/test-pluginSkills.js scripts/test-automation.js scripts/test-automationTools.js` (`test-automation` checks `docs/automation.md`).
- [ ] **Step 5: Commit.** `git add src/ai src/automation docs/automation.md scripts && git commit -m "Let the Assistant and agents ask for a distinct count"`

### Task 3: The pickers, and the key hint

**Files:** Modify `web/src/features/visuals/model.ts:15-16` (`AGGS`, `AGG_LABELS.countd = 'Count distinct'`), `web/src/features/analyses/metrics/MetricEditor.tsx:33,230`, `web/src/features/analyses/editor/AddKpi.tsx:24,148`, `web/src/features/assistant/PlanEdit.tsx:20`, `web/src/features/explore/spec.ts:34`, `web/src/features/prepare/steps.ts:42` (split into `GROUP_FNS` with `countd`, used by `FormsBasic.tsx:38`, and `PIVOT_FNS` without, used by `FormsReshape.tsx:50`). Create `web/src/features/analyses/metrics/KeyHint.tsx` (+ test). Extend `web/e2e/analyses.e2e.ts` (the "metrics" test, `:299-339`).
**Interfaces:** `KeyHint({ projectId, datasetId, column, aggregation, onUseCount })`: shown when `aggregation === 'countd'` and part 1's table doc (`catalog:getTable`) has `key === column` and `keyCheck.repeatedKeys === 0`; text `Each ${column} appears once, so Count gives the same number.` and a button **Use Count** that calls `onUseCount()`. It never changes the aggregation itself.
- [ ] **Step 1: Write the failing tests.** Vitest: the chart measure select lists "Count distinct" and choosing it puts `aggregation: 'countd'` in the encoding; the Prepare group form lists it and the pivot form does not; `decodeQuestion(encodeQuestion({ ...Q, values: [{ column: 'c', aggregation: 'countd' }] }))` keeps it; `KeyHint` with a stubbed `catalog:getTable` reply `{ key: 'customer_id', keyCheck: { repeatedKeys: 0 } }` shows the sentence, its button calls `onUseCount`; with `repeatedKeys: 3`, or with no `keyCheck` (a restricted viewer), it renders nothing (NEGATIVE CONTROL). e2e, in the metrics test: pick "Count distinct" for a text column and wait for the preview's `count distinct of …` words.
- [ ] **Step 2: Run them to see them fail.** `npm run test:web -- model FormsBasic spec KeyHint` → no "Count distinct" option.
- [ ] **Step 3: Implement** with the existing `Select`/`PickSelect` and CSS-module tokens; no new styles beyond the hint's muted line.
- [ ] **Step 4: Run them to see them pass.** `npm run test:web && npm run build:web && npm --prefix web run e2e -- analyses && npm --prefix web run size && npm run lint`. Look at `web/e2e/__screens__/metrics-editor*` in both themes.
- [ ] **Step 5: Commit.** `git add web/src web/e2e && git commit -m "Offer Count distinct in every aggregation picker, and suggest Count for a key with no repeats"`

## Existing tests that must stay green

`test-metrics`, `test-metricCheck`, `test-metricMeasures`, `test-answerSpec`, `test-answerRefine`, `test-liveRouteAnswers`, `test-countDistinct`, `test-countSites`, `test-aggregationList`, `test-pluginSkills`, `check-contracts`, `npm run test:web`, the `analyses` e2e, `npm run lint`. CHANGELOG `[Unreleased]`: "Count distinct", in every aggregation picker and as `countd(col)` in metric formulas.
