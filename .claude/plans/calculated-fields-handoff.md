# Handoff: Tableau-style calculated fields

## State
- **Branch:** `feat/workspace-projects` (NOT committed — the whole workspace expansion, Weeks 6–14+16, sits here as untracked/modified files. Standing instruction: **do not commit**.)
- **Last real commit:** `200c650` (merge of #25, the TypeScript bootstrap on `main`).
- **Build:** `npm run build:ts` = 0 errors. **Tests:** `npm test` = 964 `ok`, 0 FAIL.

## What was done this session
Expanded the safe formula evaluator from **15 → 70 functions** with row-level Tableau parity, plus new syntax. All three files are **new/untracked**:
- `src/formula.ts` — the evaluator (hand-written tokenizer + recursive-descent parser + tree-walker; **no eval / no new Function**; per-row failures degrade to `null`, never throw).
- `scripts/test-formula.ts` — self-checks (extended; ~130 assertions).
- `renderer/hub/prepare.ts` — calculated-field editor hint text updated.

### Functions now supported (70)
- **Number (26):** ABS ACOS ASIN ATAN ATAN2 CEIL/CEILING COS COT DEGREES DIV EXP FLOOR LN LOG MAX MIN PI POWER RADIANS ROUND SIGN SIN SQRT SQUARE TAN ZN
- **String (25):** ASCII CHAR CONTAINS ENDSWITH FIND FINDNTH LEFT LEN LOWER LTRIM MID PROPER REPLACE RIGHT RTRIM SPACE SPLIT STARTSWITH TRIM UPPER CONCAT REGEXP_MATCH REGEXP_EXTRACT REGEXP_EXTRACT_NTH REGEXP_REPLACE
- **Date (22):** YEAR MONTH DAY QUARTER WEEK ISOWEEK ISOYEAR ISOQUARTER ISOWEEKDAY DATEPART DATENAME DATEDIFF DATEADD DATETRUNC MAKEDATE MAKEDATETIME MAKETIME NOW TODAY ISDATE DATE DATETIME
- **Type conversion (3):** INT FLOAT STR
- **Logical/null (6):** IF (fn form) IIF IFNULL ISNULL ZN COALESCE

### New syntax (parser-level)
- `IF … THEN … ELSEIF … THEN … ELSE … END`
- `CASE … WHEN … THEN … ELSE … END`
- `<expr> IN (v1, v2, …)`
- Operators unchanged: `+ - * / %`, `= == != > < >= <=`, `AND OR NOT`, `[Col Name]` refs.

### Key design decisions / fidelity notes
- **Dates are TEXT cells** — Ordinate has no date *type*. Date fns parse a string → JS `Date` (LOCAL time, so it agrees with TODAY/NOW), compute, return an integer (YEAR, DATEDIFF…) or an ISO-ish string (DATEADD → `YYYY-MM-DD`, time parts → `YYYY-MM-DD HH:MM:SS`). Unparseable → `null`.
- `DATE(number)` returns `null` (no serial-date guessing — ambiguous across engines).
- `date_part` strings: year quarter month dayofyear day weekday week hour minute second iso-year iso-quarter iso-week iso-weekday.
- DATEDIFF counts **boundary crossings** (Tableau semantics), day/week via DST-safe integer day counts (`Date.UTC`-based `dayNumber`).
- `num()` still refuses to coerce numeric strings in arithmetic (never fabricate) — use INT()/FLOAT() to cast explicitly.
- min/max use `reduce` (no `Math.min(...spread)` — Week 14 hardening rule); work numeric OR lexical-string.
- Regex compiled once per pattern via bounded `RE_CACHE` (max 500); invalid pattern → `null`, never throws.
- `weekday` = 1=Sun…7=Sat; `iso-weekday` = 1=Mon…7=Sun.

## What Tableau has that we DON'T (and why) — already explained to user
- **Aggregates (~17: SUM AVG COUNT COUNTD MEDIAN PERCENTILE STDEV VAR CORR ATTR COLLECT…):** not row-level. Ordinate ALREADY does these in the group/aggregate prepare step + chart/metric aggregation. Not a formula gap.
- **Table calcs (~30: WINDOW_* RUNNING_* RANK* INDEX SIZE FIRST LAST LOOKUP TOTAL PREVIOUS_VALUE):** run across a laid-out, sorted, partitioned result — no row-level equivalent. **Real gap** (running totals / rankings).
- **LOD `{FIXED/INCLUDE/EXCLUDE}`:** separate granularity-scoping engine.
- **Spatial (~10: MAKEPOINT MAKELINE DISTANCE BUFFER AREA LENGTH INTERSECTS SHAPETYPE HEXBINX HEXBINY):** no spatial data type (maps join place names to GeoJSON).
- **RAWSQL (~13):** data is an immutable in-memory copy; no live passthrough; security boundary.
- **User/identity (~8: USERNAME ISMEMBEROF …):** local-first single-user, no server/accounts.
- **Predictive (2: MODEL_PERCENTILE MODEL_QUANTILE):** regression engine + partition-aware.

## Open follow-ups (user was offered, not yet chosen)
1. **DATEPARSE** — the ONLY skipped row-level function that genuinely fits. Needs an ICU-style format-token parser. Add to `FUNCTIONS` in `src/formula.ts` + tests. Small, self-contained.
2. **Aggregate-in-formula** (e.g. `SUM([x])/SUM([y])`) — Tableau mixes aggregation into formulas; we keep aggregation as a separate step. This is the real architectural difference; would need the evaluator to know view granularity. Big.
3. **Running totals & rankings** (the table-calc gap) — would be a new post-layout calc layer, not a formula-box change.

## Where things live (for the next session)
- Evaluator: `src/formula.ts` (`FUNCTIONS` record + `Parser` class). Add a fn = one entry in `FUNCTIONS`; add syntax = a `parseX()` method + hook in `parsePrimary`/`parseComparison`.
- Called from: `src/transforms.ts` `calculated_field` step (passes a row `{colName: value}` → scalar).
- UI: `renderer/hub/prepare.ts` (step editor + hint), AI suggest via `dataset:suggestCalcField` IPC.
- Tests: `scripts/test-formula.ts` → `npm test`.
- Emitted `.js` siblings are gitignored (in-place-emit convention); `src/formula.js` already listed in `.gitignore`.
