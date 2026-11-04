# Semantic layer part 8, step 03: the formula's SQL back end — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One formula compiles to one SQL expression per dialect, with static types and the JS evaluator's semantics. v1 covers the operators and 28 of the 83 functions. Every other function, `%`, LOD and `[[parameter]]` is a typed refusal that carries its token span. A table keyed by every `FUNCTIONS` name says which. A per-row differential on the DuckDB bench holds it to `evaluate()`. Nothing on a request path calls it yet (step 04 does).
**Architecture:**
- `SqlFormulaBuilder implements FormulaBuilder<SqlTerm>` (step 02's interface) builds `{ sql, type }` terms.
- Columns enter as a copy stores them (D3). Results are projected as a copy stores them, at the projection only.
- Literals go through the statement's `Binder`. Function names pick fixed spellings. What differs between engines becomes a required `SqlDialect` member, as `binary` is.
- A refusal is a `FormulaError` subclass carrying `tokenIndex`, mapped to a source span exactly as `compileTokens` maps parser errors (`sqlGenClean.genConditional` is the precedent for a second back end).
**Tech Stack:** `src/engine/live/` (dialects, `Binder`, `ParamSink`), `src/formula/` (parser, `FUNCTIONS`), the DuckDB bench in `scripts/liveParityFixture.ts` (`loadWarehouse`, `runDuck`).
**Spec:** docs/semantic-layer/08-engine.md (D2–D6, D8; Tests "Expression differential", "Safety", "Negative controls") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p8-00-index.md
**Branch and PR:** `feat/semantic-p8-03-formula-sql` off `origin/develop` after step 02 merges. One PR.

## Global Constraints
- **One function list for every dialect** (D4). Databricks is compiled and golden-shaped, but step 04 refuses it (owner's answer 1).
- **Never `ROUND`, never `LEAST`/`GREATEST`, never a bare `/`.** These are D5's spellings. Each has a negative control.
- Literals are bound: `ParamSink` markers, never text. `TRUE`, `FALSE` and `NULL` are keywords. The compiler's own constants (`''`, `0.5`, `'true'`/`'false'` in the boolean projection) are text it writes itself.
- **Types are static:** `number`, `text`, `date`, `boolean`, `null`. A result's type comes from the formula, never from values.
- `src/formula/formulaEval.ts` (625) is not touched. `formula.ts` changes by one word: `export` on `spanOf`. `dialect.ts` is 152 lines and gains about 25 for the members. New files stay under 400 lines: `formulaSql.ts` holds the builder and the projection, and `formulaSqlFunctions.ts` the table and the spellings.
- Sentences go through `t()` in `src/engine/live/formulaSqlMessages.ts`, appended to `MAIN_FILES` (`scripts/i18n-extract.ts:346`), then `node scripts/i18n-extract.js`.

## Old pods (rolling deploy and rollback)
Nothing is stored and nothing is reachable from a route. No pod behaves differently.

## Review Focus
- A null in an ordering compare: JS compares `null` as `''`, below everything, so `null < 5` is TRUE and `null <= null` is TRUE. → Task 2
- `round` ties: `Math.round(-2.5)` is `-2`. Engines' `ROUND` gives `-3` or rounds to even. → Task 2
- A text column's `''` enters as NULL (a copy stores `''` as null), but a `''` the formula MAKES stays `''` until the projection (`trim(' ') = ''` is TRUE). → Task 2
- `floor` on Databricks returns BIGINT: a double past 2^52 passes through, the rest cast back. → Task 1
- A literal holding `'`, `\`, `` ` ``, `'; DROP …` or NUL never reaches the SQL text. → Task 3

---

### Task 1: the dialect members and the function table
**Files:** Modify `src/engine/live/dialect.ts` (`SqlDialect` :76-129 gains five members; append `likeAffix`) and the six `src/engine/live/dialects/*.ts`. Create `src/engine/live/formulaSqlFunctions.ts` and `scripts/test-formulaSql.ts` (§ table, § members).
**Interfaces:** Produces
```ts
// SqlDialect — required, so no dialect ships without them
lower(x: string): string;            // ClickHouse lowerUTF8(x); else LOWER(x)
upper(x: string): string;            // ClickHouse upperUTF8(x); else UPPER(x)
trimJs(x: string, b: Binder): string; // JS trim(): the dialect's caseKey without the lower
floor(x: string): string;            // a DOUBLE; Databricks: CASE WHEN abs(x) >= 4503599627370496 THEN x ELSE CAST(floor(x) AS DOUBLE) END
ceil(x: string): string;             // the same rule
datePart(d: string, part: 'year' | 'month' | 'day' | 'quarter'): string; // an integer; ClickHouse toYear/toMonth/toDayOfMonth/toQuarter, else EXTRACT(… FROM d)
export function likeAffix(needle: string, esc: string, where: 'contains' | 'starts' | 'ends'): string; // likePattern's escaping, % placed by `where`
// src/engine/live/formulaSqlFunctions.ts
export type LiveFnReason = 'math' | 'characters' | 'notMeasured' | 'regex' | 'dates' | 'clock' | 'conversion';
export type LiveFn = { v1: true; arity: readonly [number, number] } | { v1: false; reason: LiveFnReason };
export const LIVE_FUNCTIONS: Readonly<Record<string, LiveFn>>; // keys === FUNCTIONS keys
export const V1_FUNCTIONS: readonly string[];                  // the 28
```
- **v1 and its arities.**
  - `abs`, `sign`, `floor`, `ceil`, `ceiling`, `sqrt` and `square`: 1.
  - `round`: 1–2, `min`/`max`: 1–∞.
  - `lower`, `upper` and `trim`: 1. `contains`, `startswith` and `endswith`: 2. `concat`: 1–∞.
  - `isnull`: 1, `ifnull`: 2, `coalesce`: 1–∞, `zn`: 1, `if`: 3, `iif`: 3–4.
  - `year`, `month`, `day` and `quarter`: 1. `datediff`: 3.
- **Refused, by reason** (D6's table):
  - `math`: `power`, `exp`, `ln`, `log`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `cot`, `pi`, `degrees`, `radians`, `distance_km`.
  - `characters`: `len`, `left`, `right`, `mid`, `find`, `findnth`, `split`, `ascii`, `char`, `space`, `proper`.
  - `notMeasured`: `replace`, `ltrim`, `rtrim`, `div`. They stay refused in this part (my call, the spec leaves it to the builder): a v1.1 after a measured run.
  - `regex`: the four `regexp_*`.
  - `dates`: `date`, `datetime`, `dateadd`, `datetrunc`, `makedate`, `maketime`, `makedatetime`, `datepart`, `datename`, `week`, `isoweek`, `isoyear`, `isoquarter`, `isoweekday`, `isdate`.
  - `clock`: `today`, `now`.
  - `conversion`: `int`, `float`, `str`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  ok('the table names every FUNCTIONS key, and nothing else', show(Object.keys(LIVE_FUNCTIONS).sort()) === show(Object.keys(FUNCTIONS).sort()));
  ok('28 in v1, 55 refused, each with a reason', V1_FUNCTIONS.length === 28 && Object.values(LIVE_FUNCTIONS).filter((f) => !f.v1).length === 55);
  for (const id of DIALECT_IDS) ok(`${id}: every new member spells`, ['lower', 'upper', 'floor', 'ceil'].every((m) => typeof (dialectFor(id) as any)[m]('x') === 'string') && /x/.test(dialectFor(id).trimJs('x', sink)));
  ok('databricks floor keeps a double past 2^52', dialectFor('databricks').floor('x').includes('4503599627370496'));
  ok('likeAffix escapes % _ and the escape, and places %', likeAffix('a%_\\', '\\', 'starts') === 'a\\%\\_\\\\%');
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` → tsc: every dialect lacks the new members.
- [ ] **Step 3: Implement.** `trimJs` is each dialect's `caseKey` minus its lower: Snowflake and BigQuery `TRIM(x, ws)`, Redshift `BTRIM`, Databricks `btrim`, DuckDB and ClickHouse their regex replace.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-formulaSql.js && node scripts/test-liveCompile.js` (its golden shapes untouched).
- [ ] **Step 5: Commit.** `git add src/engine/live/dialect.ts src/engine/live/dialects src/engine/live/formulaSqlFunctions.ts scripts/test-formulaSql.ts` · "Add the dialect members formulas need and the Live function table"

### Task 2: the SQL builder
**Files:** Create `src/engine/live/formulaSql.ts` and `src/engine/live/formulaSqlMessages.ts`. Modify `src/formula/formula.ts` (`export function spanOf`) and `scripts/i18n-extract.ts:346`. Test: `scripts/test-formulaSql.ts` § types, § refusals, § shapes.
**Interfaces:** Consumes `parseTokens`, `FormulaBuilder`, `tokenize`, `numberOf`/`textOf`/`dateOf`/`colRef` (`compileFilter.ts`), `isTextSourceType`, `LiveCalc` (step 00a). Produces
```ts
export type CalcValueType = 'number' | 'text' | 'date' | 'boolean' | 'null';
export interface SqlTerm { sql: string; type: CalcValueType; held?: 'date' | 'timestamp'; literal?: { value: FValue } }
export type CalcRefusalCode = 'syntax' | 'function' | 'mod' | 'lod' | 'param' | 'unknownColumn' | 'laterCalc' | 'types' | 'notBoolean'
  | 'notLiteral' | 'arity' | 'dateColumn' | 'dateResult' | 'timestampCompare' | 'roundDigits' | 'datediffPart';
export interface CalcRefusal { ok: false; code: CalcRefusalCode; error: string; at?: SourceSpan }
export interface CalcCtx { d: SqlDialect; b: Binder; columns: LiveColumn[]; earlier: readonly LiveCalc[] }
export class SqlFormulaBuilder implements FormulaBuilder<SqlTerm> { constructor(ctx: CalcCtx); project(t: SqlTerm, at: number): { sql: string; type: LiveCalcType }; round(x: SqlTerm, n: SqlTerm | null, at: number): SqlTerm; /* + every FormulaBuilder method */ }
export function compileCalcSql(expression: string, ctx: CalcCtx, B?: typeof SqlFormulaBuilder): { ok: true; sql: string; type: LiveCalcType; refs: string[] } | CalcRefusal;
/** The save-time verdict, dialect-free: compileCalcSql on the DuckDB dialect with a throwaway sink. */
export function checkCalc(expression: string, columns: LiveColumn[], earlier: readonly LiveCalc[]): { ok: true; type: LiveCalcType; refs: string[] } | CalcRefusal;
```
**The rules (each is a test case):**

| Input | Spelling |
|---|---|
| a `number` column | `numberOf(c, col)`: a finite double or NULL |
| a `text` column | `NULLIF(textOf(c, col), '')` |
| a `date` column | `dateOf(c, col)`, `held: 'timestamp'` when `sourceType` matches `/timestamp\|datetime/i`, else `'date'`. A date stored as text is refused (`dateColumn`) |
| an earlier calc | `colRef`, typed as stored (a boolean calc is stored as text, so it enters as `text`) |
| a later calc, or one that isn't there | refused: `laterCalc` / `unknownColumn` (Prepare only warns, D6) |
| `+ - * /`, unary `-` | numbers or `null` only, else `types`; `/` is `a / NULLIF(b, 0)`; `%` is `mod` |
| `=`, `==`, `!=` | same types, or one side `null`: `CASE WHEN a IS NULL OR b IS NULL THEN a IS NULL AND b IS NULL ELSE a = b END` (`!=` is its `NOT`) |
| `< > <= >=` on numbers or DATE-held dates | the null fold: `CASE WHEN a IS NULL AND b IS NULL THEN <op allows equal> WHEN a IS NULL THEN <op is < or <=> WHEN b IS NULL THEN <op is > or >=> ELSE a op b END`, with constants chosen at compile time. On a TIMESTAMP-held date, refused (`timestampCompare`, pin 7) |
| `< > <= >=` on text | `coalesce(a, '') op coalesce(b, '')` |
| `and`, `or`, `not` | boolean (or `null`) operands only, else `notBoolean`; each as `COALESCE(x, FALSE)`. The result is never NULL |
| `IN (…)`, `CASE … WHEN` | literal items of the subject's type only (`notLiteral`); an OR of the `=` spelling |
| `IF … ELSEIF … ELSE … END`, `if()`, `iif()` | boolean tests (`notBoolean`) and branches of one type, `null` allowed; `CASE WHEN COALESCE(t, FALSE) THEN …`. A 4-argument `iif` starts with `WHEN t IS NULL THEN u` |
| `isnull`, `ifnull`, `coalesce`, `zn` | `(x IS NULL)`; `COALESCE`; `zn` takes a number: `COALESCE(x, 0)` |
| `abs`, `sign`, `floor`, `ceil(ing)` | `toDouble(ABS(x))`, `toDouble(SIGN(x))`, `d.floor`, `d.ceil` |
| `round(x, n)` | `n` is an integer literal in −15…15 (`roundDigits`); `f = 10^n` is bound from JS; `y = x * f`; `(CASE WHEN y - FLOOR(y) >= 0.5 THEN FLOOR(y) + 1 ELSE FLOOR(y) END) / f`, with FLOOR as `d.floor` |
| `sqrt`, `square` | `CASE WHEN x >= 0 THEN SQRT(x) END`; `x * x` |
| `min`, `max` | numbers only; a left fold of `CASE WHEN a IS NULL THEN b WHEN b IS NULL THEN a WHEN b < a THEN b ELSE a END` (`>` for max), so a tie keeps the first |
| `lower`, `upper`, `trim` | `d.lower`, `d.upper`, `d.trimJs` |
| `contains`, `startswith`, `endswith` | a literal needle (`notLiteral`); `d.like(x, bind(likeAffix(needle, d.likeEscape, where)))`, with no coalesce: `contains(null, …)` is null |
| `concat` | text arguments only; `COALESCE(a, '') \|\| COALESCE(b, '')` |
| `year`, `month`, `day`, `quarter` | a date argument; `toDouble(d.datePart(x, part))` |
| `datediff(part, a, b)` | `part` is a literal: day, month, quarter or year, any case (`datediffPart`). Day is `toDouble(epochDay(b) - epochDay(a))`; month is `(yb − ya) * 12 + (mb − ma)`; quarter and year are built the same way from their parts |
| an LOD, `[[param]]` | refused: `lod`, `param` |

**The projection (D3)**, applied once, on the final result:
- A number is `CASE WHEN e - e = 0 THEN CASE WHEN e = 0 THEN toDouble(0) ELSE e END END`: finite only, and −0 as 0, since a copy stores `String(-0)`.
- Text is `NULLIF(e, '')`.
- A boolean is `CASE e WHEN TRUE THEN 'true' WHEN FALSE THEN 'false' END`, typed text.
- `null` is `d.text('NULL')`.
- A date result is refused (`dateResult`). That is my call: a copy types a date-shaped text column by its values, and v1 has no rule both engines share.
- [ ] **Step 1: Write the failing test** (§ types, § refusals, § shapes). For each row of the table, one accepted and one refused case, plus:
  ```ts
  const r = checkCalc('len([cat])', COLS, []);
  ok('a refused function names the function, says why, and underlines it', !r.ok && r.code === 'function' && r.error === "len() can't run on a Live table: warehouses count characters differently." && show(r.at) === '{"start":0,"end":3}');
  ok('a later calc is refused, an earlier one is not', !checkCalc('[B] + 1', COLS, []).ok && checkCalc('[A] + 1', COLS, [{ name: 'A', expression: '[amt]', type: 'number' }]).ok);
  for (const id of DIALECT_IDS) for (const [expr, want] of SHAPES[id]) ok(`${id}: ${expr} has its fragments`, want.every((w) => compiled(id, expr).includes(w)), compiled(id, expr));
  ```
  `SHAPES` pins, per dialect:
  - `[amt] / [qty]` → `NULLIF(`;
  - `round([amt], 1)` → the FLOOR CASE, and no `ROUND(`;
  - `lower([cat])` → `lowerUTF8(` on ClickHouse;
  - `trim([cat])` → the dialect's trim;
  - `floor([amt])` → Databricks' guard;
  - `contains([cat], 'a%')` → `LIKE` and its escape;
  - `[d] < [d]` → the null fold;
  - `year([d])` → the date part.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-formulaSql.js` → `compileCalcSql` missing.
- [ ] **Step 3: Implement.** Each builder method checks its operands' types and throws `new CalcError(code, message, at)` (a `FormulaError` with `tokenIndex = at`). `compileCalcSql` catches it and maps the span with `spanOf`. A `FormulaError` from the parser itself becomes `code: 'syntax'`. Then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-formulaSql.js && node scripts/test-i18n.js && node scripts/test-formulaGolden.js`.
- [ ] **Step 5: Commit.** `git add src/engine/live/formulaSql.ts src/engine/live/formulaSqlMessages.ts src/formula/formula.ts scripts/i18n-extract.ts src/i18n scripts/test-formulaSql.ts` · "Compile v1 formulas to SQL with the JS evaluator's semantics, or refuse them with a sentence"

### Task 3: the expression differential, safety and the negative controls
**Files:** Create `scripts/formulaSqlCorpus.ts` (the fixture and a seeded generator of well-typed v1 expressions) and `scripts/test-formulaSqlDiff.ts`.
**Interfaces:** Produces
- `CALC_COLUMNS` (`rid`, `n`, `m` number, `t`, `u` text, `d`, `e` DATE, `ts` TIMESTAMP) and about 40 `CALC_ROWS`. They hold null, `0`, `-0`, `0.5`, `1.5`, `2.5`, `-0.5`, `-2.5`, `1e-7`, `123456.789`, `2^53`, `''`, `'  '`, `'\t'`, `'ß'`, `'İ'`, `'ΑΣ'`, `'%_\\'`, `'007'`, 2024-02-29, 2023-12-31, 2024-01-01, 1970-01-01 and a TIMESTAMP at 23:59:59. Magnitudes stay below 1e6 except `2^53`, so nothing overflows.
- `calcCorpus(seed, n): string[]`, about 2,000 expressions of depth ≤ 4. Every v1 function and every operator appears at least 20 times; the test asserts it.
- `copyCell(v: FValue): Cell`, what one copy cell stores before the column is retyped: `null` and `''` → null, a boolean → `'true'`/`'false'`, −0 → 0, otherwise the value.
- `calcDiff(engine: ParityEngine, exprs: string[], B?: typeof SqlFormulaBuilder): Promise<string[]>`, the problems found (empty = agree). It is written over `ParityEngine` (`engine.load` for the fixture, `engine.run` per statement, `scripts/liveParityFixture.ts:171`), so step 05 runs the same function on Postgres, ClickHouse, Snowflake and BigQuery. `npm test` runs it on `fx.duckEngine`.
- [ ] **Step 1: Write the failing test.** The copy side is `compile(expr).fn.evaluate(row)` over the rows as an import stores them (`fx.importTyped`). The Live side is `SELECT lv_src.rid AS o_r, <projected> AS o_v… FROM <engine.load(…)> AS lv_src ORDER BY o_r` through `calcDiff(fx.duckEngine, …)`, 100 expressions per statement.
  ```ts
  const bad = await calcDiff(fx.duckEngine, calcCorpus(SEED, 2_000));
  ok('every v1 expression, every row: copyCell(evaluate) === Live, under Object.is', bad.length === 0, bad.slice(0, 5).join(' | '));
  for (const [name, B] of [['no null fold in <', NoNullFold], ["no NULLIF('') on a text column", NoNullifRead], ["no NULLIF('') at the projection", NoNullifProjection], ['ROUND instead of the FLOOR CASE', WithRound]] as const)
    ok(`NEGATIVE CONTROL: ${name} is caught`, (await calcDiff(fx.duckEngine, corpusUsing(name), B)).length > 0);
  for (const lit of ["'; DROP TABLE x; --", "a'b", 'back\\slash', 'tick`', 'nul\u0000']) { const q = compiledWith(`concat([t], ${quoteFormula(lit)})`);
    ok(`literal ${JSON.stringify(lit)} is bound, never in the SQL text`, !q.sql.includes(lit) && q.params.some((p) => p.value === lit)); }
  ok('PIN: an overflow is ±Infinity in JS and NULL on Live', Object.is(copyCell(evalJs('[n] * [n] * [n] * 1e300', HUGE)), Infinity) && liveValue('[n] * [n] * [n] * 1e300', HUGE) === null);
  ```
  - Each negative control is a subclass that overrides one method (`compare`, `col`, `project`, `round`).
  - If DuckDB's `lower`/`upper` differ from JS on `ß`, `İ` or a final `Σ`, those code points become ONE named pin here, with its own test. The gated corpus then leaves them out. Moving `lower`/`upper` to refused is the other choice; it needs the owner, since D4 lists them in v1.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-formulaSqlDiff.js` → the corpus module is missing.
- [ ] **Step 3: Implement** the generator and the harness. A real mismatch is fixed in the builder, never by loosening the comparison.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-formulaSqlDiff.js` → green, with 4 negative controls caught; then `npm run lint` → 0.
- [ ] **Step 5: Commit.** `git add scripts/formulaSqlCorpus.ts scripts/test-formulaSqlDiff.ts` · "Hold the formula SQL to the JS evaluator row by row on the DuckDB bench"

**Existing tests that must stay green:** test-liveCompile, test-liveParity, test-formula*, test-formulaGolden, test-i18n, test-file-size.

**Not in this step:** any route, record or editor (step 04); real engines (step 05). `replace`, `ltrim`, `rtrim` and `div` stay refused in this part.
