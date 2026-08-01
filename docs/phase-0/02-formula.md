## formula.ts

**Phase 0 behavioural contract — migration landmine 6.2**

Source of truth: `/Users/ashishb/Projects/ordinate/src/formula.ts` (1,043 lines) and its conformance suite `/Users/ashishb/Projects/ordinate/scripts/test-formula.ts` → emitted sibling `/Users/ashishb/Projects/ordinate/scripts/test-formula.js`.

**Corrections to the brief up front:**
- The brief says "70 functions". The real `FUNCTIONS` record (`src/formula.ts:476-739`) has **82 entries**: Number **27**, String **24**, Date **22**, Type conversion **3**, Logical/misc **6**.
- The brief says "~130 assertions". The suite has **174 `ok(...)` assertions** (172 behavioural + 2 static source checks).
- A `.ts` source sibling **does exist**: `scripts/test-formula.ts` (the `.js` is tsc output, byte-equivalent in behaviour). The test reads `src/formula.ts` from disk at `scripts/test-formula.ts:258` for the no-`eval` guarantee — that path is load-bearing.
- All DuckDB claims below are from knowledge, **not measured**: there is no `duckdb` npm package and no `duckdb` CLI in this environment (verified). Every non-obvious DuckDB claim is tagged **NEEDS VERIFICATION** with the experiment.

---

### 1. Exported API surface

```ts
// src/formula.ts:21
export type FValue = number | string | boolean | null;

// src/formula.ts:23-30
export interface Compiled {
  evaluate(row: Record<string, FValue>): FValue;   // never throws
  refs: string[];                                   // column names referenced
}

// src/formula.ts:32
export type CompileResult = { ok: true; fn: Compiled } | { ok: false; error: string };

// src/formula.ts:36
export function compile(expression: string): CompileResult;
```

`compile` is the **only** export. Two invariants stated in the file header (`src/formula.ts:6-12`) and enforced by tests:
1. `compile` **never throws** — syntax errors, unknown functions, and injection attempts all return `{ ok:false, error }` (`src/formula.ts:57-60`).
2. `evaluate` **never throws** — a `try/catch` at `src/formula.ts:48-53` converts any runtime escape into `null`, and `undefined` → `null`.

**Consumer 1 — `src/transforms.ts` (the real one).** `stepCalculatedField` at `src/transforms.ts:204-242`:

```ts
const compiled = compile(s.expression);                    // :211
if (!compiled.ok) return skip(t, `… skipped: ${compiled.error}`);   // :212-214
const missing = compiled.fn.refs.filter((ref) => colIndex(t.columns, ref) < 0);  // :217
if (missing.length > 0) warnings.push(`… references unknown column(s): …`);      // :218-220
const results: FValue[] = rows.map((r) => {                // :226-230
  const rowMap: Record<string, FValue> = {};
  for (let c = 0; c < columns.length; c += 1) rowMap[columns[c].name] = r[c];
  return compiled.fn.evaluate(rowMap);
});
columns.push({ name, type: 'text' });                      // :233
retypeColumn(columns, rows, newIdx);                       // :239
```

Three contract facts fall out of this and matter enormously for a SQL port:

- **The row is a name→value map**, one object allocated per row (`:227-228`). Column lookup is **case-sensitive** (verified: `ev('Price', {price:5})` → `null`).
- **`refs` is a compile-time artefact used for a soft warning** (`:217-220`), not for evaluation. Unknown columns still evaluate to `null` at `src/formula.ts:933` / `:964` (`row[name] ?? null`). This is a *warn-and-continue* contract, not an error.
- **The output column is typed by a whole-column second pass**, not by the expression. `retypeColumn` (`src/transforms.ts:130-135`) stringifies every produced cell, runs `parse.detectColumnType`, and re-coerces. Measured:

| expression | resulting column type | cells |
|---|---|---|
| `a > 3` | `text` | `"true"`, `"false"` |
| `a / 0` | `text` | `null`, `null` |
| `concat("00", a)` | `text` | `"005"`, `"001"` |
| `today()` | `date` | `"2026-08-01"` |
| `a * 2` | `number` | `10`, `2` |

Note `evaluate` can return a **boolean**, but `Cell` is `string | number | null` — the boolean survives only because `retypeColumn` stringifies it to `"true"`/`"false"`. Any SQL port must reproduce *that*, not a SQL `BOOLEAN`.

**Consumer 2 — `src/ipc/datasets.ts:437`.** `dataset:suggestCalcField` compile-checks an AI-proposed expression purely to attach a soft `warning`; a non-compiling expression is still returned. The prompt at `src/analyze.ts:778-786` advertises a **deliberately narrower** subset to the model (`round, abs, floor, ceil, min, max, lower, upper, trim, len, concat, if, coalesce`) — 13 of the 82.

---

### 2. Grammar

#### Tokenizer (`src/formula.ts:85-190`)

| Token | Rule | Line |
|---|---|---|
| whitespace | ` \t\n\r` skipped | `:94-97` |
| `num` | `\d+(\.\d*)?([eE][+-]?\d+)?` and `.\d+` | `:100-118` |
| `str` | `'…'` or `"…"`; `\` escapes the **next character literally** — `'a\nb'` is `"anb"`, **not** a newline (verified) | `:122-139` |
| `col` | `[Any Text]`, `.trim()`ed; `[]` is a legal ref to the `""` column (verified) | `:142-153` |
| `name` | `[A-Za-z_][A-Za-z0-9_]*` | `:156-162` |
| `op` | `== != >= <=` then `= > < + - * / %` | `:165-177` |
| `punc` | `( ) ,` | `:180-184` |
| — | **anything else → `FormulaError('Unexpected character: ' + c)`** | `:186` |

There is **no `.`, no `;`, no backtick, no `[`-index, no `&&`/`||`, no `^`, no `!`-prefix**. That single default branch at `:186` is what makes `1; process.exit(1)` and `process.exit(1)` compile errors — tests `scripts/test-formula.ts:126-128`.

Unterminated `'` → `'Unterminated string literal'` (`:135`); unterminated `[` → `'Unterminated [column] reference'` (`:149`).

#### Grammar sketch

```
expr        := or
or          := and   ( "OR"  and  )*                       # left-assoc
and         := not   ( "AND" not  )*                        # left-assoc
not         := "NOT" not | comparison                       # prefix, right-recursive
comparison  := additive [ "IN" "(" [ or ("," or)* ] ")" ]
                        ( ("=" | "==" | "!=" | ">" | "<" | ">=" | "<=") additive )*
additive    := multiplicative ( ("+" | "-") multiplicative )*   # left-assoc
multiplicative := unary ( ("*" | "/" | "%") unary )*            # left-assoc
unary       := "-" unary | "+" unary | primary                  # right-assoc
primary     := number | string | "TRUE" | "FALSE" | "NULL"
             | "[" colname "]" | identifier                     # bare ident = column ref
             | funcname "(" [ or ("," or)* ] ")"
             | ifStmt | caseStmt
             | "(" or ")"
ifStmt      := "IF" or "THEN" or ( "ELSEIF" or "THEN" or )* [ "ELSE" or ] "END"
caseStmt    := "CASE" or ( "WHEN" or "THEN" or )+ [ "ELSE" or ] "END"
```

Precedence, lowest→highest (documented `src/formula.ts:756-757`, implemented `:811-911`):
`OR` < `AND` < `NOT` < `IN`/comparison < `+ -` < `* / %` < unary `- +` < primary.

Verified consequences:
- **`NOT` binds looser than comparison**: `not x = 1` with `x=1` → `false`, i.e. `NOT(x = 1)`.
- **Comparisons chain left-assoc and it is nonsense but legal**: `1 < 2 < 3` → `false` (because `(1<2)` is `true`, `num(true)` is `null`, so it falls to the string branch `"true" < "3"`). `1 = 1 = 1` → `false`.
- **Unary minus binds tighter than `*`**: `-2 * 3` → `-6`.
- **No exponent operator**; `power()` only.

Keyword/identifier resolution (`src/formula.ts:936-965`):
- `true`/`false`/`null` are **case-insensitive literals** (`TRUE` → `true`, verified) and are reserved — a column literally named `true` is unreachable, but `truefoo` is a normal column (verified).
- An identifier immediately followed by `(` is a **function call**; otherwise a **bare column reference**. So `if(a,b,c)` is the function form and `IF a THEN b END` is the statement form — both supported, explicitly (`:954`, test `scripts/test-formula.ts:235`).
- **Function names are matched lower-cased** (`FUNCTIONS[name.toLowerCase()]`, `:1028`) — `ROUND(1.6)` → `2` (verified). **Column names are not** — case-sensitive.
- `case` is *always* the statement form (`:955`), so no function may be named `case`.

`IN` specifics (`src/formula.ts:846-865`): parsed **once**, before the comparison loop, at the same level. Items are full `or` expressions. Empty list `x IN ()` is legal → `false`. `IN` cannot chain: `1 IN (1) IN (true)` → `ERR: Unexpected token: IN`. But `1 IN (1,2) = true` parses (IN then a comparison) → `true`.

`CASE` requires ≥1 `WHEN` (`:1013`, `'CASE requires at least one WHEN'`). Both `IF` and `CASE` require a terminal `END` (`:995`, `:1019`).

#### What a parse error produces

`{ ok: false, error: string }` — never a throw, never a partial function. Exact messages:

| Trigger | Message | Line |
|---|---|---|
| empty / non-string / whitespace-only | `Empty expression` | `:38` |
| stray char | `Unexpected character: <c>` | `:186` |
| unterminated `'`/`"` | `Unterminated string literal` | `:135` |
| unterminated `[` | `Unterminated [column] reference` | `:149` |
| trailing tokens after a complete expr | `Unexpected token: <v>` | `:771` |
| bad token in primary position | `Unexpected token: <v>` | `:974` |
| ran out of tokens | `Unexpected end of expression` | `:915` |
| missing punctuation | `Expected "(" but got <v \| end of input>` | `:798` |
| missing keyword | `Expected "THEN" but got <v \| end of input>` | `:806` |
| unknown function | `Unknown function: <name>` | `:1029` |
| `CASE` with no `WHEN` | `CASE requires at least one WHEN` | `:1013` |

**Arity is never checked at compile time.** `round()`, `if(true)`, `left('abc')`, `round(1,2,3)` all compile; missing args arrive as `undefined` and each function's own null guards decide. Verified: `round()` → `null`, `if(true)` → `null`, `round(1,2,3)` → `1`, `concat()` → `""`, `min()` → `null`.

---

### 3. Complete function catalogue (82)

Shared helpers that define most of the null behaviour:
- `num(v)` (`:199-201`) — `typeof v === 'number' && Number.isFinite(v) ? v : null`. **A numeric string is not a number.**
- `truthy(v)` (`:205-210`) — `null`→false; boolean as-is; number → `!==0 && !NaN`; **any other value → `String(v).length > 0`**, so the string `"false"` is truthy (verified: `if(x,1,2)` with `x='false'` → `1`; `if('',1,2)` → `2`).
- `looseEq(a,b)` (`:215-221`) — numeric if both `num()`; else `null==null` only; else `String(a)===String(b)`.
- `math1(f)` (`:461-468`) — `num` arg, apply, **reject non-finite result → `null`**.
- `str1(f)` (`:470-472`) — `null` arg → `null`, else `f(String(arg0))`.
- `toDate(v)` (`:231-251`) — see §4.

#### Number (27)

| Fn | Arity | Args | Returns | Null/error behaviour |
|---|---|---|---|---|
| `round` | 1–2 | num, num digits (default 0) | number | non-num → null. `\|d\|≳309` overflows `10^d`; guard at `:488` falls back to `Math.round(x)` rather than emit NaN. **JS half-up-toward-+∞**: `round(2.5)`→3, `round(-2.5)`→**-2** (verified) |
| `abs` | 1 | num | number | non-num → null |
| `floor` | 1 | num | number | non-num → null |
| `ceil` | 1 | num | number | non-num → null |
| `ceiling` | 1 | num | number | Tableau alias of `ceil` (`:494`) |
| `sign` | 1 | num | number | `sign(0)`→0 (verified) |
| `sqrt` | 1 | num | number | `sqrt(-1)` → NaN → **null** (`math1` guard) |
| `square` | 1 | num | number | `square('4')` → **null** (no coercion, verified) |
| `exp` | 1 | num | number | overflow → non-finite → null |
| `ln` | 1 | num | number | `ln(0)` → -∞ → **null**; `ln(-1)` → NaN → null |
| `sin`/`cos`/`tan` | 1 | num | number | `tan(π/2)` finite in JS, passes |
| `asin`/`acos`/`atan` | 1 | num | number | out-of-domain → NaN → null |
| `cot` | 1 | num | number | `cot(0)` → ∞ → **null** (verified) |
| `degrees`/`radians` | 1 | num | number | non-num → null |
| `pi` | 0 | — | number | constant `Math.PI` |
| `atan2` | 2 | num y, num x | number | either null → null |
| `power` | 2 | num, num | number | non-finite result → null. `power(-8,0.5)`→null, `power(0,-1)`→null (verified) |
| `log` | 1–2 | num x, num base (default **10**) | number | `x<=0` → null; `base<=0 or base===1` → null (`:522-528`). **Arg order is `(x, base)`** |
| `div` | 2 | num, num | integer | `q===0` → null; `Math.trunc(p/q)` (**toward zero**) |
| `zn` | 1 | any | number | **null or non-numeric → `0`**. `zn('5')` → **0** (verified) — not a cast |
| `min` | variadic | any | number \| string | `reduceMinMax(a,false)` `:744-752` |
| `max` | variadic | any | number \| string | see below |

`reduceMinMax` (`:744-752`): drops `null`/`undefined`; if **every** survivor is a `number`, reduce numerically; otherwise reduce **lexically on `String(v)`**. So `min(3,1,2)`→1, `min('banana','apple')`→`'apple'`, and `min(1,'a')`→`"1"` / `max(1,'a')`→`"a"` (verified) — **the return type of a single expression depends on the data**. All-null args → `null`. Uses `reduce`, never `Math.min(...spread)` (comment `:742-743`).

#### String (24)

| Fn | Arity | Args | Returns | Null/error behaviour |
|---|---|---|---|---|
| `lower`/`upper`/`trim` | 1 | any | string | null → null; non-string stringified |
| `ltrim` | 1 | any | string | strips leading `\s+` only |
| `rtrim` | 1 | any | string | strips trailing `\s+` only |
| `len` | 1 | any | number | **UTF-16 code units**: `len('😀')` → **2** (verified). `len(12345)` → 5 |
| `proper` | 1 | any | string | `/[A-Za-z0-9]+/g` runs, first char upper + rest lower. `'3rd'` stays `'3rd'` |
| `ascii` | 1 | any | number | **empty string → `null`** (`:549`); returns `charCodeAt(0)` (UTF-16 unit, not codepoint) |
| `char` | 1 | num | string | `String.fromCharCode(trunc(n))`; `char(-1)` → `'\uFFFF'` (verified, no domain check) |
| `space` | 1 | num | string | `n<0` → null; **clamped to 100000** (`:557`) |
| `contains` | 2 | any, any | boolean | either null → null; `contains(1,'1')` → true (both stringified) |
| `startswith` | 2 | any, any | boolean | either null → null |
| `endswith` | 2 | any, any | boolean | either null → null |
| `left` | 2 | any, num | string | `slice(0, max(0,trunc(n)))`; `left('hello',-1)` → `''` |
| `right` | 2 | any, num | string | `n<=0` → `''`; else `slice(-n)` |
| `mid` | 2–3 | any, num start(**1-based**), num len | string | `from = max(0, trunc(start)-1)`; `mid('hello',0)` and `mid('hello',-3)` both → `'hello'`; null len arg → null |
| `find` | 2–3 | any, any, num start(1-based) | number | **1-based, 0 = not found** (`:591`). `find('abc','')` → **1** |
| `findnth` | 3 | any, any, num n | number | `n<1` or empty needle → **0**; not found → 0. `findnth('abc','',1)` → **0** (inconsistent with `find`) |
| `replace` | 3 | any×3 | string | any null → null; **empty needle → input unchanged**; `split/join` = **replace-all, literal** |
| `split` | 3 | any, any sep, num idx | string | `n===0` or null → **null**; negative n counts from end (`:617`); out of range → null |
| `regexp_match` | 2 | any, pattern | boolean | invalid pattern → **null**; JS `RegExp`, no flags |
| `regexp_extract` | 2 | any, pattern | string | **group 1 if present, else whole match** (`:630`); no match → null |
| `regexp_extract_nth` | 3 | any, pattern, num n | string | `m[trunc(n)] ?? null`; 0 = whole match |
| `regexp_replace` | 3 | any, pattern, repl | string | compiled with **`'g'`** (`:642`) = replace-all; JS `$1` substitution syntax (verified: `'[$1]'` → `'a[1]'`) |

Regex cache `RE_CACHE` (`:380-392`): keyed `flags + ' ' + pattern`, **bounded at 500 entries** (`:390`) — beyond that patterns still compile, just uncached. Invalid pattern is cached as `null`.

#### Date (22)

All take **text** and return **integer or formatted text**. See §4.

| Fn | Arity | Returns | Notes |
|---|---|---|---|
| `year`/`month`/`day` | 1 | int | unparseable → null |
| `quarter` | 1 | int 1–4 | `floor(month/3)+1` |
| `week` | 1 | int | **Sunday-start week-of-year** (`weekOfYear`, `:272-276`). `week('2024-12-31')` → 53 |
| `isoweek` | 1 | int | ISO-8601 week (`:278-288`) |
| `isoyear` | 1 | int | ISO week-numbering year |
| `isoquarter` | 1 | int | **identical to `quarter`** (`:654`) — not really ISO |
| `isoweekday` | 1 | int 1–7 | **Mon=1 … Sun=7** |
| `datepart` | 2 | int | `(part, date)`; unknown part → **null** |
| `datename` | 2 | string | month/weekday → names; anything else → `String(datePart(...))` (`datename('quarter',…)` → `"3"`) |
| `datediff` | 3 | int | `(part, d1, d2)` — boundary crossings, see §4 |
| `dateadd` | 3 | **string** | `(part, n, date)` → `fmtDateTime` for hour/minute/second, else `fmtDate` |
| `datetrunc` | 2 | **string** | same formatting rule; `week` truncates to **Sunday** |
| `makedate` | 3 | string | `(y,m,d)` → `'YYYY-MM-DD'`; **rolls over**, `makedate(2024,13,45)` is not rejected |
| `maketime` | 3 | string | anchored at **1899-12-30** → `'1899-12-30 HH:MM:SS'` (verified) |
| `makedatetime` | 2 | string | date part of arg0 + time part of arg1 |
| `now` | 0 | string | `fmtDateTime(new Date())` — **evaluated per row** |
| `today` | 0 | string | `fmtDate(new Date())` — **evaluated per row** |
| `isdate` | 1 | boolean | `null` arg → **`false`** (not null). `isdate(45000)` → false, `isdate(true)` → false |
| `date` | 1 | string | normalise to `'YYYY-MM-DD'` |
| `datetime` | 1 | string | normalise to `'YYYY-MM-DD HH:MM:SS'` |

#### Type conversion (3)

| Fn | Behaviour (`:708-724`) |
|---|---|
| `int` | null→null; number→`trunc`; boolean→1/0; **else `Number(String(v).trim())`**, finite → `trunc`, else null. Verified oddities: `int('0x10')`→**16**, `int('1e3')`→**1000**, `int('')`→**0**, `int('  42  ')`→42, `int('abc')`→null, `int(-3.9)`→-3 |
| `float` | same minus the trunc. `float('')`→**0**, `float('Infinity')`→**null** (isFinite guard) |
| `str` | `null → null`, else `String(v)`. `str(true)`→`"true"` |

#### Logical / misc (6)

| Fn | Behaviour |
|---|---|
| `concat` | variadic, **nulls → `''`**, everything stringified, joined. `concat()` → `''` |
| `if` | `if(cond,then,else)` using `truthy`; missing branch → null |
| `iif` | 3–4 args. **If `a[0] === null` and a 4th arg exists, return the 4th** (`:730`); else `truthy` |
| `ifnull` | `a[0] == null ? a[1] : a[0]`. `ifnull('',0)` → `''` |
| `isnull` | `a[0] == null` → boolean. `isnull('')` → false |
| `coalesce` | first non-null/non-undefined; none → null; `coalesce()` → null |

---

### 4. The semantics that deliberately differ from SQL

#### 4a. Per-row failure yields `null`; it never throws

Three independent layers:

1. **Arithmetic** (`arith`, `:394-414`): `if (a === null || b === null) return null;` then `'/': b === 0 ? null : a / b` and `'%': b === 0 ? null : a % b` (`:407-409`). Comment on `:407`: *"div-by-zero → null, not Infinity"*.
   - Proof: `scripts/test-formula.ts:50` `ok('div by zero → null', ev('5 / 0') === null)`; `:51` `ev('5 % 0') === null`; `:145` `ev('div(1, 0)') === null`.
2. **Unknown column** (`:933`, `:964`): `return (row) => row[name] ?? null`. No error, only a `refs`-derived *warning* in `transforms.ts:218-220`.
   - Proof: `scripts/test-formula.ts:56` `ok('unknown column → null (not throw)', ev('missing + 1', {}) === null)`.
3. **Backstop** (`:48-53`): `try { … } catch (_) { return null; }`.

Non-finite results are also suppressed, not surfaced: `sqrt(-1)`→null (`:133`), `ln(0)`→null (`:137`), `round(5.4,400)`→**5** rather than NaN (`:72-73`, guard at `:488` with a comment explaining that a NaN would *"poison the whole calculated-field column"*).

#### 4b. Arithmetic refuses to coerce numeric strings

`num()` at `src/formula.ts:199-201` is the entire rule, with the comment at `:196-198`: *"A numeric STRING is NOT a number here — arithmetic on a non-number operand yields null (never fabricate a value from a text cell)."*

Proof — `scripts/test-formula.ts:63-65`:
```js
ok('null operand → null', ev('x + 1', { x: null }) === null);
ok('non-numeric string operand → null', ev('x + 1', { x: 'abc' }) === null);
ok('numeric string is NOT auto-coerced → null', ev('x * 2', { x: '5' }) === null);
```
Also `square('4')` → null and `zn('5')` → **0** (verified). Casting is explicit only: `int('42')`→42 (`:190`), `float('3.14')`→3.14 (`:192`).

Comparison is the **exception**: `compareOp` (`:416-457`) falls through to string comparison when either side isn't numeric, so `'2' = 2` → **true** (`looseEq` stringifies), `' 2 ' = 2` → false, `'abc' > 5` → **true** (`"abc" > "5"`), `'10' < '9'` → true. Booleans are *not* numeric under `num()`, so `true = 1` → **false** but `true = 'true'` → **true** (all verified).

Three-valued logic does not exist. `truthy(null)` is `false`, so `null AND true` → **false**, `null OR true` → **true**, `NOT null` → **true**, and `x > 5` with `x = null` → **false**, `null = null` → **true**, `null IN (1,2)` → **false** (all verified).

#### 4c. Dates are text cells parsed as LOCAL time

Header comment `:223-227`: *"Screenchart has no date TYPE — a 'date' column is text."*

`toDate` (`:231-251`), in order:
1. `null`/boolean → `null`.
2. **`typeof v === 'number'` → `null`** — comment `:233`: *"ponytail: no serial-date guessing"*. So `date(45000)` → null, `isdate(45000)` → false, `year(20240101)` → null (verified). **`DATE(number)` is always `null`.**
3. `^(\d{4})[-/](\d{1,2})[-/](\d{1,2})([ T]HH:MM(:SS)?)?` → `new Date(y, m-1, d, …)` — **local-time constructor**, comment `:236-237`: *"parsed as LOCAL time so it agrees with TODAY()/NOW(); avoids new Date('YYYY-MM-DD') being UTC-midnight."* Note `new Date(2024,12,45)` rolls over: `date('2024-13-45')` → **`'2025-02-14'`** (verified) — no validity check.
4. `^(\d{1,2})/(\d{1,2})/(\d{4})` → **US MM/DD/YYYY**. `date('7/4/2024')` → `'2024-07-04'`; `date('04/07/2024')` → `'2024-04-07'` (verified) — never DD/MM.
5. **Fallback `new Date(s)`** — whatever the JS engine accepts. `date('July 4, 2024')` → `'2024-07-04'` (verified). This is an open-ended, engine-defined surface.

Output formatting: `fmtDate` → `YYYY-MM-DD` (`:256-258`), `fmtDateTime` → `YYYY-MM-DD HH:MM:SS` (`:259-261`), both from **local** getters. `partIsTime` (`:296-298`) picks which one `dateadd`/`datetrunc` use.

**`date_part` string vocabulary** (`normPart` = trim + lowercase, `:293-295`). `datePart` accepts exactly (`:300-318`):
`year, quarter, month, dayofyear, day, weekday, week, hour, minute, second, iso-year, iso-quarter, iso-week, iso-weekday` — **anything else → `null`** (verified: `datepart('bogus', …)` → null).
`dateDiff`/`dateAdd`/`dateTrunc` accept a **smaller** set (`:327-375`): `year, quarter, month, week, day, dayofyear, weekday, hour, minute, second` — the `iso-*` parts are **not** supported there and return `null`.

**`weekday` = 1(Sun)…7(Sat)** (`:307`, `d.getDay() + 1`) — proven by `scripts/test-formula.ts:202`: `ev("datepart('weekday', '2024-07-28')") === 1` (a Sunday).
**`iso-weekday` = 1(Mon)…7(Sun)** (`:315`, `((d.getDay()+6)%7)+1`) — `scripts/test-formula.ts:217`: `ev("isoweekday('2024-07-29')") === 1` (a Monday).

**Week numbering**: `weekOfYear` (`:272-276`) is Sunday-start, 1-based, Tableau default — `datepart('week','2024-12-31')` → **53**, `datepart('week','2024-01-01')` → 1. `isoParts` (`:278-288`) is proper ISO-8601 via the Thursday rule.

#### 4d. `DATEDIFF` counts boundary crossings

`dateDiff` (`:327-341`), with the comment at `:325-326`: *"Tableau counts boundary crossings, not elapsed time (DATEDIFF('year', 2020-12-31, 2021-01-01) === 1)."*

```ts
case 'year':    return d2.getFullYear() - d1.getFullYear();
case 'quarter': return (Δyear)*4  + (floor(m2/3) - floor(m1/3));
case 'month':   return (Δyear)*12 + (m2 - m1);
case 'week':    return trunc(((dayNumber(d2) - d2.getDay()) - (dayNumber(d1) - d1.getDay())) / 7);
case 'day': case 'dayofyear': case 'weekday': return dayNumber(d2) - dayNumber(d1);
case 'hour'/'minute'/'second': return trunc(Δms / 3600000 | 60000 | 1000);
```

Proof — `scripts/test-formula.ts:205-207`:
```js
ok('datediff year counts boundary', ev("datediff('year', '2020-12-31', '2021-01-01')") === 1);
ok('datediff month', ev("datediff('month', '2024-01-15', '2024-04-10')") === 3);
ok('datediff day', ev("datediff('day', '2024-01-01', '2024-01-11')") === 10);
```
Verified extras: `datediff('year','2021-01-01','2020-12-31')` → **-1** (signed); `datediff('week','2024-01-06','2024-01-07')` → **1** (Sat→Sun crosses a Sunday-start week boundary); `datediff('hour','2024-01-01 00:00','2024-01-01 01:30')` → **1** (truncated elapsed, *not* boundary-counted — hour/minute/second are the inconsistent ones).

**DST-safe integer day counting**: `dayNumber` (`:265-267`) is `floor(Date.UTC(y, m, d) / 86400000)` — it takes the **local calendar components** and re-encodes them as UTC, so a DST transition can never make a day-diff 23/25 hours. Verified: `datediff('day','2024-03-09','2024-03-11')` → **2** across the US DST jump. `'week'` uses the same integer-day base, subtracting `getDay()` to snap both ends to their Sunday.

---

### 5. Conformance / DuckDB breakage table

**Legend for "Differs?"**: ✅ same · ⚠️ same shape, edge cases diverge · ❌ materially different.
All DuckDB behaviour is unmeasured; entries tagged **NV** need the experiment listed at the end of this section.

#### 5.1 Grammar & operators

| Feature | Ordinate semantics | Nearest DuckDB SQL | Differs? | Translation needed |
|---|---|---|---|---|
| `+ - * ` on numbers | plain doubles | same | ✅ | direct |
| `/` | double divide; **`b=0` → NULL** | `/` → DOUBLE; `1/0` behaviour **NV** (DuckDB is believed to return NULL, unlike Postgres which raises) | ⚠️ | emit `a / NULLIF(b,0)` unconditionally |
| `%` | JS `%` — sign follows dividend, works on floats (`-7%3`→-1, `7.5%2`→1.5); `b=0` → NULL | `%`/`mod`; C semantics on integers, float mod **NV**; `%0` **NV** | ⚠️ | `a % NULLIF(b,0)`; verify float operands |
| unary `-`, `+` | `num()` first; `-'5'` → NULL | numeric negate; `-'5'` coerces **NV** | ❌ | type-aware: negation of a VARCHAR column must emit `NULL` |
| operand is a **numeric string** | **NULL** (`num()` refuses) | implicit VARCHAR→numeric cast believed to succeed **NV** | ❌ | schema-aware codegen: any arithmetic whose operand column is `text` must be constant-folded to `NULL` |
| operand is a non-numeric string | NULL | **THROWS** conversion error **NV** | ❌ | as above / `TRY_CAST` |
| `= == !=` | `looseEq`: numeric-if-both-numeric, else `String()` compare; `NULL = NULL` → **true** | `=`; `NULL = NULL` → **NULL**; cross-type comparison casts and may throw | ❌ | `a IS NOT DISTINCT FROM b` for `=`; but the numeric-vs-lexical fallback has no direct analogue — emit `CAST(a AS VARCHAR) = CAST(b AS VARCHAR)` when either side is text |
| `> < >= <=` | numeric if both numeric, else **lexical on `String()`**; NULL side becomes `''` (`:442-443`) | typed comparison; NULL → NULL | ❌ | wrap: `coalesce(CAST(x AS VARCHAR),'')` for the text path; NULL→`''` is a real semantic, `'' > 'a'` is false while SQL gives NULL |
| chained comparison `1 < 2 < 3` | legal, → false | DuckDB parses `(1<2)<3` → `TRUE < 3` → cast error **NV** | ⚠️ | rare; translator should reject or replicate via VARCHAR cast |
| `AND` / `OR` | `truthy()` both sides, **two-valued**; `NULL AND TRUE`→false, `NULL OR TRUE`→true | three-valued: `NULL AND TRUE`→NULL | ❌ | `coalesce(<bool>, FALSE)` around each operand — and `truthy` on non-boolean operands has no SQL analogue |
| `NOT` | `!truthy(v)`; `NOT NULL` → **true** | `NOT NULL` → NULL | ❌ | `NOT coalesce(x, FALSE)` |
| truthiness of non-boolean | number≠0, **non-empty string** (`"false"` is true, `"0"` is true) | boolean required; VARCHAR→BOOLEAN cast accepts `'false'`/`'0'` as FALSE **NV** | ❌ | explicit `CASE WHEN typeof… ` or, better, static-type-driven codegen |
| `[Column Name]` / bare ident | case-**sensitive**; missing → NULL | `"Column Name"`; missing → **binder error** | ❌ | resolve refs in TS first; substitute a typed `NULL` literal for every unknown ref (this is what `refs` is for) |
| `IN (…)` | `looseEq` over each item; NULL subject → **false**; empty list legal | SQL `IN`; NULL subject → NULL; empty list is a syntax error | ❌ | `coalesce(x IN (…), FALSE)`; empty list → `FALSE` |
| `IF…THEN…ELSEIF…ELSE…END` | `truthy` tests; no ELSE → NULL; branches may return **mixed types** | `CASE WHEN … THEN … END` | ⚠️ | direct, but branch types must unify — DuckDB picks a common supertype and will silently cast `1` to `'1'`; Ordinate keeps them heterogeneous per row |
| `CASE <e> WHEN <v> THEN` | `looseEq` matching (cross-type) | `CASE expr WHEN v` uses `=` | ⚠️ | rewrite to searched `CASE WHEN <looseEq translation>` |
| string literal `\` escape | escapes the **next char literally** (`'a\nb'` = `"anb"`) | `'…'` with `''` doubling; `E'…'` for C escapes | ❌ | unescape in TS, re-quote for SQL |
| parse error | `{ok:false, error}`, never throws, **injection impossible** | DuckDB parser error — and handing a raw user string to DuckDB is **SQL injection** | ❌ | the TS parser/AST **must be kept** as the trust boundary |

#### 5.2 Number functions

| Fn | Ordinate | Nearest DuckDB | Differs? | Translation |
|---|---|---|---|---|
| `round(x)` | JS `Math.round` — half **toward +∞** (`-2.5`→-2) | `round()` — half **away from zero** (`-2.5`→-3) **NV** | ❌ | `floor(x + 0.5)` for the 1-arg form |
| `round(x,d)` | as above ×10^d; `\|d\|≳309` → integer round | `round(x, d)`; huge `d` **NV** | ❌ | clamp `d` to ±15 and use the floor trick |
| `abs`,`floor`,`ceil` | direct | `abs`,`floor`,`ceil` | ✅ | direct |
| `ceiling` | alias | `ceiling` exists | ✅ | direct |
| `sign` | -1/0/1 | `sign` | ✅ | direct |
| `sqrt` | `sqrt(-1)` → **NULL** | Postgres raises; DuckDB **NV** (NaN or error) | ❌ | `CASE WHEN x<0 THEN NULL ELSE sqrt(x) END` |
| `square` | `x*x` | `x*x` (no `square`) **NV** | ✅ | inline |
| `exp` | non-finite → NULL | `exp` → `inf` | ⚠️ | `CASE WHEN isfinite(exp(x)) THEN … END` |
| `ln` | `ln(0)`→NULL, `ln(-1)`→NULL | `-inf` / error **NV** | ❌ | `CASE WHEN x>0 THEN ln(x) END` |
| `sin cos tan asin acos atan` | non-finite → NULL | same names | ⚠️ | finite-guard wrapper |
| `cot` | `1/tan(x)`; `cot(0)`→NULL | `cot` exists **NV** | ⚠️ | guard |
| `degrees`/`radians` | direct | `degrees`/`radians` | ✅ | direct |
| `pi()` | constant | `pi()` | ✅ | direct |
| `atan2(y,x)` | direct | `atan2(y,x)` | ✅ | direct |
| `power(x,p)` | non-finite → NULL; `power(-8,0.5)`→NULL, `power(0,-1)`→NULL | `pow`/`power`; NaN or error **NV** | ❌ | finite guard |
| `log(x[,base])` | **base 10 default**, args `(x, base)`; `x<=0`→NULL; `base<=0 or 1`→NULL | `log(x)` is base-10; **`log(b, x)` takes base FIRST** | ❌ | **swap arguments** + domain guards |
| `div(p,q)` | `trunc(p/q)` toward zero; `q=0`→NULL | `p // q` — floor vs trunc on negatives **NV** | ⚠️ | `trunc(p / NULLIF(q,0))` |
| `zn(x)` | null **or non-numeric** → `0`; a numeric string also → `0` | `coalesce(x,0)` | ❌ | numeric column: `coalesce(x,0)`; text column: **constant `0`** |
| `min`/`max` variadic | numeric if **all** args numeric, else **lexical**; return type data-dependent | `least`/`greatest` — single result type, NULL handling **NV** | ❌ | only translatable when every arg is statically the same type; the mixed case is not expressible |

#### 5.3 String functions

| Fn | Ordinate | Nearest DuckDB | Differs? | Translation |
|---|---|---|---|---|
| `lower`/`upper` | JS case mapping | `lower`/`upper` (ICU) | ⚠️ | direct; locale edge cases (Turkish ı, ß) may diverge **NV** |
| `trim`/`ltrim`/`rtrim` | JS `\s` class (incl. NBSP, unicode spaces) | trims **spaces** by default, or a given char set | ❌ | `regexp_replace(s,'^\s+','')` etc. to match the `\s` class |
| `len` | **UTF-16 code units** (`len('😀')`=2) | `length()` = **characters** (=1); `strlen()` = bytes | ❌ | no exact equivalent; nearest is `length(s)` and accept the emoji/astral divergence, or `array_length(…)` over UTF-16 — realistically **not reproducible** |
| `proper` | upper-first of each `[A-Za-z0-9]+` run | `initcap` **NV** (existence + word rule) | ⚠️ | verify; `regexp_replace` fallback |
| `ascii` | `charCodeAt(0)` UTF-16 unit; `''` → **NULL** | `ascii()` returns codepoint; `''` → 0 **NV** | ❌ | `CASE WHEN s='' THEN NULL ELSE ascii(s) END`; astral chars still differ |
| `char` | `fromCharCode`, no domain check (`char(-1)`=`'\uFFFF'`) | `chr(n)` errors on negative **NV** | ⚠️ | guard |
| `space(n)` | `' '.repeat(min(n,100000))`; `n<0`→NULL | `repeat(' ', n)` | ⚠️ | add clamp + negative guard |
| `contains` | `includes`, nulls→NULL | `contains(s,sub)` | ✅ | direct |
| `startswith`/`endswith` | nulls→NULL | `starts_with` / `ends_with` **NV** (`ends_with` existence) | ✅ | direct |
| `left(s,n)` | `n<0` → `''` | `left(s,n)` — negative n means "all but last n" in Postgres **NV** | ⚠️ | `left(s, greatest(n,0))` |
| `right(s,n)` | `n<=0` → `''` | `right(s,n)` **NV** | ⚠️ | guard |
| `mid(s,start[,len])` | **1-based**; `start<=0` clamps to 1; negative len → `''` | `substring(s,start,len)` — 1-based; `start<=0` uses Postgres window semantics (counts from a virtual position ≤1, shortening the result) **NV** | ⚠️ | `substring(s, greatest(start,1), greatest(len,0))` |
| `find(s,sub)` | **1-based, 0 = not found** | `strpos`/`position` — 1-based, 0 not found | ✅ | direct |
| `find(s,sub,start)` | 3-arg | **DuckDB has no 3-arg `instr`** | ❌ | `CASE WHEN strpos(substr(s,st),sub)=0 THEN 0 ELSE strpos(substr(s,st),sub)+st-1 END` |
| `find(s,'')` | → **1** | `strpos(s,'')` **NV** (likely 1) | ⚠️ | verify |
| `findnth(s,sub,n)` | nth occurrence, 1-based, 0 if absent; empty needle → **0** | no native | ❌ | list trick: `len(str_split(s,sub)[1..n] joined)+1`, plus guards. Expressible but ugly |
| `replace` | **replace-all, literal**; empty needle → unchanged | `replace()` replaces all; empty needle **NV** | ⚠️ | `CASE WHEN sub='' THEN s ELSE replace(...) END` |
| `split(s,sep,n)` | 1-based; **negative = from end**; `n=0`→NULL; out of range → NULL | `str_split(s,sep)[n]`; lists are 1-based, negative indexing supported, out-of-range → NULL **NV** | ⚠️ | direct + `NULLIF(n,0)` |
| `regexp_match` | JS `RegExp.test`, **no flags**; invalid pattern → NULL | `regexp_matches(s,p)` — **RE2** | ❌ | see regex note below |
| `regexp_extract` | **group 1 if it exists, else whole match** | `regexp_extract(s,p[,idx])`, **default idx = 0 = whole match** | ❌ | `coalesce(nullif(regexp_extract(s,p,1),''), regexp_extract(s,p,0))` — and even that differs when group 1 legitimately matches `''` |
| `regexp_extract_nth` | `m[n] ?? null`; 0 = whole match | `regexp_extract(s,p,n)` | ✅ | direct |
| `regexp_replace` | compiled with **`'g'`** = replace-all; replacement uses **`$1`** | `regexp_replace(s,p,r)` replaces **first only** unless `'g'` passed as a 4th arg; replacement uses **`\1`** | ❌ | add `'g'`; rewrite `$n` → `\n` in the replacement string |
| **regex flavour** | JS `RegExp`: backreferences (`(a)\1` → verified true), lookbehind `(?<=x)` (verified), lookahead, named groups `(?<g>…)`, JS-specific classes | **RE2**: no backreferences, no lookaround (both are hard errors, not false matches); named groups are `(?P<n>…)`/`(?<n>…)` | ❌ | patterns must be validated against RE2 in TS; a pattern using a backreference or lookaround **cannot** be translated |
| invalid pattern | → NULL, cached | binder/runtime error | ❌ | pre-validate literal patterns in TS; a **column-valued** pattern is untranslatable |

#### 5.4 Date functions

Everything here starts from a **VARCHAR** cell, so every translation begins with a cast that Ordinate does implicitly and permissively.

| Fn | Ordinate | Nearest DuckDB | Differs? | Translation |
|---|---|---|---|---|
| text → date | 3 accepted shapes + **open-ended `new Date(s)` fallback**; local time; **rolls over invalid dates** (`'2024-13-45'` → `2025-02-14`) | `TRY_CAST(s AS DATE)` / `strptime(s, fmt)`; ISO only; **rejects** out-of-range | ❌ | `coalesce(try_strptime(s,'%Y-%m-%d'), try_strptime(s,'%Y/%m/%d'), try_strptime(s,'%m/%d/%Y'), …)`; rollover and the free-form fallback are **not reproducible** |
| number → date | always **NULL** | `CAST(45000 AS DATE)` succeeds (epoch days) **NV** | ❌ | force NULL for numeric columns |
| `year`/`month`/`day` | int | `year(d)`, `month(d)`, `day(d)` | ✅ after cast | direct |
| `quarter` | 1–4 | `quarter(d)` | ✅ | direct |
| `week` | **Sunday-start** Tableau week; `2024-12-31` → 53 | `week(d)` = **ISO** (Monday) | ❌ | compute: `floor((doy + dow_of_jan1 - 1)/7)+1` |
| `isoweek`/`isoyear` | ISO-8601 | `isoweek` / `isoyear` **NV** | ✅ | direct |
| `isoquarter` | **same as `quarter`** | `quarter` | ✅ | map to `quarter` |
| `isoweekday` | Mon=1…Sun=7 | `isodow(d)` = Mon=1…Sun=7 | ✅ | direct |
| `datepart('weekday')` | **Sun=1…Sat=7** | `dayofweek(d)` / `date_part('dow')` = **Sun=0…Sat=6** | ❌ | `dayofweek(d) + 1` |
| `datepart('dayofyear')` | 1-based | `dayofyear(d)` | ✅ | direct |
| `datepart(<unknown>)` | **NULL** | unknown part is an **error** | ❌ | whitelist parts in TS, emit `NULL` otherwise |
| `datename('month'\|'weekday')` | English names | `monthname(d)` / `dayname(d)` **NV** (locale) | ⚠️ | verify English regardless of locale |
| `datename(<other>)` | `String(datePart(...))` | — | ❌ | `CAST(date_part(…) AS VARCHAR)` |
| `datediff` year/quarter/month | boundary crossings | DuckDB `date_diff` is documented as counting **partition boundaries** — believed to match **NV** | ⚠️ | direct **once verified**; the brief's claim that DuckDB "measures differently" may be wrong for these parts |
| `datediff('day')` | integer local-calendar-day difference, DST-safe | `date_diff('day', d1, d2)` on DATE ✅; on TIMESTAMP **NV** | ⚠️ | cast both to DATE first |
| `datediff('week')` | **Sunday**-anchored week boundaries | DuckDB week partitions are **Monday**-anchored **NV** | ❌ | `(datediff_days(d1_sunday, d2_sunday))/7` computed manually |
| `datediff('weekday'\|'dayofyear')` | **aliased to plain day count** | DuckDB likely rejects these part names **NV** | ❌ | rewrite to `'day'` |
| `datediff('hour'\|'minute'\|'second')` | **truncated elapsed**, not boundary count (`00:00`→`01:30` = 1) | DuckDB counts boundaries for these **NV** — would give 1 too here, but `00:59`→`01:00` would give 1 vs Ordinate's 0 | ❌ | `trunc(epoch_diff/3600)` explicitly |
| `dateadd(part,n,d)` | returns a **string** (`YYYY-MM-DD`, or `…HH:MM:SS` for time parts) | `d + INTERVAL n part` → DATE/TIMESTAMP | ❌ | wrap in `strftime(…, '%Y-%m-%d')` / `'%Y-%m-%d %H:%M:%S'`, choosing by part |
| `datetrunc(part,d)` | string; **`week` truncates to Sunday** | `date_trunc('week', d)` truncates to **Monday** | ❌ | manual Sunday snap + `strftime` |
| `makedate(y,m,d)` | string; **rolls over** | `make_date(y,m,d)` errors on invalid | ❌ | `strftime(make_date(…))` + a rollover emulation, or accept divergence |
| `maketime(h,m,s)` | string anchored at **1899-12-30** | `make_time` → TIME | ❌ | literal-prefix `'1899-12-30 ' \|\| strftime(...)` |
| `makedatetime(d,t)` | date of arg0 + clock of arg1, string | `make_timestamp` / concat | ⚠️ | expressible |
| `now()`/`today()` | **`new Date()` per row** — can straddle midnight mid-column | `now()` / `current_date` are **fixed per transaction** | ⚠️ | DuckDB's behaviour is arguably better; document the change |
| `isdate(x)` | boolean; `null` arg → **false**; number → false | `TRY_CAST(s AS DATE) IS NOT NULL` — `NULL` input → **NULL** | ❌ | `coalesce(try_cast(...) IS NOT NULL, FALSE)`, and the free-form JS fallback still diverges |
| `date`/`datetime` | normalise to a **string** | `CAST(… AS DATE)` returns a DATE | ❌ | `strftime` wrapper |

#### 5.5 Type conversion & logical

| Fn | Ordinate | Nearest DuckDB | Differs? | Translation |
|---|---|---|---|---|
| `int(x)` | number→`trunc`; bool→1/0; string→`Number()` then `trunc` — accepts **`'0x10'`→16**, **`'1e3'`→1000**, **`''`→0**; non-numeric → NULL | `CAST(x AS BIGINT)` — **rounds**, not truncates **NV**; throws on failure; `''`→error; hex → error | ❌ | `trunc(TRY_CAST(x AS DOUBLE))` — and hex/empty-string still diverge (**not reproducible**) |
| `float(x)` | `Number()`; `''`→0; `'Infinity'`→**NULL** | `TRY_CAST(x AS DOUBLE)`; `'Infinity'`→`inf` **NV** | ❌ | `TRY_CAST` + `CASE WHEN isfinite(…)` + empty-string special case |
| `str(x)` | `null`→null, else `String(x)` — number formatting is JS's | `CAST(x AS VARCHAR)` | ⚠️ | direct; float→string formatting differs (`0.1+0.2`, `1e21`) **NV** |
| `concat(...)` | **nulls → `''`**, all stringified; 0 args → `''` | `concat()` **ignores NULLs** (unlike `\|\|`) **NV** | ✅ | direct — verify DuckDB's `concat` NULL rule |
| `if(c,t,e)` | `truthy(c)` | `CASE WHEN c THEN t ELSE e END` | ⚠️ | + truthiness coercion |
| `iif(c,t,e[,unk])` | `c === null` **and** 4 args → 4th | `CASE WHEN c IS NULL THEN unk WHEN c THEN t ELSE e END` | ✅ | direct |
| `ifnull(a,b)` | `a == null ? b : a` | `ifnull` / `coalesce` | ✅ | direct |
| `isnull(x)` | boolean | `x IS NULL` | ✅ | direct |
| `coalesce(...)` | first non-null; 0 args → NULL | `coalesce` (≥1 arg required) | ⚠️ | direct; 0-arg form → `NULL` |

#### Experiments that would settle every **NV** above

Install DuckDB (`npm i @duckdb/node-api`, or the CLI) and run one script:

```sql
SELECT 1/0, 5%0, -7.5%2, '5'+1, round(-2.5), round(5.4,400), sqrt(-1), ln(0),
       power(-8,0.5), log(2,8), 17//(-5), least(NULL,5), initcap('the QUICK'),
       length('😀'), ascii(''), chr(-1), left('hello',-1), substring('hello',0,3),
       strpos('abc',''), replace('abc','','x'), str_split('a,b,c',',')[-1],
       str_split('a,b',',')[9], regexp_extract('order-42','-([0-9]+)'),
       regexp_replace('a1b2','[0-9]','#'), regexp_matches('aa','(a)\1'),
       CAST(45000 AS DATE), TRY_CAST('2024/07/28' AS DATE), TRY_CAST('7/4/2024' AS DATE),
       date_diff('year', DATE '2020-12-31', DATE '2021-01-01'),
       date_diff('week', DATE '2024-01-06', DATE '2024-01-07'),
       date_diff('hour', TIMESTAMP '2024-01-01 00:59', TIMESTAMP '2024-01-01 01:00'),
       week(DATE '2024-12-31'), dayofweek(DATE '2024-07-28'), isodow(DATE '2024-07-29'),
       date_trunc('week', DATE '2024-07-28'), monthname(DATE '2024-07-28'),
       CAST(3.9 AS BIGINT), TRY_CAST('0x10' AS BIGINT), TRY_CAST('' AS BIGINT),
       CAST('Infinity' AS DOUBLE), concat('a', NULL, 'b'), NULL AND TRUE, NOT NULL;
```
Each expression above corresponds one-to-one with an **NV** row. A single run resolves all of them.

---

### 6. Classification of all 174 test assertions

| Bucket | Count | Share |
|---|---|---|
| **(a)** DuckDB SQL reproduces it directly (possibly with a purely syntactic rewrite: name mapping, arg swap, `==`→`=`) | **114** | 66% |
| **(b)** Reproducible only with a wrapper — `TRY_CAST`, `NULLIF`, `coalesce`, domain guard, schema-aware codegen, or a hand-built expression | **45** | 26% |
| **(c)** NOT reproducible in SQL — must stay in TypeScript | **15** | 9% |

#### Bucket (a) — 114

`test-formula.ts` lines 37–47 (arithmetic/precedence, 11), 54–55 (column refs, 2), 63 (null operand, 1), 68–69 (round, 2), 74–78 (abs/floor/ceil/min/max, 5), 80–91 (string basics, concat, coalesce, if, nesting, 12), 94–101 (comparisons, 8), 104–108 (boolean ops, 5), 111–113 (literals, 3), 132/134/135/136/138/139/140/141/142/143/144/146/147/148/149/151/152/153 (number fns, 18), 156–162/164–166/167–168/172/174–175/176–179/180–182/184 (string fns, 23), 189/193/194 (type conv, 3), 220–221/223–226 (logical, 6), 229–235 (IF/THEN, 7), 238–241 (CASE, 4), 244–247 (IN, 4).

Caveat: several of these pass *only because the test data is benign*. `ev('5 > 3')` is bucket (a); `ev('x > 5', {x:null})` — untested — is not. The suite under-tests NULL operands in comparisons and boolean ops, so bucket (a) is optimistic relative to real user data.

#### Bucket (b) — 45

| Lines | Assertions | Wrapper required |
|---|---|---|
| 50, 51 | div/mod by zero → null (2) | `NULLIF(divisor, 0)` |
| 56 | unknown column → null (1) | TS-side ref resolution → `NULL` literal (SQL would raise a binder error) |
| 64, 65 | non-numeric / numeric-string operand → null (2) | schema-aware codegen — the **inverse** of DuckDB's coercion |
| 72, 73 | `round(x, 400)` → no NaN (2) | clamp digits in the emitter |
| 79 | `min(x,5)` with null (1) | verify `least` NULL rule; `coalesce`/`list_min` |
| 133, 137, 145, 150 | `sqrt(-1)`, `ln(0)`, `div(1,0)`, `zn('abc')` (4) | domain guards / `NULLIF` / `TRY_CAST` |
| 163, 169, 170, 171, 173, 183, 185, 186 | `proper`, `find` w/ start, `findnth` ×2, `replace` empty needle, `regexp_extract` group-1 fallback, `regexp_replace` global, invalid regex (8) | hand-built expressions; invalid-regex only works for **literal** patterns pre-validated in TS |
| 190, 191, 192 | `int('42')`, `int('abc')`, `float('3.14')` (3) | `TRY_CAST` |
| 197–217 | **all 21 date assertions** | every one needs at least a text→DATE cast, and most need `strftime` to return text; `datepart('weekday')` needs `+1`, `week` needs a Sunday-start rebuild |
| 222 | `iif` unknown branch (1) | `CASE WHEN c IS NULL THEN …` |

#### Bucket (c) — 15, listed explicitly

These are the ones that decide the architecture. **Every one is about `compile()`'s contract, not about evaluating a row.**

| # | Line | Assertion | Why SQL can't do it |
|---|---|---|---|
| 1 | `scripts/test-formula.ts:57` | `compile exposes refs` — `compile('a + [b c] + round(d)').fn.refs` contains `a`, `b c`, `d` | `refs` is a **parser artefact**. `transforms.ts:217-220` uses it to warn about unknown columns *before* evaluation. DuckDB has no "give me the identifiers in this expression string" API short of parsing it yourself — which is exactly the thing you were trying to delete. |
| 2 | `:120` | `empty expression → error` | `compile('   ')` must return `{ok:false,'Empty expression'}`. Sending `""` to DuckDB is a SQL syntax error at query time, in a different place, with a different shape. |
| 3 | `:121` | `dangling operator → error` (`1 +`) | Error must arrive from `compile`, not from executing a query. |
| 4 | `:122` | `unbalanced paren → error` (`(1 + 2`) | ditto |
| 5 | `:123` | `unknown function → error` (`frobnicate(1)`) | Ordinate's function set is a **closed vocabulary of 82**. Passing through to DuckDB opens the door to DuckDB's several-hundred-function surface — including `read_csv`, `read_blob`, and file/URL access. This is a security regression, not a naming issue. |
| 6 | `:124` | `unterminated string → error` (`'oops`) | ditto |
| 7 | `:126` | **injection: `1; process.exit(1)` → error** | The `;` is rejected by the tokenizer at `src/formula.ts:186`. In SQL, `;` is a **statement separator**. A user expression reaching DuckDB unparsed is a multi-statement injection: `1; ATTACH '…'; COPY … TO '/tmp/x'`. |
| 8 | `:127` | **injection: `process.exit(1)` (member access `.`) → error** | `.` is rejected at `:186`. In SQL `.` is schema/table qualification — `main.read_csv(...)`. |
| 9 | `:128` | **injection: `` `${1}` `` → error** | backtick rejected at `:186`; DuckDB uses backticks as an identifier quote. |
| 10 | `:129` | **injection: trailing garbage `1 2 3` → error** | `parse()` at `:770-772` requires all tokens consumed. |
| 11 | `:250` | `IF x > 0 THEN 1` (no `END`) → error | keyword-form validation lives in `parseIf` (`:995`). DuckDB's `CASE` grammar is different; the error would be about `CASE`, not `IF`. |
| 12 | `:251` | `IF x > 0 1 END` (no `THEN`) → error | ditto |
| 13 | `:252` | `CASE x END` (no `WHEN`) → error | explicit check at `:1013` |
| 14 | `:260` | **`source contains no eval(`** | A static assertion about `src/formula.ts` itself (read from disk at `:258`). |
| 15 | `:261` | **`source contains no new Function`** | ditto |

The last two deserve emphasis. They encode the project's stated security principle (`src/formula.ts:6-12`, CLAUDE.md "no `eval`") in a *testable* form. Their SQL analogue is "no user string is ever interpolated into SQL text" — which can only be guaranteed by an AST→SQL emitter, i.e. by **keeping the tokenizer and parser**.

**The shape of the answer:** bucket (c) contains **zero evaluation semantics**. Every per-row behaviour is (a) or (b). The parts that can't move are the front end — tokenizer, parser, closed function vocabulary, `refs` extraction, structured errors.

---

### 7. Recommendation

**Hybrid, and specifically: keep the entire front end in TypeScript, and move only the evaluator — via an AST→SQL emitter — behind a per-expression fallback to the existing tree-walker.**

Concretely:

1. **Keep `tokenize` + `Parser` unchanged** (`src/formula.ts:85-190`, `:759-1043` — roughly 350 lines). The 15 bucket-(c) assertions all live here, four of them are anti-injection tests, and two are static guarantees about the source. Handing a user or AI-authored string to DuckDB is a **SQL injection surface** (`;`, `.`, backtick, and DuckDB's `read_csv`/`ATTACH`/`COPY` are all reachable) — an unambiguous regression against a project whose core promise is "no surprise network calls, no telemetry". The parser is also the only thing that can produce `refs`, which `transforms.ts:217-220` needs.

2. **Change `Parser` to build an AST instead of closures.** Today it builds `EvalFn` closures directly (`:818`, `:830`, `:870`, `:881`…). An AST is the enabling refactor: it gives you two back ends from one front end — the existing tree-walker (for conformance and fallback) and a new `astToSql(node, schema): string | null` emitter.

3. **The emitter returns `null` for anything it can't translate faithfully**, and `transforms.ts` falls back to the row-loop for that expression. From §6 the emitter can cover ~66% of assertions directly and another ~26% with wrappers, but the wrappers are the whole cost.

**Why not full translation.** The gap is not a long tail of exotic functions; it is that **Ordinate's core semantics are the negation of SQL's**:

- **NULL-instead-of-error is pervasive and load-bearing.** Nine wrapper sites (`NULLIF`, `TRY_CAST`, `isfinite`, domain guards) just to get `5/0`, `sqrt(-1)`, `ln(0)`, `int('abc')` to yield NULL. Each is a place a future DuckDB version can change behaviour under you.
- **Two-valued vs three-valued logic inverts every boolean.** `NULL AND TRUE` → `false` here, `NULL` there. `null = null` → `true` here, `NULL` there. `x > 5` with NULL → `false` here, `NULL` there. Every comparison and every logical operator needs a `coalesce(..., FALSE)` wrapper, and `truthy()`'s string rule (`"false"` is truthy, `""` is falsy) has no SQL analogue at all — it can only be emitted when the operand's static type is known.
- **The non-coercion rule is a semantic inversion, not a translation.** `'5' * 2` must be `NULL`; DuckDB is believed to produce `10`. The only way to reproduce it is schema-aware codegen that constant-folds arithmetic on text columns to `NULL` — which means the emitter needs the dataset schema and must be re-run whenever a column is retyped.
- **Return-type polymorphism is not expressible.** `min(1,'a')` → `"1"`, `max(1,'a')` → `"a"` (verified). A SQL scalar expression has one type. `datename` returns a name or a stringified number depending on the part. `IF … THEN 1 ELSE 'small' END` is legal here and gets silently unified in DuckDB.
- **Dates are text with a JS-`Date` escape hatch.** `date('July 4, 2024')` works because of `new Date(s)` at `src/formula.ts:249`. That is an unbounded, engine-defined format surface with no SQL equivalent. And `date('2024-13-45')` → `'2025-02-14'` — JS rolls over, `make_date` raises. Every date function also has to `strftime` back to text because there is no date type.
- **Regex flavour is a hard wall.** JS `RegExp` supports backreferences and lookbehind (both verified working); RE2 rejects them outright. A saved calculated field using `(?<=x)` or `\1` would go from working to erroring.
- **`len` on non-BMP text.** `len('😀')` = 2 (UTF-16 units); `length('😀')` = 1 (characters). There is no DuckDB function that counts UTF-16 code units. This one is genuinely not reproducible.
- **The output-typing pass is not an expression at all.** `retypeColumn` (`src/transforms.ts:130-135`) inspects the *whole produced column* to decide `text`/`number`/`date` and then re-coerces. Booleans become the strings `"true"`/`"false"` only because of this. That is a second pass over the result, and it is what protects `"005"` from becoming `5` — the same protection landmine 6.1 is about. It stays in TypeScript regardless of where the expression runs.

**Why not stay purely in TypeScript either.** The 114 bucket-(a) assertions are real: plain arithmetic, comparisons, `IF`/`CASE`/`IN`, and most string functions map cleanly. Those are also the expressions users actually write — the AI prompt at `src/analyze.ts:781-784` advertises exactly 13 functions, and 12 of the 13 (`round, abs, floor, ceil, min, max, lower, upper, trim, len, concat, if, coalesce`) are bucket (a) or a one-line wrapper. Pushing those into DuckDB gets the calculated field evaluated inside the same scan as the filter and the aggregate, with no per-row `Record<string, FValue>` allocation (`src/transforms.ts:227-228` allocates one object *per row, per calculated field*). That is where the win is, and it is available without touching the hard cases.

**Honest bottom line:** the formula layer **cannot** move to SQL wholesale, and attempting a faithful full translation would produce a mapping layer larger and more fragile than the 1,043 lines it replaces — every wrapper is a place where a DuckDB version bump silently changes a user's saved calculated field. But the *common* expressions translate cleanly. Build the AST, emit SQL for what you can prove is faithful, fall back to the tree-walker for the rest, and **run `scripts/test-formula.ts` against both back ends** — with the 15 bucket-(c) assertions permanently pinned to the TypeScript path.

**Suggested sequencing:** (1) refactor `Parser` to emit an AST and re-point the existing evaluator at it — behaviour-neutral, all 174 assertions must still pass; (2) run the NV experiment script in §5 and fill in the real DuckDB column; (3) write `astToSql` covering only the verified-identical subset, with a `null` return for everything else; (4) add a differential test that evaluates every expression in the suite through **both** back ends and asserts equality.agentId: a14000eb24ddfd767 (use SendMessage with to: 'a14000eb24ddfd767', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 124014
tool_uses: 22
duration_ms: 585469</usage>