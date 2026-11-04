# Semantic layer, part 8 — Engine

Status: draft, not built (2026-11-03). Builds on [part 1](00-design.md); read it first.

Part 1 left three engine jobs out: calculated fields on Live tables (D15), computing a fan-out join
instead of refusing it, and column-level lineage. This part designs all three. The rule does not
change: an engine computes every figure, two implementations agree under `Object.is`, and a
question we can't answer exactly is refused with a sentence.

## What you will see when this is done

```
Sales (Live) · Snowflake                                        [ + Calculated field ]
CALCULATED FIELDS · run in the warehouse
Margin         [revenue] - [cost]                                         number
Margin %       IF [revenue] > 0 THEN ([revenue] - [cost]) / [revenue] END   number
Deal size      CASE [tier] WHEN 'ent' THEN 'Large' ELSE 'Small' END         text
  ✗ len([sku])   len() can't run on a Live table: warehouses count characters differently.
```

A Live calculated field is a column like any other; the editor greys out what Live can't run.

```
Customers · by segment       Customers     Revenue · Orders     Returns · Returns
Enterprise                         120          1,204,000               40,100
SMB                                800            902,500               22,300
(blank)                              —              3,100                    —
ⓘ Revenue and Returns count their own rows. "Order date" narrows Revenue only.
```

Refused today. After this part each number equals the same measure on its own table's chart.

```
Data model › Orders › Lineage      Trace a column: [ amount ▾ ]
amount ─┬─ Margin (calculated field) ── Margin % (metric) ── Margin by region (chart) ── Exec
        └─ Revenue (metric) ── 4 charts ── 2 dashboards · 1 alert
Fields:  amount · Used by 2 metrics, 6 charts       Delete "Margin"? It feeds 1 metric, 3 charts.
```

## Intent

- **The same formula gives the same number on a copy and on Live**, so a dataset can move between them.
- **Answer a cross-table question when the answer is unambiguous**, and keep refusing when it isn't.
- **Know what moves before you change a column.**

## Goals

1. Row-level calculated fields on Live datasets, in the formula language, compiled per dialect.
2. A named v1 function list, a typed refusal for every other function, parity on every engine.
3. Charts and KPIs on the one side of a relationship can use measures from its many sides.
4. Lineage traces a column into calculated fields, metrics, terms, charts, dashboards and alerts.

## Non-goals

- LOD, regex, `today()`/`now()` and date-returning functions on Live (D6).
- Live joins, so fan-out on Live (D15); many-to-many (`CARDINALITIES` has none); grouping one-side
  rows by a many-side field (D13).
- The copy's resident Prepare SQL: `sqlGen` bails on `calculated_field`, and no server runs it.
- Changing how Prepare types a calculated field. Lineage inside SQL datasets or source tables.

## Anti-goals

- A Live formula whose number differs from its copy without a named, tested pin.
- A formula function reaching the warehouse untested because someone added it to `FUNCTIONS`.
- An existing chart whose number changes because fan-out became possible.
- A row access rule bypassed through a sub-question. Lineage that shows a table, path, URL or SQL.

## Where we start (checked in the code)

| Today | Where |
|---|---|
| The parser builds closures, not a tree: each grammar rule returns an `EvalFn` | `src/formula/formulaParse.ts` |
| 83 functions, one doc entry each, key sets held identical by a test | `formulaEval.ts`, `formulaDocs.ts`, `test-formulaDocs` |
| A text result `''` is stored null, a boolean as text `'true'`, and the column is typed from its values | `transforms.stepCalculatedField`, `retypeColumn`, `parse.coerceCell` |
| Formula **metrics** already reach Live: totals from the warehouse, formula in JS | `src/ipc/vizMetricMeasures.ts` |
| Every Live statement reads columns as `lv_src.<ident>` over one FROM item; the cache key holds `{ir, source, dialect}` | `compile.ts` `fromItem`, `compileFilter.ts` `colRef`, `liveQuery.ts` `keyOf` |
| Joins walk many→one only; `findPath` refuses the reverse | `src/analysis/joinPlan.ts` |
| A one-side measure grouped by many-side fields is **already computed**, once per group (Rule 3) | `joinJs.maskFanIn`, `joinResident.maskedCol`, `test-joins` |
| Lineage has calc nodes; metric formulas are read by regex; related fields hang off the primary | `src/analysis/lineage.ts` `formulaRefs`, `visualColumns` |

## Approaches

**Calculated fields on Live**

| | Approach | Trade-off |
|---|---|---|
| **A (my call)** | Compile the formula to SQL per dialect, as a derived table under the source | A second back end, held to the JS one by parity tests |
| B | Tell people to write the column in the defining query | Zero code, but SQL-only, no parity with Prepare, table sources need rewriting |
| C | Transpile DuckDB SQL with a library | No JS transpiler of quality; a new runtime dependency |

A is the only one where one formula means one thing on a copy and on Live.

**Fan-out**

| | Approach | Trade-off |
|---|---|---|
| **A (my call)** | Drill-across: one question per table the measures live on, each by the same category through forward joins we already compute, lined up by label (as `metricMeasureData` does for formula metrics) | N questions per chart; the line-up's limits (D13) |
| B | Pre-aggregate the many side to its key, then join | One query, but a new join kind and new math in two engines, in the code part 1 D14 is changing; orphan rows silently vanish |
| C | Looker's symmetric aggregates: fan out, count each table's row once per group (Rule 3 extended to the primary) | Allows many-side categories, but two many sides multiply on the request thread, and the SQL trick is not bit-exact |

A adds no aggregation code, keeps `avg` exact, and gives a measure one number on any chart (as Power BI).

**Column-level lineage**

| | Approach | Trade-off |
|---|---|---|
| **A (my call)** | Column nodes in the existing graph, built from the records | A per-step column-flow table to keep current (D18's test) |
| B | A separate column graph per request | Two builders that can disagree about "used by" |
| C | Record what each figure read at run time | A store and a write per figure; misses charts nobody opened |

## Decisions

### Calculated fields on Live

**D1. Stored on the Live record, shown as columns (my call).** `live.calculated: {name,
expression}[]` on `LiveSettings` (`src/data/liveDataset.ts`), in order, written by a new `write`
contract. One function appends them, typed, to the declared columns on every save and schema sync,
so every reader that lists columns (pickers, catalog, `liveRoute.preRefusal`, AI facts, MCP) sees
them unchanged. A calc that stops compiling stays listed as broken, with its sentence.
`dataset:copyLive` writes them as `calculated_field` Prepare steps.

**D2. One grammar, two back ends (my call).** The parser becomes generic over a small builder
(literal, column, operator, `IF`, `CASE`, `IN`, call, LOD). The JS builder is today's closures
moved verbatim, so the reference is untouched. The SQL builder returns `{sql, type}` or a refusal
with the token span, so the editor underlines `len(`. (`sqlGenClean.genConditional` is the precedent.)

**D3. Static types; columns enter as a copy stores them.** Types: number, text, date, boolean, null.
A `number` column enters as `numberOf` (finite double or NULL), `text` as `NULLIF(text, '')`
because a copy stores `''` as null, `date` only where D4 allows and only when the warehouse type is
DATE or TIMESTAMP. A result's type comes from the formula, never its values (cast on the declared
type). A boolean result is projected as `'true'`/`'false'` text and a text result through
`NULLIF(…, '')`, **at the projection only**, as a copy stores them.

**D4. The v1 functions: 28 of the 83**, one list for every dialect (my call: a dataset that moves
connection keeps working; Databricks waits on Q1). New `SqlDialect` members are required, like `binary`.

| Group | In v1 | Spelling notes |
|---|---|---|
| Operators | `+ - * /`, unary `-`, `= == != < > <= >=`, `and or not`, `IN (literals)`, `IF…ELSEIF…ELSE…END`, `CASE … WHEN` | `/` is `a / NULLIF(b, 0)`: BigQuery and Databricks (ANSI) raise on zero |
| Null, logic | `isnull`, `ifnull`, `coalesce`, `zn`, `if(c,a,b)`, `iif(c,a,b[,u])` | `COALESCE`, `CASE` |
| Number | `abs`, `sign`, `floor`, `ceil`, `ceiling`, `round(x[, n])`, `sqrt`, `square`, `min`, `max` | Databricks' `floor`/`ceil` of a DOUBLE return BIGINT: values past 2^52 pass through, the rest cast back |
| Text | `lower`, `upper`, `trim`, `contains`, `startswith`, `endswith`, `concat` | ClickHouse `lowerUTF8`/`upperUTF8`; `trim` uses `JS_WHITESPACE` (the dialects' `caseKey` minus the lower); needles are literals, as `LIKE` patterns via `likePattern` |
| Date | `year`, `month`, `day`, `quarter`, `datediff(part, a, b)` for day, month, quarter, year | days = `epochDay(b) − epochDay(a)`; the rest from year and month parts |

**D5. JS semantics restated, not SQL's.** Three-valued logic never leaks. Each row is a test case.

| JS rule (`formulaEval.ts`) | SQL spelling |
|---|---|
| Arithmetic on text is null | refused at save: `+` needs numbers |
| `=`: numeric for numbers, null equals only null | `CASE WHEN a IS NULL OR b IS NULL THEN a IS NULL AND b IS NULL ELSE a = b END` |
| `<` on numbers or dates: null compares as `''`, below everything | null branches fold to constants at compile time, then `a < b` |
| `<` and `=` on text: null as `''`, exact | the filter compiler's `coalesce(a,'') < …`, with its collation pins (R1) |
| `and`, `or`, `not`, an `IF` test: null is false | `COALESCE(x, FALSE)`; a test must be boolean-typed |
| `IN`, `CASE WHEN`: `looseEq` | an OR of the `=` spelling; literal items only |
| `round`: `Math.round(x·f)/f`, ties toward +∞ | `f = Math.pow(10, n)` bound from JS; `CASE WHEN y − FLOOR(y) >= 0.5 THEN FLOOR(y) + 1 ELSE FLOOR(y) END / f`, y = x·f. Never `ROUND`: engines split ties away from zero or to even. `n` is a literal in −15…15 |
| `sqrt` of a negative is null | `CASE WHEN x >= 0 THEN SQRT(x) END` (BigQuery raises) |
| `min`/`max` skip nulls | a CASE fold: `LEAST`/`GREATEST` treat NULL differently across the five |
| `concat`: null is `''`, text arguments only | `COALESCE(a,'') \|\| COALESCE(b,'')` |
| `contains(null, …)` is null | `x LIKE p`, no coalesce (unlike the filter) |

**D6. Everything else is a typed refusal, at save.** Mixed-type comparisons, a non-boolean test, an
unknown column (Prepare only warns), a reference to a later calc, a name equal to a column or calc
**ignoring case** (BigQuery and Databricks names are case-insensitive). The other 55 functions:

| Refused in v1 | Why |
|---|---|
| `%` | BigQuery's `MOD` takes no FLOAT64 |
| `power`, `exp`, `ln`, `log`, trig, `pi`, `degrees`, `radians`, `distance_km` | math libraries differ in the last digit |
| `len`, `left`, `right`, `mid`, `find`, `findnth`, `split`, `ascii`, `char`, `space`, `proper` | JS counts UTF-16 units; warehouses count code points or bytes |
| `replace`, `ltrim`, `rtrim`, `div` | not yet measured on real engines; first for v1.1 |
| `regexp_*` | RE2, Java and POSIX differ; user regex runs only in the regex worker |
| `date`, `datetime`, `dateadd`, `datetrunc`, `make*`, `datepart`, `datename`, `week`, `iso*`, `isdate` | dates are text in JS; week rules and names differ |
| `today`, `now`; `int`, `float`, `str` | the clock is not in the cache key; number ↔ text formatting differs |
| `{FIXED …}`, `[[param]]` | needs window functions; an unbound parameter is a column of nulls |

A table keyed by every `FUNCTIONS` name (spelling or refusal) sits beside the SQL builder; a test
holds its keys equal to `FUNCTIONS` (the `formulaDocs` pattern). The editor reads a `live` flag.

**D7. How a statement reads them.** `fromItem` wraps the source in one derived table per calc the
statement needs, in order, each projecting only the columns still needed (never `*`: BigQuery bills
what is read). Part 1's base filters (D13) sit in the innermost layer. The outer alias stays
`lv_src`, so filters, category keys and case matches are unchanged. The definitions travel in
`LiveSource`, so an edit changes the cache key without an `epoch` bump. A dropped input refuses only
the statements that read the calc (`columnMissing`). Profile SQL never reads calcs, so in v1 a calc
has no value list: its control shows the existing "not sampled" state (`liveProfile.liveDistinct`)
and takes typed values (my call; profiling calcs is the first follow-up).

**D8. Safety.** Literals are bound (`ParamSink`); `true`/`false`/`NULL` are dialect keywords; a
function name picks a fixed spelling, never spliced. A calc name is quoted by `ident()` and passes
`badName`; refs resolve only through `columnOf` to declared columns or earlier calcs (live-data D4).
A calc can't be a row access column (my call: editing a formula would widen access). A restricted
viewer gets a calc's name and type, not its formula, which may name a customer (part 1 D12).

### Fan-out

**D9. What is refused today.** `findPath` refuses a chart on the one side that reads a many side, and
any chart reading two many sides (a chasm trap: orders and returns per customer). Row access adds:
a caller locked on the chart's dataset is refused any join (`reachesOther` → `related`, `rowDoors.ts`),
any caller a join reading a dataset closed to them (`relatedClosed`). Row-policy "fan-out" is publishing.

**D10. The shape.** A chart on P with a measure on a many side M becomes one question per table its
measures live on. P's measures are P's question, unchanged; M's are a question on M by the same
category, reached by forward hops. Replies line up by label, the first reply's date grain pinned on
the others (`metricMeasureData`). **The path rule:** P reaches M forward to a shared table J, then
against the arrows. The category and split must sit on P's path **through J**, and M's question
reaches them by M→J plus P's path from J, pinned (part 1 D14's `via`), never re-chosen by
breadth-first search (Orders may reach Regions directly, by ship region). Otherwise refused. M rows
matching no P row fall in the blank category, as on a chart built on M (Q2).

**D11. Filters keep one meaning per chart (my call).** A bare filter resolves from P as today (P,
then the nearest forward table), so no existing chart changes, and reaches M's question by the D10
path. A column only a many side has narrows that side's measures. A measure a filter can't reach is
unaffected and the tile says so, as an inapplicable dashboard filter is noted today (Q3).

**D12. KPIs and formula metrics.** A metric on Customers over `Orders.amount` is that measure on
Orders with P's filters through the path (`joinedMetricFor`). A formula metric may name many-side
columns (`sum(Orders.amount) / count(customer_id)`), planned as leaves (`metricMeasures`).
`relatedColumnNames` keeps meaning safe hops (four callers rely on it); many sides get their own list.

**D13. Still refused, each with a sentence:**

| Case | Why |
|---|---|
| Category or split from a many side with a one-side measure | a customer would sit in several groups; chart Orders instead |
| Category not on P's path through the shared table | no single answer |
| A text axis folded into "Other" (over 50 values), or bins, across questions | each question keeps its own top 50 or bin range (`measureNeedsOneAxis`); lifting it needs the door to take kept keys |
| Pivot, cohort, funnel, facet, map | the planner skips the first three, the line-up refuses facets; maps stay out (my call) |
| A Live dataset anywhere in the chart | D15 |

**D14. Row access: no new refusal, no new opening.** Each question goes through the gated door
(`vizDataFor` → `lockedViz`), so M's rules apply to M's question. **A trap found while checking:**
sub-questions run inside P's lock scope, where `closedReason` treats P as open (`rowAccess.ts`,
`scope.locked === id`), so the **outer** gate must refuse a caller locked on P. It does: a fan-out
measure always names its dataset (`values[].datasetId`), which `reachesOther` refuses for a locked
caller. `chartReads`/`metricReads` learn every table of every question, so `relatedClosed` and
publish scopes (row-policy D10) check and record them all.

**D15. Live gets none of it.** Live has no joins (`liveSpec.chartCore` refuses `related`), and each
drill-across question needs one. Live joins are their own design.

### Column-level lineage

**D16. Column nodes from records only.** New kinds `column` and `term`: names only, never a formula or
filter value, and only for columns something reads. `lineage:get` keeps today's picture; a new `read`
contract focuses one column, `META` in `scripts/rowPolicyReaders.ts` like `lineage:get`.

**D17. Formulas through the parser.** Calc refs and LOD dimensions from `compile().fn.refs`, metric
formulas from `compileMetricFormula` (`aggregates`, `metricRefs`), replacing the regex `formulaRefs`.

**D18. Through Prepare**, folded from `meta.sourceColumns` over the steps:

| Steps | Column edges |
|---|---|
| `calculated_field`, `conditional_column` | output ← the columns it reads |
| `rename_column`, `drop_column` | follows the name ("was amt"); a dropped column ends |
| `fill_empty`, `trim`, `replace_values`, `parse_date`, `mask_*` | in place (masked says so) |
| `group_aggregate` | each output ← its column; group-by columns pass through |
| `lookup_join` | added columns ← the other dataset's columns |
| `filter`, `dedupe` | none: they change rows (shown under Always applied) |
| Any other step, now or later | every output ← every input, marked approximate |

A test enumerates `STEP_TYPES` and fails on a step with no rule.

**D19. Consumers.** Every encoding field naming a column (category, series, values, pivot, geo,
cohort, funnel, drivers, facet), on **its own** dataset per `categoryDatasetId`/`values[].datasetId`
(today `visualColumns` drops them, so Customers.region hangs off Orders: fixed). Also metric
columns, `timeColumn` and snapshot (part 1 D8–D9), terms (D10), controls, alerts, and the keys of
every relationship a figure crosses. A test sets every column-naming encoding field.

**D20. Origins never shown.** Column edges stop at the dataset for `sql`, `composed` and `combined`
origins (no SQL parsing). While here: a connection source's `sub` reads `Table <origin.table>` for
every reader today, which part 1 forbids. It becomes the connector's kind (my call).

**D21. Where it shows.** A column picker in the Data model Lineage tab, "Used by" per field, and
delete confirmations for a column-producing step or Live calc. All counts come from the server.

## Constraints (from the repo's rules)

- **Engines do the math:** the line-up only places engine figures. **Agreement** is `Object.is`;
  divergences are named pins (`scripts/liveParityPins.ts`), never a loosened comparison.
- **Live:** values bound, identifiers from the stored schema, no JS fallback, all through `warehouse()`;
  calcs open no row-reading channel. **No eval**, **no runtime dependency**, nothing sync on a request
  path, caches on `orgKey()`, contracts with zod and the narrowest access, sentences through `t()`.
- **File size:** `src/ipc/visuals.ts` is at 769, so it gets one line; `formulaEval.ts` (625) nothing;
  `compile.ts` (455) only `fromItem`. The builders and both tables are new files.

## Tests

**Calculated fields**
- *Refactor guard:* record a golden of 5,000 seeded expressions before D2; after, `Object.is` on
  every value. `test-formula*` untouched.
- *Expression differential* (new): seeded v1 expressions, per row, `evaluate()` on the copy vs
  `SELECT <expr>` on the DuckDB bench, through D3's projection.
- *Matrix:* `test-liveParity` gains calcs as every aggregation's measure, a text category, bins,
  every filter op, a split, under a base filter and a row lock, against the same formulas as Prepare
  steps on the copy; golden shapes in `test-liveCompile`; thinned on Postgres in CI, ClickHouse
  nightly, Snowflake and BigQuery in `test-warehouseLive`.
- *Safety:* literals with `'`, `\`, `` ` ``, `'; DROP` never reach SQL text; NUL and case-insensitive
  collisions refused; `test-liveRoute` spies `getDataset`; a schema sync keeps calcs; an edit moves
  the cache key; `copyLive` figures equal Live's. The function table's keys equal `FUNCTIONS`.
- *Negative controls:* drop the null-below-everything compare, the `NULLIF('')` read or the `''`
  projection, or use `ROUND`: the differential fails.

**Fan-out**
- *Differential* (beside `test-joins`): Customers, Orders, Returns, Regions and a second Orders→Regions
  path; measures on one side, a many side and two; every aggregation; categories and filters on P, J and
  a forward table; auto grain, a split, orphans, empty and repeated keys. Resident-forced, JS-forced and
  a brute-force loop reference, all `Object.is`.
- *Invariant:* each series equals its own table's chart. *Unchanged:* every `test-joins` case, byte for byte.
- *Row access:* locked on P → `related`; restricted on M → refused; a publish scope records every
  table. Negative controls: BFS instead of the pinned path, `setRelatedGateForTest(false)`, and no
  `datasetId` check in `reachesOther` each fail.

**Lineage**
- `test-lineage`: renames, calc over calc, `group_aggregate`, `lookup_join`, an approximate step, related
  attribution, parser-read formulas, terms, keys, Live calcs; exhaustiveness over `STEP_TYPES` and the
  encoding fields. *Origin canary:* a planted path, keyed URL, table and SQL reach neither reply.

## Build order (each a PR, chained)

1. Column lineage on the server: flow table, column nodes, parser refs, the two fixes, the contract.
2. The parser over a builder (D2), golden first; no behaviour change.
3. The SQL builder, dialect members, function table, golden shapes, expression differential.
4. Live calculated fields: record, contract, `fromItem`, `copyLive`, the matrix, the editor.
5. Real-engine runs and pins: ClickHouse, Snowflake, BigQuery.
6. Fan-out for charts.
7. Fan-out for KPIs and formula metrics, and the builder's pickers.
8. Lineage in the Data model section: column picker, Used by, delete confirmations.

## Dependencies

- **Part 1 D14** (labelled joins) before step 6: both change `joinPlan`, and D10 pins paths with `via`.
- **Part 1 D13** (base filters) before step 4, or step 4 adds the innermost-layer rule itself.
- **Part 1 D16** shares `vizMetricMeasures` with step 6; terms (D10) and D8–D9 join lineage when built;
  the Data model section hosts step 8. Part 5's distinct counts will need their own fan-out case.

## Owner's answers

The owner took every recommended answer below (2026-11-03). They are decisions now, not open questions.

**Facts from the owner:** there is no Databricks workspace yet. So Live calculated fields are refused on Databricks with a sentence until one joins the nightly tests.

1. **Databricks has no real-engine parity run** (only golden shapes), and formula SQL has more engine
   edges than aggregates (ANSI errors, BIGINT `floor`). *Recommended:* refuse Live calculated fields on
   Databricks with a sentence until a Databricks workspace joins the nightly; the cost is that account.
2. **Many-side rows matching no one-side row.** *Recommended:* the blank category, so "Revenue by
   segment" is the same on the Customers and Orders charts (as Power BI does). Dropping them makes
   the two charts disagree.
3. **A filter only a many side has, on a chart that also has one-side measures.** *Recommended:* it
   narrows that side's measures and the tile says so (D11). Refusing the tile is safer, but refuses
   most fan-out tiles under a dashboard date control on Orders.

## Left to the builder

- File and contract names, the exact sentences, `KIND_RANK` for the new kinds, and where the
  drill-across planner and the many-side column list live.
- Merging calc layers; caps on calcs per Live dataset, statement size and the generator.
- Whether `replace`, `ltrim`, `rtrim`, `div` join v1 after the first real-engine run.
