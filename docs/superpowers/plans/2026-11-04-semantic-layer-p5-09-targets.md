# Semantic layer part 5, step 09: targets on the metric, on tiles and scorecards — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A metric carries a target (D12): a figure, or a metric over a plan dataset (usually an input table). Under any scope the server works out the matching target (D13): the dates map onto the plan's date widened to whole periods, a metric that adds up across time is pro-rated by calendar days for a period in progress (owner's answer 1), every other filter must apply to the plan too, and row rules must restrict both datasets or neither. Tiles, scorecards, MCP and the Assistant show the target, attainment and status (D14); React prints what it is sent.
**Architecture:** No new record kind and no migration: `Metric.target` (kept since step 01). A pure module (`src/analysis/targetMath.ts`) splits the covered range into periods with `scorecardModel.periodWindow` (`src/analysis/scorecardModel.ts:122`, which already follows fiscal years, `weekStart` and week calendars) and plans at most three resolutions: a partial first period, the whole periods between as one, and a partial last period. One reader (`src/ipc/targetResolve.ts`) checks segments and row rules, resolves the plan metric through `resolveMetric` (so plan datasets on Live, terms and caches come free), and grades with `scorecardModel.rowStatus` (`:174-184`).
**Tech Stack:** `src/analysis`, `src/ipc`, `src/api` (zod), `src/automation`, `src/ai`, React (`web/src/features/analyses`), self-checks, Vitest, Playwright.
**Spec:** docs/semantic-layer/05-metrics-depth.md (D12, D13, D14 tile/scorecard/MCP; owner's answer 1; Tests "Targets") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p5-00-index.md
**Branch and PR:** `feat/semantic-p5-09-targets` off `origin/develop` after step 08 merges. Release 5B.

## Rolling deploy

New stored field: `Metric.target`. A 5A pod keeps it on read and re-save (step 01, `normalize` + the `...existing` spread in `updateMetric`) and shows no target. A browser tab from before this PR sends no `target` key, which keeps the stored one; only `target: null` clears it.

## Global Constraints

- **Covered range:** `scopeRange(filters, [metric's date column])` after part 1's control rewrite (`metricScope`), with `to` capped at today (`todayIso()`); an open or missing `from` → no target for an additive metric ("Pick a period"). The cap is what makes Nov 1–20 meet 800k, not 1.2M.
- **Additive across time** = part 1's `additivityOf(metric, …).time`. Additive: target = Σ over periods `target(p) × days covered ÷ days in p`, whole periods resolved together. Not additive: the plan metric over the covered range widened to whole `per` periods (or unwidened with no `per`), never pro-rated; a fixed figure holds at any scope.
- **Segments:** every scope filter other than the date bounds on the metric's date must apply to the plan's dataset by the rule filters already follow: the plan's own column of that name, or `joinPlan.resolveColumnOwner(planDs, column, rels, infos)` (`src/analysis/joinPlan.ts:185`); a term must expand on the plan's dataset with no notes (`expandTerms`, part 1's 05b). Otherwise **no target**, with a sentence naming the column. Never the unfiltered plan: the engine would silently skip the filter (`transforms.ts` `stepFilter` skip).
- **Row rules:** `rowLockFor(P, metric dataset)` (`src/data/rowAccess.ts:217`) and `rowLockFor(P, plan dataset)` are both null or both non-null; otherwise no target with a sentence. A `RowPolicyError` from either means no target, never a thrown tile.
- At most three plan resolutions per target, each `resolveMetric(P, plan.id, { filters })`.
- Status: `rowStatus(value, target, thresholds ?? defaultThresholds(direction), direction)` (`:164`, `:174`).
- Sentences in a new `src/analysis/targetMessages.ts` (append to `MAIN_FILES`), figures formatted before `t()`. `src/ipc/scorecards.ts` (485), `src/ipc/analysesServer.ts` (240), `src/automation/handlers.ts` (337) take calls only.
- A metric with no target: every reply byte-identical.
- Commits carry no Co-Authored-By or AI trailer.

## Review Focus

- **The whole plan against a filtered actual** (an anti-goal). Pinned by Task 2's negative control: the same plan resolution with the unmatched filter left in gives the whole plan, so removing the check would show it.
- **A target restricted on one side only** (an anti-goal). Pinned in Task 2 for both one-sided cases.
- **Week calendars:** a 4-4-5 "month" has 28 or 35 days, so pro-rating divides by the period's own length from `periodWindow`, never 30. Pinned in Task 1.
- **`metric_value` (MCP) has no scope argument** (`src/automation/handlers.ts:200-209`), so an additive metric's target there is "Pick a period". It returns the sentence; adding a period argument is not asked for.

---

### Task 1: The arithmetic, pure

**Files:** Create `src/analysis/targetMath.ts`, `scripts/test-targets.ts` (section "math").
**Interfaces:** Produces
```ts
export interface PeriodPart { from: string; to: string; covered: number; days: number; label: string }   // one `per` period the range touches
export function periodParts(range: { from: string; to: string }, per: ScorePeriod, cal: CalendarPrefs): PeriodPart[]
export interface PlanAsk { from: string; to: string; fraction: number }   // a resolution of the plan metric and what share of it counts
export function planAsks(parts: PeriodPart[]): PlanAsk[]                   // ≤ 3: partial first, whole middle merged (fraction 1), partial last
export function fixedTarget(value: number, parts: PeriodPart[]): number    // Σ value × covered ÷ days
export function widened(parts: PeriodPart[]): { from: string; to: string }
```
- [ ] **Step 1: Write the failing test.**
  ```ts
  const G = { weekStart: 1, fiscalYearStart: 1 }, W445 = { ...G, calendarType: '445' };
  const p = periodParts({ from: '2026-11-01', to: '2026-11-20' }, 'month', G);
  ok('Nov 1–20 is 20 of 30 days of November', p.length === 1 && p[0].covered === 20 && p[0].days === 30);
  ok('1.2M a month, pro-rated to Nov 20, is 800k', Object.is(fixedTarget(1_200_000, p), 800_000));
  ok('February 2024 has 29 days', periodParts({ from: '2024-02-10', to: '2024-02-29' }, 'month', G)[0].days === 29);
  const span = periodParts({ from: '2024-01-15', to: '2024-04-10' }, 'month', G);
  ok('a span: partial Jan, whole Feb–Mar, partial Apr', span.length === 4 && span[0].covered === 17 && span[3].covered === 10);
  ok('…planned as three asks, the middle as one', same(planAsks(span), [{ from: '2024-01-01', to: '2024-01-31', fraction: 17 / 31 }, { from: '2024-02-01', to: '2024-03-31', fraction: 1 }, { from: '2024-04-01', to: '2024-04-30', fraction: 10 / 30 }]));
  ok('a whole month is one ask with fraction 1', same(planAsks(periodParts({ from: '2024-03-01', to: '2024-03-31' }, 'month', G)), [{ from: '2024-03-01', to: '2024-03-31', fraction: 1 }]));
  const w = periodParts(RANGE_IN_A_5_WEEK_445_PERIOD, 'month', W445);
  ok('a 4-4-5 period divides by its own 35 days', w[0].days === 35);
  ok('fiscal quarters follow the fiscal year', periodParts({ from: '2024-04-01', to: '2024-04-30' }, 'quarter', { ...G, fiscalYearStart: 4 })[0].days === 91);
  ok('widened to whole periods', same(widened(span), { from: '2024-01-01', to: '2024-04-30' }));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-targets.js` → module not found.
- [ ] **Step 3: Implement.** Walk from `range.from`: `periodWindow(day, per, 0, cal)`, clip to the range, step to the window's `to` + 1.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-targets.js scripts/test-scorecards.js`.
- [ ] **Step 5: Commit.** `git add src/analysis/targetMath.ts scripts/test-targets.ts && git commit -m "Split a date range into target periods and pro-rate a target by calendar days"`

### Task 2: Save a target, and resolve one under a scope

**Files:** Create `src/ipc/targetResolve.ts`, `src/analysis/targetMessages.ts`. Modify `src/api/metrics.ts` (`Fields` gains `target`; the `metric:update` patch takes `target: Target.nullable().optional()`), `src/analysis/metrics.ts` (`MetricInput.target`, `updateMetric` key presence: absent keeps, null clears; ≤ 6 lines), `src/ipc/metrics.ts` (the save and update handlers call `checkTarget`), `scripts/i18n-extract.ts:346`. Test: `scripts/test-targets.ts`, section "resolve".
**Interfaces:** Produces
```ts
export interface TargetResult { value: number | null; display: string; attainment: number | null; attainmentDisplay: string; status: RowStatus; how?: string; none?: string }
export async function metricTarget(projectId: string, m: Metric, scope: FilterStep[], value: number | null): Promise<TargetResult | null>   // null when m has no target
export async function checkTarget(projectId: string, m: Pick<Metric, 'id' | 'datasetId' | 'definition' | 'timeColumn'>, t: MetricTargetSpec): Promise<{ error: string; field: 'target' } | null>
// targetMessages.ts
targetPickPeriod(): string                       // "Pick a period to see the target."
targetPlanLacks(column: string): string          // "The plan has no {column}, so there is no target for this filter."
targetRowRules(): string                         // "The target comes from data your access rules treat differently, so it isn't shown."
targetPlanGone(): string                         // "The plan metric was deleted."
targetHowProRated(full: string, period: string, to: string): string   // "{full} for {period}, pro-rated to {to}"
targetHowWhole(full: string, period: string): string                  // "{full} for {period}"
targetNeedsPer(): string                         // "A target for a metric that adds up over time needs the period one figure covers."
targetPlanNoDate(name: string): string           // "“{name}” has no date it counts by, so it can't be a plan."
```
`checkTarget`: `per` is required when the metric adds up over time; a plan metric must exist, not be this metric, and have a date (`metricDate`); the metric needs a date when `per` is set.
- [ ] **Step 1: Write the failing test.** Fixtures: `SALES` (part 5's) with `region` and `channel`; `PLAN`, an input table (`input:create`, `src/data/inputTable/store.ts:226`): `month` (date, the 1st of each month), `region`, `amount`; `Revenue` (sum, by `day`, target `{ source: { metricId: PLAN_REV }, per: 'month' }`); `Plan revenue` (sum of `PLAN.amount`, by `month`); `Avg sale` (avg, target `{ source: { value: 50 } }`); `ORDINATE_TODAY=2024-11-20`.
  ```ts
  const t = (m: Metric, f: FilterStep[]) => targetResolve.metricTarget(P, m, f, null);
  ok('this month, pro-rated: November\'s plan × 20/30', Object.is((await t(rev, [THIS_MONTH]))!.value, planNov * 20 / 30));
  ok('the tile says how', (await t(rev, [THIS_MONTH]))!.how === tm.targetHowProRated(fmt(planNov), 'Nov 2024', 'Nov 20'));
  let asks = 0; spyOn(ipcMetrics, 'resolveMetric', () => asks++);
  await t(rev, [ON('2024-01-15', '2024-04-10')]);
  ok('a span is at most three plan resolutions', asks === 3);
  ok('EAST: the plan filtered to East', Object.is((await t(rev, [THIS_MONTH, EAST]))!.value, planNovEast * 20 / 30));
  const ch = (await t(rev, [THIS_MONTH, eq('channel', 'web')]))!;
  ok('the plan has no channel: no target, and why', ch.value === null && ch.none === tm.targetPlanLacks('channel'));
  ok('NEGATIVE CONTROL: left in, that filter would silently give the whole plan', Object.is((await ipcMetrics.resolveMetric(P, PLAN_REV, { filters: [NOV_ON_MONTH, eq('channel', 'web')] }))!.value, planNov));
  ok('no period, additive: no target', (await t(rev, []))!.none === tm.targetPickPeriod());
  ok('avg: a fixed figure holds at any scope, never pro-rated', Object.is((await t(avg, [THIS_MONTH]))!.value, 50) && Object.is((await t(avg, []))!.value, 50));
  ok('status and attainment are rowStatus\'s', same(pick(await targetResolve.metricTarget(P, rev, [THIS_MONTH], 700_000)), rowStatus(700_000, planNov * 20 / 30, undefined, rev.direction)));
  for (const [who, metricRules, planRules, shown] of [['both restricted', true, true, true], ['neither', false, false, true], ['actuals only', true, false, false], ['plan only', false, true, false]] as const)
    ok(`row rules, ${who}: ${shown ? 'shown' : 'not shown'}`, (await asViewer(rulesOn(metricRules, planRules), () => t(rev, [THIS_MONTH])))!.none === (shown ? undefined : tm.targetRowRules()));
  ok('a target on Live actuals with an extract plan works', Object.is((await t(revLive, [THIS_MONTH]))!.value, planNov * 20 / 30));
  ok('save refuses a sum target with no per', (await trySave(rev, { source: { value: 1 } })).error === tm.targetNeedsPer());
  ok('an old editor\'s update keeps the target', /* metric:update { name } */ isDeepStrictEqual((await metrics.getMetric(P, rev.id))!.target, REV_TARGET));
  ok('target: null clears it', /* metric:update { target: null } */ !('target' in (await metrics.getMetric(P, rev.id))!));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-targets.js` → the contract refuses `target`.
- [ ] **Step 3: Implement** as specified, then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-targets.js scripts/test-metrics.js scripts/test-part5Readers.js scripts/test-rowPolicy.js scripts/test-termDoors.js scripts/check-contracts.js scripts/test-i18n.js scripts/test-file-size.js`.
- [ ] **Step 5: Commit.** `git add src scripts/i18n-extract.ts scripts/test-targets.ts && git commit -m "Give a metric a target and work it out under any scope, pro-rated, segmented and row-rule safe"`

### Task 3: Tiles, published pages, scorecards, MCP and the Assistant

**Files:** Modify `src/ipc/analysesServer.ts:153-159` (a KPI with a `metricId` whose metric has a target gets `res.target`), `src/publish/dashboardData.ts:488` (the published KPI payload carries it), `src/ipc/scorecards.ts:305-312` (a row with no target of its own uses `metricTarget` over the row's window), `src/automation/handlers.ts:200-209` (`metric_value` returns `target`), `src/ai/copilotFacts.ts` (`metricLines`: `Target {display} ({attainment}, {status}).`), `src/ipc/copilot.ts` (`factMetrics`), then `node scripts/gen-automation-docs.js`. Test: `scripts/test-targets.ts`, section "surfaces".
**Interfaces:** `analysis:tiles` item and `metric_value` reply gain `target?: TargetResult`; `FactMetric.target?: TargetResult`. A scorecard row's own target still wins (D12).
- [ ] **Step 1: Write the failing test.**
  ```ts
  const tile = (await post('analysis:tiles', { projectId: P, items: [{ kind: 'metric', metricId: rev.id, datasetId: D, column: '', aggregation: 'sum', filters: [THIS_MONTH] }] })).value[0];
  ok('tile: target, attainment, status from the server', Object.is(tile.target.value, planNov * 20 / 30) && Object.is(tile.target.attainment, tile.value / tile.target.value * 100));
  ok('NEGATIVE CONTROL: a metric with no target: the tile reply is byte-identical', JSON.stringify(await tileOf(units)) === UNITS_TILE_BEFORE);
  ok('a published KPI carries the same target', Object.is(publishedPayload(await buildDashboard(P, dash.id, 1), card).target.value, tile.target.value));
  const sc = await computeScorecard(P, { id: U(1), name: 's', period: 'month', rows: [{ metricId: rev.id }, { metricId: rev.id, target: 5 }] });
  ok('scorecard: the metric\'s target for the month in progress, pro-rated', Object.is(sc.rows[0].target, planNov * 20 / 30));
  ok('scorecard: a row\'s own target wins', sc.rows[1].target === 5);
  ok('metric_value carries the target', 'target' in (await handlers.metricValue(ctx, 'Revenue') as object));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-targets.js` → the tile has no `target`.
- [ ] **Step 3: Implement** as specified (calls only in the files near their caps).
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-targets.js scripts/test-scorecards.js scripts/test-analysesServer.js scripts/test-publishMemo.js scripts/test-copilot.js scripts/test-automation.js scripts/test-file-size.js`.
- [ ] **Step 5: Commit.** `git add src docs/automation.md scripts/test-targets.ts && git commit -m "Show a metric's target on tiles, published pages, scorecards and to agents"`

### Task 4: The editor and the KPI card

**Files:** Create `web/src/features/analyses/metrics/TargetFields.tsx` (+ test). Modify `web/src/features/analyses/metrics/MetricEditor.tsx` (a **Target** section; `target` in both `saveMetric` calls), `web/src/features/analyses/metrics/api.ts`, `web/src/features/analyses/api.ts:290-292` (`MetricTile.target?`), `web/src/features/analyses/editor/MetricCard.tsx` (after the delta, `:190`). Extend `web/e2e/analyses.e2e.ts`.
**Interfaces:** `TargetFields`: **Target**: None · A figure · A plan metric (metrics with a date, not this one); **Each figure covers**: Week · Month · Quarter · Year (shown, and required, when the metric adds up over time: the server's `adds_up` from part 1's metric list); **Good at / At risk below** (% of target, defaults from `defaultThresholds`). Sends `target: <object> | null`. The card prints `88% of target`, the scorecard `Dot` (`web/src/features/reports/scorecards/Dot.tsx`) for `status`, and `how` as a muted line; with `none`, only the muted sentence.
- [ ] **Step 1: Write the failing tests.** Vitest: picking "A plan metric" → `Plan revenue`, "Month" sends `{ source: { metricId }, per: 'month' }`; "None" on an existing one sends `null`; `MetricCard` with `target: { attainmentDisplay: '88%', status: 'warn', how: '1.2M for Nov 2024, pro-rated to Nov 20' }` shows all three; with `target.none` it shows only the sentence; with no `target`, nothing new (NEGATIVE CONTROL). e2e: give Revenue a fixed monthly target, and the dashboard KPI shows "% of target".
- [ ] **Step 2: Run them to see them fail.** `npm run test:web -- TargetFields MetricCard`.
- [ ] **Step 3: Implement** with existing components and tokens; both themes.
- [ ] **Step 4: Run them to see them pass.** `npm run test:web && npm run build:web && npm --prefix web run e2e -- analyses && npm --prefix web run size && npm run lint`.
- [ ] **Step 5: Commit.** `git add web && git commit -m "Set a metric's target in the editor and show attainment on its card"`

## Existing tests that must stay green

`test-scorecards`, `test-analysesServer`, `test-publishMemo`, `test-publishSite`, `test-embedLock`, `test-metrics`, `test-metricTimeDoors`, `test-additivity`, `test-rowPolicy`, `test-rowPolicySafetyNet`, `test-termDoors`, `test-copilot`, `test-automation`, `test-part5Readers`, `test-i18n`, `test-file-size`, `check-contracts`, `npm run test:web`, the `analyses` e2e, `npm run lint`.
