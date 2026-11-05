# Semantic layer part 8, step 02: the formula parser over a builder — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The formula parser builds through a small builder interface, so step 03 can add a SQL back end to the same grammar. The JS builder is today's closures moved verbatim. Every Prepare formula, LOD field and metric formula computes exactly as before, which a 5,000-expression golden proves. The golden is recorded on today's parser **before** anything changes.
**Architecture:** `Parser` becomes `Parser<T>` over `FormulaBuilder<T>`. The grammar, the token positions, the `refs` set, the LOD bookkeeping (`@lod:<n>` keys, `nested`, `cost`, spans) and every error message stay in the parser. Each place that today builds a closure calls one builder method instead. `src/formula/formulaJs.ts` holds those closures, cut and pasted. `compile` and `compileTokens` keep their signatures and outputs.
**Tech Stack:** `src/formula/` (tokenizer, parser, evaluator), self-checks, `src/server/wire.ts` for the golden's encoding.
**Spec:** docs/semantic-layer/08-engine.md (D2; Tests "Refactor guard") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p8-00-index.md
**Branch and PR:** `feat/semantic-p8-02-formula-builder` off `origin/develop`. It depends on nothing; it may start before part 1 finishes. One PR, two commits that matter: Task 1 (the golden, scripts only) and Task 2 (the refactor).

## Global Constraints
- **Task 1's commit touches `scripts/` only.** `git show --stat` of it lists no `src/` file. The golden is recorded by today's `compile()` and is never re-recorded. A mismatch after Task 2 is a bug in Task 2.
- `test-formula`, `test-formulaBudget`, `test-formulaCheck`, `test-formulaDocs`, `test-lod`, `test-lod-resident`, `test-transforms`, `test-params`, `test-powerSteps` and `test-prepareServer` stay green **untouched**.
- No behaviour change, so no stored field, no contract and no sentence. No `eval` or `new Function` (lint-enforced).
- The exports other modules import stay where they are: `LodSpec`, `LodDim`, `LodKind`, `LodAgg` and `LOD_AGGS` from `formulaParse.ts` (`src/formula/lod.ts:36`, `src/ipc/lodData.ts:21`, `src/engine/lodResident.ts:28`), and `compile`, `compileTokens`, `Compiled` and `FValue` from `formula.ts`.
- Size: `formulaParse.ts` is 430 lines and drops to about 330. `formulaJs.ts` (new) is about 150 and `formulaBuilder.ts` (new) about 60. `formulaEval.ts` (625) is not touched.

## Old pods (rolling deploy and rollback)
Nothing is stored or sent differently. Pods of either version compute identical formulas, and the golden proves it.

## Review Focus
- `IN` binds once, before the comparison loop (`parseComparison`, `formulaParse.ts:161-190`). A refactor that moves it inside the loop changes `a IN (1) = TRUE`. The corpus has such cases. → Task 1
- The LOD key and `nested` flag come from the count of LODs **built so far**, nested ones first (`parseLod`, :357-407). → Task 2
- `spendCall` runs inside the call closure on every row, not at parse time (`parseCall`, :409-430). → Task 2
- The error positions (`FormulaError.tokenIndex`) are unchanged, so the editor underlines the same character: the golden records `at`. → Task 1

---

### Task 1: record today's answers (before any change)
**Files:** Create `scripts/formulaCorpus.ts` (the seeded generator and the recorder), `scripts/test-formulaGolden.ts` and `scripts/fixtures/golden/formulaCorpus.json`.
**Interfaces:** Produces
```ts
export const CORPUS_SEED = 0x5eed_0008;
export const CORPUS_SIZE = 5_000;
export const CORPUS_COLUMNS: { name: string; type: ColumnType }[]; // n, m (number), t, u (text), d (date text), "x y" (a spaced name)
export const CORPUS_ROWS: Record<string, FValue>[];                  // 8 rows
export function corpus(): string[];                                   // deterministic: the same 5,000 strings on every run
export interface Answer {
  expr: string; ok: boolean; error?: string; at?: SourceSpan; refs?: string[]; cost?: number;
  lods?: Omit<LodSpec, 'arg'>[]; values?: FValue[]; table?: FValue[];
}
export function answers(exprs?: string[]): { version: 1; rows: typeof CORPUS_ROWS; entries: Answer[] };
```
- **The generator** is a mulberry32 PRNG seeded with `CORPUS_SEED`. It builds:
  - about 3,500 well-formed trees of depth ≤ 4: every operator; `IF`/`ELSEIF`/`ELSE`/`END` and `CASE`/`WHEN`; `IN` lists; keyword case variants (`If`, `eLsE`); every `FUNCTIONS` name except `now` and `today` (the clock) with 0 to 4 arguments, wrong arities included; `[[p]]` parameters; LODs (FIXED, INCLUDE, EXCLUDE, no dimensions, a nested one, `COUNTD`); a column that doesn't exist; and literals `0`, `0.5`, `2.5`, `-2.5`, `1e21`, `''`, `' '`, `'ß'`, `'ΑΣ'`, `'2024-02-29'`;
  - about 1,000 malformed strings: a well-formed one cut at a random token, a stray token inserted, an unknown function, an unclosed `[`, `'` or `{`;
  - about 500 fixed edge cases listed in the file: `a IN (1) = TRUE`, `-[n] * [m]`, `+[n]`, `((1))`, `[x y]`, `{FIXED : SUM([n])}`.
- **The rows** cover null, `0`, `-0`, a negative, a decimal, `2^53`, `''`, whitespace, Unicode, numeric-looking text (`'007'`), each date text shape `toDate` parses (`YYYY-MM-DD`, `YYYY/M/D H:MM`, `MM/DD/YYYY`), an invalid date, and a boolean.
- **Each `Answer`:**
  - `compile(expr)`'s `ok`, `error`, `at`, `refs`, `cost`, and `lods` without `arg`;
  - `values`: `fn.evaluate(row)` per row, with every `@lod:<i>` slot set to `100 + i`;
  - `table`: `evaluateTable(fn, CORPUS_COLUMNS, rows)` (`src/formula/lod.ts:174`), only when `lods.length > 0`.
- **The run is pinned.** `process.env.TZ = 'UTC'` is the first statement of both the recorder and the test, because `toDate` parses local time. Both run in local mode: `isServerMode()` false, so regexes run without the linear engine's `l` flag.
- [ ] **Step 1: Write the failing test.** `scripts/test-formulaGolden.ts`:
  ```ts
  process.env.TZ = 'UTC';
  const golden = wire.decode(fs.readFileSync(GOLDEN, 'utf8')) as ReturnType<typeof answers>;
  ok('the corpus is the recorded one, string for string', show(corpus()) === show(golden.entries.map((e) => e.expr)));
  ok('5,000 expressions, some malformed, some with LODs, every function but now/today named', golden.entries.length === CORPUS_SIZE && golden.entries.some((e) => !e.ok) && golden.entries.some((e) => e.lods?.length) && everyFunctionNamed(golden));
  const now = answers(golden.entries.map((e) => e.expr));
  const diffs = golden.entries.flatMap((g, i) => sameAnswer(g, now.entries[i]) ? [] : [g.expr]);
  ok('every answer is identical: ok, error, at, refs, cost, lods, and every value under Object.is', diffs.length === 0, diffs.slice(0, 5).join(' | '));
  ```
  `sameAnswer` compares strings with `===`, `at` field by field, `refs` and `lods` with `stableStringify`, and `values`/`table` element by element with `Object.is`.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-formulaGolden.js` → ENOENT on `formulaCorpus.json`.
- [ ] **Step 3: Record ONCE, on today's parser.** `npm run build:ts && TZ=UTC node -e "const w=require('./src/server/wire');require('fs').writeFileSync('scripts/fixtures/golden/formulaCorpus.json',w.encode(require('./scripts/formulaCorpus.js').answers()))"`. The file is about 1 MB; check that by hand. Read ten entries by hand: one `IN … = TRUE`, one nested LOD, one malformed with its `at`, and one `round(-2.5)` reading `-2`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-formulaGolden.js` → green on today's parser. `git status` shows no change under `src/`.
- [ ] **Step 5: Commit.** `git add scripts/formulaCorpus.ts scripts/test-formulaGolden.ts scripts/fixtures/golden/formulaCorpus.json` · "Record today's answers for 5,000 seeded formulas before the parser changes"

### Task 2: the builder, the JS builder, the generic parser
**Files:** Create `src/formula/formulaBuilder.ts` and `src/formula/formulaJs.ts`. Modify `src/formula/formulaParse.ts` (every closure-building site: `parseOr` :128, `parseAnd` :140, `parseNot` :152, `parseComparison` :161, `parseAdditive` :192, `parseMultiplicative` :203, `parseUnary` :214, `parsePrimary` :230, `parseIf` :307, `parseCase` :332, `parseLod` :357, `parseCall` :409) and `src/formula/formula.ts` (`compileTokens` :112-141). Test: `scripts/test-formulaGolden.ts` § negative control.
**Interfaces:** Produces
```ts
// src/formula/formulaBuilder.ts
export type ArithOp = '+' | '-' | '*' | '/' | '%';
export type CompareOp = '=' | '==' | '!=' | '>' | '<' | '>=' | '<=';
export interface LodParts<T> { key: string; kind: LodKind; dims: LodDim[]; agg: LodAgg; arg: T; argCol: string | null; nested: boolean; cost: number; start: number; end: number }
/** One method per grammar rule. `at` is the token index an error from the builder names (FormulaError.tokenIndex). */
export interface FormulaBuilder<T> {
  num(value: number, at: number): T;
  str(value: string, at: number): T;
  bool(value: boolean, at: number): T;
  nul(at: number): T;
  param(at: number): T;                                  // an unbound [[name]]
  col(name: string, at: number): T;
  neg(e: T, at: number): T;                              // unary + builds nothing
  arith(op: ArithOp, l: T, r: T, at: number): T;
  compare(op: CompareOp, l: T, r: T, at: number): T;
  and(l: T, r: T, at: number): T;
  or(l: T, r: T, at: number): T;
  not(e: T, at: number): T;
  inList(subject: T, items: T[], at: number): T;
  ifThen(branches: { test: T; then: T }[], otherwise: T | null, at: number): T;
  caseWhen(subject: T, whens: { val: T; then: T }[], otherwise: T | null, at: number): T;
  call(name: string, args: T[], at: number): T;          // lower-cased, a FUNCTIONS key (the parser checks it)
  lod(parts: LodParts<T>, at: number): T;
}
// src/formula/formulaParse.ts
export function parseTokens<T>(tokens: Tok[], b: FormulaBuilder<T>): { root: T; refs: string[] }; // throws FormulaError, as today
// src/formula/formulaJs.ts
export function jsBuilder(): FormulaBuilder<EvalFn> & { readonly lods: LodSpec[] };
```
- `at` is the operator's token for `arith`/`compare`/`and`/`or`/`not`, and the keyword's for `IF`, `CASE`, `IN` and `{`. For `call` it is the name's token, and for a literal or a column, its own token.
- `LodSpec` stays declared in `formulaParse.ts`. `jsBuilder().lod` pushes `{ ...parts }` onto `lods` and returns `(row) => row[parts.key] ?? null`.
- `compileTokens` becomes `const b = jsBuilder(); const { root, refs } = parseTokens(tokens, b);` and uses `b.lods`. The rest of the function is unchanged.
- [ ] **Step 1: Write the failing test.** Append to `scripts/test-formulaGolden.ts`:
  ```ts
  const broken = { ...jsBuilder(), compare: (op: CompareOp, l: EvalFn, r: EvalFn) => (row: Record<string, FValue>) => l(row) === r(row) };
  const caught = golden.entries.filter((g) => g.ok && !sameValues(g, evaluateWith(g.expr, broken))).length;
  ok('NEGATIVE CONTROL: a builder whose `=` is `===` changes some recorded answers', caught > 0, String(caught));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` → tsc: `jsBuilder` and `parseTokens` do not exist.
- [ ] **Step 3: Implement.** Move each closure body into `formulaJs.ts` unchanged: the same helper calls (`arith`, `compareOp`, `looseEq`, `num`, `truthy`, `FUNCTIONS`, `spendCall`), in the same order. Then the parser calls the builder where it built the closure.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-formulaGolden.js && for t in formula formulaBudget formulaCheck formulaDocs lod lod-resident transforms params powerSteps prepareServer user-templates geoCore file-size; do node scripts/test-$t.js || break; done` → all green; `npm run lint` → 0.
- [ ] **Step 5: Commit.** `git add src/formula/formulaBuilder.ts src/formula/formulaJs.ts src/formula/formulaParse.ts src/formula/formula.ts scripts/test-formulaGolden.ts` · "Build formulas through a builder, with today's closures as the JS one"

**Existing tests that must stay green:** every `scripts/test-formula*`, test-lod, test-lod-resident, test-transforms, test-params, test-powerSteps, test-prepareServer, test-user-templates, test-geoCore, test-metrics (metric formulas go through `compileTokens`), test-file-size; web `prepare.test.tsx` and `calc.test.tsx` (unchanged replies).

**Not in this step:** the SQL builder (step 03). Typing in the parser: the JS builder stays untyped, and types live only in the SQL builder.
