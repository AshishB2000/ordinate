# Semantic layer part 5, step 08: funnel metrics — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Visit → buy" is a metric (D5): its conversion rate, converted or entered, from the funnel grid's own matching, saved from the grid with **Save as metric** (D7). A dashboard filter picks **who enters**; the metric's own filters and the row lock pick **which events count** (D6, owner's answer 2), so a bar for Germany by entry country equals the tile filtered to Germany.
**Architecture:** The funnel engine gains one runtime input, the **entry filters**, on both paths: `buildEventFunnel` (`src/analysis/funnelEvents.ts:174-241`) and `funnelGroupsResident` (`src/engine/funnelResident.ts:43-129`), held to `Object.is`; `foldEventFunnel` is unchanged. It rides on `FunnelEncoding.entry`, which the server sets and `sanitizeEventFunnel` never reads from a client, so saved visuals are unchanged and the chart door's cache key (which holds the encoding) separates entry scopes. A funnel metric's KPI is one chart-door call (`vizDataFor` with `eventFunnel`), so resident-or-JS, the lock, terms, Live's `funnel` refusal and the answer cache come from the door. Charts reuse step 06: by entry date, `bucketSeries`; by a category, the engine's breakdown.
**Tech Stack:** `src/analysis`, `src/engine` (DuckDB), `src/ipc`, `src/api` (zod), React (`web/src/charts/grids`, `web/src/features/analyses/metrics`), self-checks, Vitest, Playwright.
**Spec:** docs/semantic-layer/05-metrics-depth.md (D5, D6, D7; Tests "Funnel") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p5-00-index.md
**Branch and PR:** `feat/semantic-p5-08-funnel-metrics` off `origin/develop` after step 07 merges. Release 5B.

## Rolling deploy

New stored shape: `definition: { funnel, show }` (step 01 keeps it; a 5A pod shows "—" and refuses it on charts). A KPI card or alert on one stores `column: ''`, the `metricId`, `aggregation: 'sum'`; a chart measure stores `{ column: funnel.entity, aggregation: 'countd', metricId }`, which only a deleted metric ever draws (part 1's "Metric deleted" chip). `FunnelEncoding.entry` is runtime-only: never stored, never sanitized in.

## Global Constraints

- **Matching is the grid's** (`funnelEvents.ts:1-19`, `:196-240`): entry at the first step-1 event; each later step the earliest event strictly after the previous; within the window from entry; duplicates once; rows with no entity or an unreadable time excluded and counted.
- **Entry filters pick which step-1 events may be the entry**: an entity enters at its first step-1 event that passes them. Every event, entry or not, still passes the metric's own filters and the lock (the `filters` argument, as today).
- `rate = counts[last] / counts[0]`, null when `counts[0] === 0` (format percent); `converted = counts[last]`; `entered = counts[0]`.
- **Additivity:** `entered` and `converted` add across categories (one entry per entity), not across time; `rate` adds across neither (part 1's `additivityOf`).
- The grid (`encoding.eventFunnel` with no `entry`) is byte-identical: its filters still filter every event (D7).
- A funnel measure charts alone (step 06's `measureChartsAlone`); a breakdown has at most 12 groups (`FUNNEL_BREAKDOWN_CAP`, `:42`) with the existing "truncated" note.
- Its date (`metricDate`, part 1) is `funnel.time` when that is a `date` column, else unset.
- Live: the door's existing `funnel` refusal (`liveSpec.ts:316`, `liveFunnelRefused`), thrown as `LiveFigureError` from the KPI branch so tiles show it typed.
- Sentences in `src/analysis/metricCheckMessages.ts`, then `node scripts/i18n-extract.js`. `src/ipc/visuals.ts` gets no line; `src/ipc/metrics.ts` gets ≤ 4.
- Commits carry no Co-Authored-By or AI trailer.

## Review Focus

- **Bar = tile, and its one edge (flagged for the owner).** A category chart uses the engine's breakdown: an entity counts under its entry event's value, once. A tile filtered to Germany admits an entity at its first *German* step-1 event. The two differ only for an entity whose step-1 events carry different countries; then the bars add up (D7) and the filtered tiles do not. The test fixture pins both: equality for one-country entities, and the documented difference for a two-country one.
- **The negative control (spec):** applying the scope to every event instead of the entry changes the Germany tile on a fixture where Germans buy from France. Pinned in Task 1.
- **The lock still filters later events.** Pinned in Task 2 with a lock on `channel` that hides purchases.
- **`filterCannotWarn` (`src/ipc/visualsEngines.ts:39`)** gates the resident path on the filters; it must gate on the entry filters too, or a skipped entry filter would widen who enters. Pinned in Task 1.
- **"Recent entries may still convert":** when the entry period's end plus the window is after today, the tile notes it. Pinned in Task 2.

---

### Task 1: Entry filters in both engines

**Files:** Modify `src/analysis/funnelEvents.ts` (`FunnelEncoding :30-38` gains `entry?: FilterStep[]`; `buildEventFunnel` marks entry-eligible step-1 events), `src/engine/funnelResident.ts` (`raw` gains `x`, the entry predicates; `s0` takes `WHERE n = ? AND x`), `src/ipc/visualsEngines.ts:39` (also over `encoding.eventFunnel.entry`). Test: `scripts/test-funnelEvents.ts` (extend `testDifferential :169-197`).
**Interfaces:** Produces `FunnelEncoding.entry?: FilterStep[]`. JS: the rows that pass `applyPipeline(table, entry)` (tag each row with its ordinal first) are the eligible ones; `entry` = the eligible step-1 event with the least `(t, o)`. SQL: `(${filterPredicates(cols, entry, params).join(' AND ') || 'TRUE'}) AS x` in `raw`'s select list; its params are pushed **before** the filters' (statement-text order, `:64-66`). `sanitizeEventFunnel` (`:82-97`) is unchanged and drops `entry`.
- [ ] **Step 1: Write the failing test.** Fixture `SHOP` (≥ 1,200 rows, written to Parquet by `fixture()` `:136-142`): `user`, `event` (visit/cart/buy), `ts`, `country`, `channel`. Most users have one country; users `g1..g20` visit from Germany and buy with `country = 'France'`; user `x1` visits from France first, then from Germany.
  ```ts
  const E = (country: string) => ({ ...enc(), entry: [eq('country', country)] });
  ok('no entry filters: the grid, byte for byte', JSON.stringify(run(ROWS, enc())) === JSON.stringify(run(ROWS, { ...enc(), entry: [] })));
  for (const [label, e, f] of [['Germany entries', E('Germany'), []], ['March entries', { ...enc(), entry: [MARCH_TS] }, []], ['Germany, own filter channel=web', E('Germany'), [eq('channel', 'web')]], ['nobody enters', E('Mars'), []]] as const)
    await diff(`entry: ${label}`, SHOP, e, f);   // buildEventFunnel vs eventFunnelResident, firstDiff with Object.is
  const g = run(ROWS, E('Germany')).funnel;
  ok('Germans who bought from France convert', g.counts[2] === G_BUYERS);
  ok('NEGATIVE CONTROL: the same filter on every event loses them (D6)', run(ROWS, enc(), [eq('country', 'Germany')]).funnel.counts[2] < g.counts[2]);
  ok('sanitizeEventFunnel never reads entry from a client', !('entry' in sanitizeEventFunnel({ ...enc(), entry: [eq('country', 'Germany')] })!));
  ok('an entry filter on a missing column falls back to JS, never skipped', await residentDeclines(E_ON_MISSING_COLUMN));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-funnelEvents.js` → the Germany case counts every visit.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-funnelEvents.js scripts/test-engineIpc.js scripts/test-termSites.js` (re-count `funnelResident.ts` and `funnelEvents.ts` there).
- [ ] **Step 5: Commit.** `git add src/analysis/funnelEvents.ts src/engine/funnelResident.ts src/ipc/visualsEngines.ts scripts/test-funnelEvents.ts scripts/termSites.ts && git commit -m "Let a funnel's entry be filtered apart from its events, in JS and in place"`

### Task 2: The funnel kind, through the KPI door

**Files:** Create `src/ipc/funnelMetric.ts`. Modify `src/api/metrics.ts` (a `Definition` arm), `src/ipc/metrics.ts` (`resolveDefinition :121`, one branch; `metric:save`/`metric:update` call the check), `src/analysis/metricTimeScope.ts` (`metricDate` for a funnel), `src/analysis/additivity.ts`, `src/analysis/metricFormat.ts` (words), `src/analysis/pendingKinds.ts` (a funnel is no longer pending), `src/analysis/metricCheckMessages.ts`. Test: create `scripts/test-funnelMetrics.ts` (harness: `scripts/test-periodMetrics.ts`, with a Live copy over the fake warehouse).
**Interfaces:** Produces
```ts
// src/api/metrics.ts
z.strictObject({ funnel: z.strictObject({ entity: Col, event: Col, time: Col, steps: z.array(z.string().max(400)).min(2).max(8), window: z.strictObject({ n: z.number().int().min(1).max(100_000), unit: z.enum(['hours', 'days']) }) }), show: z.enum(['rate', 'converted', 'entered']) })
// src/ipc/funnelMetric.ts
export async function funnelMetricValue(ctx: ResolveCtx, datasetId: string, def: MetricFunnelDefinition, ownFilters: FilterStep[], depth: number): Promise<number | null>
export function funnelFigure(f: EventFunnel, show: FunnelShow): number | null
export async function checkFunnelDefinition(projectId: string, datasetId: string, def: MetricFunnelDefinition): Promise<{ error: string; field: 'definition' } | null>   // entity, event, time are columns
// metricCheckMessages.ts
funnelMayStillConvert(): string                // "Recent entries may still convert."
funnelExcluded(n: string): string              // "{n} rows without an entity or a readable time were left out."
funnelEntryNotOwn(column: string): string      // "A filter on “{column}” can't pick who enters this funnel: it is not a column of its dataset."
```
`funnelMetricValue`: `own = resolveFilterParams(ownFilters).steps`; `entry = (await expandTerms(projectId, datasetId, ctx.scope)).steps` (its notes go to `ctx.info.notes`); an entry step on a column the dataset lacks → null with `funnelEntryNotOwn`; then `vizDataFor(projectId, datasetId, { category: '', values: [], eventFunnel: { ...def.funnel, entry } }, own, { params: ctx.params })`. A Live refusal reply is thrown as `new LiveFigureError(reply)`; `data.eventFunnel` gives the figure. Notes: `funnelExcluded` when `excluded > 0`; `funnelMayStillConvert` when the scope's range on `time` ends later than today minus the window.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const rate = await save('Visit → buy', { funnel: F, show: 'rate' }), conv = await save('Buyers', { funnel: F, show: 'converted' }), ent = await save('Visitors', { funnel: F, show: 'entered' });
  const grid = (await chart({ category: '', values: [], eventFunnel: F })).data.eventFunnel;
  ok('no scope: entered and converted are the grid\'s first and last counts', Object.is(await kpi(ent, []), grid.counts[0]) && Object.is(await kpi(conv, []), grid.counts[2]));
  ok('rate is converted ÷ entered', Object.is(await kpi(rate, []), grid.counts[2] / grid.counts[0]));
  ok('resident = JS through the door', Object.is(await kpi(rate, [GERMANY]), await withoutResident(() => kpi(rate, [GERMANY]))));
  ok('a tile filtered to Germany admits German entries only, and keeps their French purchases', Object.is(await kpi(conv, [GERMANY]), G_BUYERS));
  ok('the lock still filters later events', Object.is(await asLockedTo('channel', 'store', () => kpi(conv, [])), refConvertedWhere((e) => e.channel === 'store')));
  ok('a period on time is an entry period, and says recent entries may still convert', (await resolved(conv, [LAST_3_DAYS_TS])).notes?.includes(msg.funnelMayStillConvert()));
  ok('NEGATIVE CONTROL: an old period has no such note', !(await resolved(conv, [MARCH_TS])).notes?.includes(msg.funnelMayStillConvert()));
  ok('nobody entered: rate is null, entered is 0', (await kpi(rate, [MARS])) === null && (await kpi(ent, [MARS])) === 0);
  ok('Live: the typed funnel refusal, never hydrated', (await liveTile(rateL)).code === 'live_refused' && (await liveTile(rateL)).reason === 'funnel' && !hydrated);
  ok('a one-step funnel is refused at save', (await trySave({ funnel: { ...F, steps: ['visit'] }, show: 'rate' })).status === 400);
  ok('words', describeDefinition(rate) === 'visit → buy within 7 days, conversion rate');
  ok('additivity: converted adds across categories, not time; rate neither', same(additivityOf(conv, COLS, byName), true, false) && same(additivityOf(rate, COLS, byName), false, false));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-funnelMetrics.js` → the contract refuses `{ funnel }`.
- [ ] **Step 3: Implement** as specified, then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-funnelMetrics.js scripts/test-metrics.js scripts/test-part5Readers.js scripts/test-liveRoute.js scripts/test-liveSafetyNet.js scripts/test-rowPolicySafetyNet.js scripts/test-termDoors.js scripts/check-contracts.js scripts/test-i18n.js scripts/test-file-size.js`.
- [ ] **Step 5: Commit.** `git add src scripts/test-funnelMetrics.ts && git commit -m "Compute a funnel metric through the chart door, its scope picking who enters"`

### Task 3: Charts and alerts

**Files:** Modify `src/analysis/metricMeasures.ts` (step 06's `special` gains `'funnel'`), `src/ipc/vizMetricMeasures.ts` (dispatch), `src/ipc/funnelMetric.ts` (`funnelChartData`). Test: `scripts/test-funnelMetrics.ts`, section "chart".
**Interfaces:** Produces `funnelChartData(projectId, datasetId, metric, encoding, filters, opts): Promise<VizDataReply>`:
- category = `funnel.time` (a date column): step 06's `bucketSeries` with `figure = (f) => resolveMetric(P, metric.id, { filters: f }).value`;
- any other category: one `vizDataFor` with `eventFunnel: { ...funnel, breakdown: category, entry }`; each group's figure through `funnelFigure`; labels in the engine's order; `breakdown.truncated` gives the existing truncated warning.
Alerts need no change: step 05's `metricFor` already evaluates a funnel metric by `metricId`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const byCountry = await chart({ category: 'country', values: [M(conv)] }, []);
  ok('Germany\'s bar equals the Germany tile (one-country entities)', Object.is(valueAt(byCountry, 'Germany'), await kpi(conv, [GERMANY_ONLY_ONE_COUNTRY_USERS_SCOPE])));
  ok('the bars add up to the tile (one entry per entity)', Object.is(sum(byCountry.data.series[0].values), await kpi(conv, [])));
  ok('the documented edge: x1 counts under France in the chart, and in both filtered tiles', countsUnder(byCountry, 'x1') === 'France' && enteredIn(GERMANY, 'x1') && enteredIn(FRANCE, 'x1'));
  const byWeek = await chart({ category: 'ts', grain: 'week', values: [M(rate)] }, [MARCH_TS]);
  ok('by entry week: each point is its week\'s tile', byWeek.data.labels.every((l, i) => Object.is(byWeek.data.series[0].values[i], tileUnderWeek(rate, l))));
  ok('more than 12 countries: the truncated note', (await chart({ category: 'city', values: [M(conv)] }, [])).warnings?.some((w) => /truncated|top 12/i.test(w)));
  ok('a funnel measure with a second measure is refused', (await chart({ category: 'country', values: [M(conv), M(ent)] }, [])).error === msg.measureChartsAlone('Buyers'));
  ok('an alert on a funnel metric watches its figure', Object.is((await alertStore.metricFor(P, ruleOn(rate, [GERMANY]))).value, await kpi(rate, [GERMANY])));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-funnelMetrics.js` → the chart is refused as pending.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-funnelMetrics.js scripts/test-periodCharts.js scripts/test-chartsFollowMetric.js scripts/test-additivity.js scripts/test-alerts.js`.
- [ ] **Step 5: Commit.** `git add src scripts/test-funnelMetrics.ts && git commit -m "Chart a funnel metric by entry date or by its breakdown"`

### Task 4: Save as metric, and the editor

**Files:** Modify `web/src/charts/grids/Engine.tsx` (`FunnelView :208-287`: an `onSaveMetric?` prop, a **Save as metric** button in `Head`, beside `ExportButton`), `web/src/charts/grids/GridViz.tsx:17-60` (passes it), `web/src/features/visuals/ChartStage.tsx:39-76` (passes it), `web/src/features/visuals/Stage.tsx:133-148` (the builder sets it; dashboard tiles and Explore do not), `web/src/features/analyses/metrics/api.ts:16` (`Definition` gains the funnel arm, `isFunnel`), `web/src/features/analyses/metrics/MetricEditor.tsx` (a read-only **Funnel** mode). Create `web/src/features/analyses/metrics/FunnelFields.tsx` (+ test). Extend `web/e2e/grids.e2e.ts` (the funnel grid's spec).
**Interfaces:** `onSaveMetric(enc)` opens `MetricEditor` with the draft `{ name: \`${steps[0]} → ${steps.at(-1)}\`, datasetId, definition: { funnel: { entity, event, time, steps, window }, show: 'rate' }, filters: [] }` (the grid's `breakdown` and filters are not copied), as `editor/MetricLink.tsx:70-81` opens one. `FunnelFields({ value, onChange })`: the steps and window as text ("visit → cart → buy, within 7 days"), and **Show**: Conversion rate · Converted · Entered; Conversion rate sets the format to percent. The button label goes through the chart's own `t()` catalog, like `Head`'s other text.
- [ ] **Step 1: Write the failing tests.** Vitest: `FunnelView` with `onSaveMetric` shows "Save as metric" and calls it with the encoding; without the prop there is no button (NEGATIVE CONTROL: dashboard tiles); `FunnelFields` choosing "Converted" sends `show: 'converted'`. e2e: in the funnel grid, **Save as metric**, save, and the Metrics list shows the new metric with a figure.
- [ ] **Step 2: Run them to see them fail.** `npm run test:web -- Engine FunnelFields`.
- [ ] **Step 3: Implement** with existing components and CSS-module tokens.
- [ ] **Step 4: Run them to see them pass.** `npm run test:web && npm run build:web && npm --prefix web run e2e -- grids analyses && npm --prefix web run size && npm run lint`. Look at the screens in both themes.
- [ ] **Step 5: Commit.** `git add web && git commit -m "Save a funnel grid as a metric"`

## Existing tests that must stay green

`test-funnelEvents`, `test-engineIpc`, `test-cohort` (the engine door is shared), `test-liveRoute` (`:272`, the funnel refusal), `test-liveSafetyNet`, `test-rowPolicySafetyNet` (`:74`), `test-termSites`, `test-termDoors`, `test-periodCharts`, `test-chartsFollowMetric`, `test-metricMeasures`, `test-part5Readers`, `test-additivity`, `test-i18n`, `test-file-size`, `check-contracts`, `npm run test:web`, the e2e specs above, `npm run lint`.
