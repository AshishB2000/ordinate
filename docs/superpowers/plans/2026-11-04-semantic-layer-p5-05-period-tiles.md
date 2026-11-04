# Semantic layer part 5, step 05: period metrics on tiles, scorecards, the tree and alerts — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A metric can be "Revenue, year to date", "Orders, last 7 days" or "Revenue, % change on last year": a period kind built on a base metric (D8), whose window covers the days D9 says, computed as a rewritten scope through the KPI door (D10, first bullet), so it is right on every aggregation, on Live, under row rules and terms, everywhere a single figure is shown.
**Architecture:** No new engine. A pure module (`src/analysis/periodMath.ts`) turns a scope into a window: it reads the scope's range on the base's date (`periodScope.scopeRange`, `src/analysis/periodScope.ts:51`, given only that column), builds the window from `dateIntel.resolvePeriod` (`:224`) under the workspace calendar, and replaces the scope's bounds on that column (`withRange`, `:85`). One reader (`src/ipc/periodMetric.ts`) resolves the base under that scope in a **fresh** resolve context, and, for a compare, a second time under `compareScope` (`:125`) of the windowed scope. `resolveDefinition` (`src/ipc/metrics.ts:121`) gets a one-line branch, so tiles, `/p/`, scorecards, the metric tree, formulas over period metrics, MCP and the Assistant all get it.
**Tech Stack:** `src/analysis`, `src/ipc`, `src/api` (zod), React (`web/src/features/analyses/metrics`), self-checks, Vitest, Playwright.
**Spec:** docs/semantic-layer/05-metrics-depth.md (D8, D9, D10 first bullet; Dependencies) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p5-00-index.md
**Branch and PR:** `feat/semantic-p5-05-period-tiles` off `origin/develop` after step 04 merges. Release 5B.

## Rolling deploy

New stored shape: `definition: { base, window?, compare? }` (step 01 keeps it; a 5A pod shows "—" and refuses it on a chart). A KPI card or alert rule on a period metric stores `column: ''` with the `metricId` and `aggregation: 'sum'` (step 01 keeps both). A pod older than 5A cannot be in the cluster (step 04's gate).

## Global Constraints

- **The days a window covers (D9).** *Scope end* = the `to` of `scopeRange(filters, [baseDateColumn])`, or today when there is none or it is open. Today is `todayIso()` (`dateIntel.ts:446`).
  - `to_date: u` → `{ from: resolvePeriod({ preset: 'this_' + u }, e, cal).from, to: e }` with `e = min(scope end, today)`. (`dateIntel` has no `mtd`/`wtd`; for `year`/`quarter` this equals `ytd`/`qtd`, which Task 1 asserts rather than assumes.)
  - `last: n, unit: u` → `resolvePeriod({ preset: 'last_n_' + u + 's', n }, min(scope end + 1 day, today), cal)`: n whole units ending at scope end; with no scope, ending yesterday.
  - The window replaces the scope's bounds on the base's date column; every other filter stays.
  - Use `resolvePeriod` (fiscal year, `weekStart`, week calendar), never `categoryKey.dateBucket` (Monday weeks, calendar quarters: `:128-138`).
- **Compare:** `compareScope(windowed, [baseDateColumn], { mode: vs })`, so like with like (`toDate`, `periodScope.ts:104-117`). `pct_change = (now − prior) / |prior|`, null on a null or zero prior. With no window and no period in scope: null, and the note "Pick a period to compare".
- **The base resolves in a fresh `ResolveCtx`** (`newCtx`, `ipc/metrics.ts:201`). The per-call memo is keyed by name alone (`:76`), so resolving the base inside the caller's context would hand `[Revenue]` the windowed figure in `[Revenue YTD] - [Revenue]`.
- **The date:** a period metric counts by its base's date: part 1's `metricDate` (`src/analysis/metricTimeScope.ts`) follows `base` for a period definition, and a period metric stores no `timeColumn` of its own (refused at save, `field: 'timeColumn'`).
- `src/ipc/metrics.ts` is 563 lines: calls only (≤ 8 lines). Sentences in `src/analysis/metricCheckMessages.ts` (in `MAIN_FILES`), then `node scripts/i18n-extract.js`.
- With no period metric anywhere, every reply is byte-identical; golden fixtures are not re-recorded.
- Commits carry no Co-Authored-By or AI trailer.

## Review Focus

- **The memo trap** above. Pinned in Task 2 (`[Revenue YTD] - [Revenue]`).
- **`resolveMetricSeries` adds a label filter (`=`/`contains`) instead of a range** (`ipc/metrics.ts:356-369`), so a period metric's sparkline would be "year to today" at every point. This PR returns no series for a period metric (`shortcut:` until step 06 draws it per bucket). Pinned in Task 2.
- **Alerts on a period metric** have no `{column, aggregation}` copy to evaluate, so they evaluate by `metricId` through `resolveMetric` (D14). Pinned in Task 3.
- **A deleted base** gives null with "Its base metric was deleted", never a fallback copy. Pinned in Task 2.

---

### Task 1: The window, pure

**Files:** Create `src/analysis/periodMath.ts`, `scripts/test-periodMetrics.ts` (section "math"; ends on `finish()`).
**Interfaces:** Produces
```ts
export function scopeEnd(filters: FilterStep[], dateColumn: ScopeColumn, today: string): string
export function windowRange(window: MetricWindow, end: string, today: string, cal: CalendarPrefs): DateRange
export function windowedScope(filters: FilterStep[], dateColumn: ScopeColumn, window: MetricWindow | undefined, today: string, cal: CalendarPrefs): { filters: FilterStep[]; range: DateRange | null }
  // no window: the filters as they are, range = the scope's range on dateColumn (or null)
export function pctChange(now: number | null, prior: number | null): number | null
export function periodValue(show: MetricCompare['show'] | undefined, now: number | null, prior: number | null): number | null
  // no compare → now; 'change' → now − prior (null if either null); 'pct_change' → pctChange; 'prior' → prior
```
- [ ] **Step 1: Write the failing test.** `TODAY = '2024-11-03'`, `D = { name: 'day', type: 'date' }`, `ON = (from, to) => ({ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from, to } })`.
  ```ts
  const GREG = { weekStart: 1, fiscalYearStart: 1 }, FY4 = { weekStart: 1, fiscalYearStart: 4 }, W445 = { ...GREG, calendarType: '445' };
  const r = (w: MetricWindow, f: FilterStep[], cal = GREG) => windowedScope(f, D, w, TODAY, cal).range;
  ok('YTD, no scope = the ytd preset', same(r({ to_date: 'year' }, []), resolvePeriod({ preset: 'ytd' }, TODAY, GREG)));
  ok('YTD, fiscal April, scope October', same(r({ to_date: 'year' }, [ON('2024-10-01', '2024-10-31')], FY4), { from: '2024-04-01', to: '2024-10-31' }));
  ok('QTD = the qtd preset under a week calendar', same(r({ to_date: 'quarter' }, [], W445), resolvePeriod({ preset: 'qtd' }, TODAY, W445)));
  ok('MTD, February 2024 ends on the 29th', same(r({ to_date: 'month' }, [ON('2024-02-01', '2024-02-29')]), { from: '2024-02-01', to: '2024-02-29' }));
  ok('to date never passes today', r({ to_date: 'month' }, [ON('2024-11-01', '2024-11-30')])!.to === TODAY);
  ok('last 7 days, scope February: the 23rd to the 29th', same(r({ last: 7, unit: 'day' }, [ON('2024-02-01', '2024-02-29')]), { from: '2024-02-23', to: '2024-02-29' }));
  ok('last 7 days, no scope, ends yesterday', r({ last: 7, unit: 'day' }, [])!.to === '2024-11-02');
  ok('last 3 months, scope ending mid-October: whole months only', same(r({ last: 3, unit: 'month' }, [ON('2024-10-01', '2024-10-15')]), resolvePeriod({ preset: 'last_n_months', n: 3 }, '2024-10-16', GREG)));
  const f = windowedScope([REGION_EAST, ON('2024-10-01', '2024-10-31'), { type: 'filter', column: 'ship', op: '>=', value: '2024-01-01' }], D, { to_date: 'year' }, TODAY, GREG).filters;
  ok('the window replaces only the date bounds on the base\'s date', f.includes(REGION_EAST) && f.some((s) => s.column === 'ship') && f.filter((s) => s.column === 'day').length === 1);
  ok('pct_change', pctChange(110, 100) === 0.1 && pctChange(90, -100) === 1.9 && pctChange(5, 0) === null && pctChange(5, null) === null);
  ok('NEGATIVE CONTROL: a scope on another date column does not move the window', r({ to_date: 'year' }, [{ type: 'filter', column: 'ship', op: 'period', period: { preset: 'last_month' } }])!.to === TODAY);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-periodMetrics.js` → module not found.
- [ ] **Step 3: Implement** to the signatures and the rules in Global Constraints.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-periodMetrics.js scripts/test-dateIntel.js`.
- [ ] **Step 5: Commit.** `git add src/analysis/periodMath.ts scripts/test-periodMetrics.ts && git commit -m "Work out the days a to-date or last-N window covers under any scope"`

### Task 2: Save it, and resolve it through the KPI door

**Files:** Create `src/ipc/periodMetric.ts`. Modify `src/api/metrics.ts:10-13` (a `Definition` arm), `src/analysis/metricTimeScope.ts` (`metricDate` follows a period's base), `src/ipc/metrics.ts` (`resolveDefinition :121`, one branch; `ResolvedMetric :205` gains `periodRange?: DateRange` and `notes?: string[]`; `resolveMetric :228` copies them; `resolveMetricSeries :339` returns null for a period metric; `metric:save`/`metric:update` call the check), `src/analysis/metricFormat.ts` (`describeDefinitionShort`), `src/analysis/metricUsage.ts:151` (a period metric counts as using its base), `src/analysis/pendingKinds.ts` (step 01: the period half of `pendingMetric` is false now), `src/analysis/metricCheckMessages.ts`. Test: `scripts/test-periodMetrics.ts`, section "kpi" (harness: `scripts/test-metricTimeDoors.ts`, part 1's, with an extract and a Live copy of one fixture).
**Interfaces:** Produces
```ts
// src/api/metrics.ts
z.strictObject({ base: Uuid, window: z.union([z.strictObject({ to_date: z.enum(['week', 'month', 'quarter', 'year']) }), z.strictObject({ last: z.number().int().min(1).max(366), unit: z.enum(['day', 'week', 'month']) })]).optional(),
                 compare: z.strictObject({ vs: z.enum(['previous_period', 'previous_year']), show: z.enum(['change', 'pct_change', 'prior']) }).optional() })
// src/ipc/periodMetric.ts
export async function periodMetricValue(ctx: ResolveCtx, datasetId: string, def: MetricPeriodDefinition, filters: FilterStep[], depth: number): Promise<number | null>
  // sets ctx.info.periodRange / ctx.info.notes at depth 0; copies the inner ctx's fx/asOf to ctx
export async function checkPeriodDefinition(projectId: string, datasetId: string, def: MetricPeriodDefinition, timeColumn?: string): Promise<{ error: string; field: 'definition' | 'timeColumn' } | null>
// metricCheckMessages.ts
periodBaseMissing(): string          // "Its base metric was deleted, so it has no figure."
periodBaseOtherDataset(): string     // "The base metric must be on the same dataset."
periodBaseNoDate(base: string): string  // "“{base}” has no date it counts by. Give it one first."
periodOfPeriod(): string             // "A period metric can't be built on another period metric."
periodOwnDate(): string              // "A period metric counts by its base metric's date."
pickPeriodToCompare(): string        // "Pick a period to compare."
```
`ResolveCtx` (`ipc/metrics.ts:76`) gains `info?: { periodRange?: DateRange; notes: string[] }`. The words: `Revenue, year to date` / `Revenue, last 7 days` / `Revenue, change on last year` / `Revenue, % change on the previous period` / `Revenue, last year`.
- [ ] **Step 1: Write the failing test.** Fixture `SALES`: `day` (date, every day 2023-01-01..2024-11-03, ISO and US spellings), `region`, `amount` (integers), `ship` (date). `ORDINATE_TODAY=2024-11-03`. `Revenue` = sum of amount with `timeColumn: 'day'`; `Avg sale` = avg of amount, same date.
  ```ts
  const ytd = await save('Revenue YTD', { base: REV, window: { to_date: 'year' } });
  const yoy = await save('Revenue YTD vs LY', { base: REV, window: { to_date: 'year' }, compare: { vs: 'previous_year', show: 'pct_change' } });
  const d7 = await save('Revenue 7d', { base: REV, window: { last: 7, unit: 'day' } });
  const avgYtd = await save('Avg sale YTD', { base: AVG, window: { to_date: 'year' } });
  for (const [m, scope, range] of [[ytd, [], ['2024-01-01', '2024-11-03']], [ytd, [OCT], ['2024-01-01', '2024-10-31']], [d7, [FEB], ['2024-02-23', '2024-02-29']], [avgYtd, [OCT, EAST], ['2024-01-01', '2024-10-31']]] as const)
    ok(`${m.name} under ${label(scope)} = the base tile under the explicit range`, Object.is(await kpi(m, scope), await kpi(baseOf(m), [...scope.filter((s) => s.column !== 'day'), ON(...range)])));
  ok('the tile says which days', same((await resolved(ytd, [OCT])).periodRange, { from: '2024-01-01', to: '2024-10-31' }));
  const now = await kpi(ytd, [OCT]), prior = await kpi(REV, [ON('2023-01-01', '2023-10-31')]);
  ok('% change on last year: like with like', Object.is(await kpi(yoy, [OCT]), (now! - prior!) / Math.abs(prior!)));
  ok('NEGATIVE CONTROL: not against the whole of last year', !Object.is(await kpi(yoy, [OCT]), (now! - (await kpi(REV, [Y2023]))!) / Math.abs((await kpi(REV, [Y2023]))!)));
  const diff = await saveFormula('YTD less month', '[Revenue YTD] - [Revenue]');
  ok('a formula over a period metric: the base keeps its own scope (the memo trap)', Object.is(await kpi(diff, [OCT]), (await kpi(ytd, [OCT]))! - (await kpi(REV, [OCT]))!));
  const cmpOnly = await save('Revenue vs LY', { base: REV, compare: { vs: 'previous_year', show: 'change' } });
  ok('compare with no window and no period: null, and why', (await kpi(cmpOnly, [])) === null && (await resolved(cmpOnly, [])).notes?.[0] === msg.pickPeriodToCompare());
  ok('a date control lands on the base\'s date first (part 1 D9)', Object.is(await kpi(ytd, [{ ...ON_SHIP_OCT, fromControl: true }]), await kpi(ytd, [OCT])));
  ok('Live: the same figure, never hydrated', Object.is((await hydrates(L, () => kpiOn(L, ytdL, [OCT]))).value, await kpi(ytd, [OCT])) && !hydrated);
  ok('no sparkline until step 06', (await ipcMetrics.resolveMetricSeries(P, ytd.id, 'day')) === null);
  for (const [def, tc, err] of [[{ base: GONE }, undefined, msg.periodBaseMissing()], [{ base: OTHER_DS_REV }, undefined, msg.periodBaseOtherDataset()], [{ base: NODATE }, undefined, msg.periodBaseNoDate('Units')], [{ base: ytd.id, window: W }, undefined, msg.periodOfPeriod()], [{ base: REV, window: W }, 'ship', msg.periodOwnDate()]] as const)
    ok(`save refuses: ${err}`, (await trySave(def, tc)).error === err);
  await post('metric:delete', { projectId: P, id: REV });
  ok('a deleted base: null and why, never a copy', (await kpi(ytd, [])) === null && (await resolved(ytd, [])).notes?.[0] === msg.periodBaseMissing());
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-periodMetrics.js` → the contract refuses `{ base }` (400).
- [ ] **Step 3: Implement.** `resolveDefinition`: `if (isPeriodDefinition(definition)) return periodMetricValue(ctx, datasetId, definition, filters, depth);` before the simple branch. `periodMetricValue`: read the base (`metrics.getMetric`), its date (`metricDate`) and its dataset's columns (`getDatasetMeta`, never `getDataset`); `windowedScope(resolveFilterParams(filters).steps.concat(ctx.scope), …, todayIso(), getCalendar())` (`dateIntel.ts:442`; `calendarNow` is private); then `resolveDefinition(newCtx(projectId, windowed, ctx.params), base.datasetId, base.definition, base.filters, depth + 1)`; for `compare`, the same on `compareScope(...).filters`. `metric:save`/`metric:update` call `checkPeriodDefinition` after the name check and return `{ ok: false, error, field }`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/i18n-extract.js && node scripts/test-periodMetrics.js scripts/test-metrics.js scripts/test-metricTimeDoors.js scripts/test-part5Readers.js scripts/test-liveRoute.js scripts/test-i18n.js scripts/check-contracts.js scripts/test-file-size.js`.
- [ ] **Step 5: Commit.** `git add src scripts/test-periodMetrics.ts && git commit -m "Compute a to-date, last-N or compared metric as its base over a rewritten scope"`

### Task 3: Scorecards, the tree and alerts

**Files:** Modify `src/analysis/alertStore.ts` `metricFor :320-342` (a period or funnel metric is evaluated by `metricId`), `src/analysis/alerts.ts` `canEvaluate` (an empty column with a `metricId` is evaluable now; a pending metric is still skipped through `metricFor`'s `skip`). Test: `scripts/test-periodMetrics.ts`, section "surfaces".
**Interfaces:** `metricFor`: when `rule.metric.metricId` names a metric with `isPeriodDefinition || isFunnelDefinition`, `value = (await resolveMetric(projectId, id, { filters: rule.metric.filters ?? [] }))?.value ?? null`; a `previous_period` change rule resolves it twice, with the period key filter appended, as `at()` does today; a metric that is gone gives `{ value: null, previous: null, skip: true }` (step 10 words it in the inbox).
- [ ] **Step 1: Write the failing test.**
  ```ts
  const sc = await computeScorecard(P, { id: U(1), name: 's', period: 'month', rows: [{ metricId: ytd.id }] });
  ok('scorecard: the row is the tile under the scorecard\'s window', Object.is(sc.rows[0].value, await kpi(ytd, [ON(sc.window.from, sc.window.to)])));
  const tree = (await post('metricTree:compute', { projectId: P, id: ytd.id, filters: [OCT], compare: { mode: 'previous_year' } })).value;
  ok('tree: current and previous are tiles', Object.is(tree.root.current, await kpi(ytd, [OCT])) && Object.is(tree.root.previous, await kpi(ytd, [ON('2023-10-01', '2023-10-31')])));
  const rule = { id: U(2), name: 'r', datasetId: D, enabled: true, compare: 'threshold', threshold: { op: '>', value: 0 }, metric: { column: '', aggregation: 'sum', metricId: ytd.id, filters: [OCT] } };
  ok('an alert on a period metric watches its figure', Object.is((await alertStore.metricFor(P, rule as never)).value, await kpi(ytd, [OCT])));
  ok('NEGATIVE CONTROL: an alert on a plain metric still uses its copy', Object.is((await alertStore.metricFor(P, { ...rule, metric: { column: 'amount', aggregation: 'sum', metricId: REV } } as never)).value, await kpi(REV, [])));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-periodMetrics.js` → the alert value is null.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-periodMetrics.js scripts/test-alerts.js scripts/test-scorecards.js scripts/test-metricTree.js scripts/test-part5Readers.js`.
- [ ] **Step 5: Commit.** `git add src/analysis/alertStore.ts src/analysis/alerts.ts scripts/test-periodMetrics.ts && git commit -m "Evaluate an alert on a period metric by the metric, and pin scorecards and trees on it"`

### Task 4: The editor and the tile's dates

**Files:** Create `web/src/features/analyses/metrics/PeriodFields.tsx` (+ `PeriodFields.test.tsx`). Modify `web/src/features/analyses/metrics/api.ts:16` (`Definition` gains `{ base: string; window?: …; compare?: … }`, `isPeriod`), `MetricEditor.tsx` (a third mode, **Period**, beside Simple and Formula; the definition at `:93`), `web/src/features/analyses/api.ts:290-292` (`MetricTile.periodRange?`), `web/src/features/analyses/editor/MetricCard.tsx` (the range under the figure, as a muted line), `src/ipc/analysesServer.ts:153-159` (pass `periodRange`). Extend `web/e2e/analyses.e2e.ts` (the "metrics" test).
**Interfaces:** `PeriodFields({ projectId, datasetId, value, onChange })`:
- **Base** select: metrics on this dataset that have a date and are not period metrics (from `useMetricList`, by `timeColumn`).
- **Window**: None · To date (week / month / quarter / year) · Last N (number 1–366, day / week / month).
- **Compare**: None · Previous period · Same period last year; **Show**: Change · % change · Prior figure.
- Picking `% change` sets the format to percent; the others copy the base's format, which the user may change.
- [ ] **Step 1: Write the failing tests.** Vitest: choosing base `Revenue`, "To date", "year" puts `{ base: REV, window: { to_date: 'year' } }` in the save body; the base list leaves out a metric with no `timeColumn` and a period metric (NEGATIVE CONTROL); `MetricCard` with `periodRange: { from: '2024-01-01', to: '2024-10-31' }` shows `Jan 1 – Oct 31, 2024`, and without it shows no line. e2e: create "Revenue YTD" from the sample's Revenue, wait for the preview's `Revenue, year to date` words.
- [ ] **Step 2: Run them to see them fail.** `npm run test:web -- PeriodFields MetricCard` → no Period mode.
- [ ] **Step 3: Implement** with the existing `Select`, radio and CSS-module tokens.
- [ ] **Step 4: Run them to see them pass.** `npm run test:web && npm run build:web && npm --prefix web run e2e -- analyses && npm --prefix web run size && npm run lint`. Look at `metrics-editor*` screens in both themes.
- [ ] **Step 5: Commit.** `git add web src/ipc/analysesServer.ts && git commit -m "Build a period metric in the editor, and show its days on the tile"`

## Existing tests that must stay green

`test-metrics`, `test-metricTimeDoors`, `test-metricTree`, `test-scorecards`, `test-alerts`, `test-periodLabels`, `test-compareSeries`, `test-dateIntel`, `test-liveRoute`, `test-liveSafetyNet`, `test-part5Readers` (rewrite its period "no figure" assertion as a figure), `test-publishMemo`, `test-i18n`, `test-file-size`, `check-contracts`, `npm run test:web`, the `analyses` e2e, `npm run lint`.
