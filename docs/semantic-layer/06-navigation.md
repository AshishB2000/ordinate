# Semantic layer, part 6 — navigation

Status: draft, not built (2026-11-03). Builds on [part 1](00-design.md): part 1 D1 (`TableDoc`) and
part 1 D5 (hierarchies, moved here by the owner's answer B).

Part 6 covers moving around the data model. **Hierarchies** let people drill from Region to State
to City and back. **Topics** give a team its own short list of datasets, fields, metrics and terms
("Sales").

## What you will see when this is done

**A dashboard tile.** Click a bar on a chart whose axis is a hierarchy level:

```
┌ Revenue by region ──────────────────── ⋯ ┐      ┌──────────────────────────────┐
│ ▇▇▇▇▇▇ East    $412k   ◀ click ──────────┼────▶ │ Drill into East · by state   │
│ ▇▇▇▇   West    $301k                     │      │ Show the rows behind East    │
└──────────────────────────────────────────┘      └──────────────────────────────┘
┌ Revenue by region ──────────────────── ⋯ ┐
│ All regions › East · by state    [↑ Up]  │      crumbs go back up; a reload
│ ▇▇▇▇▇ Pennsylvania  $151k                │      starts at the saved level
└──────────────────────────────────────────┘
```

A date axis drills on its own: 2024 › Q2 2024 › May 2024 › days. On a phone, the tap sheet that
already offers "Show the rows behind this point" also offers "Drill into East".

**Explore with a topic.** The question is still the URL. A click on a bar drills, so Back goes up:

```
Explore   Topic: Sales ▾   Dataset: Retail orders ▾
FIELDS                       SHOW      [Sum | revenue ×]
Dimensions                   GROUP BY  [state ×]
  ▾ Geography                FILTERS   [region = East ×]
      region · state ●       All regions › East · by state
    customer_segment         ▇▇▇▇ Pennsylvania …
Dates  order_date   Measures  revenue ●  units
Other fields ▸               (the fields outside Sales, one click away)
```

**A cascading filter.** On a dashboard with Region and State controls:

```
[Region: West ▾]  [State: Ohio ▾]  ┌ Narrowed to Region: West ───────┐
                                   │ ☑ Ohio — not in West   [Clear]  │  kept, never cleared silently
                                   │ ☐ California  ☐ Oregon …        │
```

**The Data model section.** The owner's four tabs stay. A topic picker sits in the header and
narrows all four tabs. Hierarchies sit on a dataset's **Fields** tab:

```
Data model · Retail demo                    Topic: All ▾   [ + Term ]  [ + Metric ]
Datasets · Metrics · Glossary · Relationships       Retail orders › Fields
  HIERARCHIES   Geography  region › state      Product  category › sub_category   [ + Hierarchy ]
                Dates drill by themselves: year › quarter › month › day
Topic · Sales (drawer)   Datasets ☑ Retail orders (8 of 12 fields ▾) ☑ Regions   (up to 12)
  Metrics ☑ Revenue ☑ Profit   Terms ☑ EMEA
  ⓘ Topics tidy what people see first. They don't limit access: anyone who can open this
    project can still reach every dataset. Use project sharing or row access rules for that.
```

## Intent

- **Answer "why?" in one click.** East is high: which states, which cities? Today a bar's only
  click opens the rows behind it (`web/src/features/visuals/drill/DrillPanel.tsx`). That is a grid,
  not an answer.
- **Narrow a filter by its parent.** After picking West, a State list with all 50 states is noise.
- **A smaller world per team.** Thirty datasets are a wall for the sales team. The Assistant hits
  this too: on a project-wide question it reads the columns of only the first 12 datasets
  (`dsList.slice(0, 12)`, `src/ipc/copilot.ts`).

## Goals

1. Named hierarchies of a dataset's own text columns. Dates work as a hierarchy without being
   defined.
2. Drill down and back up, through the existing figure doors: on dashboard tiles (desktop and
   phone) and in Explore.
3. Drill and "the rows behind this number" agree on what a clicked mark means.
4. Filter pickers narrow a lower level by the levels above it.
5. Topics: a named, ordered subset of datasets, fields, metrics and terms, for Explore, the
   Assistant, MCP and the Data model section.

## Non-goals

- Drill on published pages, embeds, reports, subscriptions and file exports (D6, question 2). No
  drill in the builder either: the author picks the axis directly.
- Levels from a related table, map-to-map drill, number levels, and pivot expand/collapse (pivots
  have their own levels).
- Drill-through to another dashboard. It already exists as the `navigate` tile action
  (`web/src/features/dashboards/tileActions.tsx`).
- Narrowing a picker by every other control (Tableau's "only relevant values").
- A default topic per team, and topics on Home, ⌘K, the Data list or the catalog.

## Anti-goals (a failure even if it works)

- **A drilled figure that disagrees with the bar it came from**, including a child that shares a
  name with a child of another parent and gets counted twice.
- **Two meanings of a clicked mark.** "Drill into East" and "the rows behind East" must select
  the same rows.
- **A topic that people mistake for access control.**
- **A picker that ignores its parent without saying so** (Live).
- **A drill that changes what other people, or other tiles, see.**

## Approaches

**Drill-down.**
- **A. A drill is a new question (my call).** The click asks the server for the exact step behind
  the mark and for the next level. The tile or Explore then asks `visual:data` again with the new
  axis and the added steps. Cache, Live executor, row lock and answer shape are all the existing
  ones. *Trade-off:* two RPCs per drill, plus one warehouse statement on Live.
- **B. Child levels prefetched in the chart's reply** (Power BI's "expand all"). No round trip per
  drill. But replies grow N times, every chart's answer-cache key changes, and Live pays for
  questions nobody clicks. Explore refuses Live thumbnails for exactly that reason
  (`docs/explore/00-design.md`).
- **C. Drill levels saved on each visual** (Power BI's multi-field axis). Each chart keeps its own
  copy of the hierarchy, which is part 1's first anti-goal, and Explore and the Assistant can't use
  it.

A wins: the smallest change, no new figure path, and it reuses `resolveDrill`.

**Topics.**
- **A. A `topic` record that narrows lists (my call).** An ordered list of datasets, each with an
  optional field subset, plus metric and term ids. It changes no figure and refuses no read.
- **B. Topics as access control.** Every door would have to enforce them: `visual:data`,
  `query_sql`, the rows panel, exports, catalog, ⌘K, lineage, Assistant facts. That is part 4's
  object-level hiding under another name (D15).
- **C. Topics as catalog tags.** Datasets and metrics already take tags (`DocPatch.tags`,
  `src/api/catalog.ts`). This is cheaper if a topic only holds datasets. But columns take no tags
  (`ColumnPatch`), tags have no order (the Assistant needs the first 12), and a team's world would
  have no single place to edit it.

## Decisions

### Hierarchies and drill-down

**D1. Stored on the table doc.** Part 1's `TableDoc` gains
`hierarchies?: { id: string; name: string; levels: string[] }[]`.
- Each hierarchy has 2 to 6 of the table's own **text** columns. Number columns are bucketed into
  ranges, and dates are covered by D3.
- At most 10 per table, names unique.
- A column belongs to at most one hierarchy (my call), so a click offers one "Drill into". This
  can be lifted later.
- Saved through part 1's `catalog:setTable` and sanitized. The field is optional, so no migration.

**D2. A hierarchy is never checked, and doesn't need to be (my call).** Every drill carries the
whole path (`region = East AND state = Ohio`), so a "Springfield" in two states still drills right.
Unlike a key (part 1 D2), a hierarchy makes no promise about the data.

**D3. Dates are an implicit hierarchy.**
- Gregorian: year › quarter › month › day. A week bar drills to days, because a Gregorian week can
  straddle two months.
- Retail calendar (`activeWeekCal`): year › quarter › month › week › day, because its weeks sit
  inside its periods.
- The step is the exact range that `bucketRange` (`src/analysis/driverScope.ts`) already gives the
  rows panel. The drilled chart gets an explicit `encoding.grain`.

**D4. One new read channel, `visual:drillDown`**, project-scoped, in its own file
`src/ipc/drillDown.ts` (`src/ipc/visuals.ts` is at 769 lines).
- **Input:** the same `Drill` shape as `visual:rows`.
- **Work:** runs `drillFilters` (`src/ipc/drillScope.ts`), and so `resolveDrill`, on the mark. It
  uses the encoding **without its split**, so a split chart drills its axis and keeps every series.
- **Reply:** `{ available: true, encoding, steps, crumb }`, or `{ available: false, reason }` with
  **the same sentence** the rows panel gives (blank label, "Other", number axis, raw-point chart,
  map).
- **Next:** the browser asks `visual:data` (or the tile batch) with that encoding and
  `filters + steps`. Nothing new computes a figure.
- **Live:** `drillFilters` skips its grain lookup on Live, because rows can't be listed afterwards.
  The drill handler does the lookup on Live too, since `vizDataFor` is the Live door.

**D5. Drill and the rows panel agree by construction:** both use `resolveDrill`. After a drill,
every ⋯ action acts on what is on screen. Show the rows (its chips show the path), Explain this
change and export all follow the drilled state. Comment pins hide while a tile is drilled, because
they name points at the saved level.

**D6. Where drill-down works.**

| Screen | Drill | Why |
|---|---|---|
| Explore | Yes. A plain click drills and pushes history, so Back goes up | Nothing owns that click today (no mark handler in `Answer.tsx`), and the URL already holds the state |
| Dashboard tiles: view and present | Yes, through the point menu (D7) | |
| Dashboard on a phone | Yes, as a `PointSheet` entry | The sheet already holds what a tap can do |
| Builder | No | The author changes the axis directly |
| Published `/p/`, embeds | No (question 2) | The page "fetches nothing" (`src/server/published.ts`). Its states are a precomputed menu capped at 256 (`src/publish/combos.ts`), and 64 for embeds (`embedPage.ts`) |
| Reports, subscriptions, PDF/PPTX | No | Static |
| Assistant answers | A "By state" chip (D13) | |

**D7. On a dashboard, a plain click keeps its order.** It runs the first of these that applies:
1. the tile's click actions;
2. click-to-filter, which is off unless the sheet turns it on (`clickFilterOn`);
3. on a drillable mark, the point menu: "Drill into East · by state", "Show the rows behind East",
   and Explain on time axes;
4. otherwise, the rows drawer, as today.

Also:
- The right-click menu gains "Drill into".
- Drill state is per-tile view state, kept beside `tileSteps`. Saved views, the URL and
  subscriptions don't hold it, just as they don't hold click-filters.
- A drill never filters other tiles. Click-to-filter is off on a drilled tile (my call), because a
  child value ("North") alone may not identify the mark.
- Edit mode has no drill.

**D8. Explore.**
- Crumbs are drawn from the question's structure: GROUP BY is level *k*, and FILTERS hold `=`
  steps on the levels above it.
- The field list nests each hierarchy's levels.
- On a phone, a tap opens `PointSheet` instead of drilling at once.

**D9. Hierarchies load when needed.** A new read, `model:navigation { projectId }`, returns the
project's hierarchies and topics in one reply.
- A dashboard asks for it on the first mark click or picker open (my call: +0 RPCs per load).
- Explore and Data model ask on load.

**D10. Which charts drill.** The Chart.js charts whose category is a group-by: column, bar, their
stacked and grouped variants, line, area, pie, donut. The final list comes from `eligibility.ts`.
The axis must be a text level or a date. Not:
- maps, tables, grids, scatter and raw-point charts, KPIs;
- waterfalls, whose stored totals ride `visualId` (R19);
- a category from a related table, because `resolveDrill` only knows the main table's columns.

**D11. Live drills.** Each level is one warehouse statement through `vizDataFor`: cached, and
counted against `LIVE_DAILY_QUERY_LIMIT` like an Explore question. The rows panel stays off on Live
(`LIVE_DRILL`, `web/src/features/visuals/Stage.tsx`).

**D12. Cascading pickers.**
- **Contract:** `dataset:distinct` gains an optional `filters` (≤ 6 steps, sanitized). Both engine
  twins already take `DistinctRequest.filters` for the row lock (`readDistinctPage`,
  `distinctValuesPageJs` in `src/engine/datasetPage.ts`), and `src/ipc/distinctFor.ts` puts the
  lock first. So the parent steps follow the lock with no new engine code.
- **What it sends (my call):** only the steps of controls on *higher levels of the same
  hierarchy*. Those steps also join the query key.
- **Ruled-out picks:** a pick the new parent rules out stays at the top, marked "not in West", with
  Clear.
- **Live:** a Live list comes from the profile's per-column sample (`liveDistinct`,
  `src/ipc/liveProfile.ts`), which can't be narrowed. The reply says `narrowed: false` and the
  picker says "Not narrowed by Region: values come from a sample".
- **Published pages:** `/p/` and embeds keep their precomputed options.

**D13. The Assistant and MCP read hierarchies.**
- The facts list them, so "break it down further" means the next level.
- `answerChips` (`src/ai/answerSpec.ts`) gains "By <next level>". That chip is a complete spec, so
  no model is involved.
- `describe_dataset` returns them.
- With part 1 D6 value labels, crumbs show the label while steps carry the raw value.

### Topics

**D14. A topic is a project record** of kind `topic`, stored like metrics and terms: `recordFs`,
the edit-conflict tag, Trash.

```ts
interface Topic {
  id: string; projectId: string;
  name: string;                                   // unique in the project, ≤ 80
  description?: string;                           // ≤ 500, shown in the picker
  datasets: { id: string; fields?: string[] }[];  // ordered, ≤ 12; no `fields` = all
  metricIds: string[]; termIds: string[];         // ≤ 100 each
  updatedBy: string; updatedAt: string; schemaVersion: 1;
}
```

- **Cap (my call):** 12 datasets, the Assistant's cap, so a topic always fits whole in its facts.
- **Stale members:** dropped on read and listed in the editor ("2 items no longer exist"). Never
  an error.
- **Who:** editing needs project `write`; anyone who can read the project can pick a topic.
- **Remembering:** the last pick is kept per browser in localStorage, like `ordinate.dockProject`
  (`dockState.ts`).

**D15. A topic is a convenience, never access control.**
- **Access is per project** (`project_grants`, `src/server/authz/`), and a topic is a list inside
  one.
- **Everything is reachable anyway.** MCP's `query_sql` reads any dataset in the project by design,
  and a viewer can type any `?dataset=` into Explore. Making topics a boundary means guarding every
  door. That is part 4's object-level hiding, enforced the way row policy is.
- **A partial boundary is worse than none:** it looks safe and isn't.
- **Real isolation** means a separate project, row rules, or part 4.

So the copy never says "hidden" or "restricted", and "Other fields" and "All datasets" are always
one click away. When part 4 lands, its hiding wins over a topic.

**D16. Who reads a topic.**

| Reader | What the topic does |
|---|---|
| Explore | `topic=` in the URL. The dataset picker lists the topic's datasets. Fields show topic fields first and the rest under **Other fields**. `explore:suggest` gains an optional `topicId`, so suggestions stay inside the topic (still no number in the reply) |
| Assistant | The `@` picker (`ContextPicker.tsx`) gains Topics. `copilot:ask`'s `Context.kind` gains `'topic'`. Facts cover the topic's datasets in order, their fields' notes, then its metrics and terms. Explore opens the dock on its topic |
| MCP | A new `list_topics`. An optional `topic` on `list_datasets`, `list_metrics`, `list_terms` (part 1) and `describe_dataset`. `query_sql`, `aggregate` and `metric_value` ignore it, and the docs say so |
| Data model | The header picker narrows all four tabs. Topics are edited in a drawer |

## Constraints (from the repo's rules)

- **Engines do the math.** A drill re-asks the server. Crumbs and the field list's nesting come from
  structure.
- **Contracts.** New channels: `visual:drillDown`, `model:navigation`, `topic:save`,
  `topic:delete`. Additive optional fields: `dataset:distinct.filters`, `explore:suggest.topicId`,
  and `'topic'` in `copilot:ask`'s Context. All are project-scoped, and all are `read` except the
  topic writes. `src/api/index.ts` stays append-only.
- **Row policy.** `scripts/rowPolicyReaders.ts` classifies `model:navigation` and the topic reads
  as META, and `visual:drillDown` as DOOR (its grain is read through `vizDataFor`).
  `dataset:distinct` stays LOCKED. A drill or a cascade gives a viewer nothing they couldn't
  already ask in Explore under the same lock.
- **File size.** `src/ipc/visuals.ts` (769) and `src/ipc/datasets.ts` (748) take only a few-line
  pass-through. `answerSpec.ts` (632) and `copilot.ts` (604) get a few lines each. New handlers and
  topic facts go in new files.
- **Bundle and setup.** The drill UI lives in the dashboards and Explore lazy chunks, so initial JS
  doesn't change. Sentences go through `t()`. No new dependency, no migration.
- **Any pod.** Drill state lives in the browser or the URL; topics live in records.
- **States.** Every new list has designed empty, loading and error states in both themes, with
  mockups first.

## Tests

- **`scripts/test-drillDown.ts`, on the sample** (region › state, category › sub_category,
  `order_date`).
  - **Differential:** for every bar, the total of the rows behind it (`visual:rows` with the mark)
    `Object.is` the total behind the whole drilled chart. This runs over text levels and every date
    step, under both calendars.
  - **Refusals:** each sentence equals `visual:rows`' for the same mark.
  - **Negative control:** with "Springfield" planted in two states, the totals agree with the full
    path and come out bigger without the parent step.
- **Live:** a drill over `liveFakeConnector` answers from the warehouse, with `getDataset` spied and
  never called.
- **Row policy:** a restricted viewer's drilled chart equals their own `visual:data` for the same
  question, and their cascade lists only their values. **Negative control:** without the lock, it
  lists more.
- **Cascade:** resident and JS agree with parent steps (`Object.is`), and Live carries
  `narrowed: false`. **Negative control:** a level outside the hierarchy is not narrowed.
- **Topics:**
  - lifecycle, edit-conflict tag and Trash; stale members are dropped;
  - the same `visual:data` request with and without a topic gives `Object.is`-equal figures;
  - a dataset outside the topic still answers (D15, pinned);
  - MCP `list_datasets` with `topic` lists only the topic's datasets;
  - `test-exploreSuggest`'s no-number walk still passes;
  - `docs/automation.md` is regenerated and `test-pluginSkills` is updated.
- **e2e:** one per screen, ≤ 25 RPCs per load, each extending the screen's existing spec.
  - `dashboards-view.e2e.ts`: drill into East, check the crumbs, go Up; the figures equal the
    server's reply. The page load is unchanged. The first drill adds three RPCs
    (`model:navigation`, `visual:drillDown`, one tile read); Up is cached.
  - `phone.e2e.ts`: the sheet entry.
  - `explore.e2e.ts`: a click drills and Back goes up; a topic narrows the fields.
  - `saved-views.e2e.ts`: State narrows by Region, and shows "not in West".
  - Part 1's Data model spec covers the two editors.
  - `published-access.e2e.ts`: no drill on `/p/`.
  - Screens: `tile-drilled`, `explore-drill`, `picker-cascade`, `model-topic`.

## Build order (chained PRs)

1. Hierarchies on `TableDoc`, `model:navigation`, the Fields-tab block, `describe_dataset`, facts.
2. `visual:drillDown`, the date ladder and the differential test (server only).
3. Explore drill and the nested field list. This is the cheapest UI, because the URL is the state.
4. Dashboard drill: point menu, crumbs, phone sheet.
5. Cascading pickers.
6. The "By <next level>" chip.
7. Topics: the record, `topic:*`, the Data model header and drawer.
8. Topics in Explore, the dock and MCP, with the docs regenerated.

## Dependencies

- **Part 1 D1 (`TableDoc`) and `catalog:setTable`:** step 1 needs them.
- **Part 1 D6 value labels:** the raw value has to reach the mark, or a drill (and today's rows
  panel) filters by a label.
- **Part 1 D9:** drill steps are not `fromControl`, so the `timeColumn` rewrite leaves them alone.
- **Part 1 D11:** drilled requests keep term steps.
- **Part 1 D16:** drilled measures keep their `metricId`.
- **Part 1 D14:** a joined level stays out until `resolveDrill` reads `categoryDatasetId`.
- **Part 4:** its hiding filters topics and field lists, and wins over them.
- **Part 3:** could later add AI instructions per topic.

## Owner's answers

The owner took every recommended answer below (2026-11-03). They are decisions now, not open questions.

This changes the prototype's mock, which showed Views as a tab: topics are a picker in the Data model header.

1. **Should a plain click on a drillable dashboard mark open a small menu** (Drill into / Show the
   rows) instead of the rows drawer directly? *Recommend yes.* Right-click alone is hard to
   discover, and tiles that can't drill keep today's click.
2. **No drill-down on published pages and embeds in part 6?** *Recommend yes.* Precomputing even
   one level multiplies the 256 and 64 state caps. Revisit with numbers when a customer asks.
3. **Topics as a convenience, not access control, shown as a header picker rather than a fifth
   tab?** *Recommend yes to both* (D15; the owner picked the four tabs).

## Left to the builder

- Contract names, and the exact chart list from `eligibility.ts`.
- Whether the Live grain lookup hits the tile's cached answer. If not, a Live date drill costs one
  extra statement: measure it.
- Dropping `visualId` from drilled tile requests, and checking that nothing else on the tile path
  needs it.
- **A possible existing bug:** the rows panel may resolve a joined category to a main-table column
  with the same name, because `resolveDrill` never reads `categoryDatasetId`. Check it, and fix it
  there if so.
- Where the crumb row sits at phone width, and the topic drawer's field picker (mockups).
- Exact caps on levels, hierarchies and topics per project.
