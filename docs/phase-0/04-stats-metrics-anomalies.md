I have everything I need. Here is the Phase 0 spec.

---

# Phase 0 spec — `datasetStats.ts`, `metricValue.ts`, `anomalies.ts`

**Baseline facts.** Assertion counts in scope: `scripts/test-datasetStats.ts` = **31**, `scripts/test-metricValue.ts` = **26**, `scripts/test-anomalies.ts` = **30** (counted as `ok('` occurrences; the `.js` siblings are tsc output of these `.ts` sources — all line references below are to the `.ts`). DuckDB is **not installed** in this environment (`which duckdb` → not found, no `node_modules/@duckdb`), so every DuckDB-behaviour claim below is marked with an experiment that settles it.

**Cross-cutting finding that outranks everything else in this spec:** all three modules are **synchronous, pure, in-memory** functions over `Cell[][]`. DuckDB's Node bindings are **asynchronous**. Phase 1 states "the exported function signatures do not change" — that is **not satisfiable** for these three modules if the compute moves into DuckDB, unless a synchronous execution path is used (WASM sync build, or worker + `Atomics.wait`). See "Open questions" §OQ-0.

---

## datasetStats.ts

### 1. Exported API surface (verbatim)

`src/datasetStats.ts:16-28`:
```ts
export interface ColumnSummary {
  name: string;
  type: ColumnType;
  nonEmpty: number; // count of non-null / non-'' cells (all column types)
  // number columns:
  min?: number;
  max?: number;
  mean?: number;
  count?: number; // count of finite numeric cells (the mean's denominator)
  // text / date columns:
  distinct?: number;
  mostCommon?: { value: string; count: number } | null;
}
```

`src/datasetStats.ts:30-35`:
```ts
export interface QualityIssue {
  kind: 'empty_heavy' | 'duplicate_rows' | 'constant_column';
  column?: string; // set for column-scoped issues
  detail: string; // human-readable, safe to show as-is
  severity: 'info' | 'warn';
}
```

`src/datasetStats.ts:56-59` and `106-109`:
```ts
export function computeColumnSummary(
  column: { name: string; type: ColumnType },
  cells: Cell[],
): ColumnSummary

export function findQualityIssues(
  columns: { name: string; type: ColumnType }[],
  rows: Cell[][],
): QualityIssue[]
```

Not exported but load-bearing: `type Cell = string | number | null` (`:14`), `const EMPTY_HEAVY_RATIO = 0.5` (`:38`), `isEmpty` (`:42-45`), `keyOf` (`:49-51`).

**Call sites** (all inside `async` IPC handlers, so an async conversion is mechanically possible):
`src/ipc/datasets.ts:208,210` (`dataset:stats`), `:241,243` (`dataset:explain`), `:399,401` and `:424,426` (suggestSteps / suggestCalcField), `src/ipc/copilot.ts:36,38`, `src/ipc/visuals.ts:29`, and — synchronously, from non-async code — `src/anomalies.ts:308`.

### 2. Complete statistic / quality-flag catalogue

**Per-column summary — every field:**

| Field | Applies to | Exact definition | Source |
|---|---|---|---|
| `name` | all | echoed from `column.name`, unvalidated | `:64` |
| `type` | all | echoed from `column.type` — **the branch selector is the DECLARED type, not cell contents** | `:64,66` |
| `nonEmpty` | all | `count of cells where !isEmpty(c)`. `isEmpty` = `c == null` (catches `null` **and `undefined`**) **or** (`typeof c === 'string' && c.trim() === ''`). **Numbers are never empty** — including `0`, `NaN`, `Infinity`. | `:61-62`, `:42-45` |
| `count` | `number` only | `count of cells where typeof c === 'number' && Number.isFinite(c)`. Always set (0 when none). | `:72,79` |
| `min` | `number` only | scan-minimum over the same finite set; **omitted (`undefined`) when `count === 0`** | `:74,80-81` |
| `max` | `number` only | scan-maximum, same omission rule | `:75,82` |
| `mean` | `number` only | `sum / count`, where `sum` is a **left-fold in row order** (`sum += c`); omitted when `count === 0` | `:73,83` |
| `distinct` | `text`/`date` only | `Map.size` over `keyOf(c)` for non-empty cells | `:89-95` |
| `mostCommon` | `text`/`date` only | `{value, count}` of the modal key, or `null` when no non-empty cells. **Tie-break: first occurrence in the column wins** (`n > mostCommon.count` is strict, and `Map` iterates in insertion order) | `:96-100` |

**Branch exclusivity is a contract:** a `number` column has `distinct === undefined` and `mostCommon === undefined` (early `return` at `:85`); a `text`/`date` column has `min/max/mean/count === undefined`. There is **no median, no percentile, no stddev, no variance, no mode-for-numbers, no null-count field** in this module. Do not add them during the port.

**Quality flags — exact thresholds:**

| Flag | Trigger condition (verbatim logic) | Detail string | Severity |
|---|---|---|---|
| `empty_heavy` | `rowCount > 0 && empties / rowCount >= 0.5` — **inclusive at exactly 0.5** (`EMPTY_HEAVY_RATIO`, `:38`, `:124`). `empties` counts `isEmpty(row ? row[c] : null)` over all rows. | `Column "<name>" is ${Math.round(ratio*100)}% empty` | `warn` |
| `constant_column` | `rowCount > 0 && distinct.size <= 1 && empties < rowCount` (`:135`). `distinct` = `Set` of `keyOf` over the column's **non-empty** cells. The `empties < rowCount` clause means an **all-empty column is NOT constant**. A column with one value + some empties **IS** constant (and may simultaneously be `empty_heavy`). | `Column "<name>" has the same value in every row` | `info` |
| `duplicate_rows` | `dups > 0`, where `dups` = number of rows whose key was already seen. Key = `JSON.stringify(cols.map((_, c) => (row ? (row[c] ?? null) : null)))` (`:149`) — **order-sensitive across all declared columns; cells beyond `columns.length` are ignored**. | `1 fully-duplicate row` / `${dups} fully-duplicate rows` | `info` |

**Emission order** (not asserted by tests, but it drives badge order in `renderer/hub/datasets.ts:471-481` and the AI FACTS text in `src/ipc/datasets.ts:82-86`): for each column in declaration order → `empty_heavy` then `constant_column`; then a single `duplicate_rows` last.

### 3. Numerical semantics in detail

**Exclusions, per statistic:**

| Statistic | Excludes |
|---|---|
| `nonEmpty` | `null`, `undefined`, `''`, whitespace-only strings (JS `trim()` semantics — see below). **Does not exclude** `NaN`/`Infinity`/`0`. |
| `count`/`min`/`max`/`mean` | everything that is not a JS `number` passing `Number.isFinite` — so strings (including numeric-looking strings like `'42'`), `null`, `NaN`, `±Infinity`. |
| `distinct`/`mostCommon` | `null`, `''`, whitespace-only. Everything else is included **verbatim, untrimmed**. |
| `empty_heavy` empties | same predicate as `nonEmpty` (inverted). |
| `duplicate_rows` | nothing — every row participates. |

**Whitespace definition — a real divergence risk.** `isEmpty` uses JS `String.prototype.trim()`, which strips the full Unicode WhiteSpace + LineTerminator set: `\t \n \v \f \r`, space, `\u00A0` (NBSP), `\u1680`, `\u2000`–`\u200A`, `\u2028`, `\u2029`, `\u202F`, `\u205F`, `\u3000`, `\uFEFF`. DuckDB's `trim(s)` strips **spaces only**; RE2 `\s` is only `[\t\n\f\r ]`. An NBSP-only cell (very common in web-pasted tables) is **empty today and non-empty in naive SQL**.

**Median / percentile:** **none exist in this module.** If the Phase 1 implementer "helpfully" adds `median` to `ColumnSummary` while porting, that is scope creep and a new number the app has never shown. The only percentile code in the whole scope of this spec is `anomalies.quantile` (§anomalies).

**Standard deviation / variance:** **none in this module.** Only `anomalies.ts:121` has one, and it is **population** (÷N).

**Mean, rounding, floating point:**
- `mean` is a raw IEEE-754 double. **No rounding is applied anywhere in this module** except `Math.round(ratio*100)` inside the `empty_heavy` *display string* (`:125`).
- Rounding for display happens **outside** the module: `renderer/hub/datasets.ts:521-525` (`fmtNum` → 2 dp) and… **nowhere in the AI path** — `src/ipc/datasets.ts:73` and `src/copilot.ts:238` emit `mean ${s.mean}` **raw and unrounded** into the model prompt. So any last-ULP change in `mean` becomes **visible text in an AI prompt**, e.g. `mean 200.00000000000003`.
- `sum` accumulates left-to-right in stored row order (`:73`). DuckDB sums in vectorized, potentially parallel, potentially compensated (Kahan) order. For non-integer data the results will differ in the last ULP. The `mean` assertion tolerates this (`approx`, 1e-9, `test-datasetStats.ts:17-19,29`); the `metricValue` `avg` assertion **does not** (`===`, `test-metricValue.ts:34`).

**Distinct counting:** keys come from `keyOf` (`:49-51`) — `typeof cell === 'number' ? String(cell) : cell`. So:
- `null`, `''`, `'   '` → **excluded entirely** (never keys).
- **Case-sensitive**, exact UTF-16 comparison (JS `Map` uses SameValueZero on strings). `'Paris'` ≠ `'paris'`, and `'Paris'` ≠ `' Paris'` (**non-blank strings are never trimmed**).
- Numbers are stringified with JS number→string rules: `1.5→"1.5"`, `1→"1"` (not `"1.0"`), `1e21→"1e+21"`, `-0→"0"`, `NaN→"NaN"`. Relevant only inside `findQualityIssues` (which scans number columns too); `computeColumnSummary`'s distinct branch never runs on a `number` column.

**Empty vs null — every place it matters:**
1. `isEmpty` **conflates** `null`, `undefined`, `''`, `'  '`. Nothing downstream distinguishes them for `nonEmpty`/`distinct`/`empty_heavy`/`constant_column`.
2. `duplicate_rows` **does NOT conflate them.** `JSON.stringify` renders `null` as `null` and `''` as `""`. So rows `['', 1]` and `[null, 1]` are **not** duplicates today. SQL agrees (`''` is a value, `NULL` is not) — **provided the DuckDB ingest path does not map `''` → `NULL`**, which the CSV reader does by default in some configurations.
3. `duplicate_rows` **also conflates NaN/Infinity with null**: `JSON.stringify(NaN)` → `"null"`. DuckDB's `DISTINCT` treats `NaN = NaN` as true and `NaN ≠ NULL`, so a table containing both `NaN` and `NULL` in the same column yields a different duplicate count. (Low real-world risk: dataset rows are persisted as JSON, and `JSON.stringify(NaN)` is `null`, so `NaN` cannot survive a disk round-trip — it is reachable only in-memory.)
4. Ragged rows: `row ? row[c] : null` yields `undefined` for short rows, which `== null` treats as empty. Arrow/SQL tables are rectangular, so this converges — `parse.finalize` already pads.

### 4. Contract encoded by each test assertion

**R-STATS-01 — `nonEmpty` counts cells that are neither null nor blank, for every column type; numbers (including 0) are never blank.**
Assertions: `test-datasetStats.ts:30` (`[10,20,30,null,40]` → 4), `:37` (`[null,null]` → 0), `:41` (`[0,0,5]` → 3), `:52` (`['Paris','Berlin','Paris','',null,'Paris']` → 4), `:59` (`['', null, '  ']` → 0 — **whitespace-only is empty**), `:71` (`[]` → 0).

**R-STATS-02 — `count` on a number column is the number of finite numeric cells, and is always present (0, never absent).**
`:26` (→ 4, the `null` excluded), `:35` (all-null → 0), `:41` (→ 3), `:72` (`[]` → 0).

**R-STATS-03 — `min`/`max` are the extremes of the finite numeric cells, and `0` is a legitimate extreme.**
`:27` (→ 10), `:28` (→ 40), `:42` (`[0,0,5]` → min 0, i.e. no falsy-zero bug).

**R-STATS-04 — `mean` = sum ÷ count-of-finite-cells, compared with a 1e-9 tolerance.**
`:29` (`[10,20,30,null,40]` → 25, via `approx`).

**R-STATS-05 — with no finite numeric cells, `min`/`max`/`mean` are ABSENT (`undefined`), not `null`, not `0`, not `NaN`.**
`:36` (`emptyNum.min === undefined && emptyNum.max === undefined && emptyNum.mean === undefined`). *This is the single most likely silent breakage in the module: SQL returns `NULL` here.*

**R-STATS-06 — the two branches are mutually exclusive; each omits the other's fields.**
`:31` (number column: `distinct === undefined && mostCommon === undefined`), `:53` (text column: `min === undefined && count === undefined`).

**R-STATS-07 — `distinct` counts distinct non-empty stringified values; `date` behaves exactly like `text`.**
`:49` (`['Paris','Berlin','Paris','',null,'Paris']` → 2), `:57` (all-empty → 0), `:66` (`['2024-01-01','2024-01-02','2024-01-01']` → 2).

**R-STATS-08 — `mostCommon` is the modal non-empty value with its count, or `null` when there is nothing to count.**
`:50` (`'Paris'`), `:51` (count 3), `:58` (all-empty → **`null`, not `undefined`**), `:67` (date column → `'2024-01-01'` ×2).

**R-STATS-09 — `empty_heavy` fires at an empty ratio of exactly 0.5 and above, and not below.**
`:87` (2 of 4 empty, one `''` one `null` → flagged on column `a`), `:93` (1 of 4 → not flagged).

**R-STATS-10 — `constant_column` fires for a column with exactly one distinct non-empty value; not for a varied column; not for an all-empty column.**
`:97` (column `b`, `'same'`×4 → flagged), `:99` (column `a`, varied → not flagged), `:107` (`[[''],[null],['']]` → not flagged).

**R-STATS-11 — `duplicate_rows` counts rows fully identical across every column, reporting the count in the detail string.**
`:122` (`['Paris',1]` twice plus `['Paris',3]` → detail contains `'1'`; note `['Paris',3]` differing only in the number is not a dup), `:126` (all-unique → issue absent).

**R-STATS-12 — an empty table produces no issues at all.**
`:131` (`findQualityIssues(cols, [])` → `[]`; the `rowCount > 0` guards at `:124` and `:135`).

### 5. DUCKDB BREAKAGE TABLE — `datasetStats`

Assumed schema: number columns as `DOUBLE`, text/date columns as `VARCHAR`, one row per source row, plus a monotonic row ordinal (`rn`).
🔴 = **silent wrongness** (renders fine, wrong number). 🟠 = loud failure (type error / test fails obviously). 🟢 = matches.

| Rule | Current behaviour | Naive DuckDB SQL | Exact match? | Mitigation |
|---|---|---|---|---|
| R-STATS-01 (text) | `''` and `'  '` and `'\u00A0'` all empty (JS `trim()` = full Unicode whitespace) | `count(c)` → counts `''` and `'  '`; `count(*) FILTER (WHERE trim(c) <> '')` → `trim` strips **spaces only** | 🔴 **NO** — over-counts for tab/NBSP/`\uFEFF`-only cells | `count(*) FILTER (WHERE c IS NOT NULL AND regexp_full_match(c, '[\t\n\x0B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*') = false)`. Write the class out explicitly — do **not** use `\s` (RE2 `\s` ≠ JS `\s`). Add a regression fixture with an NBSP-only cell. |
| R-STATS-01 (number) | `NaN`/`±Inf` count toward `nonEmpty` | `count(c)` (non-NULL) | 🟢 yes (NaN/Inf are non-NULL in DuckDB) | none |
| R-STATS-02 | finite-only count | `count(c)` | 🔴 **NO** if any `NaN`/`Inf` present | `count(*) FILTER (WHERE isfinite(c))`. NEEDS VERIFICATION that `isfinite(DOUBLE)` exists — run `SELECT isfinite('nan'::DOUBLE), isfinite('inf'::DOUBLE);` |
| R-STATS-03 | min/max over finite only | `min(c)`, `max(c)` | 🔴 **NO** — DuckDB sorts `NaN` **greater than all values**, so `max` returns `NaN`; `NaN` then serialises to `null` over IPC and the UI shows a blank max | `min(c) FILTER (WHERE isfinite(c))`. NEEDS VERIFICATION: `SELECT max(x) FROM (VALUES (1.0),('nan'::DOUBLE)) t(x);` |
| R-STATS-04 | `sum/count`, naive left-fold, row order | `avg(c)` | 🔴 **possibly** — differs in last ULP if DuckDB uses Kahan/Welford or parallel reduction. Tolerated by `approx` in the test, but **leaks raw into the AI prompt** at `ipc/datasets.ts:73` | Emit `sum(c) FILTER (...) / count(*) FILTER (...)` rather than `avg`, to at least mirror the formula. Accept ULP drift; consider rounding `mean` before it enters prompt text (a deliberate behaviour change to record). NEEDS VERIFICATION: `SELECT sum(x), avg(x) FROM (VALUES (0.1),(0.2),(0.3)) t(x);` vs JS `0.1+0.2+0.3`. |
| R-STATS-04 (types) | JS double throughout | if the column lands as `DECIMAL` or `BIGINT`, `sum` is exact/`HUGEINT` and may come back as a **BigInt** | 🟠 `JSON.stringify(BigInt)` throws in the IPC layer | Force `DOUBLE` at ingest for every `number` column; assert no BigInt crosses the IPC boundary. |
| **R-STATS-05** | `min/max/mean` **absent** when count 0 | `SELECT min(c), avg(c) …` over zero qualifying rows → `NULL` | 🟠→🔴 **NO** — the test fails loudly (`=== undefined`), but if the adapter is written as `summary.min = row.min` the JSON carries `min: null`, `renderer/hub/datasets.ts:530` (`typeof sum.min === 'number'`) silently drops it, and the bug ships | Adapter must **delete the key when SQL returns NULL**, and coerce `count` NULL→0. One shared `omitNull()` helper; unit-test it. |
| R-STATS-06 | branch selected by declared `ColumnType` | SQL is generated per column anyway | 🟢 yes | keep the branch decision in TS, off `column.type` — never off the DuckDB physical type. |
| R-STATS-07 | distinct over non-empty, case-sensitive, untrimmed | `count(DISTINCT c)` | 🔴 **NO** — counts `''` and `'  '` as two extra distinct values | `count(DISTINCT CASE WHEN <non-empty predicate> THEN c END)` (the `CASE` yields NULL, which `COUNT(DISTINCT)` ignores). Verify collation is binary: `SELECT 'A' = 'a';` must be false. |
| R-STATS-08 | modal value; **ties → first occurrence in row order** | `mode(c)` | 🔴 **NO** on ties — DuckDB's tie-break is unspecified/implementation-defined, so `mostCommon.value` can flip between runs or after a re-sort | `SELECT c FROM t WHERE <non-empty> GROUP BY c ORDER BY count(*) DESC, min(rn) ASC LIMIT 1` — **requires a preserved row ordinal `rn`**. This makes "stable row order + a row ordinal" a hard requirement for Phase 2 (Parquet). |
| R-STATS-08 (empty) | `mostCommon: null` (key present, value null) | zero rows → no row returned | 🟠 | adapter sets `mostCommon = null` explicitly when the subquery is empty — distinct from R-STATS-05's delete-the-key rule. Two different null conventions in one interface; encode both in the adapter. |
| R-STATS-09 | `empties/rowCount >= 0.5`, JS `Math.round` for the pct | ratio in SQL + `round()` | 🟠 low risk — ratios are non-negative so JS half-up ≡ DuckDB half-away-from-zero | do the ratio comparison and the `Math.round` **in TS** on raw counts returned by SQL. Keep all detail-string assembly in TS. |
| R-STATS-10 | `distinct.size <= 1 && empties < rowCount` | `count(DISTINCT c) = 1` | 🔴 **NO** if the non-empty predicate is omitted: an all-empty column has `count(DISTINCT '')` = 1 → wrongly flagged constant, contradicting `:107` | use the same non-empty-filtered distinct as R-STATS-07, plus an explicit `empties < rowCount` check. |
| R-STATS-11 | JSON-key identity; `''` ≠ `null`; `NaN` ≡ `null` | `SELECT count(*) - (SELECT count(*) FROM (SELECT DISTINCT * FROM t))` | 🟢 mostly — SQL `DISTINCT` treats NULLs as equal ✓, `''` ≠ NULL ✓. 🔴 for `NaN` vs `NULL` (edge, unreachable through disk persistence) | use the subquery form. NEEDS VERIFICATION that `count(DISTINCT (a,b))` over a row/struct works in DuckDB — if unsure, use the `SELECT DISTINCT *` subquery, which definitely does. **Also verify the ingest does not fold `''` → `NULL`**: `SELECT '' IS NULL;` plus a CSV round-trip with an empty quoted field. |
| R-STATS-12 | empty table → `[]` | `SELECT … FROM t` with 0 rows returns one row of NULLs for scalar aggregates | 🟠 | guard on `rowCount === 0` in TS before issuing SQL, mirroring `:124`/`:135`. |

### 6. Open questions / risks — `datasetStats`

- **OQ-0 (blocking, all three modules).** DuckDB Node is async; these exports are sync. Either (a) change the signatures to return `Promise<…>` — which contradicts the Phase 1 gate wording and forces `anomalies.ts:308` and all three test files to become async, or (b) run DuckDB synchronously (WASM, or worker + `Atomics.wait`). Decide before writing any SQL. Note every production call site is already inside an `async` handler, so (a) costs ~8 `await`s plus the anomalies refactor.
- **OQ-1.** Is `computeColumnSummary` handed a table handle or still `Cell[][]`? If it keeps taking `Cell[][]`, Phase 1 materialises Arrow → JS arrays → pushes them back into DuckDB per call, which is strictly slower than today. The signature-stability requirement and the performance goal are in direct tension here; recommend adding a *parallel* handle-based entry point and keeping the array form as a thin adapter for tests.
- **OQ-2.** `dataset:stats` calls `computeColumnSummary` once per column (`ipc/datasets.ts:207-209`), i.e. N passes. SQL should compute all columns in one query — but then the per-column function is no longer the unit of work. Where does the batching live?
- **OQ-3.** Two different "no data" encodings in one interface (`min` absent vs `mostCommon: null`) must both survive; there is no test for a `mostCommon` present-but-null vs absent distinction beyond `:58`.
- **OQ-4.** `mean` reaches the model prompt unrounded (`ipc/datasets.ts:73`, `copilot.ts:238`). Any ULP drift changes prompt bytes. If the team wants prompt stability, that is a deliberate behaviour change (round in `buildDatasetSummaryText`) and should be committed as such.
- **OQ-5.** Row ordinal preservation becomes a *correctness* requirement (R-STATS-08 tie-break). Parquet + DuckDB do not guarantee row order across a re-read unless an explicit ordinal column is stored. Decide this in Phase 1, not Phase 2.

---

## metricValue.ts

### 1. Exported API surface (verbatim)

`src/metricValue.ts:20` and `42-46`:
```ts
export type MetricAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

export function computeMetric(
  columns: ParsedColumn[],
  rows: Cell[][],
  spec: { column: string; aggregation: MetricAggregation },
): number | null
```
Internal: `AGG_FNS` (`:22`), `isEmptyCell` (`:26-29`, byte-identical to `datasetStats.isEmpty`), `colIndex` (`:31-37`).

**Call sites:** `src/ipc/dashboards.ts:72` (`dashboard:metric`, after `applyPipeline` of the dashboard filters) and `:102` (`computeMetricCards`, feeding `dashboard:summary`); `src/ipc/copilot.ts:74`. Renderer entry points `renderer/hub/dashboards.ts:647,1314`.

### 2. Complete metric catalogue

Five aggregations, no others; anything else → `null` (`:47`).

| Aggregation | Exact formula | Denominator / participants | Empty-set result |
|---|---|---|---|
| `count` | `Σ 1 for each row r where r is truthy and !isEmptyCell(r[ci])` (`:53-55`) | **all cell types**, text included; excludes `null`/`''`/whitespace-only; **includes** `NaN`, `Infinity`, and arbitrary strings | **`0`** (never `null`) |
| `sum` | `nums.reduce((a,b) => a+b, 0)` (`:67`) — left-fold from `0`, row order | finite JS numbers only (`:61`) | **`null`** (via `:63`) |
| `avg` | `nums.reduce((a,b)=>a+b,0) / nums.length` (`:69`) — **sum ÷ count of finite numeric cells**, not ÷ row count, not ÷ non-empty count | finite JS numbers only | **`null`** |
| `min` | `nums.reduce((a,b) => (b<a ? b : a))` — **no initial value**, deliberately not `Math.min(...nums)` (comment `:70-72`: spread would `RangeError` on 100k+ rows) | finite JS numbers only | **`null`** |
| `max` | `nums.reduce((a,b) => (b>a ? b : a))` | finite JS numbers only | **`null`** |

**Guards, in order** (`:47-50`): falsy `spec` → `null`; `typeof spec.column !== 'string'` → `null`; aggregation not in the set of five → `null`; column name not found → `null`. `colIndex` is an exact, **case-sensitive** `===` match returning the **first** matching column (duplicate column names → first wins). Non-array `rows` degrades to `[]`.

**Return type is `number | null` and NEVER `NaN`** — stated at `:8` and enforced by the `nums.length === 0` early return.

There is no `median`, `count_distinct`, `first`, `last`, `stddev`, or `percentile` metric. `test-metricValue.ts:89` explicitly asserts `'median'` → `null`; `src/ipc/dashboards.ts:114` (`DRAFT_AGGS`) clamps AI-drafted aggregations to the same five.

### 3. Numerical semantics in detail

- **Exclusions:** `sum/avg/min/max` see only cells satisfying `typeof v === 'number' && Number.isFinite(v)`. Excluded: `null`, `undefined`, every string (**including `'42'` — no coercion, ever**), `NaN`, `±Infinity`. `count` excludes only `null`/`undefined`/`''`/whitespace-only, using the same JS-`trim()` whitespace set discussed under datasetStats.
- **Median/percentile:** none. Not supported, and asserted absent.
- **Stddev/variance:** none.
- **Rounding:** **none at all.** Raw doubles cross IPC to the renderer. Display rounding is the renderer's job.
- **Float summation order:** left-fold, row order, no compensation. The `avg` result is *exactly* `(Σ in row order) / n`. `test-metricValue.ts:34` asserts `=== 350/3` — **exact double equality**. This is the only exact-equality float assertion in the two primary modules and is the sharpest tripwire for a summation-algorithm change. (`350/3` = `116.66666666666667`.)
- **Empty vs null:** `count` conflates `null`/`''`/`'  '`; `sum/avg/min/max` treat every non-number identically (ignored). Nothing distinguishes `''` from `null` in this module.
- **Zero-row behaviour is asymmetric and both halves are asserted:** `sum` over no rows → `null` (`:90`), `count` over no rows → `0` (`:91`). SQL happens to agree on both — see the breakage table — but **a defensive `COALESCE(sum(x), 0)` would break it.**

### 4. Contract encoded by each test assertion

**R-METRIC-01 — `sum` totals only the finite numeric cells, in row order, treating `0` as real.**
`test-metricValue.ts:33` (`[100,200,null,50]` → 350), `:53` (`[0,0,10]` → 10), `:83` (`[10,'oops',20,NaN,Infinity]` → **30**), `:99` (text column `['007','012','90210']` → **`null`**, never 7+12+90210).

**R-METRIC-02 — `avg` divides by the count of finite numeric cells, not by the row count, and the result is compared with exact `===`.**
`:34` (`350/3`, i.e. denominator 3 not 4), `:64` (all-empty → `null`), `:76` (text column → `null`).

**R-METRIC-03 — `min`/`max` scan the finite numeric cells only; `0` is a valid minimum; a text column has none.**
`:35` (→ 50), `:36` (→ 200), `:55` (`[0,0,10]` → min 0), `:65`/`:66` (all-empty → `null`), `:101` (text id column → `null`).

**R-METRIC-04 — `count` is the number of non-empty cells of ANY type, and always a number (never `null`).**
`:39` (text column, 4 rows → 4), `:40` (numeric column with one `null` → 3), `:46` (`['a','','   ',null,'b']` → **2**), `:54` (`[0,0,10]` → 3, zeros counted), `:67` (all-empty → **0**), `:84` (`[10,'oops',20,NaN,Infinity]` → **5** — the string, `NaN` and `Infinity` are all non-empty), `:91` (no rows → 0), `:100` (id column → 3).

**R-METRIC-05 — a column with no finite numeric cells yields `null` for sum/avg/min/max — not `0`, not `NaN`.**
`:63` (sum → `null`, comment "not 0, not NaN"), `:64`, `:65`, `:66`.

**R-METRIC-06 — no coercion: a string is never read as a number, most importantly a leading-zero identifier.**
`:75`/`:76` (`['x','y','z']` → `null`), `:83` (mixed array ignores `'oops'`), `:99` (`'007'` must **not** become 7), `:101`.

**R-METRIC-07 — an unknown column or an unsupported aggregation yields `null`.**
`:88` (`column: 'nope'`), `:89` (`aggregation: 'median'`).

**R-METRIC-08 — an empty table yields `null` for sum but `0` for count.**
`:90`, `:91`.

**Related, outside the file (also a `computeMetric` contract):** `scripts/test-dashboardFilters.ts:96` (unfiltered `sum(sales)` = 650), `:98` (`region=West` filter → 150), `:104` (filter on a missing column skipped → still 650), `:115` (after filtering to the single `code='007'` row, `sum(sales)` = 100 and the `code` cell is still the string `'007'`).

### 5. DUCKDB BREAKAGE TABLE — `metricValue`

| Rule | Current behaviour | Naive DuckDB SQL | Exact match? | Mitigation |
|---|---|---|---|---|
| **R-METRIC-06 / R-METRIC-01** | `sum` of a **text** column → `null` | `SELECT sum(zip) FROM t` — DuckDB implicitly casts `VARCHAR`→`DOUBLE`: `'007'` → **7**, `'012'` → **12** | 🔴 **CATASTROPHIC** — this is exactly invariant 6 (`isFiniteNumber`) being violated, and the dashboard card renders a plausible wrong total. (Or it throws on `'x'` — 🟠 — which is the *lucky* case.) | **Gate in TS on `column.type`**: if the declared type is not `number`, return `null` without generating SQL. Never let an implicit cast decide. |
| **R-METRIC-03 / R-METRIC-06** | `min` of a **text** column → `null` (return type is `number \| null`) | `SELECT min(zip)` → `'007'`, a **string** | 🔴 **silent type violation** — a `string` flows through `{ ok:true, value }` (`ipc/dashboards.ts:78`) into a metric card that then displays `007` as a computed metric | same TS type gate; additionally assert `typeof value === 'number' \|\| value === null` at the IPC boundary. |
| R-METRIC-01 (numeric) | finite-only, `NaN`/`Inf` ignored | `sum(c)` | 🔴 if `NaN`/`Inf` present → `NaN`, which JSON-serialises to `null` → card shows "—" instead of 30 | `sum(c) FILTER (WHERE isfinite(c))`. |
| R-METRIC-01 (mixed col) | `[10,'oops',20,NaN,Inf]` → 30 | **unrepresentable**: a typed Arrow/DuckDB column cannot hold both `10` and `'oops'` | 🟠 the fixture must change | Decide the storage model: if number columns are `DOUBLE`, this test becomes untestable-as-written and must be re-expressed (e.g. store the column `VARCHAR` and apply an `isFiniteNumber`-equivalent predicate in SQL). **Do not** substitute `TRY_CAST(v AS DOUBLE)` — `TRY_CAST('007')` = 7, re-introducing the leading-zero bug. If a VARCHAR path is needed, port the regex from `parse.ts:325-329` into `regexp_full_match` (RE2 `\d` is ASCII-only, matching JS). |
| **R-METRIC-02** | `(100+200+50)/3` computed as a JS left-fold then one division; asserted with `===` | `avg(c)` | 🔴 **possibly wrong in the last ULP.** With the integer fixture it will most likely match, but for real decimal data the dashboard number changes with no visible signal | prefer `sum(c) FILTER (…) / count(*) FILTER (…)` over `avg`. NEEDS VERIFICATION — settle with: `SELECT sum(x)/count(x) = avg(x) FROM (VALUES (0.1),(0.2),(0.3),(0.4),(0.5),(0.6),(0.7)) t(x);` and compare both to the JS left-fold. Also check whether DuckDB uses Kahan for `sum(DOUBLE)`: `SELECT sum(x) FROM (VALUES (1e16),(1.0),(-1e16)) t(x);` — Kahan gives `1.0`, naive fold gives `0.0`; JS gives `0`. |
| R-METRIC-04 | `count` = non-empty of any type; `''`/`'  '` excluded | `count(c)` | 🔴 **NO** — over-counts `''` and whitespace-only cells (`:46` expects 2, naive SQL gives 4) | `count(*) FILTER (WHERE c IS NOT NULL AND NOT <blank-regex>)` using the explicit Unicode-whitespace class from R-STATS-01. For `DOUBLE` columns `count(c)` is correct (numbers are never blank) — including `NaN`/`Inf`, which must **stay counted** (`:84`). |
| **R-METRIC-05** | sum/avg/min/max of an all-empty column → `NULL` | `sum(c)` over 0 qualifying rows → `NULL`; `avg` → `NULL`; `min`/`max` → `NULL` | 🟢 **yes — matches** | **do not add `COALESCE(…, 0)`.** The brief's "SQL SUM of nothing is NULL, not 0" is, for this module, the *desired* behaviour; the failure mode here is an over-defensive implementer "fixing" it. Add a comment in the SQL generator. |
| **R-METRIC-08** | zero rows → `count` 0, `sum` `null` | `count(*) FILTER (…)` over 0 rows → `0`; `sum` → `NULL` | 🟢 yes | none — but a filtered dashboard that matches nothing must keep showing `0` for count cards and "—" for sum cards; assert both after a filter that selects nothing. |
| R-METRIC-07 | unknown column / unknown agg → `null` | unknown column → **binder error**, unknown agg → **catalog error**; both caught by the `try/catch` at `ipc/dashboards.ts:76` → `{ ok:false, error }` | 🔴 **behaviour change**: today the card shows "—" (`value: null, ok: true`); with SQL it shows an error state | keep both guards in TS (`AGG_FNS.has`, `colIndex`) **before** generating SQL. They are cheap and they are the contract. |
| test-dashboardFilters `:115` | filtering by the string `'007'` keeps the cell as `'007'`, sum over that subset = 100 | depends entirely on ingest typing | 🔴 if ingest sniffs `code` as an integer | ingest all columns as `VARCHAR`, then apply `parse.detectColumnType` explicitly and cast only the columns TS declares `number` (landmine 6.1). |
| all rules | 5 aggregations, closed set | SQL exposes hundreds | 🔴 scope leak: a future card could request `median` and get a real number where today it gets `null` | keep `AGG_FNS` as the allowlist and keep `DRAFT_AGGS` (`ipc/dashboards.ts:114`) in sync; never interpolate `spec.aggregation` into SQL text without allowlist validation (also an injection concern — invariant 7's spirit). |

### 6. Open questions / risks — `metricValue`

- **OQ-6.** Column identity: `colIndex` matches on `name` with exact string equality and allows duplicates. DuckDB identifiers are case-insensitive by default for unquoted names and duplicate column names are illegal. Column names come from user CSV headers and may collide or differ only in case. Decide the name→SQL-identifier mapping now (recommend: positional aliases `c0..cN` internally, with the user-facing name held only in metadata; this also removes all quoting/injection concerns).
- **OQ-7.** The whole function is ~30 lines of arithmetic executed once per metric card, over a dataset already in memory. Moving it to DuckDB adds a query round-trip per card. If the dataset is not already resident in DuckDB, this is a **pure regression**. The value only materialises once Phase 2 puts the table in Parquet/DuckDB permanently — consider sequencing metricValue *after* the storage move, or making it handle-based (OQ-1).
- **OQ-8.** `ipc/dashboards.ts:66-71` runs `applyPipeline(dashboard filters)` in JS and then `computeMetric` on the result. In SQL these must fuse into one query (`WHERE` + aggregate) or the filter materialises to JS first and nothing is gained. That fusion changes where the "filter on a missing column is skipped with a warning" rule (`test-dashboardFilters.ts:104`) is enforced.
- **OQ-9.** Return-type policing: today TypeScript guarantees `number | null`. Under SQL, `min` of a mistyped column returns a string and nothing checks it. Add a runtime assertion at the IPC boundary; this is the cheapest defence against the highest-severity finding in the table above.

---

## anomalies.ts

### 1. Exported API surface (verbatim)

`src/anomalies.ts:23-51` and `282-286`, `346`:
```ts
export type AnomalyKind =
  | 'numeric_outlier' | 'dominant_category' | 'empty_heavy'
  | 'constant_column' | 'period_change';

export interface Anomaly {
  kind: AnomalyKind;
  column?: string;
  severity: 'info' | 'warn';
  detail: string;
  facts: Record<string, string | number>;
}

export interface AnomalyOptions {
  iqrMult?: number; zThreshold?: number; dominantShare?: number;
  periodChangePct?: number; maxPerKind?: number; maxTotal?: number;
  dateCol?: string; measureCol?: string;
}

export function detectAnomalies(
  columns: { name: string; type: ColumnType }[],
  rows: Cell[][],
  opts?: AnomalyOptions,
): Anomaly[]

export function buildAnomaliesFacts(datasetName: string, anomalies: Anomaly[]): string
```
Defaults (`:53-60`): `iqrMult 1.5`, `zThreshold 3`, `dominantShare 0.6`, `periodChangePct 0.5`, `maxPerKind 3`, `maxTotal 12`. `MIN_OUTLIER_SAMPLE = 8` (`:63`, **not** overridable). Sole call site: `src/ipc/dashboards.ts:247,250`.

### 2. Rule catalogue with exact formulas

**`numeric_outlier`** (`:111-153`) — only for columns whose declared type is `number`, with **≥ 8** finite values (`:112`).
- Sort ascending; `q1 = quantile(0.25)`, `q3 = quantile(0.75)` with **linear-interpolated type-7** quantiles (`:85-94`): `pos = p*(n-1)`, `lo = floor(pos)`, `hi = ceil(pos)`, `result = s[lo] + (pos-lo)*(s[hi]-s[lo])`.
- `iqr = q3-q1`; `lowerFence = q1 - 1.5*iqr`; `upperFence = q3 + 1.5*iqr`.
- `mean = Σv/n` (left-fold); `variance = Σ(v-mean)² / n` — **POPULATION, ÷N** (`:121`); `std = √variance`.
- A value is an outlier if `v < lowerFence || v > upperFence` (**strict**) **OR** `std > 0 && |(v-mean)/std| > zThreshold` (**strict**). Union, not intersection.
- Outliers collected in original row order; `minOutlier`/`maxOutlier` **unrounded**; fences **rounded** via `round()` (`:79-82`: `Math.round(n*1e6)/1e6`). Severity `warn`.

**`dominant_category`** (`:158-187`) — non-`number` columns. Requires `nonEmpty > 0` **and `counts.size >= 2`** (a single-value column is `constant_column`, not dominant). `share = topCount/nonEmpty`; fires when `share >= dominantShare` (implemented as `if (share < …) return null`). Top value chosen with strict `n > topCount` → **first-occurrence tie-break**. `facts.share` rounded to 1e-6; `pct` = `Math.round(share*100)`. Severity `info`.

**`empty_heavy` / `constant_column`** (`:308-315`) — **delegated verbatim to `datasetStats.findQualityIssues`**; severities remapped to `warn`/`info`; `facts` is `{}`; `duplicate_rows` deliberately dropped. Every datasetStats rule above therefore applies transitively here.

**`period_change`** (`:194-275`) — at most **one** anomaly total.
- Date column: pinned `dateCol`, else the **first** column with `type === 'date'`; absent → none.
- Measures: all `number` columns (or the pinned `measureCol`).
- Bucket per distinct date key (`keyOf`), summing **finite** values per measure. A bucket only gets an entry for a measure if ≥1 finite value was seen — so a missing measure yields `undefined` and the step is **skipped, not treated as 0** (`:249`).
- Needs ≥ 2 distinct dates. Ordering: `Date.parse` every key; **if all parse finitely** sort numerically by parsed time, **else** default lexical `Array.sort()` (`:236-240`).
- For each measure, each consecutive pair: skip if `from`/`to` missing **or `from === 0`**; `pct = (to-from)/from`; keep the single largest `|pct|` where `|pct| >= periodChangePct` and `> bestAbs` (strict → **first-found wins ties**). Severity `warn`; `fromValue`/`toValue`/`pctChange` rounded to 1e-6.

**Assembly** (`:296-333`): discovery order = per-column outlier/dominant (column order) → empty_heavy/constant (column order) → period_change. Then cap **3 per kind**, then a **stable** sort putting `warn` before `info`, then `slice(0, maxTotal)`. The whole body is wrapped in `try/catch → []` (`:334-336`).

**`buildAnomaliesFacts`** (`:346-358`): `GUARD_LINE`, blank line, either `No anomalies were detected in dataset "<name>".` or a header line plus one `- [severity] detail` bullet per anomaly.

### 3. Numerical semantics — the parts that decide SQL fidelity

- **Standard deviation is POPULATION (÷N).** `anomalies.ts:121` divides by `values.length`. DuckDB's `stddev()`/`stddev_samp()` is **sample (÷N−1)**; the correct function is **`stddev_pop`**. This is not theoretical: for the fixture at `test-anomalies.ts:51` (`[10,11,12,13,14,15,16,20]`), mean 13.875, **population σ = 2.9764702249476644 → z(20) = 2.0578**, whereas **sample σ = 3.181980515339464 → z(20) = 1.9251**. With `zThreshold: 2` (`:54`), population **flags** the outlier and sample **does not** — `test-anomalies.ts:56` flips from pass to fail. Every naive port that writes `stddev(c)` gets a *different anomaly set*, not just a different digit.
- **Quantiles are type-7 linear interpolation.** DuckDB's `quantile()` is an **alias for `quantile_disc`** (discrete — returns an actual data point); the interpolating function is **`quantile_cont`**. `median()` is the 0.5 case. Same fixture: type-7 gives `q1 = 11.75, q3 = 15.25 → fences [6.5, 20.5]`; a discrete quantile gives `q1 = 11 (or 12), q3 = 15 (or 16) → fences [5, 21]` — different fences, different `detail` string, and potentially a different outlier set. NEEDS VERIFICATION that `quantile_cont` is *exactly* numpy type-7 (§experiments below).
- **Rounding:** `round()` (`:79-82`) is `Math.round(n*1e6)/1e6`. JS `Math.round` is **half-up** (`Math.round(-2.5) === -2`); DuckDB `round()` is **half-away-from-zero** (`round(-2.5) = -3`). `pctChange` **can be negative** (`:254`, a "fell" finding), so a value landing exactly on a 1e-6 half-boundary rounds differently. Low frequency, silent when it happens. Mitigation: return raw doubles from SQL and keep `round()` in TS.
- **Empty vs null / whitespace:** inherited from the shared `isEmpty` (`:67-70`) and from `findQualityIssues` — identical caveats to datasetStats §3, including the JS-`trim()` Unicode whitespace set.
- **Ordering dependencies:** first-occurrence tie-breaks in `dominantAnomaly` (`:171-176`) and in period ordering (`dateKeys` first-seen, `:220-223`); first-found-wins in the period-change scan (`:252`); stable severity sort (`:332`). All of these require a **preserved row ordinal** once data lives in Parquet.
- **`Date.parse` semantics:** `Date.parse('2023')` → 2023-01-01T00:00:00**Z** (finite), so the year-string fixture takes the numeric-sort path. DuckDB's `TRY_CAST('2023' AS DATE)` fails (it wants a full date) and `strptime` needs an explicit format — the ordering rule does **not** translate to a plain `ORDER BY date_col`.

### 4. Contract encoded by each test assertion

**R-ANOM-01 — the IQR fence flags a lone spike and leaves a clean column alone; the finding carries the offending value and count.**
`test-anomalies.ts:39,40` (`maxOutlier === 1000`), `:41` (`count === 1`), `:42` (`clean` unflagged), `:43` (severity `warn`). Verified numerics: spike column sorted `[10,10,10,11,11,12,12,1000]` → q1 10, q3 12, fences `[7, 15]`, mean 134.5, pop σ 327.129, z(1000) = 2.6457 (**below the default 3** — so this case is caught by the *fence*, not the z-test).

**R-ANOM-02 — the detector is the UNION of the fence test and the z-score test, and the z-score uses population σ.**
`:53` (default z=3 does **not** flag 20; it sits inside the upper fence 20.5), `:56` (with `zThreshold: 2` it **is** flagged). Only true with ÷N.

**R-ANOM-03 — fewer than 8 finite values → no outlier finding, however extreme.**
`:63` (`[1,2,1000]` → none).

**R-ANOM-04 — a categorical column whose modal share of non-empty cells is ≥ 0.6 is `dominant_category`, with app-computed value/count/share; below the threshold it is silent.**
`:79` (`value 'A'`, `count 7`), `:80` (`share === 0.7` — exact), `:81` (severity `info`), `:82` (top share 0.4 → not flagged).

**R-ANOM-05 — `empty_heavy` and `constant_column` pass through from `findQualityIssues` with fixed severities, and `duplicate_rows` is never surfaced.**
`:101` (`warn`), `:102` (`info`), `:103` (no `duplicate_rows`).

**R-ANOM-06 — a step-over-step change ≥ 50% between adjacent periods is flagged, naming the measure column and carrying from/to periods and app-computed period sums; a 10% step is not.**
`:115` (`pctChange === 1`), `:116-118` (`fromPeriod '2023'`, `toPeriod '2024'`, `fromValue 100`, `toValue 200`), `:119` (`column === 'rev'` — the measure, not the date column), `:122` (100→110 → nothing).

**R-ANOM-07 — a leading-zero identifier column is text and must never enter the numeric path; a varied id column produces no findings at all.**
`:133` (no `numeric_outlier`), `:134` (`out.length === 0` — 8 distinct values are neither dominant, constant, nor empty-heavy).

**R-ANOM-08 — degenerate input never throws; it returns `[]`.**
`:138` (empty), `:139` (columns, no rows), `:140` (`null, null`).

**R-ANOM-09 — findings are ordered warn-before-info and capped by `maxTotal`.**
`:158` (every `warn` precedes every `info`), `:159` (`{maxTotal: 1}` → exactly 1). Note the fixture produces 6 findings (2 dominant + 2 empty_heavy + 2 constant) before capping.

**R-ANOM-10 — the FACTS block opens with the guard line, names the dataset, emits exactly one bullet per anomaly, and is safe when empty.**
`:167`, `:168`, `:169`, `:171`.

### 5. DUCKDB BREAKAGE TABLE — `anomalies`

| Rule | Current behaviour | Naive DuckDB SQL | Exact match? | Mitigation |
|---|---|---|---|---|
| **R-ANOM-02** | z-score over **population** σ (÷N) | `stddev(c)` / `stddev_samp(c)` — **sample, ÷N−1** | 🔴 **NO — proven.** σ 2.9765 vs 3.1820; z(20) 2.0578 vs 1.9251; the finding **disappears** at `zThreshold 2`. Larger σ ⇒ systematically **fewer** anomalies detected on every dataset | use **`stddev_pop(c)`** (or `sqrt(var_pop(c))`). Add a fixture asserting σ to 12 significant digits so a future refactor cannot silently swap it back. |
| **R-ANOM-01/02** | q1/q3 = **type-7 linear interpolation** | `quantile(c, 0.25)` — **alias for `quantile_disc`**, returns an actual data point | 🔴 **NO.** Fences `[6.5, 20.5]` vs `[5, 21]` — different `detail` text and a potentially different outlier set | use **`quantile_cont(c, 0.25)`**. NEEDS VERIFICATION that `quantile_cont` is exactly type-7: run `SELECT quantile_cont(x,0.25), quantile_cont(x,0.75) FROM (VALUES (10),(11),(12),(13),(14),(15),(16),(20)) t(x);` — must return **11.75** and **15.25**. Also `SELECT quantile(x,0.25) …` to confirm the disc/cont alias trap, and `SELECT median(x) FROM (VALUES (1),(2),(3),(4)) t(x);` — must return **2.5** to be `quantile_cont`-equivalent. |
| R-ANOM-01 | mean via left-fold; variance via **two-pass** `Σ(v-mean)²/n` | `avg`/`var_pop` may use Welford or `E[x²]−E[x]²` | 🔴 last-ULP drift in fences and z-scores; can flip a value sitting exactly on a threshold | accept ULP drift but pin the *functions* (`var_pop`), and keep the strict `<`/`>` comparisons in TS on returned doubles rather than in SQL, so at least the comparison semantics are unchanged. NEEDS VERIFICATION: `SELECT var_pop(x) FROM (VALUES (1e8),(1e8+1),(1e8+2)) t(x);` — a naive `E[x²]−E[x]²` implementation loses catastrophically here and may even return a negative variance. |
| R-ANOM-01 | outliers collected in **row order**; `minOutlier`/`maxOutlier` unrounded | `SELECT c FROM t WHERE …` — unordered | 🔴 the `detail` string's "from X to Y" and the `facts` values can vary run to run | `ORDER BY rn`; requires the row ordinal again. |
| R-ANOM-01 | requires ≥ 8 **finite** values | `count(c) >= 8` | 🔴 counts `NaN`/`Inf` | `count(*) FILTER (WHERE isfinite(c))`; also filter the value set feeding the quantiles — DuckDB sorts `NaN` last, so an unfiltered `quantile_cont` is skewed. |
| **R-ANOM-04** | modal value; ties → first occurrence; share ≥ 0.6 over **non-empty** cells | `mode(c)` and `count(c)` as the denominator | 🔴 twice over: unspecified tie-break, **and** `''`/whitespace inflate the denominator, lowering `share` below the threshold and **suppressing real findings** | `GROUP BY … ORDER BY count(*) DESC, min(rn) LIMIT 1` with the explicit non-empty predicate; denominator = the same filtered count. |
| R-ANOM-04 | `counts.size >= 2` required | — | 🟠 easy to drop during a port; without it a constant column is reported twice (as dominant **and** constant) | keep the guard explicitly in the SQL/TS bridge. |
| **R-ANOM-05** | delegates to `findQualityIssues` | — | 🔴 **inherits every datasetStats breakage** (whitespace, distinct, all-empty-not-constant) | port `findQualityIssues` first; keep anomalies calling it rather than re-deriving the SQL — the "no duplication" property at `anomalies.ts:12-14` is also a correctness property. **Note the sync/async coupling: `anomalies.ts:308` calls it synchronously (OQ-0).** |
| **R-ANOM-06** | period ordering: numeric by `Date.parse` when *all* keys parse, else **lexical**; buckets in first-seen order | `GROUP BY date_col ORDER BY date_col` | 🔴 **NO** — `'2023'` is not castable to `DATE` in DuckDB; a plain `ORDER BY` on VARCHAR is always lexical, and on a real `DATE` column it is always chronological. The current code switches strategies at runtime | keep the ordering decision in TS: `GROUP BY` in SQL to get `(dateKey, sum)` pairs, then sort and diff in TS exactly as today. Only the grouped sums move to SQL. |
| R-ANOM-06 | missing measure in a bucket ⇒ **skip the step** (not 0) | `SUM` over a group with no finite values → `NULL` | 🟢 matches, **provided no `COALESCE(...,0)`** is added | forbid `COALESCE` in the metric/period SQL generators; comment why. |
| R-ANOM-06 | `from === 0` ⇒ skip (no division by zero) | SQL `x/0` on DOUBLE → `NULL` or `Infinity` depending on the type | 🟠/🔴 | keep the `from === 0` guard in TS. |
| R-ANOM-06 | `round(n)` = `Math.round(n*1e6)/1e6`, **half-up** including negatives | `round(n, 6)`, **half-away-from-zero** | 🔴 last-digit divergence on negative `pctChange` | do all rounding in TS on raw SQL doubles. |
| R-ANOM-09 | stable sort, discovery order preserved within a severity | any SQL `ORDER BY severity` | 🔴 the FACTS bullet order changes ⇒ different model prompt bytes | assemble and sort the `Anomaly[]` in TS; SQL returns only raw aggregates. |
| R-ANOM-08 | `try/catch` → `[]`, never throws | a DuckDB binder/IO error now has many more ways to fire | 🟠 as long as the outer `try/catch` survives; but "no anomalies" and "the engine failed" become indistinguishable | keep the catch, but log the error to the main-process log so a systematically failing detector is not invisible. |
| R-ANOM-10 | pure string assembly | n/a | 🟢 | keep `buildAnomaliesFacts` untouched — it is pure string work and has no business in SQL. |

### 6. Open questions / risks — `anomalies`

- **OQ-10.** `detectAnomalies` calls `findQualityIssues` synchronously (`:308`). If datasetStats goes async, `detectAnomalies` must too, and so must `ipc/dashboards.ts:247`. This is the concrete propagation path for OQ-0 — cost it before starting.
- **OQ-11.** `MIN_OUTLIER_SAMPLE = 8` is a module constant, not an option (`:63`). If the port makes it configurable, that is a new behaviour; keep it hard-coded.
- **OQ-12.** Recommended split for this module: **SQL computes only raw aggregates** (`quantile_cont` q1/q3, `avg`, `var_pop`, per-group sums, filtered counts, the modal value + count). **TS keeps** all thresholds, comparisons, `round()`, tie-breaks, ordering, capping, and every `detail`/`facts` string. This preserves the maximum number of assertions with the minimum SQL surface, and it keeps the auditable part of "the app does the math" in code a reviewer can read.
- **OQ-13.** Whether these three modules should move to DuckDB **at all** in Phase 1. `datasetStats` runs once per dataset open; `metricValue` runs once per metric card; `anomalies` runs on demand. None is in the interactive cross-filter hot path that motivates the migration — `transforms.ts`/`vizData.ts` are. Porting these three buys little performance and carries every silent-wrongness risk tabulated above. A defensible Phase 1 scope is: port `transforms`/`vizData` to SQL, and leave these three reading the Arrow result via a thin `Cell[][]` view. Worth raising with the owner before committing.

---

## Consolidated DuckDB verification experiments

Run all of these before writing any SQL generator; each settles a "NEEDS VERIFICATION" above.

```sql
-- 1. Sample vs population stddev (R-ANOM-02) — expect 3.181980515339464 / 2.9764702249476644
SELECT stddev(x), stddev_samp(x), stddev_pop(x)
FROM (VALUES (10),(11),(12),(13),(14),(15),(16),(20)) t(x);

-- 2. quantile aliasing + type-7 (R-ANOM-01) — quantile_cont must give 11.75 / 15.25
SELECT quantile(x,0.25), quantile_disc(x,0.25), quantile_cont(x,0.25), quantile_cont(x,0.75)
FROM (VALUES (10),(11),(12),(13),(14),(15),(16),(20)) t(x);
SELECT median(x) FROM (VALUES (1),(2),(3),(4)) t(x);   -- 2.5 ⇒ continuous

-- 3. Float summation: Kahan or naive? JS left-fold gives 0.0
SELECT sum(x) FROM (VALUES (1e16),(1.0),(-1e16)) t(x);
SELECT sum(x)/count(x) = avg(x) FROM (VALUES (0.1),(0.2),(0.3),(0.4),(0.5),(0.6),(0.7)) t(x);

-- 4. Variance algorithm stability (R-ANOM-01)
SELECT var_pop(x) FROM (VALUES (1e8),(1e8+1),(1e8+2)) t(x);   -- must be 0.666…, never negative

-- 5. NaN ordering and isfinite (R-STATS-03)
SELECT max(x), min(x), isfinite('nan'::DOUBLE), isfinite('inf'::DOUBLE)
FROM (VALUES (1.0),('nan'::DOUBLE)) t(x);

-- 6. Empty string is NOT null; distinct/collation (R-STATS-07, R-STATS-11)
SELECT '' IS NULL, 'A' = 'a', count(DISTINCT x) FROM (VALUES (''),('  '),('a'),(NULL)) t(x);
SELECT trim('<tab><nbsp>') = '';   -- expect FALSE ⇒ trim() ≠ JS trim()

-- 7. FILTER with DISTINCT, and struct-distinct for duplicate_rows (R-STATS-11)
SELECT count(DISTINCT x) FILTER (WHERE x <> '') FROM (VALUES ('a'),('') ) t(x);
SELECT (SELECT count(*) FROM t) - (SELECT count(*) FROM (SELECT DISTINCT * FROM t));

-- 8. Implicit VARCHAR→numeric cast — the leading-zero landmine (R-METRIC-06)
SELECT sum(x), min(x), typeof(min(x)) FROM (VALUES ('007'),('012'),('90210')) t(x);
SELECT TRY_CAST('007' AS DOUBLE);   -- expect 7 ⇒ TRY_CAST is NOT a safe substitute

-- 9. Negative rounding half-rule (R-ANOM-06)
SELECT round(-2.5), round(-1.2345675, 6);   -- JS Math.round gives -2 and -1.234567
```agentId: a9e4f1f89a21e0dc5 (use SendMessage with to: 'a9e4f1f89a21e0dc5', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 142633
tool_uses: 26
duration_ms: 587024</usage>