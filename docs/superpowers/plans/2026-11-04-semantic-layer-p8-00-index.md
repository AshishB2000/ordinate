# Semantic layer part 8 (Engine) — implementation plan index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan below task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implement the plans in the order of the table below, one PR each.

**Goal:** Build part 8 of Ordinate's semantic layer:
- **Live calculated fields:** the same formula gives the same number on a copy and on Live.
- **Fan-out:** a chart or KPI on the one side of a relationship uses measures from its many sides, answered exactly or refused with a sentence.
- **Column-level lineage:** a person sees what a column feeds before changing it.

**Architecture:**
- **Live calculated fields.** The formula parser becomes generic over a builder (02). The JS builder is today's closures moved verbatim, held by a 5,000-expression golden recorded first. A second builder compiles v1's 28 functions to SQL per dialect (03), held to `evaluate()` row by row. A Live dataset stores its calcs at the top level of its record (00a reads them, 04 writes them). Each statement that names a calc reads its source through one derived table per calc (04).
- **Fan-out** is drill-across: one question per table through the existing chart door, each phrased in public encoding fields on a path proved equal to D10's pin. The replies line up by label (06), then KPIs, formula metrics and the builder's pickers (07).
- **Lineage** adds column and term nodes to the existing graph, from the records only (01), drawn in the Data model section (08).
- Every figure still comes from an engine through `vizDataFor`, `computeCardMetric` or `computeCard`.
**Tech Stack:** TypeScript server (`src/formula`, `src/engine/live`, `src/analysis`, `src/ipc`), DuckDB bench and real engines for parity, self-check suites, React 19 web app, Vitest, Playwright.
**Spec:** [docs/semantic-layer/08-engine.md](../../semantic-layer/08-engine.md) (approved 2026-11-03; its owner's answers are binding) · builds on part 1 ([index](2026-11-03-semantic-layer-p1-00-index.md)).

## The PR chain

Two releases. **8A** carries the guard 00a. After 8A, every pod keeps a Live dataset's calculated fields and refuses its figures. **8B** carries the features that need that. The owner cuts both. 00a must be deployed on every pod before 04 reaches a release: 04's merge gate is `git tag --contains <00a's merge commit>` (fetch tags outside work hours) and the owner's word that the rollout is done. 02, 03 and 01 store nothing, so they may land in 8A or 8B. 06 and 07 store nothing either; they wait only for part 1.

| # | PR branch | Plan | Needs merged first | Release |
|---|---|---|---|---|
| 1 | `feat/semantic-p8-00a-live-calc-guard` | [00a](2026-11-04-semantic-layer-p8-00a-live-calc-guard.md) | — (part 1's 08a is in develop) | 8A |
| 2 | `feat/semantic-p8-02-formula-builder` | [02](2026-11-04-semantic-layer-p8-02-formula-builder.md) | — | 8A or 8B |
| 3 | `feat/semantic-p8-03-formula-sql` | [03](2026-11-04-semantic-layer-p8-03-formula-sql.md) | 02 | 8A or 8B |
| 4 | `feat/semantic-p8-01-column-lineage` | [01](2026-11-04-semantic-layer-p8-01-column-lineage.md) | part 1 step 10 | 8A or 8B |
| | **owner cuts 8A (with 00a), and it rolls out everywhere** | | | |
| 5 | `feat/semantic-p8-04-live-calcs` | [04](2026-11-04-semantic-layer-p8-04-live-calcs.md) | 03, part 1 step 08, **00a released** | 8B |
| 6 | `feat/semantic-p8-05-engine-pins` | [05](2026-11-04-semantic-layer-p8-05-engine-pins.md) | 04 (and a green nightly on its branch) | 8B |
| 7 | `feat/semantic-p8-06-fan-out-charts` | [06](2026-11-04-semantic-layer-p8-06-fan-out-charts.md) | part 1 steps 09 and 05b | 8B |
| 8 | `feat/semantic-p8-07-fan-out-kpis` | [07](2026-11-04-semantic-layer-p8-07-fan-out-kpis.md) | 06 | 8B |
| 9 | `feat/semantic-p8-08-lineage-ui` | [08](2026-11-04-semantic-layer-p8-08-lineage-ui.md) | 01, 04, part 1 step 10 | 8B |

Plan numbers follow the spec's build order (1–8) plus the guard (00a). The chain moves the parser refactor (02, 03) ahead of lineage (01), because they need nothing from part 1 and 04 waits on them. 00a and 02 can start today. The rest start once part 1's chain has merged.

## Global Constraints

- **No remote work on weekdays 08:00–18:00 local time, not even to read:** no push, pull, fetch, `gh` of any kind or GitHub MCP (the owner's global rule, enforced by a hook). Commit locally inside the window. Push, open PRs and run the nightly outside it.
- One worktree per PR off `origin/develop` (`feature-branch-workflow` skill). Never commit to `develop`. Never `git checkout`/`git switch` in the shared clone. No `Co-Authored-By` or any AI trailer.
- No release, `v*` tag or image push without the owner. 8A is fully rolled out before 04 ships.
- No new runtime dependency, no migration, no `eval`/`new Function`. Every new stored field (only `calculated`) is a top-level record key with an older-pod analysis (00a).
- **Engines do the math.** The line-up places door figures only. Agreement is `Object.is` (sum and avg in the parity matrix keep its documented 1e-13 tolerance). A divergence is a named pin with a test, never a loosened comparison. Golden fixtures (`formulaCorpus.json`, `joinsNoVia.json`, every `__golden__`) are never re-recorded.
- Live: values bound, identifiers only from the declared schema or a stored calc name through `ident()`, all through `warehouse()`, no JS fallback. No new statement builder: part 1 step 08's inventory still counts `compile.ts` ×7 and `profileSql.ts` ×2. Calcs open no row-reading channel.
- Contracts:
  - zod inputs, the narrowest access, a project scope;
  - new `read` contracts (`lineage:column`, `lineage:fields`) classified `META` in `scripts/rowPolicyReaders.ts`;
  - `node scripts/check-contracts.js` → 0 unresolved;
  - `src/api/index.ts`, `web/src/app/routes.tsx` and `web/src/app/nav.ts` append-only (this part needs no line in them).
- Server sentences through `t()` in a `MAIN_FILES` file, then `node scripts/i18n-extract.js`; never hand-edit `en.json`.
- File caps 500/800. Near the cap or watched:
  - `src/ipc/visuals.ts` 773 (06 adds two lines);
  - `src/data/datasets.ts` 799 (not touched);
  - `src/formula/formulaEval.ts` 625 (not touched);
  - `src/ipc/metrics.ts` 563 (one line);
  - `src/engine/live/compile.ts` about 480 after part 1 (≤ 8 lines);
  - `src/analysis/lineage.ts` 413 (≤ 25 lines).
  
  New logic goes in new files.
- Required checks on every PR: `smoke (all shards)` and `oxlint (blocking)`; `npm run lint` → 0.

## Review Focus

1. **Older pods and Live calcs:** a pod before 00a skips a filter on a calc column and copies a dataset without its calcs. 00a, the release gate and the upgrade note hold it. Owners: 00a, 04.
2. **The refactor changes nothing:** the corpus is recorded before any `src/` change (its commit is scripts-only), and `test-formula*` stays untouched. Owner: 02.
3. **Copy = Live for one formula:** the per-row differential and the calc matrix, with negative controls for each of D5's spellings. Pins 9+ only. Owners: 03, 04, 05.
4. **No figure that answers today changes:** `test-joins`/`test-joinsVia` stay byte for byte, and only refused cases become answers (fan-out, many-side KPIs, chart formulas over related columns). Owners: 06, 07.
5. **Row access through sub-questions:** a caller locked on P is refused by the outer gate, for charts (`values[].datasetId`) and for KPIs (many-side names join `reachesOther`), and every table is recorded in a publish scope. Owners: 06, 07.

## Calls made while planning (deliberate; the spec left them to the builder or the code forced them)

- **A guard release (00a)** first, because a pod of today's release skips a filter on an unknown column (a wider figure) and copies a Live dataset without its calcs.
- **Where calcs live:**
  - `calculated` is at the record's top level (part 1 08's pattern). The calc columns are appended to `meta.columns` when the record is read (`applyLive`), never written into `raw.columns`.
  - D1 said "appends them … on every save and schema sync". But `writeSchemaSync` rewrites `raw.columns` from the warehouse on every sync, and keeping calcs out of `raw.columns` makes D8 free: a row access column is checked against `raw.columns` (`src/ipc/rowPolicy.ts:110`).
  - The schema sync, the Schema panel and base filters use `declaredColumns(meta)`.
- **An edit does not bump the epoch:** the definitions ride in `LiveSource.calcs`, so in every key (D7).
- **No preview rows** in the Live formula editor: only the type and the refusal, since a statement per keystroke would spend `LIVE_DAILY_QUERY_LIMIT`. It uses `live:checkCalc`, a `write` contract, so `formula:check` and its safety-net row are unchanged.
- **Result types:** number, text, and true/false (stored as text). A date result is refused in v1. A comparison on a TIMESTAMP-held date is refused (pin 7 already shows the text comparison disagrees); date parts and `datediff` take DATE or TIMESTAMP columns.
- **Base filters** may not name a calc: they sit innermost, before calcs exist (refused as `baseFilter`). Base filters move innermost only for statements that read a calc; every other statement is byte-identical to part 1's.
- **Caps:** 50 calcs, 4,000-character expressions, 200-character names, 256 KB statements. Layers are not merged.
- **Names:** case-insensitive unique against columns and calcs; the `lv_`/`o_` prefixes are refused.
- `replace`, `ltrim`, `rtrim` and `div` stay refused in this part. Databricks is refused at save and at compile, with its golden shapes still pinned.
- **One function list for every dialect:** an engine that can't be made to agree refuses that function everywhere (05).
- **Fan-out sub-questions** use only public fields (`categoryDatasetId` + `categoryVia`, a filter `via`), verified with step 09's `viaPath` against D10's pin, so there is no internal field and no cache-key gap. A many-side measure's `via` names a relationship from M itself. Fan-out runs after the Live branch and before the answer cache.
- **Notes** reuse part 1 05b's `notes`: one "count their own rows" sentence and one per narrowing filter. The names are quoted and comma-joined, with no locale list builder.
- **A metric's bare many-side column** resolves only when exactly one many side has it; two is refused, naming both. Chart formula measures may also name forward-related columns: they don't compile today, so they go from refused to answered.
- **Lineage:**
  - `KIND_RANK`: `column: 3` (with calc), `term: 4` (with metric).
  - Column and term nodes are drawn only by `lineage:column` and `lineage:fields`. The second is a read beside the spec's one, so "Used by" and the delete confirmations stay inside the RPC budget.
  - Lineage's term counts are held to part 1's `termUsage` by a differential.
- **Delete confirmations** appear only when the step or calc feeds something, so one click stays one click for most steps.

## Changes found while planning (the code against the approved spec)

- **D14 covers charts but not KPIs.** `reachesOther` (`src/ipc/rowDoors.ts:57-65`) only knows forward names (`relatedColumnNames`). A KPI over a many-side bare column would not be refused for a caller locked on P, and its sub-question would run inside P's lock scope. 07 adds the many-side names to the gate.
- **D10 says pinned "by part 1 D14's `via`".** But a `via` names one relationship, and `viaPath` prefixes the default path, so one `via` can't pin an arbitrary multi-hop path. Fan-out answers when the phrasing provably resolves to the pin, and refuses otherwise.
- **D3 versus the non-goal "Prepare typing unchanged".** `retypeColumn` types a text calc by its values: `'12'` becomes a number, ISO text a date. A copy and Live then differ on such a calc, and that is pin 9.
- **D20 conflicts with part 2's PR 1 test.** Part 2's PR 1 trims the table for viewers only, and its negative control pins that an editor still reads "Table …" in `lineage:get`. D20 removes it for every reader. 01 rewrites that control to "the editor reads the connector kind too" if part 2's PR lands first.
- **Part 5 defers "Live funnels and snapshots, symmetric aggregates, Approach B" to part 8**, but part 8's approved design has none of them: it rejected B and C, and D15 keeps Live joins out. Part 5's distinct counts need only a differential case on 06's planner.
- `src/ipc/visuals.ts` is 773 lines now, not 769, after release 1.
