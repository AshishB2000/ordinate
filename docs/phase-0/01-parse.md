## parse.ts

**Scope:** `src/parse.ts` (361 lines), its self-check `scripts/test-parse.ts` → compiled sibling `scripts/test-parse.js` (54 assertions), and `src/parseXlsx.ts` as a consumer of `finalizeTable`.

**Method note:** every "actual behaviour" claim below that is not covered by a test assertion was verified empirically by `require`-ing the compiled `src/parse.js` in plain Node and printing real return values. DuckDB is **not installed** in this repo (`which duckdb` → not found; no `duckdb` in `node_modules`; not in `package.json`), so every DuckDB claim in §5 is either (a) high-confidence from the documented option surface, or (b) explicitly marked **NEEDS VERIFICATION** with the experiment that settles it. Nothing about DuckDB was verified by execution.

---

### 1. Exported API surface

Six runtime exports and three types. Verified at runtime: `Object.keys(require('./src/parse.js'))` → `['parseCsv','parseJson','parsePaste','detectColumnType','finalizeTable','coerceValue']`.

#### Types (`src/parse.ts:16-29`)

```ts
export type ColumnType = 'text' | 'number' | 'date';

export interface ParsedColumn {
  name: string;
  type: ColumnType;
}

export interface ParseResult {
  columns: ParsedColumn[];
  rows: (string | number | null)[][]; // parallel to columns; number when the column is numeric
  rowCount: number;                   // rows.length (post-cap; see MAX_ROWS)
  sheetNames?: string[];              // xlsx only
  warnings: string[];                 // human-readable, never throws
}
```

`ParseResult.rows` is the **cell union**: `string | number | null`. There is no boolean and no date object — dates are stored as the **original string**, losslessly. This is the pinned wire shape that `datasets.ts`, `transforms.ts`, `vizData.ts`, `metricValue.ts`, `datasetStats.ts` and every dashboard/visual consumer depends on.

`sheetNames` is populated **only** by `src/parseXlsx.ts:83`, never by `parse.ts` itself.

#### Functions

| Export | Signature | Line | Returns |
|---|---|---|---|
| `parseCsv` | `(text: string, delimiter: string = ',') => ParseResult` | `parse.ts:42` | Full result; also the TSV path (`delimiter='\t'`) |
| `parseJson` | `(text: string) => ParseResult` | `parse.ts:54` | Array-of-objects, 2D array, or bare object |
| `parsePaste` | `(text: string) => ParseResult` | `parse.ts:68` | JSON-first, then delimiter sniff (`\t` vs `,`) |
| `detectColumnType` | `(cells: string[]) => ColumnType` | `parse.ts:89` | `'text' \| 'number' \| 'date'` |
| `finalizeTable` | `(header: string[], body: string[][]) => ParseResult` | `parse.ts:101` | Shared tail; thin wrapper over internal `finalize` |
| `coerceValue` | `(value: string \| number \| null, type: ColumnType) => string \| number \| null` | `parse.ts:236` | Re-coerce a **stored** cell on a retype |

**Non-exported but load-bearing:** `MAX_ROWS = 50_000` (`parse.ts:36`), `isFiniteNumber` (`parse.ts:321`), `looksLikeDate` (`parse.ts:333`), `coerceCell` (`parse.ts:218`), `splitCsvRecords` (`parse.ts:110`), `finalize` (`parse.ts:185`).

**No function in this module ever throws.** Every failure path returns `emptyResult(warning)` (`parse.ts:358`) or pushes to `warnings`.

**Consumers (blast radius):** `src/parseXlsx.ts:82`, `src/connectionRun.ts:147,205`, `src/captureDataset.ts:58,78,85,133`, `src/datasets.ts:351`, `src/ipc/datasets.ts:109,167`; type-only imports in `transforms.ts`, `datasetStats.ts`, `anomalies.ts`, `vizData.ts`, `metricValue.ts`.

---

### 2. Behavioural rules encoded by the test suite

54 assertions, 14 named rules. Line references are `scripts/test-parse.ts:LINE`.

**R-PARSE-01 — RFC-4180 quoting is honoured: quoted delimiters, quoted newlines, and `""` escapes all resolve inside a single field.**
Assertions `:22-27`. Input `'name,note\n"Smith, John","line1\nline2"\n"Jane","She said ""hi"""'` → `rowCount === 2`; `rows[0][0] === 'Smith, John'`; `rows[0][1] === 'line1\nline2'`; `rows[1][1] === 'She said "hi"'`; zero warnings.

**R-PARSE-02 — CRLF is a record separator; a trailing newline produces no phantom row.**
Assertions `:34-37`. `'a,b\r\n1,2\r\n3,4\r\n'` → 2 rows, both columns `number`. Mechanism: `parse.ts:154-158`, `parse.ts:173-174`.

**R-PARSE-03 — Ragged rows are repaired to header width, never rejected: short rows padded, long rows truncated, one warning.**
Assertions `:44-47`. `'a,b,c\n1,2\n3,4,5,6'` → every row length 3; `rows[0][2] === null`; `rows[1] === [3,4,5]` (the `6` is **discarded**, `parse.ts:200`); warning `Ragged rows — padded to 3 columns` (`parse.ts:203`). **This is data loss by design.**

**R-PARSE-04 — Empty or whitespace-only input yields a zero-column, zero-row result with an `'Empty file'` warning, not an error.** Assertions `:53-58`. Gate is `text.trim() === ''` (`parse.ts:43`).

**R-PARSE-05 — JSON array-of-objects: columns are the union of keys in first-seen order; a key missing from a row becomes `null`.**
Assertions `:64-67,71,75`. `'[{"a":1},{"b":2,"a":3}]'` → columns `a,b` — first-seen, **not** sorted (`parse.ts:260-269`). A bare object becomes a one-row table (`parse.ts:247-248`).

**R-PARSE-06 — JSON 2D array: the first row is a header only if every cell is a non-numeric string; otherwise names are synthesized `col1..colN` with a warning.**
Assertions `:81-88`. Predicate `first.every(c => typeof c === 'string' && !isFiniteNumber(c))` (`parse.ts:284`). Note the coupling: **header detection depends on `isFiniteNumber`** — `[["007","y"],…]` IS treated as a header row.

**R-PARSE-07 — Malformed JSON returns a warning, never a throw.** Assertion `:91` → `'Could not parse as JSON or delimited text'` (`parse.ts:60`).

**R-PARSE-08 — Column-width detection for a headerless 2D array uses a loop, not argument spread, so a 70k-element array does not `RangeError`.** Assertions `:98,99`. Guarded by the comment at `parse.ts:292-296`.

**R-PARSE-09 — Paste auto-detect: valid JSON wins; otherwise the delimiter is chosen by counting `\t` vs `,` on the first non-empty line, `,` as tie-break.**
Assertions `:105-112`. `tabs > commas ? '\t' : ','` (`parse.ts:81`). Only two delimiters are ever considered; `;` and `|` are **not** candidates.

**R-PARSE-10 — A bare JSON scalar is not tabular: it falls through to the delimited path.**
Assertions `:118,122`. `parsePaste('42')` → 1 column named `"42"`, 0 rows. Gate at `parse.ts:72`.

**R-PARSE-11 — Column typing is all-or-nothing over non-empty cells: `number` if every non-empty cell is strictly numeric, else `date` if every non-empty cell looks like a date, else `text`. An all-empty column is `text`.**
Assertions `:127-134`.

| Input | Result |
|---|---|
| `['1','2','3.5','-4']` | `number` |
| `['2024-01-01','2023/12/31']` | `date` |
| `['2024-01-01','01/15/2024']` | `date` |
| `['1','apple','2']` | `text` (**one** offender demotes the column) |
| `['1','','3']` | `number` (empties ignored) |
| `['','','']` | `text` |

There is **no majority/threshold rule and no per-cell fallback**.

**R-PARSE-12 — A bare integer is a number, not a date.** Assertion `:133`. Two guards: `parse.ts:336` and the `number`-before-`date` ordering at `parse.ts:92-93`.

**R-PARSE-13 — Identifier preservation: leading-zero values, zip codes, and >15-significant-digit ids stay `text` and keep their exact original string.** *(Invariant 6 of the brief.)*
Assertions `:136-143`. `['007','012','049']` → `text`; `['12345678901234567890',…]` → `text`; `['02139','10001','90210']` → `text`; `['1.50','2.25','3']` → `number`; and end-to-end `parseCsv('code\n007\n012')` → type `text`, cell `'007'`.

> **Pre-existing gap:** the zip column is text because of `'02139'` alone. `'90210'` in isolation is a `number` (verified). Zip protection is **incidental** — a column of only West Coast zips (`90210,94103,98101`) types as `number`. Untested. Raise in Phase 1 rather than faithfully reproducing.

**R-PARSE-14 — Output is capped at 50,000 rows with a warning; `rowCount` is the post-cap count.**
Assertions `:152,153`. Warning `Row cap reached — kept first 50000 of 50005 rows` (`parse.ts:192`). The cap trims **output**, not peak memory — the real anti-OOM guard is `MAX_FILE_BYTES = 100MB` at `src/ipc/datasets.ts:31`.

---

### 3. Type detection in full

#### 3.1 `isFiniteNumber` (`parse.ts:321-331`) — the gate

```ts
function isFiniteNumber(s: string): boolean {
  const t = String(s).trim();
  if (t === '') return false;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return false;
  if (/^[+-]?0\d/.test(t)) return false;                     // 007 is an identifier
  if (t.replace(/[^\d]/g, '').length > 15) return false;     // can't round-trip a double
  return Number.isFinite(Number(t));
}
```

Four sequential gates: **trim → strict literal regex → leading-zero veto → digit-count veto → finite check.**

| Input | Result | Deciding gate | Tested? |
|---|---|---|---|
| `"12"`, `"-4"`, `"3.5"`, `"1.50"` | ✔ | — | yes |
| `"0"`, `"0.0"`, `"0.5"` | ✔ | leading-zero regex needs a digit *after* the `0` | no |
| `"+5"`, `".5"`, `"-.5"`, `"5."` | ✔ | regex alternatives | no |
| `"1e3"`, `"1E-3"`, `"1.0e2"` | ✔ | scientific accepted | partial |
| `" 12 "`, `"\t12"` | ✔ → `12` | **surrounding whitespace trimmed** | no |
| `"   "`, `""` | ✘ | empty after trim | partial |
| `"007"`, `"+007"`, `"02139"` | ✘ | leading-zero veto (covers a sign) | yes |
| `"1234567890123456"` (16 digits) | ✘ | digit-count veto | at 20 digits |
| `"123456789012345"` (15 digits) | ✔ | boundary is **>15**, inclusive at 15 | no |
| `"1.5e-10"` | ✔ | **exponent digits count toward the 15 limit** | no |
| `"1,200"`, `"1_000"`, `"$5"`, `"5%"` | ✘ | regex — no currency/percent handling anywhere | no |
| `"0x1F"`, `"0b101"`, `"Infinity"`, `"NaN"` | ✘ | regex | no |
| `"1e400"` | ✘ | `Number()` → `Infinity` | no |
| `"1e-400"` | ✔ → **`0`** | underflows silently | no — **precision landmine** |
| `"true"`, `"false"`, `"null"` | ✘ | regex | no |
| `"１２３"` (fullwidth), `"٣"` | ✘ | `\d` is ASCII-only | no |

**Precision boundary:** integers up to 15 digits are numbers; 16+ are text. `MAX_SAFE_INTEGER` is 16 digits, so the rule is **conservative by one digit**, deliberately. `1e-400 → 0` is the one silent lossy path in an otherwise lossless design.

#### 3.2 `looksLikeDate` (`parse.ts:333-343`) — the fallback, and where it misbehaves

```ts
function looksLikeDate(s: string): boolean {
  const t = String(s).trim();
  if (t === '') return false;
  if (isFiniteNumber(t)) return false;                       // "2024" is a number
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t)) return true;
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(t)) return true;
  if (/^[+-]?\d+$/.test(t)) return false;                    // bare all-digits is never a date
  return !Number.isNaN(Date.parse(t));                       // permissive, engine-defined
}
```

The `Date.parse` fallback at line 342 is **implementation-defined by the JS engine** and accepts far more than intended. Verified:

| Input | `detectColumnType` | Note |
|---|---|---|
| `"2024-01-01"`, `"01/15/2024"`, `"Jan 5, 2023"` | `date` | intended |
| `"2024-13-45"` | `date` | regex-matched, **never validated as a real date** |
| `"$5"`, `"5%"`, `"1.2.3"`, `"--5"`, `"1 2"`, `"abc 1"` | **`date`** | V8's lenient `Date.parse`. Untested, almost certainly unintended. |
| `"10:30"`, `"Q1 2024"`, `"March"` | `text` | |
| `"007"`, `"02139"` | `text` | guarded by line 341 — load-bearing |

**Consequence (verified, untested):** a currency column `$5 / $6` types as `date`. Cell *values* survive intact (date columns store the original string), so nothing is corrupted — but the column type is wrong, and that propagates into `datasetStats`, `SHAPE_CHARTS` eligibility, and `vizData`.

#### 3.3 `coerceCell` / `coerceValue` (`parse.ts:218-239`)

```ts
function coerceCell(cell: string, type: ColumnType): string | number | null {
  if (cell == null || cell === '') return null;
  if (type === 'number') return isFiniteNumber(cell) ? Number(cell) : null;
  return cell; // text and date stay as the original string (lossless)
}
```

- `''` → `null` for **every** type. There is no empty-string cell in a `ParseResult`, only `null`.
- Whitespace-only `"   "` is **not** `''`, so it takes the type branch: `number` → `null`; `text`/`date` → preserved verbatim.
- `text`/`date` cells are **never trimmed**. Verified: `parseCsv('a\n  hi  \nbye')` → `[["  hi  "],["bye"]]`.
- Coercion re-runs the **strict** gate rather than trusting detection (`parse.ts:221-225`): on a manual retype `'007'` → `null`, not `7`.
- `coerceValue` stringifies first, so `coerceValue(7,'text') === "7"`. **Number→text is not round-trip safe**: `1e-7` → `"1e-7"`.

#### 3.4 Column naming (`parse.ts:188`)

```ts
const names = header.map((h, i) => (h && h.trim() ? h.trim() : `col${i + 1}`));
```

- Header names are **trimmed**. Empty cells become `col1`-based, **1-indexed**.
- **Duplicate names are preserved, not deduplicated** (`a,a` → two columns named `a`). Untested; downstream code addresses by index.
- **BOM is stripped by accident**: `trim()` treats U+FEFF as whitespace. Verified: `parseCsv('﻿id,b\n007,2').columns[0].name === 'id'`. Load-bearing, undocumented — must be reproduced deliberately.

---

### 4. CSV tokenizer semantics (`splitCsvRecords`, `parse.ts:110-177`)

A hand-written character-by-character state machine with a single `inQuotes` flag.

| Aspect | Behaviour | Verified |
|---|---|---|
| Quoted fields / `""` escapes / embedded newlines | RFC-4180 | tested |
| CRLF, lone CR (old Mac), mixed line endings | all record separators | tested / verified |
| Trailing newline | final `['']` popped | tested |
| **Delimiter detection** | **None.** Explicit param, default `,`. A semicolon CSV parses as **one column**. | verified |
| Header | always `records[0]`; **no header-vs-data heuristic** for CSV | implicit |
| Header-only file | 2 text columns, 0 rows, warning `'No rows found'` | verified |
| **Blank line mid-file** | 1-field record → padded → **a row of nulls + a ragged warning**. Blank lines are **not** skipped. | verified |
| BOM | incidentally stripped by the header `trim()` | verified |
| **Unterminated quote** | silently swallows the rest of the file. **No error, no warning.** | verified |
| Quote mid-unquoted-field | `x"y"z` → `xyz` — quotes consumed as mode toggles | verified |
| Quoted empty `""` | → `''` → `null`. **Indistinguishable from unquoted empty.** | verified |
| **Quoting does not affect typing** | `"1200"` → number `1200`; `"007"` → text. Quoting a number does **not** force it to text. | verified — **relevant to §5** |
| Encoding | UTF-8 only (`src/ipc/datasets.ts:108`); no detection | out of module |

---

### 5. DUCKDB BREAKAGE LIST

**Confidence statement.** DuckDB is not installed here; nothing below was executed. Items where the outcome depends on sniffer internals or version are marked **NEEDS VERIFICATION** with the settling experiment.

**The proposed mitigation, stated precisely:** ingest via `read_csv(path, all_varchar = true, header = …)` so DuckDB performs **zero** type inference, then run the *existing* `detectColumnType`/`isFiniteNumber`/`coerceCell` logic over the VARCHAR columns. "Mitigation sufficient?" asks whether that specific plan restores current behaviour.

#### 5.1 Type-detection rules

| Rule | Current | DuckDB default | Breaks? | Mitigation |
|---|---|---|---|---|
| **R-PARSE-13a** leading zeros | `007` → `text`, cell `'007'` | Sniffer types BIGINT; `007` → `7`. **NEEDS VERIFICATION** — recent sniffers may reject leading-zero integer candidates. `SELECT typeof(c), c FROM read_csv('code\n007\n012')` | **YES — critical** | `all_varchar=true`. **Sufficient.** |
| **R-PARSE-13b** zips | text via the `02139` leading zero | same | **YES** | Sufficient. But the **pre-existing gap** (all-non-leading-zero zips already type as `number`) must be decided explicitly, not silently "fixed". |
| **R-PARSE-13c** >15-digit ids | 16+ digits → `text`, exact string | 20 digits exceeds BIGINT → likely DOUBLE with precision loss, possibly VARCHAR. **NEEDS VERIFICATION** | **YES if DOUBLE** | Sufficient. Also re-apply the >15-digit rule at the **IPC/serialization boundary** — a DuckDB HUGEINT has more precision than the JS number the renderer receives. |
| **R-PARSE-11** all-or-nothing typing | one `'apple'` → whole column `text`, every value preserved | sniffer fits the sample; `ignore_errors=true` nulls the offender or drops the row; otherwise a **cast error mid-scan** | **YES — silent data loss** | Sufficient. Do **not** substitute per-cell `TRY_CAST` — that reproduces DuckDB's null-the-offender semantics, the *opposite* of the rule. |
| **R-PARSE-11b** sample size | all rows (≤50k) inspected | first `sample_size` rows (default 20480) | **YES** | Sufficient — `all_varchar` bypasses sniffing entirely. |
| whitespace trimmed (`' 12 '` → `12`) | number | unquoted whitespace not trimmed; cast error | **YES** | Sufficient |
| `1e400` → text / `1e-400` → `0` | as stated | DOUBLE → `inf` / `0` | YES / NO | Sufficient; `1e-400` is a pre-existing lossy path to decide on |
| `"true"`/`"false"` | `text` | sniffs BOOLEAN | **YES** — `ParseResult` has **no boolean cell type** | Sufficient for ingest; if DuckDB later *stores* the table, BOOLEAN must project back to `string\|number\|null` |
| **`looksLikeDate`'s `Date.parse` fallback** | `'$5'`, `'5%'`, `'1.2.3'` type as `date` | all VARCHAR | **YES — in the direction of "DuckDB is more correct"** | Covered **only if the exact JS function, including the V8 fallback, is ported verbatim.** Rewriting it as `TRY_CAST(x AS DATE)` changes results on real user data. **This is the rule the mitigation most easily gets wrong.** |
| `'2024-13-45'` → `date` | regex only, never validated | `TRY_CAST` → NULL → VARCHAR | **YES** | Sufficient only with literal regex porting |
| date cells stored losslessly (`'  2024-02-02  '`) | original string kept | DATE normalizes; original text gone | **YES** | Sufficient under `all_varchar` |

#### 5.2 CSV tokenizer rules

| Rule | Current | DuckDB default | Breaks? | Mitigation |
|---|---|---|---|---|
| R-PARSE-01/02 quoting, CRLF | RFC-4180 | RFC-4180 | NO | genuine simplification |
| Lone `\r` | record separator | **NEEDS VERIFICATION** — may be data | Possibly | Not covered by `all_varchar` |
| **R-PARSE-03 ragged rows** | pad short / **truncate long**, warn, never fail | default: **error**. `null_padding=true` pads short; **there is no truncate mode for long rows**; `ignore_errors=true` likely **drops the row**. **NEEDS VERIFICATION** | **YES — critical** | **`all_varchar` does NOT cover this.** Needs `null_padding=true` + a row-drop check + a synthesized warning (text asserted at `:47`). If long rows are dropped rather than truncated, the mitigation misses a real regression. |
| Blank line mid-file | row of nulls + warning | skipped | **YES — row count differs** | Not covered. DuckDB is arguably better; must be an explicit decision — `rowCount` is asserted throughout the suite. |
| Unterminated quote | silent swallow | errors | **YES** | Not covered. DuckDB is better; decide explicitly. |
| Quote mid-unquoted-field | `x"y"z` → `xyz` | likely preserved literally. **NEEDS VERIFICATION** | **YES — cell values differ** | Not covered |
| **Quoted `""` vs unquoted empty** | both → `null` | **DuckDB distinguishes**: unquoted → NULL, `""` → `''` | **YES** | **Not covered by `all_varchar`.** Must post-process `''` → `null`, else `ParseResult` gains empty-string cells it has never contained and every downstream null check breaks. **High-priority, easy to miss.** |
| **Column naming** | `col1`, **1-indexed**; duplicates preserved; header trimmed | `column0`, **0-indexed**; duplicates → `a_1`; spaces likely kept | **YES** | Not covered. Must re-apply. **Saved visuals and dashboards reference columns by name — a rename silently breaks every existing project.** |
| Delimiter policy | never sniffs `;`/`\|` | sniffs four candidates | **YES — column count differs** | Pass `delim` explicitly. Preserves a *worse* behaviour on European CSVs — a product decision. |
| R-PARSE-09 paste sniff | `\t` vs `,`, tie → `,` | different algorithm | **YES** | Keep the 5-line JS sniff, pass the result as `delim` |
| Header | always row 0 | auto-detected | **YES** | Pass `header=true`. Sufficient. |
| **R-PARSE-14 50k cap + "of N" warning** | clamped, warning names the true total | no cap | **YES** | `LIMIT 50000` **cannot** produce N — needs a second count query or `LIMIT 50001` + sentinel |
| R-PARSE-04 empty file | `'Empty file'` warning | error or empty relation | **YES** | Guard before handing the file to DuckDB |
| 100 MB byte ceiling | `stat()` before `readFile` | DuckDB streams from disk — **the guard is bypassed** | **YES (policy)** | Must be re-sited |

#### 5.3 JSON rules

| Rule | Current | DuckDB | Breaks? | Mitigation |
|---|---|---|---|---|
| R-PARSE-05 first-seen key order | `[{"a":1},{"b":2,"a":3}]` → `a,b` | schema unified; **key order not guaranteed first-seen**. **NEEDS VERIFICATION** | Possibly | `all_varchar` is CSV-only. **Not automatically covered** — column order affects every saved visual's encoding. |
| Nested values | `String(v)` → `"[object Object]"`; `[1,2]` → `"1,2"` (which then types as **`date`**) | STRUCT / LIST preserved | **YES** | Current behaviour should probably be *improved* — but deliberately, with a test |
| JSON booleans/nulls | `true` → `"true"` (text) | BOOLEAN | **YES** | as above |
| Large JSON numbers | lossy at `JSON.parse`, then text | parsed exactly | **Different value** — DuckDB is *more* accurate | Strict improvement; breaks any golden-file test |
| R-PARSE-06 2D header heuristic | as specified | no equivalent | **YES** | Keep in JS |
| R-PARSE-07 invalid JSON → warning | warning | throws | **YES** | Wrap |
| R-PARSE-10 bare scalar → CSV path | 1 column named `"42"` | n/a | NO | Keep the JS dispatcher |

#### 5.4 Rules the stated mitigation does NOT cover — the short list for Phase 1

`all_varchar=true` + re-applying the type rules solves the **typing** half cleanly. It does **not** touch:

1. **Ragged-row repair** — DuckDB errors or drops; current pads *and truncates*. No DuckDB option truncates. **Highest risk.**
2. **Quoted-`""` vs unquoted-empty** — DuckDB keeps them distinct; `ParseResult` has never contained `''`.
3. **Column naming** — `col1` 1-indexed vs `column0`; duplicate preservation vs `_1`; header trimming. **Breaks saved visuals/dashboards.**
4. **50k row cap + the "of N" warning text.**
5. **Delimiter policy** — DuckDB sniffs `;` and `|`.
6. **Blank lines mid-file.**
7. **Unterminated quotes.**
8. **JSON nesting, key order, booleans** — `all_varchar` is CSV-only.
9. **`looksLikeDate`'s `Date.parse` fallback** — covered only if ported verbatim.
10. **The 100 MB byte ceiling** — bypassed once DuckDB reads the path directly.

---

### 6. Open questions and risks for Phase 1

1. **Fix or freeze the `looksLikeDate` fallback?** `$5`/`5%` typing as `date` is almost certainly a bug, but it is *current behaviour on real user data*. **Recommendation: freeze for the port (keep the JS function), fix separately with its own test.**
2. **Fix or freeze the zip-code gap?** `['90210','94103','98101']` types as `number` today. The test at `:138` passes either way while real behaviour shifts.
3. **Does `rowCount` mean "rows in the file" or "rows we kept"?** Currently post-cap (`parse.ts:215`); blank-line handling changes it too. Pin before writing SQL.
4. **Where does the 15-digit rule live once DuckDB holds HUGEINT/DECIMAL?** The rule exists because a JS number is a double — enforce it at the **serialization boundary**, not only at ingest.
5. **What replaces the `string | number | null` cell union?** Arrow gives real BOOLEAN, DATE, DECIMAL. Widening it is a breaking change to `transforms.ts`, `formula.ts` ("dates are text cells"), `vizData.ts`, and every export path.

**Verification experiments (≈30 minutes, settles most of §5):**

```sql
SELECT typeof(c), c FROM read_csv('code\n007\n012');
SELECT typeof(c), c::VARCHAR FROM read_csv('id\n12345678901234567890');
FROM read_csv('a,b,c\n1,2\n3,4,5,6', null_padding=true, ignore_errors=true);
SELECT a IS NULL, b IS NULL FROM read_csv('a,b\n"",', all_varchar=true);
DESCRIBE FROM read_csv('a,,c\n1,2,3', all_varchar=true);
DESCRIBE FROM read_csv('a,a\n1,2', all_varchar=true);
FROM read_csv('a,b\r1,2\r3,4');  FROM read_csv('a,b\n1,2\n\n3,4');  FROM read_csv('a,b\n"unclosed,2');
SELECT * FROM read_json_auto('[{"a":1},{"b":2,"a":3}]');
```

**Test-suite strategy.** R-PARSE-01/02/05/06/07/08/09/10/11/12/13/14 should pass **verbatim** — they are pure input→output over the public API and say nothing about the engine. R-PARSE-03 (ragged) and R-PARSE-04 (empty file) are the two that need rewording if DuckDB's error semantics are adopted. Treat any *other* verbatim failure as a real regression.

**Recommended structure.** Keep `parse.ts`'s type-detection layer (`isFiniteNumber`, `looksLikeDate`, `detectColumnType`, `coerceCell`/`coerceValue`, the naming rule, the ragged fix — roughly `parse.ts:185-343`) as **pure TypeScript operating on VARCHAR columns after ingest**. Replace only the tokenizer (`splitCsvRecords`) and the JSON shaping with DuckDB. That is the smallest change satisfying invariant 6, it keeps `scripts/test-parse.js` meaningful, and it confines DuckDB to reading bytes rather than deciding what they mean.
