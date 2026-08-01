## transforms.ts

**Phase 0 behavioural contract — `src/transforms.ts` (688 lines) + `scripts/test-transforms.ts` / `.js` (64 assertions)**

Files read: `/Users/ashishb/Projects/ordinate/src/transforms.ts`, `/Users/ashishb/Projects/ordinate/scripts/test-transforms.ts`, `/Users/ashishb/Projects/ordinate/src/parse.ts` (`detectColumnType`, `coerceValue`, `isFiniteNumber`), `/Users/ashishb/Projects/ordinate/src/formula.ts:21-61` (signature only), plus callers `/Users/ashishb/Projects/ordinate/src/datasets.ts`, `/Users/ashishb/Projects/ordinate/src/vizData.ts`, `/Users/ashishb/Projects/ordinate/src/visuals.ts`, `/Users/ashishb/Projects/ordinate/src/dashboards.ts`, `/Users/ashishb/Projects/ordinate/src/ipc/datasets.ts:359-385`.

Every claim marked **[probed]** was verified empirically by running the compiled `src/transforms.js` under plain `node` (read-only; scratchpad scripts only, no repo file touched).

---

### 1. Exported API surface — verbatim declarations

Phase 1 must preserve all of these byte-for-byte.

```ts
// transforms.ts:23
export type Cell = string | number | null;

// transforms.ts:25-28
export interface TableData {
  columns: ParsedColumn[];
  rows: Cell[][];
}

// transforms.ts:30-35
export interface ApplyResult {
  columns: ParsedColumn[];
  rows: Cell[][];
  rowCount: number;
  warnings: string[];
}

// transforms.ts:39-45
export type FilterOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'is_empty' | 'not_empty';
export type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max';
export interface Aggregation {
  column: string;
  fn: AggFn;
  as: string;
}

// transforms.ts:47-94  (the union — see §2)
export interface CalculatedFieldStep { type: 'calculated_field'; name: string; expression: string; }
export interface FilterStep { type: 'filter'; column: string; op: FilterOp; value?: Cell; }
export interface GroupAggregateStep { type: 'group_aggregate'; groupBy: string[]; aggregations: Aggregation[]; }
export interface DedupeStep { type: 'dedupe'; columns?: string[]; }
export interface FillEmptyStep { type: 'fill_empty'; column: string; value: string | number; }
export interface TrimStep { type: 'trim'; column?: string; }
export interface DropColumnStep { type: 'drop_column'; column: string; }
export interface RenameColumnStep { type: 'rename_column'; from: string; to: string; }

export type TransformStep =
  | CalculatedFieldStep | FilterStep | GroupAggregateStep | DedupeStep
  | FillEmptyStep | TrimStep | DropColumnStep | RenameColumnStep;

// transforms.ts:96
export type StepType = TransformStep['type'];

// transforms.ts:158
export function applyPipeline(source: TableData, steps: TransformStep[]): ApplyResult;

// transforms.ts:496
export function sanitizeSteps(raw: unknown): TransformStep[];

// transforms.ts:592-598
export function combineTables(
  left: TableData,
  right: TableData,
  mode: 'append' | 'join',
  on?: { left: string; right: string },
  limit = 50_000,
): ApplyResult;
```

`ParsedColumn` is imported from `./parse` (`parse.ts:18-21`): `{ name: string; type: 'text' | 'number' | 'date' }`.

**Critical property of the return type:** `applyPipeline` is **synchronous**. DuckDB's Node bindings are async. Either Phase 1 keeps a synchronous facade (only possible with a sync-capable binding such as `@duckdb/node-api`'s sync connection, or a blocking worker) or every call site changes — which contradicts "callers must not notice". Call sites that are currently sync-in-a-sync-function: `vizData.ts:125,158,232` (`buildVizData` is a pure sync exported function used by `visuals`, `dashboards`, `dashboardExport`, `reportCapture`). **This is the single largest structural risk in Phase 1 and it is not about SQL semantics at all.**

**Exported-but-untested surface:** `sanitizeSteps` is pure TypeScript validation with no compute in it; it should **not** move to SQL. It is also a security control (`visuals.ts:206`, `dashboards.ts:243` narrow untrusted renderer/AI input to `FilterStep[]` through it).

---

### 2. The `TransformStep` union — semantics and edge cases

All eight are dispatched at `transforms.ts:179-200`. Every step handler builds a **new** `TableData`; none mutates its input.

#### 2.1 `calculated_field` — `transforms.ts:204-242`

```ts
{ type: 'calculated_field'; name: string; expression: string }   // both required
```

Semantics, in order:
1. `name` is trimmed; blank → **skip** + warning `Calculated field skipped: blank column name` (`:206`).
2. Duplicate name (`colIndex >= 0`) → **skip** + `... column "X" already exists` (`:207-209`).
3. `compile(s.expression)` from `formula.ts:36`; `{ ok:false }` → **skip** + `Calculated field "X" skipped: <error>` (`:211-214`).
4. `compiled.fn.refs` naming a column that does not exist → **warning only, step still runs** (`:217-220`). Every row then evaluates to `null` (formula degrades unknown column → null). **[probed]** `units * nothere` → column `z` of all-nulls, typed `text`, 1 warning.
5. Per row, a `Record<string, FValue>` map of `{columnName: cell}` is built and `compiled.fn.evaluate(rowMap)` is called (`:226-230`). If two columns share a name, the **last** one wins in the map (object key overwrite) — divergent from `colIndex`, which takes the first.
6. New column appended at the end, initially `{name, type:'text'}` (`:233`), `undefined`/`null` result → `null` (`:237`).
7. `retypeColumn(columns, rows, newIdx)` (`:239`, impl `:130-135`) — stringify every cell, run `parse.detectColumnType` (the strict `isFiniteNumber` gate), set the column type, then `parse.coerceValue` every cell to that type.

Edge cases (all **[probed]**):
- **Booleans stringify.** `units > 2` → cells `"true"`/`"false"`, column `text`. `FValue` includes `boolean` (`formula.ts:21`) but `Cell` does not; the boolean survives only because `retypeColumn` stringifies it.
- **One non-numeric row demotes the whole column and stringifies the numbers.** `if(units > 2, units, 'low')` → `["3","5","low","low"]`, type `text`. Numbers become **strings**.
- **Float artifacts land as text.** `0.1 + 0.2` → `0.30000000000000004` → 17 significant digits → `isFiniteNumber` rejects >15 digits (`parse.ts:329`) → the column is `text` and the cell is the **string** `"0.30000000000000004"`. This is load-bearing weirdness that a naive SQL port will silently "fix".
- **Leading zeros survive** (test L67-68): `concat('0', sku)` → `"0007"`, type `text`.
- Empty table → column appended, zero rows, type `text` (`detectColumnType([])` → `'text'`).

#### 2.2 `filter` — `transforms.ts:244-308`

```ts
{ type: 'filter'; column: string; op: FilterOp; value?: Cell }   // value optional
```

Guards: unknown column → **skip** + `Filter skipped: unknown column "X"` (`:246`); op not in `FILTER_OPS` → skip (`:247`). Rows are kept in **input order** (`Array.prototype.filter`, `:306`). Columns pass through unchanged (including the column's declared type — a filter never retypes).

Operator table. `isEmptyCell` (`:117-120`) = `null` **or** a string whose `.trim()` is `''`. `cellToString` (`:122-124`) = `''` for `null`, else `String(cell)`.

| Op | Branch | Semantics |
|---|---|---|
| `is_empty` | `:253-254` | `cell == null \|\| String(cell).trim() === ''`. **Whitespace-only counts as empty** [probed]. Ignores `value` and column type. |
| `not_empty` | `:255-256` | negation of the above. |
| `contains` | `:257-259` | `cellToString(cell).includes(cellToString(value ?? null))`. **Always string-based regardless of column type** — `contains '0'` on the numeric `units` column matches the cell `0` [probed]. Case-**sensitive**. `null` cell → `''`; a `null`/omitted `value` → needle `''` → **matches every row including nulls**. |
| `= != > < >= <=` on a **`number`-typed column** | `:260-282` | `value` is run through `coerceValue(value, 'number')`; a non-lossless value → `null`. Cell must be `typeof === 'number' && Number.isFinite`. **If either side is null, the row is dropped for *every* operator, including `!=`** (`:265`). [probed] `units != 'abc'` → 0 rows; a `null` cell never survives `< 5`. |
| `= != > < >= <=` on a **`text` or `date` column** | `:283-303` | Both sides via `cellToString`, then JS string comparison (UTF-16 code-unit order). Case-**sensitive**. `null` cell becomes `''`, so `= ` with an omitted `value` matches **both `''` and `null`** [probed]. `>=` on a `date` column is a lexicographic string compare — correct only for ISO-ish `YYYY-MM-DD` [probed: `'2024-01-05' >= '2024-01-01'` → kept]. |

The **column's declared `type`, not the cell's runtime type, selects the branch.** A `text`-typed column holding real numbers compares lexicographically (`"10" < "9"`).

#### 2.3 `group_aggregate` — `transforms.ts:310-400`

```ts
{ type: 'group_aggregate'; groupBy: string[]; aggregations: Aggregation[] }
```

- Any `groupBy` name missing → **whole step skipped** + one warning (`:314-318`). (Contrast: a missing *aggregation* column does **not** skip.)
- Output columns = the groupBy columns **with their source types preserved**, then one column per aggregation, **always declared `type:'number'`** (`:323-326`) — even when every value is `null` [probed] and even when the aggregate is `count`.
- **Output rows are in first-seen group order** (`:333-345`; `groups[]` array + `byKey` Map). [probed] rows `Z,A,Z` → output `[["Z",4],["A",2]]`.
- Group key = `JSON.stringify(keyCells)` (`:337`), so it is **type-discriminating**: the number `1` and the string `"1"` are different groups [probed]. `null` groups with `null`. `''` is its own group, distinct from `null`.
- `groupBy: []` → one global group over all rows → **one output row** [probed]. But on an **empty input table** this yields **zero rows**, not one (`groups` is empty) [probed] — see the SQL table.
- `aggregations: []` → a distinct-values projection of the groupBy columns [probed].
- Duplicate `as` names, or an `as` colliding with a groupBy name, are allowed and produce **two columns with the same name** [probed].
- The aggregate output is **not** run through `retypeColumn` — values stay raw JS numbers.

Aggregate functions (`aggregate`, `:362-400`):

| Fn | Behaviour | Empty/null/non-numeric | Mixed types |
|---|---|---|---|
| `count` | number of cells in the referenced column where `!isEmptyCell` (`:370-373`) | `null`, `''`, and **whitespace-only** are all excluded [probed: `['x','',null,' ']` → 1] | any non-empty cell counts, numeric or not |
| `sum` | `nums.reduce((a,b)=>a+b, 0)` over cells passing `typeof v === 'number' && Number.isFinite(v)` (`:376-385`) | zero qualifying cells → **`null`, not 0** (`:381`) [probed] | numeric **strings are ignored** — a `text` column of `"5"` sums to `null` [probed] |
| `avg` | `sum / nums.length` (`:387`) | zero qualifying → `null`; nulls/non-numerics excluded from both numerator and denominator | same |
| `min` / `max` | `reduce`, **deliberately not `Math.min(...)`** (`:388-396`) — argument-spread would `RangeError` on a 200k-row group, `applyPipeline` would catch it and silently return the **un-aggregated** table | zero qualifying → `null` | same |
| unknown `fn` | **falls back to `count`** (`:368`) [probed: `fn:'median'` behaved as count]. `sanitizeSteps` normally blocks this, but direct callers can hit it. |

- A missing aggregation column → the aggregate returns `null` **and pushes a warning once per group** (`:363-366`) → a 10k-group table emits 10k identical warnings [probed: 2 groups → 2 identical warnings]. That warnings array is returned to the renderer.
- Aggregation `as` is used verbatim; no trimming, no blank check.

#### 2.4 `dedupe` — `transforms.ts:402-431`

```ts
{ type: 'dedupe'; columns?: string[] }   // omitted or [] => all columns
```

- `columns` present **and non-empty**: unknown names are dropped with a per-name warning (`:411`); if *none* resolve → skip the step (`:414-416`). `columns: []` falls through to the all-columns branch [probed].
- Key = `JSON.stringify(keyIdx.map(ci => r[ci] ?? null))` — type-discriminating (`1` ≠ `"1"` [probed]), `undefined` normalised to `null`.
- **The FIRST occurrence of each key survives** (`:423-428`); later duplicates are dropped. Surviving rows keep their relative input order.
- Columns pass through untouched (no retype).

#### 2.5 `fill_empty` — `transforms.ts:433-448`

```ts
{ type: 'fill_empty'; column: string; value: string | number }   // both required
```

- Unknown column → skip + warning (`:435`).
- Fill value: `typeof s.value === 'number' ? s.value : String(s.value ?? '')` (`:439`).
- Replaces cells where `isEmptyCell` — i.e. `null`, `''`, **and whitespace-only strings**.
- Then **`retypeColumn`** (`:445`). Consequences [all probed]:
  - Filling a `number` column with the text `'n/a'` demotes the whole column to `text` and **stringifies the surviving numbers** (`1` → `"1"`).
  - Filling with the number `0` on a `number` column keeps it numeric.
  - **Filling with `''` is a no-op that leaves `null`**: the cell is set to `''`, then `coerceValue('', 'text')` → `coerceCell` returns `null` for `''` (`parse.ts:219`).

#### 2.6 `trim` — `transforms.ts:450-471`

```ts
{ type: 'trim'; column?: string }   // omitted/'' => all TEXT-typed columns
```

- Named column: unknown → skip + warning (`:457`). A named **non-text** column is still targeted, but only `typeof v === 'string'` cells are altered — so trimming a `number` column is a no-op [probed].
- `column: ''` (empty string) is falsy → takes the **all-text-columns** branch [probed], not a skip.
- All-columns branch selects `c.type === 'text'` only — `date` columns are **not** trimmed.
- Uses JS `String.prototype.trim()` (Unicode whitespace + line terminators, incl. `\t`, `\n`, NBSP `\u00A0`, BOM `\uFEFF`).
- **No retype afterwards** — trimming `" 12 "` in a `text` column leaves it `text`.

#### 2.7 `drop_column` — `transforms.ts:473-480`

```ts
{ type: 'drop_column'; column: string }
```
Unknown → skip + warning. Removes the column **and the cell at that index in every row** (`:478`). Only the **first** column of that name is removed. Dropping the last remaining column yields `columns: []`, `rows: [[], ...]`, `rowCount` unchanged [probed: `{columns:[], rows:[[]], rowCount:1}`].

#### 2.8 `rename_column` — `transforms.ts:482-492`

```ts
{ type: 'rename_column'; from: string; to: string }
```
Unknown `from` → skip + warning; blank/whitespace `to` → skip + warning (`:485-486`). `to` is trimmed. **No collision check** — renaming `units` → `price` produces two columns named `price` [probed]; subsequent steps resolve by `colIndex` = **first match**. Rows are copied unchanged.

---

### 3. The fold contract (`applyPipeline`, `transforms.ts:158-177`)

1. **Immutable source.** `cloneTable(source)` (`:138-143`) deep-copies columns (spread each) and rows (`slice()`) once, up front. Cells are scalars, so a two-level copy is a full deep copy. Test L219-229 asserts `JSON.stringify(src)` is unchanged after a 3-step pipeline. `steps` is also never mutated [probed].
2. **Strict left→right fold.** `for (const step of list)` — each step consumes the previous step's output table. Order is the semantic contract; there is no reordering, no optimisation, no short-circuit.
3. **Reversibility follows from 1+2**: output is a pure function of `(source, steps)`. `datasets.ts:394-400` (`updateSteps`) re-runs the whole pipeline from the stored immutable `source` on every add/update/remove/reorder. `datasets.ts:287,360` do the same on a connection refresh and a column retype.
4. **Never throws on a bad step.** Two layers: (a) each handler returns `skip(t, warning)` (`:150-152`) which passes the table through **unchanged**; (b) `applyPipeline` wraps `dispatch` in `try/catch` (`:165-171`) and on an exception emits `Step "<type>" skipped: <message>` and passes the table through. Unknown `type` hits `default:` in `dispatch` (`:197-199`) → `Unknown step type "X" skipped`.
5. **Warnings** are a flat `string[]` accumulated across all steps in step order (`:173`), returned as `ApplyResult.warnings`. They are human-readable prose with no code/step index — call sites surface them raw to the renderer (`datasets.updateSteps` returns `{dataset, output}` for the IPC preview). Warnings can be **duplicated per group** (see §2.3) and the array has no cap.
6. **Not defended:** a malformed `source` throws *outside* the try — `applyPipeline(null, [])` and `applyPipeline({columns:[...]} /* no rows */, [])` both throw `TypeError` [probed]. `steps` being non-array is handled (`:161`).
7. `rowCount` is always `table.rows.length` (`:176`), never a stored value.
8. **There is no `sort` step.** Output row order = source row order as mutated by the per-step rules above. Nothing downstream re-sorts: `vizData.buildAggregated` (`vizData.ts:125-133`) takes chart labels straight from `out.rows` order, and `buildPivot` (`:158-180`) derives both the category axis and series order from first-appearance in `out.rows`. **Chart x-axis order is the pipeline's row order.**

---

### 4. `combineTables` (`transforms.ts:592-688`)

Never called inside `applyPipeline` (`:587`); IPC-only via `dataset:combine` (`src/ipc/datasets.ts:359-385`, which then slices to `MAX_ROWS`). Unknown mode → `{columns:[], rows:[], rowCount:0, warnings:['Unknown combine mode "X"']}` [probed].

**`append`** (`:604-632`)
- Column set = left's names in order, then right's names **not already seen** (`:608-615`). Alignment is **by name only**; declared types are ignored for matching.
- Left rows first, then right rows (`:621-626`). A column absent from a side → `null`. `?? null` also maps `undefined` → `null`.
- **Every** output column is re-typed via `retypeColumn` (`:628-629`). Type conflict resolution: left `a:number` + right `a:text` `"007"` → column becomes **`text`** and the left `1` is stringified to `"1"` [probed]. An all-null column → `text`.
- **Duplicate column names inside one input corrupt data:** `names` keeps left's duplicates verbatim while `leftIdx` is a `Map` where the **last** index wins → both output columns take the last duplicate's value. [probed] left `[a,a]` row `['1','2']` → `[2,2]`.

**`join`** (`:634-688`) — **inner join only**, despite the header comment saying "left/inner".
- Missing/invalid `on` → returns **left unchanged** + `['Join skipped: missing "on" key pair']` (`:636-638`); unknown key column → left unchanged + a warning naming both (`:641-643`).
- Output columns = **all** left columns (types preserved as-is at `:683`, then re-typed at `:685`), then right's non-key columns; the right join key is dropped (`:650`). Name collisions get a `_right` suffix (`:652`) [probed: `id, v, v_right`]. A third collision would collide again (`v_right` vs an existing `v_right` is not re-suffixed).
- **Key matching is string-coerced:** `cellToString(r[ri])` on both sides (`:659`, `:673`). Consequences [probed]: numeric `1` **matches** the string `"1"`; **`null` matches `null`** *and* matches `''` (both stringify to `''`).
- Unmatched left rows are dropped (`:675`); unmatched right rows never appear.
- **Row multiplication:** for each left row, every matching right row emits a row — full m×n on duplicate keys. Output order = left-row order, then right-bucket insertion order [probed: `[A,1,10],[A,1,20],[A,2,10],[A,2,20]`].
- **Cap applied during the build**, not after (`:670-681`): stops at `limit` (default 50 000), sets `Join row cap reached — kept first N matched rows`. This is deliberate anti-OOM (`:666-669`) — a post-hoc `.slice()` would materialise 2.5 B rows first.
- All output columns are re-typed (`:685`), so the same "one text cell demotes the column" rule applies.

---

### 5. Rules encoded by `scripts/test-transforms.ts` (64 assertions)

Fixture (`test-transforms.ts:33-48`): columns `city:text, sku:text, units:number, price:number`; rows `['Paris','007',3,10], ['Berlin','012',5,20], ['Paris','007',2,10], ['Berlin','020',0,5]`.

| Rule | One-line contract | Assertions | Example |
|---|---|---|---|
| **R-TRANS-01** | `calculated_field` appends a column computed row-wise by `formula.compile` | L55-58 | `units*price` → `[30,100,20,0]`, typed `number`, 0 warnings |
| **R-TRANS-02** | A computed column is typed by the **strict** number gate; identifier-shaped output stays `text` and the source column is untouched | L67-70 | `concat('0',sku)` → `"0007"`, `tag:text`, `sku[0]` still `"007"` |
| **R-TRANS-03** | Blank name / duplicate name / compile error each skip the step with exactly one warning and leave the table at 4 columns | L76-80 | `name:'  '` → 4 cols, 1 warning; `name:'city'` → warning contains `already exists`; `expression:'1 +'` → 1 warning |
| **R-TRANS-04** | `filter` on a `number` column compares numerically | L86 | `units > 2` → 2 rows |
| **R-TRANS-05** | `filter` on a `text` column compares as strings, exactly and case-sensitively | L88 | `city = 'Paris'` → 2 rows |
| **R-TRANS-06** | `contains` is a case-sensitive substring test on the stringified cell | L90 | `sku contains '01'` → 1 row, `"012"` |
| **R-TRANS-07** | `is_empty`/`not_empty` treat `null` and `''` as empty and partition the table | L98,L100 | `['x'],[''],[null],['y']` → 2 / 2 |
| **R-TRANS-08** | `group_aggregate` collapses to one row per distinct key; groupBy columns come first, aggregations after, in declaration order | L118-119 | 4 rows → 2 rows; `columns[0].name === 'city'` |
| **R-TRANS-09** | `sum/avg/count/min/max` compute exactly, including zero-valued rows | L123-129 | Paris: sum 5, avg 10, count 2, min 2, max 3; Berlin avg `(20+5)/2 = 12.5` |
| **R-TRANS-10** | Aggregation output columns are declared `number`, and a clean group emits no warnings | L130-131 | `total_units`,`avg_price` → `number` |
| **R-TRANS-11** | `dedupe` with no columns keys on the whole row | L137 | no fully-identical rows → 4 rows kept |
| **R-TRANS-12** | `dedupe` on chosen columns keeps the **first** occurrence per key | L139-140 | by `city` → 2 rows; `units[0] === 3` (Paris's first row, not the later `2`) |
| **R-TRANS-13** | `fill_empty` replaces `null`/`''` and leaves existing values alone | L150-151 | `['N'],[''],[null],['S']` + `'Unknown'` → no empties; `[0] === 'N'` |
| **R-TRANS-14** | `trim` with a column touches only that column; without one, every text column | L161,L163 | `'  Alice  '`,`' hi '` → `'Alice'`,`' hi '` / `'Alice'`,`'hi'` |
| **R-TRANS-15** | `drop_column` removes the column definition **and** the cell from every row | L169-170 | 4 cols → 3; `rows[0].length === 3` |
| **R-TRANS-16** | `rename_column` renames in place, values preserved | L172-173 | `units`→`quantity`, `quantity[0] === 3` |
| **R-TRANS-17** | A step naming a missing column warns once and passes data through **unchanged** | L179-180 | `filter column:'nope'` → 1 warning containing `nope`, still 4 rows |
| **R-TRANS-18** | An unknown step `type` warns and is skipped, never throws | L182 | `{type:'frobnicate'}` → 4 rows, 1 warning |
| **R-TRANS-19** | Steps compose left→right; later steps see earlier steps' derived columns | L196-198 | `calc total` → `filter total > 0` → `group by city sum(total)` → Paris 50, Berlin 100 |
| **R-TRANS-20** | **Reversibility:** removing a step ≡ never having added it; re-adding it restores byte-identical output | L212,L213,L216 | `[A,B,C]` vs `[A,C]`: different rowCount; `JSON.stringify(readdB) === JSON.stringify(withB)`; `JSON.stringify(withoutB) === JSON.stringify(neverB)` |
| **R-TRANS-21** | **Source immutability:** the input object is byte-identical after apply | L228 | `JSON.stringify(src)` before === after |
| **R-TRANS-22** | `sanitizeSteps` keeps only well-formed steps, strips extra fields, non-array → `[]` | L242-244 | 6 raw → 2 clean; no `extra` key; `sanitizeSteps('nope')`/`(null)` → `[]` |
| **R-TRANS-23** | `append` unions columns by name in left-then-new-right order, stacks left rows then right rows, fills gaps with `null`, and re-detects types | L258-261 | `city,units` + `city,price` → `city,units,price`; `rows[0][2]===null`, `rows[1][1]===null` |
| **R-TRANS-24** | `join` is an inner join on the given key pair; right's non-key columns are appended and re-typed; a missing `on` warns instead of throwing | L275-278,L280 | 3 left × 2 right → 2 rows; `id,name,score`; `score[0]===90`, `name[0]==='Alice'` |
| **R-TRANS-25** | The join **output** is capped during the build; under the cap there is no warning | L297-298,L303 | 400×400 on one key, limit 1000 → exactly 1000 rows + `/row cap/i` warning; 10×10 → 100 rows, 0 warnings |
| **R-TRANS-26** | `min`/`max` over a huge group must not arg-spread (would `RangeError` → step silently skipped → wrong un-aggregated output) | L321-323 | 200 000 rows, one group → `rowCount 1`, min `0`, max `199 999` |

**Order-dependent assertions** (these break the moment SQL returns rows in a different order):

| Line | What it depends on |
|---|---|
| L56 | row order of `total` = `[30,100,20,0]` (source order) |
| L68, L70 | `[0]` = the *first source row* |
| L140 | dedupe keeps the **first** occurrence **and** emits Paris before Berlin |
| L151 | `region[0] === 'N'` |
| L173 | `quantity[0] === 3` |
| **L213, L216** | full `JSON.stringify` deep equality of the entire `ApplyResult` — row order, column order, warning order, and numeric formatting must all be **deterministic across runs** |
| L260 | append emits all left rows before all right rows |
| L277 | join output follows left-row order |
| L119, L123-129, L196-198, L258, L276, L322-323 | **column** order (groupBy-then-aggregations; left-then-right) |

L86/L88/L98/L100/L137/L139/L150/L169/L179-182/L275/L297/L303 are order-independent (counts, `every()`, `find()`).

---

### 6. SQL-translation / DuckDB breakage table

Notation: `S` = the previous step's relation. The recommended physical shape carries a hidden monotonic ordinal `__ord` (see §7).

#### 6.1 Per-step translation

| # | Rule | Current behaviour | SQL translation | Semantic gap | Mitigation |
|---|---|---|---|---|---|
| T1 | `calculated_field` value | `formula.compile(...).evaluate(row)` per row; unknown column/div-zero/type mismatch → `null`, never throws | `SELECT *, <expr> AS "name" FROM S` | **Entire formula→SQL mapping is a separate project** (owned by the formula agent). SQL raises on div-by-zero for integers, and DuckDB `/` on integers is float division; `x/0` on DOUBLE → `Infinity`, not `null` | Wrap every expression in the null-degrading idiom (`TRY_CAST`, `CASE WHEN d = 0 THEN NULL`, `try(...)` where available). Conformance is `scripts/test-formula.js` |
| T2 | `calculated_field` typing | Result column type is **data-dependent**: `detectColumnType` over the stringified results, then `coerceValue` every cell | SQL expression types are **static** | **Structural.** One `'low'` row demotes the whole column to text and stringifies the numbers (§2.1); SQL cannot express that in one statement | Keep the retype pass in TypeScript over the returned Arrow batch: stringify → `detectColumnType` → `coerceValue`. Do **not** try to do it in SQL. Accept a second pass over the result |
| T3 | `calculated_field` guards | blank/dup name, compile error → skip + warning, table unchanged | n/a | none — pure TS | Keep all guards in TS **before** SQL generation (R-TRANS-03) |
| T4 | `filter` numeric | `n` and target both must be finite numbers; else the row is dropped for **every** op incl. `!=` | `WHERE col <op> TRY_CAST(:v AS DOUBLE)` | Actually a **match**: SQL 3-valued logic drops NULL rows for every operator too. But **`CAST('abc' AS DOUBLE)` throws in DuckDB** | Always `TRY_CAST` the literal, never `CAST`. Then `col != NULL` → NULL → 0 rows, exactly reproducing [probed] behaviour |
| T5 | `filter` text/date | `String(cell)` vs `String(value)`, JS UTF-16 code-unit ordering, case-sensitive; `null` → `''` so `= ''` matches nulls | `WHERE col <op> :v` | Two gaps: (a) **`NULL <op> 'x'` is NULL in SQL → row dropped**, but currently a `null` cell stringifies to `''` and **can match** `=` with an empty/omitted value; (b) DuckDB VARCHAR comparison is **byte-wise UTF-8**; JS is UTF-16 code-unit — these differ for code points ≥ U+10000 vs U+E000-U+FFFF. NEEDS VERIFICATION | (a) generate `WHERE coalesce(col,'') <op> :v` for text/date columns; (b) verify with `SELECT '\uFFFD' > '\u{10000}'` in DuckDB vs the same JS comparison — if it differs, either accept (astral-plane data in a BI tool is vanishingly rare) or compare on `encode(col)` |
| T6 | `filter contains` | `String(cell).includes(String(value ?? ''))`; empty needle matches everything incl. nulls; works on numeric columns | `WHERE contains(CAST(col AS VARCHAR), :v)` | `contains(NULL, 'x')` → NULL → dropped, but currently `''.includes('x')` = false → also dropped ✓. **Empty needle**: currently every row survives incl. nulls; DuckDB `contains(NULL,'')` → NULL → dropped ✗. Also `CAST(double AS VARCHAR)` formatting may not equal JS `String(n)` (see T14) | `WHERE contains(coalesce(CAST(col AS VARCHAR),''), :v)`. NEEDS VERIFICATION of DuckDB's `contains(x,'')` → run `SELECT contains('abc',''), contains(NULL,'')` |
| T7 | `filter is_empty/not_empty` | `null` OR `trim() === ''` (JS whitespace class: space, tab, NL, NBSP, BOM…) | `WHERE col IS NULL OR trim(col) = ''` | **DuckDB `trim(str)` removes spaces only**, not tabs/newlines/NBSP. NEEDS VERIFICATION (`SELECT '[' \|\| trim(E'\t x \t') \|\| ']'`) | Use `regexp_matches(col, '^\s*$')` (RE2 `\s` = `[\t\n\f\r ]`) or, for exact JS parity incl. NBSP/BOM, `regexp_matches(col,'^[\s\u00a0\ufeff]*$')`. Same helper is needed by `count` and `fill_empty` |
| T8 | `filter` row order | preserves input order | `SELECT ... WHERE ...` | **SQL result order is unordered**; DuckDB parallel scans can reorder | `ORDER BY __ord` at the outermost SELECT only (see §7) |
| T9 | `group_aggregate` grouping | `JSON.stringify` key — **type-discriminating** (`1` ≠ `"1"`); `null` groups with `null`; `''` distinct from `null` | `GROUP BY g1, ..., gN` | `GROUP BY` on a typed column groups NULLs together ✓ and keeps `''` distinct ✓. The `1` vs `"1"` case **cannot arise** once a column is typed — see T15 | Accept; it is unreachable in a typed world provided ingestion is faithful |
| T10 | `group_aggregate` output order | **first-seen group order** | hash aggregate — **arbitrary and parallelism-dependent** | **Breakage.** Chart x-axis order comes from here (`vizData.ts:128,164-171`) | Add `min(__ord) AS __ord` to the aggregate and `ORDER BY __ord`. Verify DuckDB accepts an aggregate in ORDER BY at the outer level (it does via the alias) |
| T11 | `sum/avg/min/max` empty result | `null` when no finite numeric cells | `SUM/AVG/MIN/MAX(col)` over all-NULL → NULL ✓ | Match for the grouped case. **But `groupBy: []` on an empty table currently returns 0 rows; SQL global aggregation returns 1 row of NULLs** [probed vs. standard] | Special-case: if `groupBy.length === 0`, check the input row count in TS and return `{rows: []}` when zero. Or always generate `GROUP BY ALL` with a constant, which still emits 1 row — so the TS guard is the safer route |
| T12 | `count` | counts cells where `!isEmptyCell` — excludes NULL, `''`, **and whitespace-only** | `COUNT(col)` counts non-NULL | **Breakage**: `''` and `'  '` are counted by SQL, not by us. Also `COUNT(*)` is wrong here — the step counts a *named column* | `COUNT(*) FILTER (WHERE col IS NOT NULL AND NOT regexp_matches(CAST(col AS VARCHAR),'^\s*$'))`. For a numeric column simplify to `COUNT(col)` |
| T13 | `sum/avg/min/max` on non-numeric cells | Only `typeof === 'number'` cells participate; a `text` column of `"5"` aggregates to **`null`** | `SUM(varchar_col)` — DuckDB may implicitly cast VARCHAR→DOUBLE, or error. NEEDS VERIFICATION (`SELECT sum(x) FROM (SELECT '5' AS x)`) | Either behaviour is wrong: implicit cast returns `5` where we return `null`; an error violates "never throws" | Generate from the **declared column type**: if the column's `ParsedColumn.type !== 'number'`, emit `CAST(NULL AS DOUBLE) AS "as"` instead of an aggregate. This reproduces [probed] exactly and is cheap |
| T14 | Float arithmetic identity | `reduce((a,b)=>a+b, 0)` — strict left-to-right IEEE-754 | DuckDB `SUM(DOUBLE)` is vectorised/parallel; **DuckDB uses Kahan summation for DOUBLE `sum`** (NEEDS VERIFICATION) | Last-bit differences. Normally harmless — **but** a `0.30000000000000004`-shaped result flips the retype pass from `number` to `text` (§2.1), turning a numeric column into strings. Also breaks the byte-equality of R-TRANS-20 | Verify with `SELECT sum(x) FROM (VALUES (0.1),(0.2)) t(x)` compared to JS. If it differs, consider casting money-ish columns to `DECIMAL`, or apply the retype pass only to `calculated_field`/`fill_empty` outputs (which is what the current code already does — aggregations are **not** retyped, so this hazard is confined to T2) |
| T15 | **Mixed-type columns** | `Cell[][]` genuinely allows number `3` and string `'low'` in the same column; `filter` branches on the **declared** type while `aggregate` branches on the **runtime** type | A DuckDB column has exactly one type | **Structural mismatch — the deepest one.** See §6.2 |
| T16 | `dedupe` survivor | **first** occurrence per key (R-TRANS-12) | `SELECT DISTINCT` — arbitrary survivor; `DISTINCT ON (k)` without ORDER BY — arbitrary | **Breakage.** L140 pins the survivor's *payload*, not just the count | `QUALIFY row_number() OVER (PARTITION BY k1..kN ORDER BY __ord) = 1`. DuckDB supports `QUALIFY`. Equivalent: `DISTINCT ON (k1..kN) * ORDER BY k..., __ord`, but `QUALIFY` composes better in a CTE chain |
| T17 | `dedupe` key typing | `JSON.stringify` — `1` ≠ `"1"`; `undefined`→`null`; NULLs are equal | `PARTITION BY` treats NULLs as equal ✓ | Match, given typed columns | none |
| T18 | `fill_empty` | replaces NULL/`''`/whitespace, then **retypes the whole column**; filling with `''` yields `null` | `CASE WHEN col IS NULL OR regexp_matches(col,'^\s*$') THEN :v ELSE col END` | Same whitespace-class gap as T7; the **retype** is the same static-vs-dynamic problem as T2; the `''`→`null` quirk falls out of `coerceValue` and must be preserved | Generate the CASE, then run the TS retype pass on that one column. Preserve the `''`→NULL quirk explicitly (`NULLIF(:v,'')` when the fill is a string) |
| T19 | `trim` | JS `String.prototype.trim()` — full Unicode whitespace | `trim(col)` | **DuckDB `trim` = spaces only.** NEEDS VERIFICATION | `regexp_replace(col, '^[\s\u00a0\ufeff]+\|[\s\u00a0\ufeff]+$', '', 'g')`. Apply only to `text` columns when `column` is omitted, matching `:460` |
| T20 | `trim` no-retype | column type unchanged, `" 12 "` → `"12"` stays `text` | n/a | Easy to "improve" accidentally | Do **not** retype after trim |
| T21 | `drop_column` | drops by first matching name; can produce **zero columns with N rows** | `SELECT <remaining> FROM S` | **`SELECT` with an empty select-list is a syntax error.** [probed] current output is `{columns:[], rows:[[]], rowCount:1}` | Degenerate case handled in TS: when the projection is empty, skip SQL and return `{columns:[], rows: Array(n).fill([]), rowCount:n}`. Also keep `__ord` alive so the relation is never truly empty |
| T22 | `rename_column` | first match only; **allows duplicate names** | `SELECT c AS "new"` | Duplicate output aliases make later name references **ambiguous** in SQL; the current fold resolves them by first-index | Positional physical names (§7): `rename_column` becomes a pure metadata edit with **no SQL at all** |
| T23 | Missing column → skip | pass table through + 1 warning (R-TRANS-17) | column resolution error | SQL would fail the whole query | Resolve every column name against the TS-tracked schema **before** emitting SQL; a miss short-circuits to skip+warning without touching DuckDB. Same for unknown step type (R-TRANS-18) |
| T24 | Warnings | `string[]`, exact prose, duplicated per group for a missing agg column | n/a | Test L179 checks `warnings.length === 1` and content | Generate warnings in TS from the same guards. **Careful:** the per-group duplication (`:365`) is an artefact — if the SQL version emits it once, `warnings.length` assertions elsewhere still pass, but keep it deliberate |
| T25 | `append` | union by name, left rows first, all columns retyped | `SELECT ... FROM L UNION ALL BY NAME SELECT ... FROM R` | `UNION ALL BY NAME` exists in DuckDB and fills missing columns with NULL ✓, but (a) row order across a UNION is unordered, (b) type unification is DuckDB's promotion rules (`INTEGER`+`VARCHAR` → error or VARCHAR?) not our "any text demotes to text, stringify the numbers", (c) our duplicate-name corruption [probed] would not reproduce. NEEDS VERIFICATION of `UNION ALL BY NAME` type resolution | Add a side-tag ordinal (`0,__ord` for left, `1,__ord` for right) and `ORDER BY side, __ord`. Ingest both sides as VARCHAR and run the TS retype pass — that reproduces (b) exactly. Decide explicitly whether to keep the duplicate-name bug (recommend: **fix it and note the behaviour change**) |
| T26 | `join` key matching | `String(cell)` on both sides — `1` matches `"1"`, **`null` matches `null`**, `null` matches `''` [probed] | `JOIN ON l.k = r.k` | **Breakage: SQL NULL never joins.** Also cross-type `1 = '1'` needs an explicit cast | `ON coalesce(CAST(l.k AS VARCHAR),'') = coalesce(CAST(r.k AS VARCHAR),'')`. That reproduces all three [probed] behaviours — including the arguably-wrong NULL↔NULL and NULL↔`''` matches. Flag for a product decision |
| T27 | `join` row order & multiplicity | left order outer, right bucket order inner; full m×n | hash join — arbitrary order, same multiplicity | Order breakage only (L277) | `ORDER BY l.__ord, r.__ord` |
| T28 | `join` cap | stops **during** the build at `limit`, warns | `LIMIT 50000` | DuckDB streams and pipeline-breaks on LIMIT, so it should not materialise the full product — this is a genuine improvement. But *which* rows survive changes without an ORDER BY | `... ORDER BY l.__ord, r.__ord LIMIT :limit` — note a top-N sort **does** touch every produced row, so re-verify the 400×400 case does not blow memory. NEEDS VERIFICATION. Warning must still be emitted when `rowCount === limit` |
| T29 | `join` column naming | left cols, then right non-key cols, `_right` suffix on collision | `SELECT l.*, r.c AS "c_right"` | none, if names are positional | Compute the output name map in TS exactly as `:647-655` |

#### 6.2 NULL vs empty-string vs missing column — the three-way distinction

Ordinate distinguishes **four** states where SQL has two:

| State | Ordinate | `isEmptyCell` | SQL |
|---|---|---|---|
| missing column | step **skipped** + warning, data untouched | n/a | binder error, whole query fails |
| `null` cell | `null` | true | `NULL` |
| `''` cell | `''` | true | `''` — **not** NULL |
| `'   '` cell | `'   '` | **true** | `'   '` — not NULL, not empty |

Every predicate in the codebase that says "empty" means all three of rows 2-4. SQL's `IS NULL` covers only row 2, and DuckDB's `trim()` (spaces-only) does not fully cover row 4. **Every generated predicate touching emptiness must use one shared helper macro**, defined once:

```sql
CREATE MACRO sc_empty(x) AS (x IS NULL OR regexp_matches(CAST(x AS VARCHAR), '^[\s\u00a0\ufeff]*$'));
```

Used by: `is_empty`, `not_empty`, `count`, `fill_empty`. NEEDS VERIFICATION that DuckDB macros accept `ANY`-typed args and that RE2 handles the `\u` escapes (fallback: a literal character class).

Additionally, `parse.coerceValue`'s rule that `''` coerces to `null` (`parse.ts:219`) means an Ordinate table **round-trips `''` into `null` on every retype**. So `''` cells only exist in columns that have not been retyped since the data was created. That materially shrinks the blast radius of the `''` distinction — but does not eliminate it (`trim` produces `''` without retyping, `:466`).

#### 6.3 Row-order stability — summary

The current fold is **fully order-preserving**: `filter` (`Array.filter`), `dedupe` (first-wins, append order), `fill_empty`/`trim`/`rename`/`drop`/`calculated_field` (row-wise map), `group_aggregate` (first-seen group order), `append` (left then right), `join` (left-outer-loop). **Nothing sorts.**

SQL guarantees no order without `ORDER BY`, and DuckDB's parallel scan/hash-aggregate/hash-join actively reorder. Assertions that break: **L56, L68, L70, L140, L151, L173, L213, L216, L260, L277** (row order) and **L119, L123-129, L196-198, L258, L276, L322-323** (column order — trivially preserved by controlling the select list).

Mitigation is a hidden `__ord BIGINT` ordinal column, assigned at ingest, propagated through every step (`min(__ord)` through aggregation, `l.__ord, r.__ord` through joins), stripped at materialisation, and applied as `ORDER BY __ord` **once, at the outermost SELECT** so intermediate CTEs stay unordered and DuckDB can still parallelise. Cost: one extra sort at the end plus a `min()` per group.

L213/L216 (`JSON.stringify` deep equality) are the strictest: they demand the whole result — row order, column order, warning text and order, and **numeric formatting** — is byte-identical across two independent runs. With parallel execution and a float-sensitive retype pass (T14), this is the assertion most likely to go intermittently red.

#### 6.4 Mixed-type columns — severity assessment

`Cell[][]` lets a single column hold `3`, `'low'`, and `null` simultaneously, and the code reads that ambiguity two different ways in two different places:

- `stepFilter` (`:260`) branches on the **declared** `ParsedColumn.type`;
- `aggregate` (`:379`) branches on the **runtime** `typeof v === 'number'`.

So a `number`-declared column containing a stray string is filtered numerically (the string never matches anything) but aggregated by skipping the string. In DuckDB, that column is either `DOUBLE` (the string becomes NULL at ingest) or `VARCHAR` (the numbers become strings).

**Assessment: not as severe as it looks, and it forces one clear decision.** In practice mixed columns are rare and short-lived, because `retypeColumn` (`:130-135`) *normalises the whole column* after `calculated_field`, `fill_empty`, and both `combineTables` paths — one non-numeric cell demotes everything to `text` and stringifies the numbers. So the only durable mixed state is a `number`-declared column whose stray non-numeric cells arrived before any retype (e.g. hand-edited JSON, or `updateDataset`'s retype path where non-numeric cells become `null` anyway, `parse.ts:226`).

What it forces:
1. **Ingest everything as VARCHAR** (the plan already says this at landmine 6.1), keep `ParsedColumn.type` as Ordinate's own metadata, and `TRY_CAST` at the point of use. A `number` column is `TRY_CAST(col AS DOUBLE)`, which turns the stray string into NULL — matching `aggregate`'s "skip non-numbers" exactly, and matching `stepFilter`'s "a non-number never satisfies any comparison" exactly. **VARCHAR storage + `TRY_CAST` at use reproduces both branches faithfully.** That is the recommended shape, and it also solves T4, T13, and the `007` problem in one move.
2. It costs performance — a cast per row per predicate rather than a typed column. For BI-sized data (≤50k rows, per `parse.ts:36`) this is irrelevant; for the "millions of rows" the migration promises, materialise a typed shadow column per numeric column at ingest.
3. The retype pass (T2, T18) stays in TypeScript over the Arrow result. Accept that.

---

### 7. Query-composition design note

**Recommended: a CTE chain over a VARCHAR-typed base relation, with positional column identifiers and a hidden ordinal.**

```
Physical relation:  ds_<id>(__ord BIGINT, c0 VARCHAR, c1 VARCHAR, ...)
TS-side schema:     [{ physical:'c0', name:'city',  type:'text'   },
                     { physical:'c1', name:'sku',   type:'text'   }, ...]
```

`buildSql(schema, steps)` walks the step list left→right, maintaining a *virtual schema* exactly the way the current fold maintains `t.columns` — using the **same** `colIndex`-first-match resolution — and emitting one CTE per step:

```sql
WITH s0 AS (SELECT __ord, c0, c1, c2, c3 FROM ds_abc),
     s1 AS (SELECT *, TRY_CAST(c2 AS DOUBLE) * TRY_CAST(c3 AS DOUBLE) AS c4 FROM s0),   -- calculated_field
     s2 AS (SELECT * FROM s1 WHERE TRY_CAST(c4 AS DOUBLE) > TRY_CAST('0' AS DOUBLE)),   -- filter
     s3 AS (SELECT c0, sum(TRY_CAST(c4 AS DOUBLE)) AS c5, min(__ord) AS __ord           -- group_aggregate
            FROM s2 GROUP BY c0)
SELECT c0, c5 FROM s3 ORDER BY __ord;
```

Then a TS post-pass runs `retypeColumn` over the returned Arrow batch for exactly the columns the current code retypes (`calculated_field` output, `fill_empty` target, all `combineTables` outputs), and relabels `c0/c5` back to `city/revenue`.

Why each piece:

- **CTE chain, not nested subqueries, not one statement per step.** Reversibility is preserved for free: the SQL is a pure function of `(schema, steps)`, regenerated from scratch on every edit, exactly like the current fold. Nothing is stored. One statement per step would need temp tables — that violates "never mutate stored data in place" in spirit and adds cleanup/failure modes. Nested subqueries are semantically identical to CTEs but unreadable at 8 steps deep, and harder to debug when a step misbehaves. DuckDB inlines non-recursive CTEs, so there is no optimiser penalty. NEEDS VERIFICATION that DuckDB inlines a CTE referenced once (it does by default; `SET enable_view_dependencies`-style flags are unrelated).
- **Positional `c0..cN` identifiers** solve four problems at once: duplicate column names after `rename_column` (T22) and after `group_aggregate` aliasing; SQL identifier quoting/escaping for names containing `"`; SQL-injection through a column name; and the `colIndex`-first-match rule, which becomes trivially expressible. `rename_column` becomes zero SQL — a metadata edit. `drop_column` becomes a select-list edit.
- **`__ord`** is the only answer to §6.3.
- **Per-step debuggability**: keep the CTE names aligned to step indices (`s0`=source, `sN`=after step N) so a failing pipeline can be bisected by running `SELECT * FROM sN`.

**Risks:**

| Option | Risk |
|---|---|
| CTE chain (recommended) | A step that cannot be expressed in SQL (the zero-column `drop_column`, T21) needs a TS escape hatch mid-chain. Deep chains make DuckDB error messages point at a generated CTE, not at the user's step — mitigate by mapping CTE index → step index in every warning. |
| Nested subqueries | Identical semantics; unreadable and undebuggable at depth. No upside. |
| One statement per step (temp tables) | Materialises every intermediate → memory blowup and cleanup on failure; breaks the "regenerate from the step list" reversibility story by introducing state. Reject. |
| Per-step round-trip to TS (hybrid) | Tempting for the retype passes, but it forces `applyPipeline` to be async N times and kills DuckDB's ability to optimise across steps. Restrict TS passes to **after** the single query. |

**Skip-a-step must not become skip-a-CTE.** When a guard fires (unknown column, blank name, compile error), the generator simply emits no CTE for that step and pushes the warning — the chain continues from the previous CTE. That preserves R-TRANS-17/18 exactly.

---

### 8. Open questions and risks for the Phase 1 implementer

1. **Sync vs async is the blocking design question, not SQL semantics.** `applyPipeline` is synchronous and is called from synchronous pure functions (`vizData.buildVizData` at `vizData.ts:125,158,232`, itself called by `visuals`, `dashboards`, `dashboardExport`). "Signatures do not change" and "DuckDB Node bindings are async" are in direct conflict. Decide before writing any SQL: a sync-capable binding, a `SharedArrayBuffer`+`Atomics.wait` worker bridge, or an accepted ripple of `async` through `vizData`/`visuals`/`dashboards`. **Recommend settling this in a spike before Phase 1 starts.**
2. **Where does the retype pass live?** It is data-dependent typing and cannot be SQL. Confirm it stays in TS over Arrow, and confirm the cost of walking a large result twice.
3. **Does DuckDB `sum(DOUBLE)` match JS left-to-right accumulation bit-for-bit?** Experiment: `SELECT sum(x) FROM (VALUES (0.1),(0.2),(0.3)) t(x)` vs `[0.1,0.2,0.3].reduce((a,b)=>a+b,0)`. If not, R-TRANS-20's byte-equality and the float→text retype quirk (§2.1) are both at risk.
4. **Does DuckDB `trim()` strip tabs/newlines/NBSP?** Experiment: `SELECT '[' || trim(E'\t x \u00a0') || ']'`. Expected: no. This decides whether `trim` and every emptiness predicate need the regex form.
5. **`contains(x, '')` and `contains(NULL, '')` semantics.** Experiment: `SELECT contains('abc',''), contains(NULL,'')`.
6. **`UNION ALL BY NAME` type unification.** Experiment: union an `INTEGER` column with a `VARCHAR` column of the same name and inspect the result type. Decides how much of `appendTables` must stay in TS.
7. **`ORDER BY ... LIMIT` on a 400×400 self-join** — does DuckDB's top-N avoid materialising the full product? Experiment reproduces test L288-298 at scale. If the top-N is not streaming, the anti-OOM guarantee at `transforms.ts:666-681` regresses.
8. **VARCHAR comparison ordering** vs JS UTF-16 (T5). Low practical impact; confirm and document rather than engineer around.
9. **Deliberate behaviour changes to get a product decision on:**
   - `join` currently matches `null` to `null` **and** to `''` (§4, [probed]) — almost certainly a bug, but tests do not cover it. Fixing it changes real user output.
   - `appendTables` corrupts data when one input has duplicate column names ([probed]) — uncovered by tests. Recommend fixing, with a note.
   - `count` treats whitespace-only as empty ([probed]) — deliberate, must be preserved.
   - The per-group duplicated warning for a missing aggregation column (`transforms.ts:365`) — an unbounded `warnings` array on a high-cardinality group-by. Recommend de-duplicating, and confirm no test asserts a count in that path (none does).
10. **`sanitizeSteps` must not be ported.** It is a security control (`visuals.ts:206`, `dashboards.ts:243`) and pure validation. It stays in TypeScript, unchanged, and its 3 assertions (L242-244) are backend-independent.
11. **Warning strings are matched by tests** on substrings (`already exists` at L78, `nope` at L179, `/row cap/i` at L298) and by count (`=== 1` at L76, L80, L179, L182, L280). Keep the exact prose from `transforms.ts:206,208,213,219,246,247,317,365,411,415,435,457,475,486,681`.
12. **`applyPipeline` throws on a malformed `source`** ([probed]: `null` source, or a source with no `rows`). Not covered by tests, and the SQL version's failure mode will differ. Worth hardening while translating.
13. **Test-suite mechanics:** `scripts/test-transforms.ts` requires `../src/transforms` (the compiled sibling) at line 8; `npm test` runs the `.js`. If Phase 1 introduces async, the test file's 64 straight-line assertions all need `await` — plan for a mechanical rewrite of the test, and keep the current file as the frozen reference contract.agentId: a85945c69709e071f (use SendMessage with to: 'a85945c69709e071f', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 121652
tool_uses: 28
duration_ms: 541230</usage>