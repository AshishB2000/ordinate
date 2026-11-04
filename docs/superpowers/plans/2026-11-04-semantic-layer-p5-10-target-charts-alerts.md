# Semantic layer part 5, step 10: targets on charts and in alerts — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chart of a metric with a target draws the target as a stepped line (D14): per bucket on its own date axis, per category through the plan's same-named column. An alert can fire when a metric falls below or rises above a share of its target, edge-triggered like a threshold, and an alert whose metric was deleted says so in the inbox.
**Architecture:** Both reuse step 09's resolver. On a chart, one more reply step (`withTargetSeries`, `src/ipc/targetSeries.ts`) runs after the compare series in the `visual:data` handler and adds a `role: 'overlay'` series marked `target: true`, which every overlay-aware reader already skips (`tableCalc.ts:276`, `chartShapes.ts:60`, `analytics.ts:413`, `sharePolicy.ts:310`, `copilotFacts.ts:283`, `answerFacts.ts:260`, `subscriptionMessage.ts:130`); the web draws it as a stepped line. An alert with `compare: 'target'` (kept since step 01) evaluates through `metricFor` → `resolveMetric` and `metricTarget`.
**Tech Stack:** `src/ipc`, `src/analysis`, React (`web/src/charts`, `web/src/features/dashboards`), self-checks, Vitest, Playwright.
**Spec:** docs/semantic-layer/05-metrics-depth.md (D14 chart and alert bullets; "Left to the builder": the wire shape of target series) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p5-00-index.md
**Branch and PR:** `feat/semantic-p5-10-target-charts-alerts` off `origin/develop` after step 09 merges. Release 5B.

## Rolling deploy

New writes: alert rules with `compare: 'target'` and `targetPct` (step 01 keeps them on a 5A pod and skips them, state untouched). The reply fields (`series[].target`, a rule's `metricGone`) are never stored. A browser from before this PR draws a target series as an ordinary muted overlay, which is safe.

## Global Constraints

- **The wire shape (my call):** `{ name: 'Target', values: (number | null)[], role: 'overlay', target: true }`, one per chart, aligned to the reply's labels. A label with no target is null. No new reply key besides `target: true` on the series, and `notes` (part 1's 05b field) for why there is none.
- **Which charts:** a chart whose drawn measure is one metric with a target (`values[0]`, no series split, no facets, no pivot); anything else gets no target series and no note.
  - Date axis on the metric's date: each label's bucket range (step 06's `bucketRange`) ∩ the chart's scope, through `metricTarget`; at most 24 labels, else no series and the note `targetSeriesTooLong()`.
  - Any other axis: the plan metric charted by the **plan's column of the same name** (`vizDataFor` on the plan's dataset), with step 09's segment and row-rule checks and pro-rating (`planAsks`: ≤ 3 chart calls, combined per label by their fractions). No such column → no series and the note `targetPlanNoColumn(column)`.
- `src/ipc/visuals.ts` gets **no net line**: `withTargetSeries` is re-exported from `./visualsOverlay`, whose import line (`:16`) gains the name, and `:644` wraps the compare call.
- **Alerts:** `breached = value != null && target != null && (op === 'below' ? value < target × pct / 100 : value > target × pct / 100)`; fire on the edge into breach, re-arm on the way out, exactly as `thresholdBreached` does (`alerts.ts:517-522`); no target (`none`) is "not breached" and records nothing new beyond `lastEvaluatedAt`.
- Sentences: `src/analysis/targetMessages.ts` and `src/analysis/alerts.ts` (both in `MAIN_FILES`), then `node scripts/i18n-extract.js`. `src/analysis/alerts.ts` is ~635 after step 01: ≤ 25 lines here.
- Commits carry no Co-Authored-By or AI trailer.

## Review Focus

- **Published pages and stories draw no target series**, as they draw no period overlay today (`dashboardData.ts:458` calls `vizDataFor` directly). Tiles on `/p/` carry the target (step 09). Flagged, not fixed.
- **A target series must never feed a total.** The overlay role is what every reader skips; Task 1 pins `tableCalc` and the Assistant's facts.
- **An alert on a deleted metric** stops evaluating (step 05's `skip`) and the inbox says why. Pinned in Task 2.

---

### Task 1: The target series

**Files:** Create `src/ipc/targetSeries.ts`. Modify `src/ipc/visualsOverlay.ts` (re-export), `src/ipc/visuals.ts:16,644` (in place), `src/ipc/targetResolve.ts` (export the checked plan context step 09 builds: `targetPlan(projectId, m, scope)`), `src/analysis/vizData.ts:36-37` (the series type gains `target?: true`), `src/analysis/targetMessages.ts`, `web/src/charts/types.ts:34` (`target?: boolean`), `web/src/charts/datasets.ts:257` and `:314` (a `target` overlay draws as `{ type: 'line', stepped: 'middle', borderDash: [4, 3], pointRadius: 0, fill: false }` in the muted colour, on line and bar charts alike). Test: create `scripts/test-targetCharts.ts` (harness and fixtures: step 09's `scripts/test-targets.ts`); `web/src/charts/datasets.test.ts`.
**Interfaces:** Produces
```ts
export async function withTargetSeries(reply: VizDataReply, projectId: string, datasetId: string, enc: VizEncoding, filters: FilterStep[]): Promise<VizDataReply>
  // the reply itself (Object.is) when the drawn measure has no metric target; reads no metric when no measure has a metricId
export async function targetPlan(projectId: string, m: Metric, scope: FilterStep[]): Promise<{ plan: Metric; planDatasetId: string; filters: FilterStep[]; asks: PlanAsk[] } | { none: string }>
targetSeriesTooLong(): string            // "The target is drawn for at most 24 dates."
targetPlanNoColumn(column: string): string   // "The plan has no {column}, so the target can't be drawn by it."
```
- [ ] **Step 1: Write the failing test.**
  ```ts
  const byMonth = await chart({ category: 'day', grain: 'month', values: [M(rev)] }, [Y2024]);
  const tgt = byMonth.data.series.find((s) => s.target);
  ok('a stepped target per month, each the tile\'s target for that month', !!tgt && tgt.role === 'overlay' && byMonth.data.labels.every((l, i) => Object.is(tgt.values[i], tileTarget(rev, l))));
  ok('November is pro-rated to today', Object.is(valueAt(tgt, '2024-11'), planNov * 20 / 30));
  const byRegion = await chart({ category: 'region', values: [M(rev)] }, [THIS_MONTH]);
  ok('by region: the plan\'s region column, pro-rated', regions.every((r) => Object.is(valueOf(byRegion, 'Target', r), planNovRegion(r) * 20 / 30)));
  const byChannel = await chart({ category: 'channel', values: [M(rev)] }, [THIS_MONTH]);
  ok('by channel: no series, and why', !byChannel.data.series.some((s) => s.target) && byChannel.notes?.includes(tm.targetPlanNoColumn('channel')));
  ok('a running total ignores the target series', (await chart({ category: 'day', grain: 'month', values: [{ ...M(rev), calc: RT }] }, [Y2024])).data.series.filter((s) => !s.target).length === 1);
  ok('the Assistant\'s facts never read it', !(await ipcCopilot.buildFacts(P, { kind: 'visual', id: revChart.id })).text.includes('Target'));
  ok('two measures: no target series', !(await chart({ category: 'region', values: [M(rev), M(units)] }, [THIS_MONTH])).data.series.some((s) => s.target));
  let reads = 0; spyOn(metrics, 'getMetric', () => reads++);
  ok('NEGATIVE CONTROL: a chart with no metric measure: the reply itself, nothing read', Object.is(await withTargetSeries(PLAIN_REPLY, P, D, PLAIN_ENC, []), PLAIN_REPLY) && reads === 0);
  ```
  Web: a series `{ role: 'overlay', target: true }` becomes a dataset with `type: 'line'` and `stepped: 'middle'` on a bar chart; a plain overlay keeps today's dataset (NEGATIVE CONTROL).
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-targetCharts.js` → no target series.
- [ ] **Step 3: Implement** as specified, then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-targetCharts.js scripts/test-targets.js scripts/test-compareSeries.js scripts/test-tableCalc.js scripts/test-copilot.js scripts/test-sharePolicy.js scripts/test-file-size.js && npm run test:web -- datasets && npm run lint`, and `wc -l src/ipc/visuals.ts` has not grown.
- [ ] **Step 5: Commit.** `git add src web/src/charts scripts/test-targetCharts.ts && git commit -m "Draw a metric's target as a stepped line on its charts"`

### Task 2: Target alerts, and a deleted metric in the inbox

**Files:** Modify `src/analysis/alerts.ts` (`canEvaluate`: a `target` rule is evaluable; `EvaluateInput` gains `target?: number | null`; `evaluateRule :505-562` a `target` branch; `alertMessage` a target sentence), `src/analysis/alertStore.ts` (`metricFor` for `compare: 'target'` returns the value and `metricTarget(...).value`), `src/ipc/alerts.ts:148-160` (`alerts:list` marks each rule whose `metricId` names no metric with `metricGone: true`), `web/src/features/dashboards/AlertDialog.tsx` (a **Target** tab beside threshold and change, `:157`, shown only when the metric has a target: below/above, percent), `web/src/features/dashboards/AlertsBell.tsx` (the rule row says `Its metric was deleted, so this alert is not checked.` when `metricGone`), `web/src/features/dashboards/api.ts`. Test: `scripts/test-targetCharts.ts` section "alerts"; `web/src/features/dashboards/AlertDialog.test.tsx` (create if absent).
**Interfaces:** Produces `alerts.targetBreached(rule: AlertRule, value: number | null, target: number | null): boolean`; message `` `${label} is ${fmt(value)}, ${pct} of its target of ${fmt(target)}.` `` through `t()`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const rule = { id: U(3), name: 'Revenue off plan', datasetId: D, enabled: true, compare: 'target', targetPct: { op: 'below', pct: 90 }, metric: { column: '', aggregation: 'sum', metricId: rev.id, filters: [THIS_MONTH] } };
  await alertStore.restoreRule(P, rule);
  const ev1 = await alertStore.evaluateProject(P, D, NOW);
  ok('below 90% of target: fires once', ev1.length === 1 && ev1[0].message === alerts.alertMessageFor(...));
  ok('…and not again while still below (the edge)', (await alertStore.evaluateProject(P, D, NOW + 3_600_000)).length === 0);
  await raiseNovemberSalesAbove(0.95);
  ok('back above re-arms without firing', (await alertStore.evaluateProject(P, D, NOW + 7_200_000)).length === 0 && !(await alertStore.load(P)).rules.find((r) => r.id === rule.id)!.armed);
  ok('NEGATIVE CONTROL: no target in scope (no period) never fires', (await alertStore.testRule(P, { ...rule, metric: { ...rule.metric, filters: [] } })).fire === false);
  await post('metric:delete', { projectId: P, id: rev.id });
  ok('a deleted metric: not evaluated, and the inbox says so', (await post('alerts:list', { projectId: P })).value.rules.find((r: Reply) => r.id === rule.id).metricGone === true);
  ```
  Web: the Target tab saves `{ compare: 'target', targetPct: { op: 'below', pct: 90 } }`; it is absent for a metric with no target (NEGATIVE CONTROL); `AlertsBell` shows the deleted-metric sentence for a `metricGone` rule.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-targetCharts.js` → the target rule is skipped (step 01's `canEvaluate`).
- [ ] **Step 3: Implement** as specified, then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-targetCharts.js scripts/test-alerts.js scripts/test-alertDiagnosis.js scripts/test-part5Readers.js scripts/test-i18n.js scripts/test-file-size.js && npm run test:web && npm run build:web && npm --prefix web run e2e -- notifications && npm --prefix web run size && npm run lint`.
- [ ] **Step 5: Commit.** `git add src web scripts/test-targetCharts.ts && git commit -m "Alert when a metric falls below or rises above a share of its target"`

## Existing tests that must stay green

`test-alerts`, `test-alertDiagnosis`, `test-targets`, `test-compareSeries`, `test-tableCalc`, `test-sharePolicy`, `test-copilot`, `test-publishMemo`, `test-part5Readers` (rewrite its "target rule skipped" assertion: evaluated now), `test-liveRoute`, `test-i18n`, `test-file-size`, `npm run test:web`, the `notifications` e2e, `npm run lint`.
