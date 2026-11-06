# Semantic layer part 7, step f2: dbt import, part 5's shapes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dbt cumulative metrics and per-entity balances, which f1 skips, import as part 5 metrics: a rolling window in days or weeks becomes `last N days`, a `grain_to_date` becomes `to_date`, and one `window_groupings` entity becomes `snapshot.per`. Each one is imported only when its figures equal MetricFlow's. Conversion and time-offset metrics stay skipped, now with a reason that says why.

**Architecture:** This is a translator-only follow-up to f1. A new pure module, `src/app/dbtCumulative.ts`, turns a cumulative metric into a period definition over the simple metric f1 already translated for the same measure. f1's snapshot branch in `src/app/dbtImport.ts` gains `per`. Everything else comes from a2 and a3 unchanged:
- the dry run;
- the plan hash;
- `mapRefs` remapping `definition.base`;
- the apply writing a base before the metrics that name it;
- the editor's own period and snapshot checks.

The translator now reads the workspace calendar and each dataset's Live flag, because both decide whether a shape is exact. No AI, no guessing: a shape whose figures can differ from dbt's is skipped with a typed reason.

**Tech Stack:** `src/app`, `src/ipc`, React (`web/src/features/model`), self-checks, Vitest. MetricFlow runs offline only.

**Spec:** these documents:
- docs/semantic-layer/07-portability.md: D10, and the non-goal "Importing dbt metrics Ordinate cannot compute";
- docs/semantic-layer/05-metrics-depth.md: D8–D11;
- docs/superpowers/plans/2026-11-04-semantic-layer-cross-part-check.md: item 3, and row 87 of section (c);
- the index docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md, row 14.

This plan builds on [f1](2026-11-04-semantic-layer-p7-f1-dbt-import.md). **f1 is not built yet.** Every f1 name used here is from f1's plan: `translateDbt`, `DbtSkip`, `parseDbtWhere`, `importedFrom`, the `scripts/fixtures/dbt/` fixture and the `test-dbtImport` helpers. Where f1 ships them under another name, use f1's name and keep these behaviours.

**Branch and PR:** `feat/semantic-p7-f2-dbt-import-part5` off `origin/develop` after g1 merges. Part 5's 05, 07 and 08 are already in the chain before g1. One PR, in release C. **No merge gate.** f2 writes only shapes whose readers already shipped:
- part 5's period definition and `snapshot.per` (5A, release B);
- f1's `importedFrom` (b0).

## What f2 maps, and what it does not

| dbt shape | f2 | Why |
|---|---|---|
| cumulative, `window: N day(s)`, `period_agg: last` | period `{ base, window: { last: N, unit: 'day' } }`, N ≤ 366 | Ordinate's `last N days` is the window (t − N, t], which is MetricFlow's `metric_time > t − N days` |
| cumulative, `window: N week(s)`, `period_agg: last` | `{ last: 7N, unit: 'day' }`, N ≤ 52 | MetricFlow's week window is 7N days. Ordinate's `last N weeks` is whole calendar weeks, which is a different thing |
| cumulative, `grain_to_date: month` / `week` / `quarter` / `year`, `period_agg: last` | `{ to_date: <grain> }` | Only while the workspace calendar is dbt's: weeks from Monday, the year from January, Gregorian. Otherwise `calendar_differs` |
| measure `non_additive_dimension.window_groupings: [one entity]` | `snapshot: { column, take, per: <entity column> }` | Only on an extract (part 5 refuses per-entity snapshots on Live). Needs Task 1's partition finding |
| cumulative: no window and no grain; `period_agg` `first`/`average`/absent; windows in months, quarters, years or hours; a custom grain; `fill_nulls_with`; no plain simple metric on the measure; over a balance | skipped with a reason: `all_time`, `period_agg`, `window_unit`, `fill_nulls`, `no_base_metric`, `cumulative` | See Task 2's table |
| conversion | skipped `conversion` | MetricFlow pairs each conversion with the closest base event before it, from any of the entity's base events, in [base, base + window), and counts conversion events. Ordinate's funnel starts from each entity's first step-1 event, uses (t1, t1 + window], and counts entities. The figures differ for anyone who repeats step 1 |
| derived with `offset_window` / `offset_to_grain` | skipped `time_offset` | MetricFlow shifts each day, then adds the days up. A leap February's prior then counts 28 February twice, and a period in progress meets last year's whole period. Ordinate compares like with like |
| `window_groupings` with two or more entities | skipped `window_groupings` | `per` takes one column |

There is no dbt shape for part 5's targets. `count_distinct` → `countd` is already f1's.

dbt's `window_groupings` belongs to a measure's `non_additive_dimension`. A cumulative metric has no window grouping, and a cumulative metric over such a measure stays `cumulative`.

A ratio or derived metric whose inputs f2 now translates goes through f1's own rule: a formula over their names. Ordinate shows a formula over period metrics on tiles, scorecards and alerts, and refuses it on charts (part 5 D10). That refusal is not a wrong figure.

## dbt's field names are (to verify)

Task 1 checks these against the `semantic_manifest.json` the fixture's dbt version writes, records each answer in the fixture README with a link, and the reader reads only what Task 1 recorded.

**Cumulative metric fields**
- `type_params.cumulative_type_params.{window, grain_to_date, period_agg}`. Older manifests put `type_params.window` and `type_params.grain_to_date` at the top level.
- `window` as `{ count, granularity }`. Check whether the granularity is written singular or plural.
- `period_agg`, which dbt's docs say defaults to `first`. Check whether the manifest writes that default out.

**Inputs**
- The input as `type_params.measure` `{ name, filter, alias, join_to_timespine, fill_nulls_with }`.
- Whether the manifest from dbt's newer spec carries `input_metric` instead. dbt's v1.12 docs deprecate measures for simple metrics with `agg`.

**Window groupings**
- `measures[].non_additive_dimension.window_groupings` as a list of entity names.

**Conversion and offsets** (read only to name them)
- `type_params.conversion_type_params.{base_measure, conversion_measure, entity, calculation, window, constant_properties}`. dbt's v1.12 docs name `base_metric` and `conversion_metric`.
- `type_params.metrics[].{offset_window, offset_to_grain}`.

## Global Constraints

- **No new runtime dependency.** JSON only, read as f1 reads it (`parseBounded`, 32 MiB). dbt's YAML is never read: the person uploads `semantic_manifest.json`, which f1 settles. MetricFlow is Python and runs **offline on a developer machine**, never in CI or at run time. If the implementer cannot run it, the owner records `expected.json` once.
- **No figure from a model.** No AI in any mapping. Every figure is Ordinate's engines' (`computeCardMetric` through `metric:values`, and `vizDataFor`), held to MetricFlow's on the fixture by `Object.is`.
- **Exact or skipped: the figures decide.** A shape maps only when Ordinate's figure equals MetricFlow's at every day and at every week, month, quarter and year that has ended.
  - A mapping that fails is **removed, not pinned**. Its metric goes back to its skip reason, and the README says why.
  - `PINNED` holds only float differences in the last bits, each by name.
  - A period still in progress follows Ordinate's own rule (up to today; a "last N days" window up to yesterday), and the dry run says so (`in_progress`).
- **Old imports byte-identical.**
  - f1's translation of f1's fixture is pinned once, before any f2 code (Task 1). f2 changes only the entries f1 skipped as `cumulative`, `conversion`, `time_offset` or `window_groupings`, and adds `notes`.
  - A manifest with none of those four kinds translates byte-identically, so a2 gives it the same plan and hash.
  - Records f1 imported are unchanged on a re-import (zero writes).
- **No new contract, no input field, no stored field, no migration.** `node scripts/check-contracts.js` reports 0, and nothing new goes in `rowPolicyReaders.ts`.
- **Translations drafted.** A new server sentence goes through `t()` in `src/app/modelFileMessages.ts` (in `MAIN_FILES`), then `npm run build:ts && node scripts/i18n-extract.js`, which adds `null` drafts to es/de/fr/ja. Never hand-edit `en.json`. Skip reasons and notes are worded in the web (`importPlanText.ts`, English-only, as a2's and f1's are), so f2 should add no server sentence and the extract should report nothing new. If f1 put its reason words on the server, f2's go there too, through the extract.
- **File caps 500/800.** New logic goes in `src/app/dbtCumulative.ts`, and f1's `dbtImport.ts` takes calls only. `src/ipc/visuals.ts` is untouched.
- No push, `gh` command or release on weekdays 08:00–18:00. One worktree off `origin/develop`; never `git checkout` or `git switch` in the shared clone. No `Co-Authored-By` or any AI trailer on a commit.
- Required checks: `smoke (all shards)` and `oxlint (blocking)`; `npm run lint` reports 0.

## Review Focus

The real-world dbt shapes most likely to bite, most likely first. Each one's test is in the task that owns it, marked *(RF n)*.

1. **A cumulative metric left on dbt's default `period_agg: first`.** dbt reads it at each month's start and Ordinate at the end, so it is skipped `period_agg`, never mapped. A negative control shows the month figures would differ. Tasks 2 and 4.
2. **A rolling `window: 1 month` next to `window: 2 weeks`.** The month window is skipped `window_unit`. The weeks window becomes 14 days and equals MetricFlow on every day; Ordinate's `last 2 weeks`, which is calendar weeks, would not. Tasks 2 and 4.
3. **A workspace calendar unlike dbt's:** a fiscal year from April, Sunday weeks, or 4-4-5. Year, quarter and week to-date are skipped `calendar_differs`, while `last N days` still maps. A calendar changed between the dry run and the apply moves the hash, and the apply is refused. Tasks 2 and 4.
4. **Per-account balances** with an account that moved region, rows with no account, a tie on one day, an account that stopped reporting, and a Live dataset. All five equal MetricFlow by total, region and month. On Live the metric is skipped `live_refused`, never imported dead. Tasks 3 and 4.
5. **Year-over-year and conversion metrics:** `revenue_ly`, `revenue - revenue_ly`, `(revenue - revenue_ly) / revenue_ly`, and a visit → buy where a person visits twice. They stay skipped, with the why. Negative controls show a hand-made compare or funnel gives a different figure, so the skips are load-bearing. Tasks 2 and 4.

## Calls made while planning (deliberate; a reviewer should know)

- **Conversion → funnel and offset → compare are not built.** The index (row 14) and the cross-part check (item 3) proposed them. dbt's own docs show different matching (conversion) and a day-shifted roll-up (offsets), so neither is exact. Task 1 records the figures that prove it. Once this plan is approved, index row 14 and section (c) row 87 should be reworded to what f2 maps. This plan edits neither.
- **Only `period_agg: last` maps.** An Ordinate period metric under a month is its value at the month's end, and dbt's default is the month's start.
- **Weeks become days; months do not.** MetricFlow's month window uses calendar-month arithmetic, and Ordinate has no rolling window by day that matches it.
- **The base is reused, never synthesized.** A cumulative metric needs an unfiltered simple metric, translated by f1, on the same measure and with a `timeColumn`. Otherwise it is `no_base_metric`. A synthesized base would be a metric dbt does not have.
- **The calendar is read at translation.** A later calendar change moves these metrics away from dbt, as it moves every Ordinate period metric, and the `follows_calendar` note and the docs say so.
- **Per-entity snapshots on a Live dataset are skipped `live_refused`.** f1 imports plain snapshots onto Live, where part 1 D8 refuses their figures. That is left as is (old imports byte-identical) and flagged for f1's implementer.
- **`fill_nulls_with` on a cumulative input is skipped.** dbt shows 0 for an empty window; Ordinate shows no figure for a sum. f1's simple metrics do not read the field, and that is flagged for f1.
- **Rows with no entity.** If Task 1 finds MetricFlow drops them (plain-equality join, expected), the translated metric gets a `{ type: 'filter', column: <per>, op: 'not_empty' }` step. Part 5 D11 keeps them as one partition, and dbt has no such partition. If MetricFlow keeps NULL as a group, there is no step.

---

### Task 1: Spike and fixtures (no product code)

**Files:**
- Create `scripts/fixtures/golden/dbt-f1/translation.json`.
- Create, in `scripts/fixtures/dbt-part5/`: `orders.csv`, `balances.csv`, `events.csv`, `semantic_manifest.json`, `expected.json`, `README.md`.

- [ ] **Step 1: Pin f1 before touching it.** On the fresh branch, before any f2 code, write `stableStringify(translateDbt(F1_MANIFEST, F1_DATASETS, {}))` to `translation.json`. Use f1's fixture and its test's fixed-id `DATASETS`. Record it once; never re-record it.
- [ ] **Step 2: The seeds.** f1's fixture stays untouched.
  - **`orders.csv`:**
    - columns `order_id, customer_id, region, amount, status, order_date`;
    - rows from 2023-01-01 to 2024-03-15;
    - some empty days, a refund row with a negative amount on some days;
    - revenue on 2023-02-28 and on 2024-02-29.
  - **`balances.csv`:**
    - columns `account_id, region, mrr, snapshot_date`;
    - monthly snapshots for A01–A08, January to June 2024;
    - A07 moves from EU to US in April, and A08 stops after February;
    - two rows with an empty `account_id`, and A03 with two rows on one day.
  - **`events.csv`:**
    - columns `user_id, event, ts`, with visits and buys;
    - U1 visits on day 1 and day 20 and buys on day 22;
    - U2 buys exactly 7 days after its visit, and U3 buys on the same day as its visit.
- [ ] **Step 3: The dbt-duckdb project**, outside the repo, with a time spine, one semantic model per seed, and these metrics.
  - **Simple:**
    - `revenue` (sum amount) and `orders` (count);
    - `refunds_card` (sum amount, filtered `status = 'refund'`; the refunds measure's only simple metric).
  - **Balances:**
    - `mrr`: sum over a measure with `non_additive_dimension { snapshot_date, max, [account] }`;
    - `mrr_two`: the same with `[account, region]`;
    - `mrr_first`: `window_choice: min`.
  - **Cumulative, all with `period_agg: last`:**
    - `revenue_7d`, `revenue_2w`;
    - `revenue_wtd`, `revenue_mtd`, `revenue_qtd`, `revenue_ytd`;
    - `eu_revenue_7d` (filter `region = 'EU'`).
  - **Cumulative, each skipped for its reason:**
    - `revenue_7d_first` (no `period_agg`);
    - `revenue_all_time`;
    - `revenue_rolling_month` (`window: 1 month`);
    - `revenue_7d_filled` (`fill_nulls_with: 0`);
    - `refunds_7d` (on the refunds measure);
    - `mrr_7d` (over the balance).
  - **Derived and conversion:**
    - `aov_7d` = `revenue_7d / orders_7d`, with `orders_7d` cumulative `last`;
    - offsets `revenue_ly` (`offset_window: 1 year`), `revenue_yoy_change`, `revenue_yoy_growth`;
    - conversion `visit_to_buy` (7 days, `conversion_rate`).
- [ ] **Step 4: `mf query` into `expected.json`.**
  - **`byDay`:** every importable cumulative metric and `aov_7d` by `metric_time__day`. A day MetricFlow omits means `null`.
  - **`byMonth`:** the same by `metric_time__month`.
  - **`mrr`:**
    - by total, by `region`, by `metric_time__month`;
    - `mrr_first` the same three ways.
  - **`controls`:**
    - `revenue_7d_first` and `revenue_rolling_month` by day and by month;
    - `revenue_ly` by month;
    - `visit_to_buy` total.
- [ ] **Step 5: README.md.** Record the exact dbt, MetricFlow and dbt-duckdb versions and every command. Record, each with a link:
  - every "(to verify)" field above;
  - MetricFlow's window bounds;
  - what `period_agg: last` returns for an ended month;
  - MetricFlow's week start;
  - whether semi-additive rows partition by the entity only (and by the queried time grain) or by grouped dimensions too;
  - whether rows with a NULL entity are dropped or grouped;
  - whether `revenue_ly` for 2024-02 counts 2023-02-28 twice;
  - the conversion join bounds and attribution.

  **Stop and tell the owner** if MetricFlow counts A07 in both regions by `region`. Task 3 is then not built, `window_groupings` stays skipped, and the README says why.
- [ ] **Step 6: Commit.** `git add scripts/fixtures/golden/dbt-f1 scripts/fixtures/dbt-part5` · "Pin f1's dbt translation and add a fixture of dbt's cumulative and per-entity shapes with MetricFlow's figures"

### Task 2: Cumulative metrics become period windows

**Files:**
- Create `src/app/dbtCumulative.ts`.
- Modify `src/app/dbtImport.ts`:
  - `translateDbt` takes the calendar and returns `notes`;
  - cumulative metrics are translated after simple metrics and before ratio and derived ones;
  - `DbtSkip` is widened.
- Create `scripts/dbtHarness.ts`: f1's `post`, `uploadJson`, `figure`, `metricNamed` and `allMetricNames`, moved out of `scripts/test-dbtImport.ts` so both suites share one copy.
- Test: create `scripts/test-dbtPart5.ts` (§ cumulative).

**Interfaces:**
- Consumes:
  - f1's `parseDbtWhere(text, entity): FilterStep[] | null`;
  - `MetricWindow` (`src/analysis/periodMetric.ts`);
  - `CalendarPrefs` and `DEFAULT_CALENDAR` (`src/analysis/dateIntel.ts`);
  - `ModelMetric` (`src/app/modelFormat.ts`, with f1's `importedFrom`).
- Produces:
  - `type DbtSkip = <f1's ten> | 'all_time' | 'period_agg' | 'window_unit' | 'calendar_differs' | 'no_base_metric' | 'fill_nulls' | 'live_refused'`.
  - `type DbtNote = 'in_progress' | 'follows_calendar'`.
  - `translateDbt(json: unknown, datasets: Array<{ id: string; name: string; columns: ParsedColumn[]; live?: boolean }>, datasetMap: Record<string, string>, calendar: CalendarPrefs): { model: ParsedModel; skipped: Array<{ name: string; kind: 'metric' | 'dimension' | 'entity' | 'semanticModel'; reason: DbtSkip }>; notes: DbtNote[] }`. `notes` is sorted and distinct. f1's test calls gain `DEFAULT_CALENDAR`.
  - In `dbtCumulative.ts`:
    - `cumulativeWindow(typeParams: unknown, cal: CalendarPrefs): { window: MetricWindow } | { skip: 'cumulative' | 'all_time' | 'window_unit' | 'calendar_differs' | 'period_agg' }`;
    - `translateCumulative(m: Record<string, unknown>, ctx: CumulativeCtx): { metric: ModelMetric } | { skip: DbtSkip }`;
    - `interface SimpleTranslation { metric: ModelMetric; measure: string | null; filtered: boolean }`;
    - `interface CumulativeCtx { simple: ReadonlyMap<string, SimpleTranslation>; measures: ReadonlyMap<string, { nonAdditive: boolean; hasDataset: boolean }>; where: (text: string, measure: string) => FilterStep[] | null; shell: (m: Record<string, unknown>) => Pick<ModelMetric, 'id' | 'name' | 'base'> & { importedFrom: { kind: 'dbt'; name: string } }; calendar: CalendarPrefs }`.
    - `shell` is f1's per-metric id, name and `importedFrom`. f1's ids are deterministic, and its plan hash relies on that.

- [ ] **Step 1: Write the failing test.**
```ts
const W = (tp: unknown, cal = DEFAULT_CALENDAR) => cumulativeWindow(tp, cal);
const skipOf = (r: ReturnType<typeof cumulativeWindow>): string | undefined => ('skip' in r ? r.skip : undefined);
const ctp = (o: object) => ({ cumulative_type_params: { period_agg: 'last', ...o } });
const SUN = { ...DEFAULT_CALENDAR, weekStart: 0 }, APR = { ...DEFAULT_CALENDAR, fiscalYearStart: 4 }, R445 = { ...DEFAULT_CALENDAR, calendarType: '445' as const };
ok('7 days', isDeepStrictEqual(W(ctp({ window: { count: 7, granularity: 'day' } })), { window: { last: 7, unit: 'day' } }));
ok('2 weeks is 14 days, never calendar weeks (RF 2)', isDeepStrictEqual(W(ctp({ window: { count: 2, granularity: 'week' } })), { window: { last: 14, unit: 'day' } }));
for (const [tp, why] of [
  [ctp({ window: { count: 1, granularity: 'month' } }), 'window_unit'], // RF 2
  [ctp({ window: { count: 367, granularity: 'day' } }), 'window_unit'], [ctp({ window: { count: 53, granularity: 'week' } }), 'window_unit'],
  [ctp({ window: { count: 12, granularity: 'hour' } }), 'window_unit'], [ctp({ grain_to_date: 'day' }), 'window_unit'], [ctp({ grain_to_date: 'fiscal_quarter' }), 'window_unit'],
  [{ cumulative_type_params: { window: { count: 7, granularity: 'day' } } }, 'period_agg'], // RF 1: dbt's default is first
  [ctp({ window: { count: 7, granularity: 'day' }, period_agg: 'first' }), 'period_agg'], [ctp({ window: { count: 7, granularity: 'day' }, period_agg: 'average' }), 'period_agg'],
  [{ window: { count: 7, granularity: 'day' } }, 'period_agg'], // an older manifest: top-level window, no period_agg
  [ctp({}), 'all_time'], [ctp({ window: { count: 7, granularity: 'day' }, grain_to_date: 'month' }), 'cumulative'],
  [{ window: { count: 7, granularity: 'day' }, cumulative_type_params: { window: { count: 8, granularity: 'day' }, period_agg: 'last' } }, 'cumulative'],
] as const) ok(`skip ${why}: ${JSON.stringify(tp)}`, skipOf(W(tp)) === why);
ok('to date, dbt calendar', ['week', 'month', 'quarter', 'year'].every((g) => isDeepStrictEqual(W(ctp({ grain_to_date: g })), { window: { to_date: g } })));
ok('calendar differs (RF 3)', skipOf(W(ctp({ grain_to_date: 'week' }), SUN)) === 'calendar_differs' && ['quarter', 'year'].every((g) => skipOf(W(ctp({ grain_to_date: g }), APR)) === 'calendar_differs') && ['week', 'month', 'quarter', 'year'].every((g) => skipOf(W(ctp({ grain_to_date: g }), R445)) === 'calendar_differs'));
ok('under April and 4-4-5, month to date (April) and last 7 days still map', 'window' in W(ctp({ grain_to_date: 'month' }), APR) && 'window' in W(ctp({ window: { count: 7, granularity: 'day' } }), R445));

const { model, skipped, notes } = translateDbt(P5, P5_DATASETS, {}, DEFAULT_CALENDAR);
const m = (n: string) => metricNamed(model, n);
ok('a window over the simple metric on its measure', isDeepStrictEqual(m('revenue_7d').definition, { base: m('revenue').id, window: { last: 7, unit: 'day' } }));
ok('a period metric stores no timeColumn and takes its base\'s format', m('revenue_7d').timeColumn === undefined && isDeepStrictEqual(m('revenue_7d').format, m('revenue').format));
ok('its own filter becomes its filters, over the unfiltered base', isDeepStrictEqual(m('eu_revenue_7d').filters, [{ type: 'filter', column: 'region', op: '=', value: 'EU' }]) && (m('eu_revenue_7d').definition as { base: string }).base === m('revenue').id);
ok('importedFrom carries the dbt name', m('revenue_ytd').importedFrom?.name === 'revenue_ytd');
ok('a derived metric over two windows becomes f1\'s formula', m('aov_7d').definition.formula === '[revenue_7d] / [orders_7d]');
for (const [name, why] of [['revenue_7d_first', 'period_agg'], ['revenue_all_time', 'all_time'], ['revenue_rolling_month', 'window_unit'], ['revenue_7d_filled', 'fill_nulls'], ['refunds_7d', 'no_base_metric'], ['mrr_7d', 'cumulative'], ['visit_to_buy', 'conversion'], ['revenue_ly', 'time_offset'], ['revenue_yoy_change', 'time_offset'], ['revenue_yoy_growth', 'time_offset']] as const)
  ok(`${name}: skipped, ${why} (RF 1, 2, 5)`, skipped.some((s) => s.name === name && s.reason === why) && !m(name));
ok('every metric is translated or named', allMetricNames(P5).every((n) => !!m(n) || skipped.some((s) => s.name === n)));
ok('notes', isDeepStrictEqual(notes, ['follows_calendar', 'in_progress']));
ok('no window metric, no notes', translateDbt(dropFourKinds(F1_MANIFEST), F1_DATASETS, {}, DEFAULT_CALENDAR).notes.length === 0);
```
Metric names in the fixture have no labels, so the Ordinate name is the dbt name. The helpers are listed under Task 4.

- [ ] **Step 2: Run it and watch it fail.** `npm run build:ts && node scripts/test-dbtPart5.js`. Expected: FAIL, `cumulativeWindow` is not defined.
- [ ] **Step 3: Implement the two functions in `src/app/dbtCumulative.ts`, and the calls in `dbtImport.ts`.**

  **`cumulativeWindow`.** Reading the parameters:
  - Read `cumulative_type_params` first, falling back to the top-level `window` and `grain_to_date`.
  - A value set in both places that differs, both a window and a grain, or a non-integer or non-positive count → `cumulative`.
  - Neither a window nor a grain → `all_time`.

  Then the window or grain:
  - Day windows give `last: count`; week windows give `7 × count`. Anything over 366 days, or any other unit, → `window_unit`.
  - A grain of `week`, `month`, `quarter` or `year` maps; any other grain → `window_unit`.
  - The calendar check (`dbtCalendar`, one line): every to-date needs a Gregorian calendar (`calendarType` absent or `'gregorian'`). `week` also needs `weekStart === 1`, and `quarter` and `year` need `fiscalYearStart === 1`. Otherwise `calendar_differs`.
  - `period_agg !== 'last'` → `period_agg`, checked last.

  **`translateCumulative`.**
  - The input is read where Task 1 recorded it (`type_params.measure` in the measure-based spec).
  - Skip reasons, in this order:
    - the input's model has no dataset → `no_dataset`;
    - the input measure is non-additive → `cumulative`;
    - `fill_nulls_with` set → `fill_nulls`.
  - The base is the first, by dbt name, `SimpleTranslation` with `measure === input`, `!filtered`, no `definition.snapshot` and a `timeColumn`. With none → `no_base_metric`.
  - `filters` are the input's filter followed by the metric's own, each through `ctx.where`; any `null` → `filter_shape`.
  - The result is `{ ...shell(m), dataset: base.metric.dataset, definition: { base: base.metric.id, window }, format: base.metric.format, filters? }`, with no `timeColumn`.
  - `notes`: `in_progress` for any mapped window, and `follows_calendar` for any `to_date`.
- [ ] **Step 4: Run the tests and watch them pass.** `npm run build:ts && node scripts/test-dbtPart5.js && node scripts/test-dbtImport.js`. Expected: PASS. In `test-dbtImport`, only f1's expectations for its four-kind metrics change, to the reasons f2 now gives. Change nothing else in that suite.
- [ ] **Step 5: Commit.** `git add src/app/dbtCumulative.ts src/app/dbtImport.ts scripts/dbtHarness.ts scripts/test-dbtPart5.ts scripts/test-dbtImport.ts` · "Import dbt cumulative metrics as period windows when they are exact, naming every one that is not"

### Task 3: One window grouping becomes `snapshot.per`

**Files:**
- Modify `src/app/dbtImport.ts`, f1's `non_additive_dimension` branch.
- Test: `scripts/test-dbtPart5.ts` (§ per).

**Interfaces:**
- Consumes `MetricSnapshot.per` (`src/analysis/snapshot.ts`), and `translateDbt`'s `datasets[].live` from Task 2.
- Produces: nothing new. The branch writes `snapshot.per` and, per Task 1's finding, a `not_empty` step.

- [ ] **Step 1: Write the failing test.**
```ts
const { model, skipped } = translateDbt(P5, P5_DATASETS, {}, DEFAULT_CALENDAR);
const m = (n: string) => metricNamed(model, n);
ok('one entity becomes per (RF 4)', isDeepStrictEqual(m('mrr').definition.snapshot, { column: 'snapshot_date', take: 'last', per: 'account_id' }));
ok('min is first', m('mrr_first').definition.snapshot?.take === 'first' && m('mrr_first').definition.snapshot?.per === 'account_id');
ok('rows with no account are left out, as MetricFlow leaves them out (RF 4; Task 1)', m('mrr').filters?.some((s) => s.column === 'account_id' && s.op === 'not_empty'));
ok('two entities stay skipped', skipped.some((s) => s.name === 'mrr_two' && s.reason === 'window_groupings'));
ok('an entity whose expr is not a column', translateDbt(withEntityExpr(P5, 'account', 'lower(account_id)'), P5_DATASETS, {}, DEFAULT_CALENDAR).skipped.some((s) => s.name === 'mrr' && s.reason === 'not_a_column'));
ok('on a Live dataset: skipped, never imported dead (RF 4)', translateDbt(P5, liveBalances(P5_DATASETS), {}, DEFAULT_CALENDAR).skipped.some((s) => s.name === 'mrr' && s.reason === 'live_refused'));
ok('f1\'s plain snapshot is unchanged', isDeepStrictEqual(metricNamed(translateDbt(F1_MANIFEST, F1_DATASETS, {}, DEFAULT_CALENDAR).model, 'Stock').definition, metricNamed(GOLDEN_F1.model, 'Stock').definition));
```
- [ ] **Step 2: Run it and watch it fail.** `npm run build:ts && node scripts/test-dbtPart5.js`. Expected: FAIL, `mrr` is skipped `window_groupings`.
- [ ] **Step 3: Implement.** Exactly one grouping maps. The entity must be on the same semantic model, and its `expr` (or name) must be a column other than the snapshot column; otherwise → `not_a_column`. The dataset's `live` → `live_refused`. Then write `per` and, if Task 1 found the drop, the `not_empty` step. Two or more groupings stay `window_groupings`.
- [ ] **Step 4: Run the tests and watch them pass.** `node scripts/test-dbtPart5.js && node scripts/test-dbtImport.js`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/app/dbtImport.ts scripts/test-dbtPart5.ts` · "Import a dbt balance grouped by one entity as a per-entity snapshot, on extracts"

### Task 4: Through the dry run and apply, held to MetricFlow

**Files:**
- Modify `src/ipc/modelFiles.ts` (f1's dbt branch):
  - pass `getCalendar()`;
  - set each dataset's `live: isLive(meta)`;
  - put the translator's `notes` on the reply's `plan.source.notes` when there are any. They are not hashed: they follow from the items and the calendar, and both already move the hash.
- Modify `src/app/modelPlan.ts`: the `ImportPlan.source` type gains `notes?: DbtNote[]`. `SkipReason` already takes f1's `DbtSkip`.
- Test: `scripts/test-dbtPart5.ts` (§ route, § figures, § controls, § old imports).

**Interfaces:**
- Consumes `translateDbt` (Task 2); a2's `model:importPlan` and a3's `model:importApply`; `metric:values` with `filters`; `formats:set`; the fake Live connector as `scripts/test-liveBaseFilters.ts` uses it.
- Produces: `ImportPlan.source.notes?: DbtNote[]`.

- [ ] **Step 1: Write the failing test.**
```ts
process.env.ORDINATE_TODAY = '2024-07-01'; // after every seed: every bucket below has ended
const P = await seedProject({ orders: ORDERS_CSV, balances: BALANCES_CSV, events: EVENTS_CSV });
const tileIn = async (name: string, from: string, to: string) => valueOf(await post('metric:values', { projectId: P, ids: [idOf(P, name)], filters: [{ type: 'filter', column: dateOf(P, name), op: 'period', period: { preset: 'custom', from, to } }] }));
const plan = await post('model:importPlan', { projectId: P, fileToken: await uploadJson(P5) });
ok('window and per metrics are new; the notes are on the plan', ['revenue_7d', 'revenue_ytd', 'mrr'].every((n) => itemFor(plan, n).status === 'new') && isDeepStrictEqual(plan.plan.source.notes, ['follows_calendar', 'in_progress']));
await post('model:importApply', { projectId: P, fileToken: await uploadJson(P5), planHash: plan.plan.hash });
for (const [metric, day, want] of EXPECTED.byDay) ok(`${metric} on ${day} equals MetricFlow`, Object.is(await tileIn(metric, day, day), want) || PINNED.has(`${metric}:${day}`));
for (const [metric, month, want] of EXPECTED.byMonth) ok(`${metric} in ${month} equals MetricFlow`, Object.is(await tileIn(metric, ...monthRange(month)), want) || PINNED.has(`${metric}:${month}`));
for (const name of ['mrr', 'mrr_first']) for (const [group, want] of EXPECTED.mrr[name]) ok(`${name} by ${group || 'total'} equals MetricFlow (RF 4)`, Object.is(await figure(P, name, group), want));

// Negative controls: each skip is load-bearing.
const hand = async (name: string, definition: object, rest: object = {}) => post('metric:save', { projectId: P, input: { name, datasetId: dsOf(P, 'orders'), definition, ...rest } });
await hand('end of month 7d', { base: idOf(P, 'revenue'), window: { last: 7, unit: 'day' } });
ok('period_agg first: Ordinate\'s end-of-month window differs from dbt\'s (RF 1)', await someDiffers(EXPECTED.controls.revenue_7d_first.byMonth, (mo) => tileIn('end of month 7d', ...monthRange(mo))));
await hand('last 1 month', { base: idOf(P, 'revenue'), window: { last: 1, unit: 'month' } });
ok('a 1-month window differs from dbt\'s rolling month (RF 2)', await someDiffers(EXPECTED.controls.revenue_rolling_month.byDay, (d) => tileIn('last 1 month', d, d)));
await hand('LY prior', { base: idOf(P, 'revenue'), compare: { vs: 'previous_year', show: 'prior' } });
ok('a year compare differs from dbt\'s offset on 2024-02 or on a month in progress (RF 5)', !Object.is(await tileIn('LY prior', '2024-02-01', '2024-02-29'), byMonth(EXPECTED.controls.revenue_ly, '2024-02')) || await withToday('2024-03-15', async () => !Object.is(await tileIn('LY prior', '2024-03-01', '2024-03-31'), byMonth(EXPECTED.controls.revenue_ly, '2024-03'))));
await post('metric:save', { projectId: P, input: { name: 'hand funnel', datasetId: dsOf(P, 'events'), definition: { funnel: { entity: 'user_id', event: 'event', time: 'ts', steps: ['visit', 'buy'], window: { n: 7, unit: 'days' } }, show: 'rate' } } });
ok('a funnel differs from dbt\'s conversion with a repeat visitor (RF 5)', !Object.is(await figure(P, 'hand funnel', ''), EXPECTED.controls.visit_to_buy));
await hand('mrr with empties', { column: 'mrr', aggregation: 'sum', snapshot: { column: 'snapshot_date', take: 'last', per: 'account_id' } }, { datasetId: dsOf(P, 'balances') });
// Only with Task 1's finding that MetricFlow drops rows with no entity; with the other finding there is no step, and no control.
ok('without the not_empty step the total differs (RF 4)', !Object.is(await figure(P, 'mrr with empties', ''), EXPECTED.mrr.mrr.find(([g]) => g === '')![1]));

// The calendar decides, and moves the hash (RF 3).
const P2 = await seedProject({ orders: ORDERS_CSV });
const before = await post('model:importPlan', { projectId: P2, fileToken: await uploadJson(P5) });
await post('formats:set', { fiscalYearStart: 4 });
const late = await post('model:importApply', { projectId: P2, fileToken: await uploadJson(P5), planHash: before.plan.hash });
ok('a calendar change between dry run and apply is refused', late.ok === false && late.error === modelPlanChanged());
const after = await post('model:importPlan', { projectId: P2, fileToken: await uploadJson(P5) });
ok('under April, YTD is skipped and 7d is not', itemFor(after, 'revenue_ytd').reason === 'calendar_differs' && itemFor(after, 'revenue_7d').status === 'new');
await post('formats:set', { fiscalYearStart: 1 });

// Live: the route passes the flag.
const P3 = await seedProjectWithLiveBalances();
ok('per on a Live dataset is skipped live_refused', itemFor(await post('model:importPlan', { projectId: P3, fileToken: await uploadJson(P5) }), 'mrr').reason === 'live_refused');

// Old imports byte-identical.
const f1Now = stableStringify(withoutFourKinds(translateDbt(F1_MANIFEST, F1_DATASETS, {}, DEFAULT_CALENDAR), GOLDEN_F1));
ok('f1\'s translation is byte-identical outside the four kinds', f1Now === stableStringify(withoutFourKinds(GOLDEN_F1, GOLDEN_F1)));
ok('a manifest without the four kinds translates to f1\'s model byte for byte', stableStringify(translateDbt(dropFourKinds(F1_MANIFEST), F1_DATASETS, {}, DEFAULT_CALENDAR).model) === stableStringify(GOLDEN_F1.model)); // f1 translated none of the four kinds
const P4 = await seedProject(F1_SEED);
const firstPlan = await post('model:importPlan', { projectId: P4, fileToken: await uploadJson(F1_MANIFEST) });
await post('model:importApply', { projectId: P4, fileToken: await uploadJson(F1_MANIFEST), planHash: firstPlan.plan.hash });
const again = await post('model:importPlan', { projectId: P4, fileToken: await uploadJson(F1_MANIFEST) });
ok('a re-import writes nothing', again.plan.counts.updated + again.plan.counts.new + again.plan.counts.conflict + again.plan.counts.renamed === 0);
```
The helpers are short and test-only. Each goes in `scripts/dbtHarness.ts` when first used:
- **Projects:** `seedProject(csvs)`, and `seedProjectWithLiveBalances()` (a Live balances dataset on the fake connector, as `test-liveBaseFilters` makes one).
- **Ids:** `idOf` and `dsOf` (a metric's or a dataset's id by name), and `dateOf` (the date a metric counts by: its base's for a period metric).
- **Figures and dates:** `valueOf` (the figure out of a `metric:values` reply), `monthRange('2024-02')` → `['2024-02-01', '2024-02-29']`, and `byMonth(list, month)` (the value at that month).
- **Comparison and time:** `someDiffers(pairs, get)` (true when any pair differs by `Object.is`), and `withToday(day, fn)` (sets `ORDINATE_TODAY` for `fn`, then restores it).
- **The four kinds:** `withoutFourKinds(translation, golden)` drops the skipped entries with the four reasons, plus the metrics `golden` skipped for them; `dropFourKinds(manifest)` removes those metrics from a manifest.
- **Fixture variants:** `withEntityExpr(manifest, entity, expr)`, and `liveBalances(datasets)` (the balances dataset marked `live: true`).

`modelPlanChanged` is a2's stale-hash sentence.

- [ ] **Step 2: Run it and watch it fail.** `npm run build:ts && node scripts/test-dbtPart5.js`. Expected: FAIL. The route does not pass the calendar, and `source.notes` is undefined.
- [ ] **Step 3: Implement the route and type changes listed under Files.** If a figure assertion fails, it is not pinned. Apply Global Constraints' "figures decide": remove that mapping and record why in the README.
- [ ] **Step 4: Run the tests and watch them pass.** `node scripts/test-dbtPart5.js && node scripts/test-dbtImport.js && node scripts/test-modelPlan.js && node scripts/test-modelApply.js && node scripts/check-contracts.js`. Expected: all PASS, and check-contracts reports 0.
- [ ] **Step 5: Commit.** `git add src/ipc/modelFiles.ts src/app/modelPlan.ts scripts/test-dbtPart5.ts scripts/dbtHarness.ts` · "Hold dbt's imported windows and per-entity balances to MetricFlow's figures through the dry run and apply"

### Task 5: The dry run says why, and the docs say what maps

**Files:**
- Modify `web/src/features/model/api.ts`: `SkipReason` gains the seven new codes, plus `DbtNote` and `ImportPlan.source.notes?`.
- Modify `web/src/features/model/importPlanText.ts`: the words below.
- Modify `web/src/features/model/ImportDialog.tsx`: notes under f1's copy notice.
- Modify `web/src/features/model/importDialog.test.tsx`.
- Modify `docs/server/model-files.md`: in the "From dbt" section, the table from "What f2 maps" above, plus the in-progress and calendar paragraphs.
- Modify `CHANGELOG.md`.
- Modify `plugins/ordinate/skills/*/SKILL.md` only if f1 listed dbt skip codes there.

**Interfaces:** Consumes `ImportPlan.source.notes` (Task 4) and the `DbtSkip` codes (Task 2).

The words (the detail beside the metric's name). Each one is decided here.

**New reasons**

| Reason | Words |
|---|---|
| `all_time` | a running total since the first day: Ordinate's windows are "to date" or "last N days" |
| `period_agg` | dbt reads it at the start of each week or month (period_agg: first, its default); Ordinate at the end. Set period_agg: last in dbt to import it |
| `window_unit` | a window in months, quarters, years or hours, or a custom grain: Ordinate's rolling windows count whole days, up to 366 |
| `calendar_differs` | dbt's weeks start on Monday and its year in January; this workspace's calendar differs |
| `no_base_metric` | no unfiltered simple metric on its measure to build on: add one in dbt and import again |
| `fill_nulls` | dbt shows 0 where the window has no rows (fill_nulls_with); Ordinate shows no figure |
| `live_refused` | a latest value per entity can't be computed on a Live dataset yet |

**Rewritten reasons**

| Reason | Words |
|---|---|
| `conversion` | dbt counts a conversion after any base event; Ordinate's funnel counts from each one's first, so the figures differ |
| `time_offset` | dbt shifts each day and then adds the days up, so its periods don't line up with Ordinate's "same period last year". Make it here as a change on last year |
| `cumulative` | not a window over a plain metric: over a balance, or with both a window and a grain |
| `window_groupings` | grouped by more than one entity: Ordinate keeps each latest value per one column |

**Notes**

| Note | Words |
|---|---|
| `in_progress` | Window metrics match dbt for every day and every period that has ended. For the period in progress Ordinate counts up to today, and a "last N days" window up to yesterday. |
| `follows_calendar` | To-date metrics follow this workspace's calendar: they match dbt while weeks start on Monday and the year in January. |

- [ ] **Step 1: Write the failing test.** It checks four things:
  - a plan holding one item for each new reason shows each one's words exactly;
  - `conversion` and `time_offset` show their rewritten words;
  - `source.notes: ['follows_calendar', 'in_progress']` shows both sentences under the copy notice;
  - a plan without `notes` shows neither.
- [ ] **Step 2: Run it and watch it fail.** `npm run test:web -- importDialog`. Expected: FAIL, unknown reason codes fall through to the default line.
- [ ] **Step 3: Implement.** Add one `case` per code in `skippedLine` and a notes list in `ImportDialog`. Then:
  - the docs table and paragraphs;
  - a CHANGELOG line;
  - `npm run build:ts && node scripts/i18n-extract.js --dry`, which should report no new key (see Global Constraints).
- [ ] **Step 4: Run the tests and watch them pass.** `npm run test:web && npm run build:web && npm run lint && node scripts/test-i18n.js && node scripts/test-file-size.js`. Expected: all PASS, and lint reports 0.
- [ ] **Step 5: Commit.** `git add web/src/features/model docs/server/model-files.md CHANGELOG.md` · "Say in the dbt dry run why a metric is skipped and when imported windows match dbt"

**Before the PR:** `npm test`, `npm run test:web`, `npm run lint`. Push outside work hours, then open the PR to `develop`.
