# Semantic layer part 8, step 05: Live calculated fields on real engines — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Step 03's expression differential and step 04's calc matrix run on every engine Ordinate sends calcs to: Postgres in CI (the Redshift dialect), ClickHouse in the nightly container, and Snowflake and BigQuery on the nightly's real accounts. Each disagreement is fixed in the dialect's spelling, or the function is refused on every dialect, or, when neither can remove it, it becomes a named pin re-proved on each engine. Databricks keeps its golden shapes and its refusal (owner's answer 1).
**Architecture:**
- No product code by design. The runners that already run the live-parity matrix on each engine call two more functions:
  - `calcDiff(engine, exprs)` (step 03);
  - `calcCase(x, engine.run, typed, ok, { stride })` (step 04).
- Each runs over the same `ParityEngine` (`scripts/liveParityFixture.ts:171`): a table on Postgres and ClickHouse, literals on the cloud accounts, which are never written.
- A fix lands in `src/engine/live/dialects/*` or `src/engine/live/formulaSqlFunctions.ts`, with its own golden fragment and differential case.
**Tech Stack:** `scripts/test-liveParityPostgres.ts`, `scripts/test-liveParityClickhouse.ts`, `scripts/warehouseLiveParity.ts`, `scripts/liveParityPins.ts`, `.github/workflows/warehouse-nightly.yml`, `docs/live-data/log.md`.
**Spec:** docs/semantic-layer/08-engine.md (Tests "Matrix": "thinned on Postgres in CI, ClickHouse nightly, Snowflake and BigQuery in `test-warehouseLive`"; D4; owner's answer 1) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p8-00-index.md
**Branch and PR:** `feat/semantic-p8-05-engine-pins` off `origin/develop`, after step 04 merges. One PR. It merges only after one nightly run on this branch is green. The implementer triggers it with `gh workflow run warehouse-nightly.yml --ref feat/semantic-p8-05-engine-pins`, **outside weekdays 08:00–18:00**: no remote call of any kind inside that window.

## Global Constraints
- **One function list for every dialect** (D4). A function that can't be made to agree on one engine is refused on all of them, with its `LIVE_FUNCTIONS` reason moved to `notMeasured` and a line in `docs/live-data/log.md`. It is never refused on one dialect only, because a dataset that moves connection must keep working.
- **Comparisons are never loosened.** Agreement is `Object.is` per row in the differential. In the matrix it is `Object.is`, except sum and avg, which keep the matrix's documented 1e-13 tolerance (`scripts/liveParityCompare.ts:23`). A divergence is a pin, with a test that shows it exactly.
- A cloud account bills per statement. The differential runs `calcCorpus(SEED, 400)` there (2,000 on DuckDB, Postgres and ClickHouse), and the matrix runs `stride: 8`, `warehouseLiveParity.ts`'s `STRIDE`.
- Golden fragments in `test-formulaSql`/`test-liveCompile` are inline expectations, not recorded fixtures. When a spelling changes on purpose, its fragment changes in the same commit, with the reason in the commit message and in `log.md`.
- Databricks: none of this runs. Its refusal stays, until a Databricks workspace joins the nightly.

## Old pods (rolling deploy and rollback)
Tests only, except a possible spelling fix. A fixed spelling changes the SQL text, so the cache key moves: an old pod's cached answer is never reused by a new pod. A function moved to refused makes a stored calc that uses it refuse (`calculated`, its sentence) on new pods. It never answers differently. The PR description lists every such function, and the release note says which saved calcs will stop.

## Review Focus
- BigQuery raises on FLOAT64 overflow, where JS gives ±Infinity and DuckDB gives Infinity. A typed `live_failed` is acceptable, but it must be the pin's assertion, not a skipped case. → Task 2
- ClickHouse `lowerUTF8`/`upperUTF8` and Snowflake/BigQuery `LOWER`/`UPPER` on `ß`, `İ` and a final `Σ`: step 03's pin, re-proved here. → Task 2
- Postgres runs on the Redshift dialect: `BTRIM` with the JS whitespace set, and `EXTRACT` on a TIMESTAMP in a UTC session (`docs/live-data`, L3.2). → Task 2
- A literal source (Snowflake, BigQuery) puts the calc layers over `(SELECT … FROM literals)`. The layers must still project only what is needed. → Task 1

---

### Task 1: run the calc cases on every engine
**Files:** Modify:
- `scripts/test-liveParityPostgres.ts`: after its `runMatrix`, call `calcDiff` and `calcCase`.
- `scripts/test-liveParityClickhouse.ts`: the same.
- `scripts/warehouseLiveParity.ts`: `runOn` (:13-37) calls both, `stride: STRIDE`, with 400 expressions.
- `scripts/liveParityPins.ts`: `run` re-proves step 03's and step 04's pins on the engine it is handed.
**Interfaces:** Consumes `calcDiff`, `calcCorpus` (`scripts/formulaSqlCorpus.ts`) and `calcCase` (`scripts/liveParityCalcs.ts`). Produces no new export. Each runner ends its summary line with `calcs: <n> expressions, <m> matrix cases`.
- [ ] **Step 1: Write the failing test.** In each runner:
  ```ts
  const bad = await calcDiff(engine, calcCorpus(CALC_SEED, cloud ? 400 : 2_000));
  ok(`${engine.name}: every v1 expression agrees with JS, row by row`, bad.length === 0, bad.slice(0, 5).join(' | '));
  await calcCase(x, engine.run, report.envs.typed, ok, { stride: cloud ? STRIDE : 1 });
  ok(`NEGATIVE CONTROL: on ${engine.name}, ROUND instead of the FLOOR CASE is caught`, (await calcDiff(engine, ROUND_TIES, WithRound)).length > 0);
  ```
  `ROUND_TIES` is a short fixed list (`round([n])` and `round([n], 1)` over the tie rows), so the negative control costs a few statements.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && DATABASE_URL=… node scripts/test-liveParityPostgres.js` on a local Postgres. That is the scratch Postgres the repo's db suites use, started as memory `local-postgres-for-db-suites` says, port 54329. The new checks fail until Task 2's fixes land, or they pass and this step is a run.
- [ ] **Step 3: Implement** the calls.
- [ ] **Step 4: Run it to see it pass** where it can run here: Postgres locally, and ClickHouse if a local container is available (`CLICKHOUSE_URL`). Snowflake and BigQuery run in the nightly (Task 3).
- [ ] **Step 5: Commit.** `git add scripts/test-liveParityPostgres.ts scripts/test-liveParityClickhouse.ts scripts/warehouseLiveParity.ts scripts/liveParityPins.ts` · "Run the Live calculated-field differential and matrix on every engine"

### Task 2: fix, refuse or pin what the engines disagree on
**Files:** As found:
- `src/engine/live/dialects/*.ts` (a spelling);
- `src/engine/live/formulaSqlFunctions.ts` (a function moved to refused);
- `scripts/liveParityPins.ts` (a pin, numbered from 10; step 04 added 9);
- `scripts/test-formulaSql.ts` (the fragment that pins a changed spelling);
- `docs/live-data/log.md` (a "Part 8 — calculated fields on real engines" entry: the engine, the case, the decision).

**Interfaces:** Each pin is `{ id, engines: CompileDialectId[] | 'all', case: string, extract: unknown, live: unknown }`, asserted exactly on the engines it names, in the existing pins' style.
- **Expected candidates.** Each gets a test whichever way it lands; none is assumed:
  - BigQuery overflow raising. This is step 03's overflow pin: on BigQuery the live side is a typed `live_failed`, never a number.
  - `lower`/`upper` special casing per engine. This is step 03's pin, with each engine's own outputs recorded in it.
  - ClickHouse `toDayOfMonth` on `Date32` before 1970.
  - Snowflake `TRIM` with a multi-character set, if the JS whitespace set reaches it as one bound value.
- [ ] **Step 1: Write the failing test.** The assertion Task 1 left red, narrowed to one case: `ok('<engine>: <case>', …)`.
- [ ] **Step 2: Run it to see it fail** on that engine.
- [ ] **Step 3: Implement**, in this order of choice:
  1. A spelling that agrees on that engine and keeps every other engine green.
  2. Otherwise, refuse the function on every dialect (`notMeasured`), which its own differential case shows.
  3. Otherwise, only for a class of values no spelling can reach (an engine error on overflow), a named pin.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-formulaSql.js && node scripts/test-formulaSqlDiff.js && node scripts/test-liveParity.js && DATABASE_URL=… node scripts/test-liveParityPostgres.js`.
- [ ] **Step 5: Commit**, one per decision. For example: "Spell trim on Snowflake with a bound set so it agrees with JS", or "Refuse lower() on Live tables until engines agree on special casing".

### Task 3: the nightly, and the record
**Files:** Modify `docs/live-data/log.md`, and `docs/server/live-data.md` (step 04's "Calculated fields" section lists the pins and any newly refused function).
- [ ] **Step 1: Write the failing test.** None new. The nightly's summary must show the four engines' `calcs:` lines and no failure.
- [ ] **Step 2: Run it.** Outside weekdays 08:00–18:00: `gh workflow run warehouse-nightly.yml --ref feat/semantic-p8-05-engine-pins`, then read the run's summary (`gh run view --log`).
- [ ] **Step 3: Implement.** Each failure goes back through Task 2. When the run is green, record in `log.md` the date, the statement counts per engine and the pins.
- [ ] **Step 4: Run it to see it pass.** The nightly is green on this branch, and `node scripts/test-serverDocs.js` passes.
- [ ] **Step 5: Commit.** `git add docs/live-data/log.md docs/server/live-data.md` · "Record the calculated-field runs on Postgres, ClickHouse, Snowflake and BigQuery"

**Existing tests that must stay green:** test-liveParity, test-liveParityPostgres, test-liveParityClickhouse (nightly), test-warehouseLive (nightly), test-formulaSql, test-formulaSqlDiff, test-liveCompile, test-liveCalcs, test-serverDocs, test-file-size.

**Not in this step:** Databricks (no workspace yet: the refusal stays). `replace`, `ltrim`, `rtrim` and `div` (still refused; measuring them is v1.1).
