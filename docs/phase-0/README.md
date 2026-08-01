# Phase 0 — Behaviour spec and DuckDB breakage analysis

**Status:** complete. No product code was changed.
**Gate:** ✅ `npm install` clean · `npm run build:ts` → 0 errors · `npm test` → **964 ok / 0 fail**.
**Baseline commit:** `d70a143` on `devops`.
**✅ VERIFIED.** The §7 experiment script has been run against **DuckDB 1.5.5** — measured results are in [06-duckdb-verification.md](06-duckdb-verification.md), which supersedes every `NEEDS VERIFICATION` marker in documents 01–05. **Six predictions were wrong**; four in the migration's favour, two against. Where this document and 06 disagree, **06 wins** — it was measured, this was inferred. The revised Tier 1 list is in §5 of 06.

## Documents

| File | Covers | Assertions |
|---|---|---|
| [01-parse.md](01-parse.md) | `parse.ts`, `parseXlsx.ts` — ingest and type detection | 54 |
| [02-formula.md](02-formula.md) | `formula.ts` — the 82-function safe evaluator | 174 |
| [03-transforms.md](03-transforms.md) | `transforms.ts` — the prepare pipeline, `combineTables` | 64 |
| [04-stats-metrics-anomalies.md](04-stats-metrics-anomalies.md) | `datasetStats.ts`, `metricValue.ts`, `anomalies.ts` | 31 + 26 + 30 |
| [05-vizdata-dashboardfilters-charts.md](05-vizdata-dashboardfilters-charts.md) | `vizData.ts`, `dashboardFilters.ts`, the 28-type chart parity matrix | ~90 |
| [06-duckdb-verification.md](06-duckdb-verification.md) | **Measured DuckDB 1.5.5 results — resolves every open question in 01–05** | — |

Two brief figures were wrong and are corrected here: `formula.ts` has **82** functions, not 70, and **174** assertions, not ~130.

---

## 1. The five findings that change the plan

### F1 — `applyPipeline` is synchronous; DuckDB's Node bindings are not. This is the blocking design question, and it is not about SQL.

Phase 1's gate says "the exported function signatures do not change — callers must not notice." That is **not satisfiable** as written. `applyPipeline`, `buildVizData`, `computeColumnSummary`, `computeMetric`, and `detectAnomalies` are all synchronous pure functions, and `buildVizData` calls `applyPipeline` synchronously from `visuals.ts`, `dashboards.ts`, and `dashboardExport.ts`.

Three options, none free:
- **Accept an `async` ripple** through `vizData`/`visuals`/`dashboards` and rewrite ~8 call sites plus every straight-line assertion in five test files. Every production call site is *already* inside an `async` IPC handler, so the runtime cost is nil — it is the test suite and the "signatures don't change" promise that pay.
- **DuckDB-WASM's synchronous build**, or a worker plus `SharedArrayBuffer` + `Atomics.wait`. Preserves the signatures; adds a bridge to own.
- **Keep the sync functions as thin adapters** over a new async handle-based API, materializing to `Cell[][]` for compatibility. Preserves signatures *and* tests, but for `datasetStats`/`metricValue` this makes Phase 1 **slower than today**: it round-trips Arrow → JS arrays → back into DuckDB per call.

**Recommendation:** settle this in a one-day spike before Phase 1 opens, and amend the Phase 1 gate to say "callers change only by adding `await`" if that is the answer. Do not discover it mid-phase.

### F2 — Row order is unspecified in SQL, and 25+ assertions depend on it.

Nothing in the current codebase sorts. Every order — group labels, raw rows, series, dedupe survivors, join output, `mostCommon` tie-breaks — is *first-seen insertion order*, an artefact of folding over an array. DuckDB's parallel scans, hash aggregates, and hash joins actively reorder, and the result varies with thread count and data volume, so the failure mode is **intermittent red tests**, not a clean break.

Order-coupled assertions found: `transforms` L56, L68, L70, L140, L151, L173, L213, L216, L260, L277 · `vizData` R-VIZ-01/02/05/06/07/09/10/13/15 · `datasetStats` R-STATS-08 · plus R-VL-02/03, R-SM-04, R-FILTER-01, R-MC-03 (index/list order).

**The single mitigation for all of them:** a hidden monotonic `__ord BIGINT` assigned at ingest, propagated through every step (`min(__ord)` through aggregation, `l.__ord, r.__ord` through joins), and applied as `ORDER BY __ord` **once at the outermost SELECT** so intermediate CTEs stay unordered and parallelizable. Add `, min(__ord)` as a tiebreaker to every user-facing sort, since JS `Array.sort` has been stable since ES2019 and users' saved dashboards depend on that stability.

Open product question: *is first-seen order worth preserving at all?* It was never designed — but 25 assertions and every saved dashboard encode it.

### F3 — Ordinate's semantics are the deliberate negation of SQL's, in three specific ways.

| | Ordinate | SQL / DuckDB |
|---|---|---|
| **Failure** | degrade to `null`, never throw — div-by-zero, type mismatch, unknown column, `sqrt(-1)`, `int('abc')` | raise, or return NULL under different rules |
| **Coercion** | **refuses** to coerce numeric strings; `'5' * 2` must be `null`; casting is explicit via `INT()`/`FLOAT()` | implicitly casts VARCHAR→DOUBLE |
| **Logic** | two-valued: `NULL AND TRUE` → `false`, `null = null` → `true`, `x > 5` with null → `false` | three-valued: all of those are `NULL` |
| **Emptiness** | `null`, `''`, and `'   '` are **all** empty (JS `trim()` = full Unicode whitespace) | only `NULL` is null; DuckDB's `trim()` strips **spaces only** |

The emptiness rule alone touches `is_empty`, `not_empty`, `count`, `fill_empty`, `trim`, `nonEmpty`, `distinct`, and `constant_column`. It needs **one shared macro**, defined once, with the whitespace class written out explicitly — RE2's `\s` is not JS's `\s`:

```sql
CREATE MACRO sc_empty(x) AS (x IS NULL OR regexp_full_match(CAST(x AS VARCHAR),
  '[\t\n\x0B\f\r    -     　﻿]*'));
```

### F4 — The formula evaluator's front end cannot move, and must not.

15 of formula's 174 assertions are **not reproducible in SQL** — and every one of them is about `compile()`'s contract, not about evaluating a row. Four are explicit anti-injection tests (`1; process.exit(1)`, member access `.`, backtick, trailing garbage). Two are static assertions that `src/formula.ts` contains no `eval` and no `new Function`. The rest are structured parse errors and `refs` extraction, which `transforms.ts:217-220` needs to warn about unknown columns *before* evaluation.

Handing a user- or AI-authored expression string to DuckDB is a **SQL injection surface**: `;` is a statement separator, `.` is schema qualification, backtick is an identifier quote, and DuckDB's function catalogue includes `read_csv`, `read_blob`, `ATTACH`, and `COPY … TO`. For an app whose core promise is "no surprise network calls, no telemetry," that is an unambiguous regression, not a naming problem.

**The shape of the answer:** keep the tokenizer, parser, closed 82-function vocabulary, and structured errors in TypeScript (~350 lines). Refactor `Parser` to build an **AST** instead of closures — a behaviour-neutral change all 174 assertions must survive. Then add `astToSql(node, schema)` that returns `null` for anything it can't translate faithfully, with the existing tree-walker as the fallback. Classification: **114 assertions (66%) translate directly, 45 (26%) need a wrapper, 15 (9%) stay in TS forever.** The 114 are also the expressions users actually write — 12 of the 13 functions the AI prompt advertises are in that bucket.

Attempting a faithful *full* translation produces a mapping layer larger and more fragile than the 1,043 lines it replaces, and every wrapper is a place a DuckDB version bump silently changes someone's saved calculated field. Notable hard walls: `len('😀')` = 2 (UTF-16 units) has no DuckDB equivalent; JS `RegExp` backreferences and lookbehind are rejected outright by RE2; `min(1,'a')` → `"1"` and `max(1,'a')` → `"a"` is return-type polymorphism a SQL scalar can't express; `date('2024-13-45')` rolls over in JS and raises in `make_date`.

### F5 — Chart parity: 5 of 28 types have no vgplot/deck.gl equivalent.

**GAPs: `pie`, `donut`, `gauge`, `treemap`, `sankey`.** Observable Plot — and therefore vgplot — has never shipped an arc mark, and has no squarified-treemap or flow layout. `pie` and `donut` are `SHAPE_CHARTS.part_to_whole[0..1]` and `gauge` is `single_metric[0]`, so **three data shapes lose their default chart.**

Better news than feared on the plugin front: of the five Chart.js plugins, `heatmap` (matrix) is **DIRECT** and a likely upgrade (DuckDB-side binning is Mosaic's core strength), and `boxplot` and `candlestick` are **BUILDABLE** from primitives. Full tally: **11 DIRECT · 12 BUILDABLE · 5 GAP.**

Per-GAP recommendation: `sankey` is the strongest **cut** candidate — today's implementation is a synthetic fan-in to a fake `"Total"` node, not real flow data. `gauge` displays exactly one number and should become an HTML component, not a chart. `treemap` needs d3-hierarchy plus a custom mark. `pie`/`donut` are not cuttable and need a custom arc mark or a retained Chart.js renderer — and note that retaining Chart.js for any type means retaining the wide `{labels, series}` grid, so `buildPivot` survives the migration.

---

## 2. Assertions DuckDB breaks by default — the master list

Ranked by damage. 🔴 = **silent wrongness**: renders fine, wrong number. 🟠 = loud failure. Detail and per-rule mitigations are in the module documents.

### Tier 1 — silent wrongness (a dashboard still renders, with a wrong figure)

| # | Behaviour | Naive SQL result | Where |
|---|---|---|---|
| 1 | ~~**`sum` of a text column → `null`**~~ **REFUTED by measurement** — `sum(VARCHAR)` is a **Binder Error**, not an implicit cast. Demoted to Tier 2. See [06 §1](06-duckdb-verification.md). | — | `metricValue` R-METRIC-06 |
| 2 | **`SUM(INTEGER)` returns HUGEINT/BIGINT** | Surfaces through Arrow as a **`BigInt`**; every renderer path tests `typeof v === 'number'`, and `JSON.stringify(BigInt)` throws at the IPC boundary | `vizData`, `metricValue`, `datasetStats` |
| 3 | **`007` read as integer `7`** | **Measured: conditional.** A small file is safe (1.5.5's sniffer rejects leading-zero integer candidates), but a `007` beyond the 20,480-row sample window silently becomes `7`. Position-dependent, so **every small test fixture passes.** `all_varchar=true` or `sample_size=-1` fixes it. | `parse` R-PARSE-13 (landmine 6.1) |
| 4 | **`count` counts `''` and `'   '`** | `count(col)` excludes NULL only; the current rule excludes all three empties. `test-metricValue` `:46` expects 2, naive SQL gives 4 | `transforms` T12, `metricValue` R-METRIC-04, `datasetStats` R-STATS-01/07/10 |
| 5 | **`max` of a column containing `NaN`** | DuckDB sorts `NaN` **greater than all values** → `max` returns `NaN` → serialises to `null` → the UI shows a blank | `datasetStats` R-STATS-03 |
| 6 | **`mostCommon` ties** | Currently first occurrence in row order; DuckDB's `mode()` tie-break is unspecified and can flip between runs | `datasetStats` R-STATS-08 |
| 7 | **Text `!=` against a NULL cell** | Currently `'' !== 'US'` → **row kept**; SQL NULL → **row dropped**. Inverts a row's fate. | `transforms` T5, `vizData` filters |
| 8 | **`join` on NULL keys** | Currently `null` matches `null` *and* matches `''` (stringified keys). SQL NULL never joins. (Arguably a bug — but it is current behaviour, uncovered by tests.) | `transforms` T26 |
| 9 | ~~**Float summation identity**~~ **REFUTED by measurement** — DuckDB does **not** use Kahan; `sum` matched the JS left-fold bit-for-bit on both probes, and `sum/count = avg` exactly. See [06 §1](06-duckdb-verification.md). | — | `transforms` T14, `datasetStats` R-STATS-04, `metricValue` R-METRIC-02 |
| 10 | **`min`/`max` of a text column** | Currently `null` (return type is `number \| null`); SQL returns the **string** `'007'`, which flows through `{ok:true, value}` into a metric card | `metricValue` R-METRIC-03 |

### Tier 2 — loud failure (obvious break; cheap to fix once known)

| # | Behaviour | Naive SQL result | Where |
|---|---|---|---|
| 11 | **Filter on a missing column is skipped with a warning** | A binder error that **kills the whole query**. This is the load-bearing feature that lets one dashboard filter span heterogeneous datasets. | `transforms` T23, R-FILTER-09 |
| 12 | **Unknown column / unknown aggregation → `null`** | Binder / catalog error. Today the card shows "—" (`ok: true`); with SQL it shows an error state. | `metricValue` R-METRIC-07 |
| 13 | **Non-numeric measure → an all-`null` series** | `sum(text_col)` is a binder error, not a null series | `vizData` R-VIZ-08 |
| 14 | **`min`/`max`/`mean` absent when count is 0** | SQL returns `NULL`; if the adapter writes `summary.min = row.min` the JSON carries `min: null` and `renderer/hub/datasets.ts:530` silently drops it — **the loud failure becomes silent** | `datasetStats` R-STATS-05 |
| 15 | **Ragged rows: short padded, long truncated, one warning** | **Measured — worse than predicted, and it belongs in Tier 1.** The *default* read silently **discards the header row and the short data row**, keeping only the widest line with synthesized `column0..N` names. With `null_padding` the header survives but the overflow field becomes a **phantom extra column** instead of being truncated. No `read_csv` configuration reproduces truncate-and-warn. | `parse` R-PARSE-03 |
| 16 | **`drop_column` can produce zero columns with N rows** | `SELECT` with an empty select-list is a syntax error | `transforms` T21 |
| 17 | **Empty table + `groupBy: []`** | Currently 0 rows; SQL global aggregation returns **1 row of NULLs** | `transforms` T11, `datasetStats` R-STATS-12 |
| 18 | **Malformed JSON / empty file → a warning** | DuckDB throws | `parse` R-PARSE-04/07 |

### Tier 3 — structural mismatches (design decisions, not bugs)

| # | Behaviour | Why it doesn't map |
|---|---|---|
| 19 | **Mixed-type columns.** `Cell[][]` genuinely allows `3` and `'low'` in one column. `stepFilter` branches on the **declared** type; `aggregate` branches on the **runtime** type. | A DuckDB column has exactly one type. **Resolution: store VARCHAR, `TRY_CAST` at point of use** — that reproduces *both* branches faithfully and solves the `007` problem in the same move. Severity is lower than it looks: `retypeColumn` normalizes the whole column after `calculated_field`, `fill_empty`, and both `combineTables` paths, so mixed state is rare and short-lived. |
| 20 | **Data-dependent output typing.** A calculated field's column type is decided by inspecting *all* produced values — one `'low'` demotes the column to text and stringifies the numbers. | SQL expression types are static. **This pass stays in TypeScript over the returned Arrow batch, permanently.** |
| 21 | **`refs` extraction + structured compile errors + the closed function vocabulary.** | See F4. Stays in TypeScript; it is a security boundary. |
| 22 | **Quoted `""` vs unquoted empty.** | DuckDB keeps them distinct; a `ParseResult` has never contained an empty string — `coerceCell` maps `''` → `null`. Must be post-processed, or every downstream null check breaks. |
| 23 | **Column naming.** `col1` (1-indexed) vs DuckDB's `column0`; duplicate names preserved vs renamed to `a_1`; header cells trimmed. | **Saved visuals and dashboards reference columns by name — a silent rename breaks every existing project.** Recommended fix: positional physical identifiers `c0..cN` with user-facing names held only in metadata. That also eliminates all identifier-quoting and column-name-injection concerns. |
| 24 | **`geoMatch` place-name joining.** Normalize → exact → substring (len>4) → iso2 prefix. | Becomes a UDF or a pre-normalized lookup table. Substring matching over a cross join is O(n·m) — fine for 50 states, questionable for 3,000 counties or 40,000 zips. |

---

## 3. Recommended architecture (consistent across all five documents, arrived at independently)

**Ingest everything as VARCHAR. Keep Ordinate's own type metadata. `TRY_CAST` at point of use.**

```
Physical:  ds_<uuid>(__ord BIGINT, c0 VARCHAR, c1 VARCHAR, …)
Metadata:  [{ physical:'c0', name:'city', type:'text' }, { physical:'c1', name:'revenue', type:'number' }, …]
```

One decision buys five fixes: the `007` problem (landmine 6.1), mixed-type columns, the non-numeric-aggregate rule, the filter/aggregate declared-vs-runtime split, and column-name injection.

**Prepare compiles to a CTE chain**, one CTE per step, regenerated from `(schema, steps)` on every edit:

```sql
WITH s0 AS (SELECT __ord, c0, c1, c2 FROM ds_abc),
     s1 AS (SELECT *, TRY_CAST(c1 AS DOUBLE) * 2 AS c3 FROM s0),   -- calculated_field
     s2 AS (SELECT * FROM s1 WHERE TRY_CAST(c3 AS DOUBLE) > 0),    -- filter
     s3 AS (SELECT c0, sum(TRY_CAST(c3 AS DOUBLE)) AS c4,
                   min(__ord) AS __ord FROM s2 GROUP BY c0)        -- group_aggregate
SELECT c0, c4 FROM s3 ORDER BY __ord;
```

Reversibility (invariant 5) is preserved **for free**: the SQL is a pure function of the step list, regenerated from scratch, nothing stored. Rejected alternatives: one statement per step (temp tables — materializes every intermediate, adds cleanup and failure modes, introduces the state that invariant 5 forbids) and nested subqueries (identical semantics, undebuggable at depth). Positional `c0..cN` also makes `rename_column` **zero SQL** — a pure metadata edit — and resolves the duplicate-name ambiguity that the current fold settles by first-index.

**What stays in TypeScript, permanently:**
- All guards that run *before* SQL: unknown column, unknown step, unknown aggregation, blank/duplicate name, compile error — each producing the exact current warning string. Tests match these on substring and count.
- `sanitizeSteps` / `sanitizeFilters` — security controls, backend-independent.
- The type-detection layer: `isFiniteNumber`, `looksLikeDate`, `detectColumnType`, `coerceCell`/`coerceValue`, the naming rule.
- The `retypeColumn` pass over returned Arrow — data-dependent typing is not expressible as SQL.
- The formula front end (tokenizer, parser, vocabulary, `refs`, errors).
- `numOrNull` and `labelVal` as the **Arrow→JS marshalling gate** — now more important, not less: they are what stops a BigInt or a `NaN` from reaching a chart.

---

## 4. Decisions needed before Phase 1 opens

These are the user's calls, not the implementer's. Each one changes what gets built.

1. **Sync or async?** (F1) — the blocking one. Amends the Phase 1 gate either way.
2. **Is first-seen row order a contract or an accident?** (F2) — preserve it via `__ord`, or adopt an explicit deterministic order, accept a one-time visual change in saved dashboards, and rewrite ~25 assertions.
3. **Freeze or fix the known pre-existing bugs?** Each is current behaviour on real user data, and each is uncovered by tests:
   - `looksLikeDate`'s `Date.parse` fallback types `$5`, `5%`, `1.2.3` as `date` **(recommend: freeze for the port, fix separately with a test)**
   - a zip column with no leading zeros (`90210,94103`) already types as `number` **(recommend: fix, it's the same class as landmine 6.1)**
   - `join` matches `null` to `null` and to `''` **(recommend: fix, note the behaviour change)**
   - `appendTables` corrupts data when one input has duplicate column names **(recommend: fix)**
   - unterminated CSV quotes silently swallow the rest of the file **(recommend: adopt DuckDB's error)**
   - blank lines mid-file become a row of nulls **(recommend: adopt DuckDB's skip — but note `rowCount` is asserted throughout the suite)**
4. **The 5 chart GAPs** (F5) — per type: custom mark, retained Chart.js plugin, or cut. Retaining any plugin means retaining the wide-grid pivot code.
5. **Does deck.gl/MapLibre add a tile provider?** If so it is a **new external network dependency** in an app whose stated promise is exactly one. Needs a decision against invariant 1 before Phase 4 is scoped.
6. **Should `metricValue` move at all in Phase 1?** It is ~30 lines of arithmetic run once per card over a dataset already in memory. Moving it to DuckDB adds a query round-trip per card and is a **pure regression** until Phase 2 puts the table in Parquet. Consider sequencing it after the storage move.

---

## 5. Test-suite mechanics (the brief's "never delete a failing assertion" rule, made concrete)

- **Three test files test copies, not code.** `test-small-multiples.js`, `test-value-labels.js`, and `test-more-charts.js` re-declare the renderer helpers inline rather than importing them (`hub.js` isn't node-runnable). **They will keep passing after the originals are deleted.** Fix by extracting those helpers into a pure importable module, or delete the mirrors — otherwise they are green-lit dead weight through the entire migration.
- **`mergeDashboardFilters` is duplicated** at `renderer/hub/dashboards.ts:707-720`. Only the main-process copy is tested.
- **Warning strings are asserted** by substring (`already exists`, `nope`, `/row cap/i`) and by count (`=== 1`). Preserve the exact prose from `transforms.ts:206,208,213,219,246,247,317,365,411,415,435,457,475,486,681` and `parse.ts:192,203,204`.
- **The strictest assertions are `transforms` L213/L216** — `JSON.stringify` deep-equality across two independent runs. They demand byte-identical row order, column order, warning text *and order*, and numeric formatting. Under parallel execution with a float-sensitive retype pass, **this is the assertion most likely to go intermittently red.**
- **If Phase 1 goes async**, all 64 straight-line assertions in `test-transforms.js` need `await` — a mechanical rewrite. **Keep the current file as the frozen reference contract** and diff against it.
- Assertions expected to need deliberate rewording (and a note in the commit body): `parse` R-PARSE-03 (ragged) and R-PARSE-04 (empty file); `metricValue` R-METRIC-01's mixed-type fixture, which becomes untestable-as-written once a column is typed. **Everything else should pass verbatim — treat any other failure as a real regression.**

---

## 6. Two places where a careless "improvement" ships a bug

Both are cases where SQL's default is *different*, an implementer notices, and the obvious fix is wrong.

1. **`SUM` of nothing is NULL, not 0** — and for Ordinate, **NULL is the correct answer.** `sum`/`avg`/`min`/`max` over zero qualifying cells must return `null` so the card shows "—" rather than a fabricated `0`. Do **not** add `COALESCE(…, 0)`. Put a comment in the SQL generator saying so. (`count` is the exception: it must return `0`.)
2. **`TRY_CAST` is not `isFiniteNumber`.** `TRY_CAST('007' AS DOUBLE)` = 7. Reaching for `TRY_CAST` as the "safe" cast re-introduces the exact bug landmine 6.1 exists to prevent. Where a numeric test is needed on a VARCHAR column, port the regex from `parse.ts:325-329` into `regexp_full_match` — RE2's `\d` is ASCII-only, which matches JS.

---

## 7. Consolidated verification script — run this before Phase 1

Roughly 30 minutes of work; it resolves nearly every **NEEDS VERIFICATION** marker across all five documents.

```sql
-- Ingest / typing (landmine 6.1)
SELECT typeof(c), c FROM read_csv('code\n007\n012');
SELECT typeof(c), c::VARCHAR FROM read_csv('id\n12345678901234567890');
DESCRIBE FROM read_csv('a,,c\n1,2,3', all_varchar=true);        -- empty header cell naming
DESCRIBE FROM read_csv('a,a\n1,2', all_varchar=true);           -- duplicate header names
SELECT a IS NULL, b IS NULL FROM read_csv('a,b\n"",', all_varchar=true);  -- quoted vs unquoted empty
FROM read_csv('a,b,c\n1,2\n3,4,5,6', null_padding=true, ignore_errors=true);  -- ragged: truncate or drop?
FROM read_csv('a,b\r1,2\r3,4');                                 -- lone CR
FROM read_csv('a,b\n1,2\n\n3,4');                               -- blank line mid-file
FROM read_csv('a,b\n"unclosed,2');                              -- unterminated quote
SELECT * FROM read_json_auto('[{"a":1},{"b":2,"a":3}]');        -- JSON key order

-- Numeric fidelity  (compare each against the JS left-fold)
SELECT sum(x) FROM (VALUES (0.1),(0.2),(0.3)) t(x);
SELECT sum(x) FROM (VALUES (1e16),(1.0),(-1e16)) t(x);          -- Kahan → 1.0, naive → 0.0
SELECT sum(x)/count(x) = avg(x) FROM (VALUES (0.1),(0.2),(0.3),(0.4),(0.5)) t(x);
SELECT typeof(sum(x)) FROM (VALUES (1),(2)) t(x);               -- BigInt risk
SELECT isfinite('nan'::DOUBLE), isfinite('inf'::DOUBLE);
SELECT max(x) FROM (VALUES (1.0),('nan'::DOUBLE)) t(x);         -- NaN sorts high?

-- String / emptiness semantics
SELECT '[' || trim(E'\t x \t') || ']';                          -- does trim() strip tabs?
SELECT contains('abc',''), contains(NULL,'');
SELECT 'A' = 'a';                                               -- binary collation?
SELECT '' IS NULL;
SELECT sum(x) FROM (SELECT '5' AS x);                           -- implicit VARCHAR→DOUBLE?
SELECT '5.'::DOUBLE, '+.5'::DOUBLE;

-- Formula translation
SELECT 1/0, 1.0/0.0, sqrt(-1), ln(0), TRY_CAST('abc' AS INTEGER);
SELECT NULL AND TRUE, NULL = NULL, (NULL > 5);
SELECT length('😀');                                            -- 1 (chars) vs JS 2 (UTF-16 units)
SELECT regexp_matches('aa','(a)\1'), regexp_matches('xy','(?<=x)y');  -- RE2 rejects both
SELECT make_date(2024,13,45);                                   -- raises; JS rolls over

-- Composition
SELECT * FROM (VALUES (1)) t(x) UNION ALL BY NAME SELECT * FROM (VALUES ('a')) u(x);  -- type unification
-- 400x400 self-join with ORDER BY … LIMIT 50000 — does top-N stream, or materialize 160k rows?
```

---

## 8. Recommended next step

~~Run §7~~ — **done**, see [06-duckdb-verification.md](06-duckdb-verification.md).

**One thing remains before Phase 1 opens: answer decision 1 (sync vs async)** with a one-day spike. It is the only finding that invalidates the Phase 1 gate as written, and everything else is downstream of it.

The measured results also justify the migration on their own terms: a full scan, filter, 50-group aggregation and sort over **1,000,000 rows of raw CSV completed in ~0.07 s** — before any Parquet storage or indexing.

Then Phase 1 in the order the evidence suggests, which is **not** the order the brief lists: ingest + `__ord` + the VARCHAR schema decision → `transforms` (the CTE chain) → `vizData` → `datasetStats` → **`metricValue` last, or deferred to Phase 2**, since moving it before the storage move is a measurable regression.
