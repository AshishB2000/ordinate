# Semantic layer parts 1–8: cross-part check

Checked on 2026-11-04 against every plan in this folder (`p1-*` dated 2026-11-03, `p2-*` to `p8-*` dated 2026-11-04), the approved designs in `docs/semantic-layer/`, and the read-only code in `.claude/worktrees/semantic-p1` (branch `feat/semantic-p1-05a-unknown-steps-kept` @4fe1d7ae, which stacks all of part 1's release 1). Part 1's release-1 PRs are **not** on the local `origin/develop` ref (594e7b10), so "on develop" in a plan means "after part 1's release 1 merges".

**Clean, no action needed:**
- **Channels.** No two parts add the same contract channel. The `model:` prefix is shared without clashes:
  - part 1 has `model:overview` in `src/api/model.ts`;
  - part 6 appends `model:navigation` there;
  - part 7 appends `model:export`, `importPlan`, `importApply` and `exportOssie`;
  - part 4 puts `model:review`, `certify`, `retire` and `clearStatus` in `src/api/governance.ts`.
- **Other names.** No two parts add the same:
  - record kind: `term` (1), `verified` (3), `topic` (6), plus part 2's records under `connections/`;
  - catalog section: `tables` (1), `instructions` (3), `status` (4);
  - TableDoc field (`hierarchies`, 6) or ColumnDoc field (`values`, 1);
  - refusal code;
  - MCP tool;
  - `?tab=` value: `sources` (2), `assistant` (3);
  - new file path.

  The duplicate-path sweep only hit files a later part modifies.
- **Shared registries.** Several parts append to the same registries. Resolve these conflicts "keep both":
  - `recordKinds.ts`, `bundleRules.ts` `ENTRY_RULES`, `api/trash.ts`, `SaveKind`/`SAVE_KEYS`, `GuardType`, TrashPage words;
  - `MAIN_FILES`, the `app.ts` module arrays, `upgrade.md`;
  - `sanitizeCatalog` (three named lines);
  - `applyLive` and `liveTarget`: `baseFilters` (1), `calculated` (8), `semantic` (7). Guard order is `semanticPending`, then base filters, then calcs;
  - `LiveRefusalCode`, `Part` (`'d'` from part 5 and `'v'` from part 7);
  - `modelOverview.ts` (parts 3, 4, 8) and `TodoStrip` (parts 2, 3);
  - `FieldsPanel.tsx` (2, 6, 8), `DatasetPanel.tsx` (2, 4, 8), `LineageDrawer.tsx` (1, 2, 8);
  - `distinctFor.ts` (1, 4, 6), `rowDoors.ts` (4, 8);
  - `MetricEditor.tsx` (1, 4, 5, 7).
- **`MetricDefinition`.** Part 5 (`…| Funnel | Period`) and part 7 b0 (`…| External`) each rewrite the union and `sanitizeDefinition`. Resolve keeping both:
  - the union becomes `Simple | Formula | Funnel | Period | External`;
  - the sanitizer order becomes external → formula → funnel → base → simple (b0's "external wins over any key beside it");
  - whichever of p5-01 and p7-b0 lands second re-counts the other's sites in its ratchet (`scripts/definitionSites.ts`, `scripts/countSites.ts`).
- **Harmless name reuse in different modules:**
  - `calcRefusal`: part 1's in `src/analysis/additivity.ts` and part 8's in `src/ipc/liveDatasets.ts`;
  - `tableFacts`: part 1's Assistant `tableFacts()` in `src/app/tableDocs.ts`, and part 2's `ConnectorDef.tableFacts` and `src/connectors/tableFacts.ts`.
- **Hierarchies and the other catalog writers.** Part 6's `TableDoc.hierarchies` is safe against parts 2, 4 and 7:
  - p2-09's `catalog:setTable`/`setColumn`, p4-01's `updateStatus` and p7-a3's `mutateCatalog` all write through `sanitizeCatalog` → `sanitizeTableDoc`;
  - p6-01a's reader line is in that path;
  - a3 patches only the fields model files carry;
  - p6-01, the only writer, waits for p6-01a to be rolled out.

  The only way to lose hierarchies is a rollback below p6-01a.

---

## (a) Edits made (20 edits in 17 files)

| File | Edit | Why |
|---|---|---|
| `2026-11-03-semantic-layer-p1-07-snapshot.md` | Task 1 no longer defines `mergeSnapshot(next, raw, prev)`. It reuses 02a's shipped `mergeSnapshot(incoming, stored): MetricSnapshot \| undefined`, and Step 3 and the file list say `updateMetric` already merges at `metrics.ts:413`. | 02a ships that name in the same file (`src/analysis/snapshot.ts:25`), so a second one would not compile. Part 5 step 07 and part 7 b0 consume 02a's. |
| `p3-00-index.md` | `verifiedProblem(projectId, q, env)` → `verifiedProblem(q, env)` with `env` from `verifiedEnv(projectId)` | The producer is p3-05:112 |
| `p3-00-index.md` | `CatalogFile.instructions` is in `src/app/catalog.ts`, not `instructions.ts` | p3-02:40 |
| `p3-00-index.md` | Row 2 (p3-02) needs part 1 01a | p3-02 inserts "after `tables`" in `sanitizeCatalog`, a line only 01a adds |
| `p3-02-readers.md` | Branch line: needs part 1 01a merged (release 1), nothing from release 2 | Same as above |
| `p3-03-instructions.md` | Uses part 1's `mutateCatalog` instead of exporting `mutate` again (3 places) | p1-01 Task 4 already exports `mutate` as `mutateCatalog`, and p3-03 needs step 01 merged |
| `p4-00-index.md` | Row 1 (p4-01a) needs part 1 01a, not "none (develop)" | p4-01a copies `tableDocs.ts` and sits beside its `sanitizeCatalog` line. Neither is on develop yet |
| `p4-01a-readers.md` | Branch line: same dependency | — |
| `p4-01-status-store.md` | `getTerm` is in part 1 05b's `src/analysis/terms.ts`; `isTermStep` is in part 1 05a's `src/data/termStep.ts` | p1-05b:31, p1-05a:35 |
| `p4-05-column-gate.md` | The `dataset:distinct` gate question is `[column, req.filters]`, not `[column]`. Adds a REFUSE row: distinct of `dept` narrowed by `salary`. The branch line needs p6-05a merged. | p6-05a (release A) adds parent `filters` to `dataset:distinct`. Gating only `[column]` would let a caller probe a hidden column's values through a parent step. This is the same rule `pageFor` already applies (`{ filters: req.filters, … }`) |
| `p6-05-cascading-pickers.md` | 05a's Step 4 runs `test-valueLabels.js` only if part 1 step 06 has merged | 05a is release A. That suite is created by part 1 step 06 (release 2) |
| `p7-a2-import-plan.md` | `valueLabelDuplicateMessage('Europe')` → `labelShared('Europe', 'EU', 'EE')` | Part 1 06's sentence for one label naming two values (p1-06:49). The old name exists nowhere |
| `p7-b1-semantic-engine.md` | `LayerRefusalCode` gains `'layerFilter'` | e1:19 and d1:25 refuse with it, and b1's union lacked it |
| `p7-b3-semantic-web.md` | `src/data/datasets.ts` budget ≤ 3 → ≤ 1 line, or the field moves to the `src/ipc/datasets.ts` reply | The file is at 799 and `test-file-size` fails above 800 (`CAP = 800`, not allowlisted) |
| `p7-f1-dbt-import.md` | dbt `count_distinct` → `{ column, aggregation: 'countd' }` (part 5's `AGGREGATIONS`) once p5-04 has merged; `needs_part5` before that | It now uses the producer's spelling. p5-04 is the first `countd` writer and holds 5A's rollout gate |
| `p7-g1-ossie-export.md` | Source names use part 2's `seesSourceNames(projectId)` (`src/data/sourceNames.ts`, release 1). It no longer says "until part 2 names a narrower check" | Part 2 named it, and design 07:350 says Ossie reuses part 2's rule |
| `p8-00-index.md` | Row 1 (00a) needs part 1 08a and 05a | 00a's Task 2 bullet goes in 05a's upgrade section. 08a isn't on develop yet |
| `p8-00-index.md` | Row 3 (p8-03) needs 02 and 00a | p8-03 Task 2 consumes 00a's `LiveCalc` |
| `p8-00a-live-calc-guard.md` | Branch line: needs 08a and 05a | Same as above |
| `p8-03-formula-sql.md` | Branch line: after 02 and 00a | Same as above |

---

## (b) Judgment items

### 1. Part 2 PR 01's lineage negative control vs part 8 D20
**Confirmed.**
- p2-01 Task 2's control asserts that an editor's `lineage:get` source node reads `Table public.canary_tbl_9f3`, and that the editor's `pipelines:get` text holds the canary.
- D20 (p8-01:98, design 08) makes that `sub` the connector kind for every reader.
- p2-01 is in release A and p8-01 is in release B, so part 2's test exists when p8-01 lands. p8-01's "if that PR has merged" is therefore always true.

**Recommended change to p8-01:**
- Make the rewrite unconditional.
- Lineage half: `srcNode(await lin('ed')).sub === 'postgres'`.
- Keep the viewer assertion as a regression guard. It is now structural.
- Keep Task 1's `dataset:source` editor control as the non-vacuous anchor for the name rule. The editor still reads `Connection · Warehouse · public.canary_tbl_9f3` there.
- Keep the `pipelines:get` half only if the editor's text still carries the canary through Task 3's planted run error. Otherwise drop it from the control.
- Keep part 2's `loadInput` trim.
- p2-08's "`lineage:get` byte-identical for an editor" compares two reads in one build, so D17, D19 and D20 do not break it.

**If wrong:** the viewer-side `pipelines:get` check goes vacuous, so a later leak there is not caught. The other failure mode is a red CI on p8-01, which is cheap.

### 2. Part 5 defers Live funnels, per-account snapshots, symmetric aggregates and Approach B to part 8
**Confirmed.** Design 05:53-54 and :316-317 defer them, but no part 8 plan or design builds them. Design 08 rejected B and C, and its D15 keeps Live joins out. Part 5's plans already refuse each case with a typed sentence: Live funnels (p5-08), per-entity snapshots on Live (p5-07), and the week-calendar distinct count (p5-03).

**Recommended:**
- Record "not planned in parts 1–8; stays refused (typed)" as one line in part 5's index and as a non-goal in part 8's.
- Treat symmetric aggregates as superseded: part 8's drill-across fan-out answers per table, so distinct counts need no symmetric trick (see item 12).

**If wrong:** a Live customer cannot use funnel metrics or per-account snapshots. They get a refusal, never a wrong figure.

### 3. Part 5 says part 7 maps cumulative, conversion and window groupings 1:1; part 7 skips them
**Confirmed, and it is a design conflict.**
- Design 05:316 says part 7 maps all of them 1:1.
- Design 07's non-goals (:59, :192) skip cumulative, conversion, time offset and cross-model.
- p7-f1:27 skips them, and also skips window groupings.

**Recommended:**
- Keep v1 as part 7 plans: skip with named reasons. The `count_distinct` → `countd` mapping is now spelled in f1 (edit above).
- Add a later translator-only PR after p5-08 ("f2") for exact shapes:
  - `window_groupings: [entity]` → `snapshot.per` (design 05:48 says this is what part 5's per-entity snapshot is);
  - cumulative with `grain_to_date` → period `to_date`, and with `window` → `last N`;
  - a time-offset derived metric → period `compare`;
  - conversion → funnel only for a two-step exact shape.
- Correct p5-00:70 and :92 to say this. No part 7 export emits MetricFlow; g1 maps a distinct count to Ossie only if the spec has one.

**If wrong:** dbt users rebuild those metrics by hand. Skips are reported, never silent.

### 4. Part 2 says part 7 maps dbt `sources:`; part 7 doesn't plan it
**Confirmed.** Design 02:361 says part 7 maps them, but design 07 never mentions it. More importantly, f1 reads only `semantic_manifest.json`, which has no `sources:`. It refuses a `manifest.json` past the value budget.

**Recommended:**
- Not in v1. Correct p2-00:71.
- If the owner wants it, add a separate part 7 PR after p2-03 and f1. It would read sources from a small upload, for example the JSON from `dbt ls --resource-type source --output json`, and write `owner`, `refresh` (`freshness`) and `guide` (description) through `createSourceDoc`/`saveSourceDoc`. It would never read a full `manifest.json`.

**If wrong:** editors type source notes by hand.

### 5. `columnAccess` (part 4) and `calculated` (part 8) vs `writeRecordKeepingPolicy`
**Confirmed in code** (`src/data/datasetRecord.ts:288-305`).
- It rebuilds the record from the in-memory object and copies back only `rowPolicy`.
- It is the only whole-record rebuild. It is reached from `datasets.persist` (`datasets.ts:234/279`).
- Every other writer, including every Live writer and every new writer in parts 1, 2, 4, 7 and 8, is `serialized`, which mutates in place and so keeps unknown keys.
- On a Live record, `persist` is reached only through `toExtractRecord` (`liveRecord.ts:100-122`).

**Recommended:**
- **`columnAccess` joins the kept list.** p4-01a's `KEPT_RECORD_KEYS = ['rowPolicy', 'columnAccess']` is right as planned, because both apply to extracts and Live.
- **The Live-only keys stay out** (`baseFilters` from 1, `calculated` from 8, `semantic` from 7). `toExtractRecord` must drop them:
  - p1-08 and p8-04 fold them into steps;
  - p7-b0/b2 and p8-00a refuse the switch.

  Add a one-line comment beside `KEPT_RECORD_KEYS` that names the three and says why. The point is that nobody later "generalises" the list to every unknown key.
- **Missing tests to add:**
  - p4-01a: its Review Focus names "Live writers" and `copyLive`, but the WRITERS test runs neither. Add `bumpEpoch`, `writeSchemaSync` and a `copyLive` copy.
  - p8-00a: one assertion that a Live record is never persisted except through `toExtractRecord` (spy on `writeRecordKeepingPolicy` across its WRITERS).

**If wrong:** an extract refresh drops `columnAccess`, and hidden values are served. Or a re-save path drops calcs silently.

### 6. Part 4's column gate vs readers, prompts and figure paths that parts 3, 5, 6, 7 and 8 add
None of those plans mention column access. Each will add something part 4's p4-05/p4-06 must cover:
- **New read contracts and the class each needs** (proposed):
  - `catalog:instructions`, `model:navigation`, `topic:get`, `lineage:column`, `lineage:fields`: META;
  - `visual:drillDown`: GATE;
  - `verified:list`: DROP the rows whose spec names a hidden column;
  - `verified:checkResult`: REDACT.
- **New prompt text:**
  - p3-04's `copyValueNotes` and `filterLabels`, which read the value index. That includes hidden columns' values.
  - p3-06's examples and chips.
  - p6-08's `topicFacts` and MCP `inTopic`.
- **New figure paths:**
  - p5's funnel, period and per-entity paths: `metricHidden` must walk `funnel.entity/event/time`, the period `base` recursively, `snapshot.per`, and the target's plan metric.
  - p8's fan-out sub-questions on a many side with rules: a test case.
  - p7's semantic datasets: `layerRowPolicy` should also refuse when `hiddenColumnsFor` is non-empty.

**Recommended:**
- Merge p4-01…06 early in release B, right after part 1's release 2 (see (c)). Then p4-06's `COLUMN_TREATMENT` ratchet and its prompt canaries make each later PR classify and drop for itself.
- Hand-offs for the paths the canaries may not reach:
  - p3-04 skips `hiddenColumnsFor` columns;
  - `pickExamples`'s `withheld` adds the hidden columns;
  - `metricHidden` reads the part 5 kinds.

**If wrong:** a hidden column's values reach a prompt or a reply. That is a leak, so this item is the costliest one here.

### 7. Part 4's pins vs other parts' new fields
- **`DATASET_PIN.live` pins `baseFilters` only.**
  - Part 8's `calculated` changes figures. Pin `name` and `expression`.
  - Part 7's `semantic` should pin `backend` and `model`.
  - Pinning the whole `origin` includes part 2's `readsTables`. That is a label no figure reads (p2-02:15), so linking source tables would wrongly drop certification. Strip it before hashing.
- **`METRIC_PIN: Record<keyof Metric, …>`.** `tsc` forces whichever lands second to classify part 5's `target` and part 7's `importedFrom`. Recommend `'out'` for both, because neither changes the value.
- **Metric `deps`** should include a period metric's `definition.base`.

The owner of each change is whichever of p4-01 and the field's writer (p8-04, p7-b2, p2-08, p5-01/05) lands second. In (c), p4-01 lands first, so the writers own it.

**If wrong:** a certified badge survives a calc edit (a badge that lies), or drops after a harmless table link (a false alarm).

### 8. Verified questions vs certified and retired metrics: parts 3 and 4 point at each other
- Design 03:307 says "a verified spec on a retired metric is part 4's call".
- Design 04:303 says "verified questions cite certified metrics".
- p3-00:71 says part 4 consumes `verifiedProblem`; p4-04:80 says part 3 consumes `statusFor`. Neither plan does.

**Recommended:**
- A verified question on a retired metric keeps running, since it names the metric, matching part 4's "drop retired unless named" rule. It carries part 4's `retiredNotes` sentence on its answer card and on MCP `answer_verified_question`.
- `verifiedProblem` is unchanged.
- No "certified" citation is needed on chips.
- Owner: p3-05/p3-09, since p4-04 lands before P3-B in (c). Correct p3-00:71 and p4-00:74/p4-04:80 to match.

**If wrong:** a verified answer shows a retired metric with no note.

### 9. A topic context gets no dataset guides (parts 3 and 6)
p6-08 adds `context.kind = 'topic'`. `askGuidance` gives any kind other than dataset, visual and project "instructions only" (p3-03:163-170). p3-03 also moves guides out of the table notes, so a topic chat ends up with no guides at all.

**Recommended:**
- Add a `'topic'` arm to `askGuidance`: the guides of the topic's datasets, in topic order, first 12.
- In the same arm, apply part 4's `vocabularyOrder` and hidden drops to `topicFacts`.
- Owner: p6-08, the later of the two in (c).

**If wrong:** topic chats answer with less context. The figures are still not wrong.

### 10. Part 7's model files (formatVersion 1) vs other parts' stored kinds
Model files carry none of these:
- part 6's hierarchies and topics;
- part 4's status;
- part 3's instructions and verified questions;
- part 8's Live calcs;
- part 2's source docs;
- part 5's `target`.

Design 03 ("the file export carries both") and design 04 ("exports status") conflict with design 07:351-352 ("later, under a `formatVersion` bump").

There are also part 5 references inside `definition` that a2's `mapRefs` does not remap: a period's `base` and a target's `source.metricId`. Updates in place keep untouched fields (a3 "patches only the fields model files carry"), so nothing is erased. A fresh import does lose those kinds, though, and a period metric would land with a dangling `base`.

**Recommended:**
- Keep formatVersion 1 as part 7 plans it.
- In a1/a2, remap or skip (with a named reason) metrics whose definition references another metric.
- Have a1's dry run and export list what the files do not carry.
- Correct the consumer claims in p3-00:73-76 and p4-00:74 ("Part 7 exports `StatusDoc`").
- In (c), a1–a4 move after part 5's writers, so they see part 5's kinds.

**If wrong:** a new-project import silently lacks those kinds, or shows "—" for a period metric.

### 11. Part 2's claims about part 8 (p2-00:72, :74)
- Part 2 says part 8 builds column lineage on the stored facts and on `perTableGraph`.
- Design 02:362 agrees, but design 08:59 and p8-01:184 exclude "lineage inside SQL datasets or source tables". p8-01:184 also says part 2's `sourceTable:lineage` builds on part 8's column nodes later.
- No plan connects them, and part 4's "Part 8 can reuse `carriersOf`" is not taken up either.

**Recommended:**
- Correct both index lines to "no current consumer".
- Add a post-part-8 follow-up for column nodes under source tables if the owner wants them.

**If wrong:** nothing breaks; only the docs mislead.

### 12. Fan-out × distinct count (parts 5 and 8)
p8-07:145 says "part 5 adds its own differential case", but part 5 plans none, and design 08:335 asks for one.

**Recommended:** p8-06 adds a `countd` row to `test-fanOut`'s differential. p5-02 lands before it in (c).

**If wrong:** an untested path. The drill-across asks one table per question, so a wrong figure is unlikely.

### 13. `src/ipc/visuals.ts` near the 800 cap
It is 773 today. Projected adds:

| Plan | Adds |
|---|---|
| Part 1 release 2 | about +11 (02 +1, 04 up to +6, 05b +1, 06 ≤3) |
| p4-05 | +2 |
| p5 | +1 |
| p6-02 Task 0 | ≤3 |
| p8-06 | +2 |
| p7-b0 | possibly one `tsc` site |

That projects to about **790–795**.

**Recommended:**
- p6-02 Task 0 puts the joined-category refusal in `drillScope.ts` and calls it with one line.
- Any PR whose diff would take the file past 795 splits `vizDataForUnlocked` out first.
- Each PR body states the file's line count.

**If wrong:** a red `test-file-size` mid-chain, which forces an unplanned split.

### 14. Live features on a semantic dataset (part 7 vs parts 1 and 8)
No plan says whether `live:setBaseFilters` (p1-08) or `live:setCalculated`/`live:checkCalc` (p8-04) apply to a semantic dataset. Its origin has no table or SQL. b1's planner has no stated place for base filters, so a base filter could be skipped and give a wider figure.

**Recommended:**
- p7-b2 either maps base filters into `SemanticQuery.where` (with a parity case) or refuses `live:setBaseFilters` on a semantic dataset.
- p7-b2 refuses calcs (`formulaOverLayer`).
- Both are checked in b2's D16 cases.

**If wrong:** a wider figure from an unapplied always-on filter on a layer.

---

## (c) Combined release order

87 PRs in three gates: the 85 the parts planned, plus `feat/semantic-p1-r1-review-fixes` and p7-f2, both added when the recommendations were applied (see (d)).

**Rules this order follows:**
- A reader ships in a release that is rolled out everywhere before any writer of its field reaches a release.
- No reader release holds another part's release-2 code.
- Writers in one part never precede a reader in another part that must keep their field. That holds here because every reader is in an earlier gate, releases are cut from `develop` (cumulative), and nobody rolls back below a gate.
- The owner may cut extra releases inside a gate. That is always safe; never merge a gate into the one before it.
- Chain the PRs in this order (the owner merges fast).

### Release A: readers and guards (needs only `develop`)

| # | PR | Notes |
|---|---|---|
| 1–6 | p1-09a, p1-08a, p1-01a, p1-04a, p1-02a, p1-05a | Part 1's release-1 chain, in its own order |
| 7 | `feat/semantic-p1-r1-review-fixes` | The whole-release review fixes, after 05a |
| 8–9 | p2-01, p2-02 | The leak fix and its readers. No part 1 dependency |
| 10–11 | p3-01, p3-02 | 02 after p1-01a |
| 12 | p4-01a | After p1-01a |
| 13–14 | p6-01a, p6-05a | After p1-01a, p1-09a and p1-05a. 05a carries the `distinctFor` lock-first line, because part 1 step 06 is not merged yet |
| 15–17 | p8-00a, p8-02, p8-03 | 00a after p1-08a and p1-05a. 02 and 03 store nothing, and 03 follows 00a |

**The owner cuts release A, and it rolls out on every pod.**

### Release B: part 1's features, every feature whose reader is in A, and the readers that need part 1's features

| # | PR | Notes |
|---|---|---|
| 18–27 | p1-01, 02, 03, 04, 05b, 06, 07, 08, 09, 10 | 05b's gate is release A |
| 28–30 | p5-01 (5A reader), p5-02, p5-03 | 01 needs p1-10. 02 and 03 store nothing |
| 31–32 | p7-b0 (reader), p7-b1 | b0 needs all of part 1 |
| 33–38 | p4-01 … p4-06 | Early on purpose: the column ratchet and canaries then bind every later PR (item 6) |
| 39–45 | p2-03 … p2-09 | 07 needs p1-10; 09 needs p1-01 |
| 46–53 | p3-03 … p3-10 | |
| 54–61 | p6-01 … p6-08 | |
| 62–67 | p8-01, p8-04, p8-05, p8-06, p8-07, p8-08 | 01 needs p1-10. 04's gate is 00a, released in A |
| 68 | p4-07 | The column setter, last: every reader before it enforces column rules |

**The owner cuts release B, and it rolls out on every pod.**

### Release C: part 5's and part 7's writers

| # | PR | Notes |
|---|---|---|
| 69–75 | p5-04 … p5-10 | 04's gate: 5A (in B) is rolled out |
| 76–79 | p7-a1 … p7-a4 | They store nothing. Placed after part 5 so a1 sees part 5's kinds, and so a2's lift of the `metric:save`/`update` bodies into `src/ipc/metricSave.ts` moves part 5's checks verbatim instead of part 5 rewriting them |
| 80–84 | p7-b2, b3, c1, e1, d1 | b2's gate: b0 (in B) is released |
| 85–86 | p7-f1, p7-g1 | f1 maps `countd` because p5-04 has merged |
| 87 | p7-f2 | Maps dbt's exact cumulative, conversion, time-offset and window-grouping shapes onto part 5's kinds (item 3). Needs g1 and p5-08. Its plan is to be written before it starts |

**The owner cuts release C.**

### How this differs from the parts' own indexes
- **P3-A, part 4's A and part 6's A** ride with part 1's release 1. Each index allows this or something later.
- **p8-01** cannot be in 8A, because it needs p1-10, so it moves to B.
- **5A and b0** cannot ship before part 1's release 2 is merged, so they are in B, with their writers in C.
- **Part 7's a1–a4** move from part 7's "release 1" to C. That is safe because they store nothing.
- **Part 4's B chain** moves ahead of parts 2, 3, 6 and 8's features.

---

## (d) Applied

The owner took every recommendation in (b), with one choice on item 14: p7-b2 refuses `live:setBaseFilters` on a semantic dataset (with a negative control) instead of mapping base filters into `SemanticQuery.where`. Docs only, no git writes. This round changed 31 plan files and this report: section (c) gained `feat/semantic-p1-r1-review-fixes` and p7-f2, now 87 PRs.

**Every index (all eight):**
- A "Combined release order" section points at (c), says which of this part's PRs are in A, B and C, and states the `src/ipc/visuals.ts` ledger rule (item 13).
- The Release column, the release dividers and the release paragraph now say A, B or C.

**Part-specific index changes:**

| Index | Changes |
|---|---|
| `p1-00-index` | Release 1 is now release A. It also carries p2-01, p2-02, p3-01, p3-02, p4-01a, p6-01a, p6-05a, p8-00a, p8-02 and p8-03 before the owner cuts it. Row 7 `feat/semantic-p1-r1-review-fixes` (the whole-release review fixes, after 05a) is added, and rows 8–17 are renumbered. Release 2 is now release B |
| `p2-00-index` | dbt `sources:` is not in v1 (item 4). The facts and `perTableGraph` lines say "no current consumer" (item 11) |
| `p3-00-index` | Part 4 does not consume `verifiedProblem`; the retired-metric rule is item 8. Part 6 08 adds the topic arm (item 9). Part 7 reads instructions and verified questions only after a later `formatVersion` bump (item 10) |
| `p4-00-index` | Release B order: 01–06 first, 07 last. The `statusFor`, `StatusDoc` and `carriersOf` claims are corrected (items 8, 10, 11). Later parts classify their readers (item 6) |
| `p5-00-index` | 01–03 are in B and 04–10 in C. The part 7 claim now says f1 v1 plus f2 (item 3). "Exported as `count_distinct`" now refers to g1. A "Not planned in parts 1–8" line is added (items 2, 12) |
| `p6-00-index` | `visuals.ts` gets 1 line from 02 (item 13) |
| `p7-00-index` | The table is reordered into B (b0, b1) and C (a1–a4, b2–g1, f2). The f2 row and its scope are added (item 3). A dbt-sources note is added, for later and only if the owner asks (item 4) |
| `p8-00-index` | 01 moves to B. The D20 control is rewritten unconditionally (item 1). The non-goal line and the source-table column-nodes follow-up are added (items 2, 11, 12) |

**Plan files:**

| Plan | Change | Item |
|---|---|---|
| `p3-03` | `catalog:instructions` META in `COLUMN_TREATMENT` | 6 |
| `p3-04` | `copyValueNotes` and `filterLabels` skip `hiddenColumnsFor` columns, with a canary test | 6 |
| `p3-05` | `verified:list` DROP in `COLUMN_TREATMENT`. A question on a retired metric keeps running and carries `retiredNotes`, with a test | 6, 8 |
| `p3-06` | `pickExamples`'s `withheld` adds the hidden columns | 6 |
| `p3-09` | `answer_verified_question` returns the card's `notes` | 8 |
| `p3-10` | `verified:checkResult` REDACT in `COLUMN_TREATMENT` | 6 |
| `p4-01a` | A comment beside `KEPT_RECORD_KEYS` on the Live-only keys. Live writers (`bumpEpoch`, `writeSchemaSync`) and a `copyLive` copy join its test | 5 |
| `p4-01` | `METRIC_PIN` classes `target` and `importedFrom` as out. `DATASET_PIN` pins `live.calculated` and leaves out `origin.readsTables`. Deps include a period metric's `base`. The test comment is extended | 7 |
| `p4-04` | The "Not in this step" line is corrected | 8 |
| `p4-06` | `metricHidden` walks part 5's kinds | 6 |
| `p6-01` | `model:navigation` META | 6 |
| `p6-02` | `visual:drillDown` GATE. Task 0's check moves into `drillScope.ts`, with one line in `visuals.ts` | 6, 13 |
| `p6-07` | `topic:get` META | 6 |
| `p6-08` | The `askGuidance` `'topic'` arm, with a test and a negative control. Part 4's `vocabularyOrder` and hidden drops apply in `topicFacts`, `list_topics` and `inTopic` | 9, 6 |
| `p7-a1` | Part 5 `definition.base` is a reference. A "Not carried by formatVersion 1" list, and `notCarried` on the export reply | 10 |
| `p7-a2` | `mapRefs` remaps `definition.base` or skips the metric `depends_on_skipped`. The dry run states the not-carried list | 10 |
| `p7-b2` | Pins `semantic` backend and model. A caller with hidden columns gets `layerRowPolicy`. `live:setBaseFilters` is refused on a semantic dataset, with a negative control. `live:setCalculated` and `live:checkCalc` are refused `formulaOverLayer`, with a negative control | 7, 6, 14 |
| `p7-f1` | Points at f2 for the skipped shapes | 3 |
| `p7-g1` | `countd` maps to the spec's distinct count, if it has one | 3 |
| `p8-00a` | `writeRecordKeepingPolicy` is never reached on a Live record: a spy test with a negative control | 5 |
| `p8-01` | The part 2 control rewrite is unconditional, with the details. `test-sourceNamesHidden` joins the run list and the commit. `lineage:column` and `lineage:fields` META in `COLUMN_TREATMENT` | 1, 6 |
| `p8-06` | `countd` in the fan-out differential. A many side under column rules is refused `hidden`, and the named team gets the figure as the negative control | 12, 6 |
| `p8-07` | The `countd` sentence now points at 06's case | 12 |
