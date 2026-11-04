# Semantic layer part 7 (portability) — implementation plan index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan below task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implement the plans in the order of the table below, one PR each.

**Goal:** Move definitions in and out of Ordinate: export and import the model as reviewable files (and drive that from git over MCP), import dbt's simple, ratio and derived metrics as a copy, export an Ossie file, and for a company that already has a semantic layer, query it live (Snowflake semantic views, then Cube, then dbt as beta) so its metrics keep their own math.

**Architecture:** Postgres stays the store; files and other layers are doors (spec approach A). **Model files** (`src/app/model*.ts`) are a1's metadata-only export (sorted JSON, a markdown guide per dataset, `base` hashes), a2's stateless dry run (id then name, three-way only within one project, the editor's own gates, a plan hash), a3's apply through each store's own save, and a4's MCP tools. dbt import (f1) and the Ossie export (g1) are a translator into, and a mapper out of, the same shapes. **External layers** are Live datasets with a top-level `semantic` block: b1 widens the IR (`{ metric }`), adds a neutral `SemanticQuery` plan whose answers are read back into the rows `shape.ts` already labels, and carries layer questions through the one `warehouse()` door; b2 adds the records, the sync, read-only mirror metrics (`{ external, additive, layer }`) and the three doors; b3 the screens; c1, e1 and d1 each add one encoder and one connector capability. A reader release (b0) ships first so no older pod can erase a mirror.

**Tech Stack:** TypeScript server (`src/app`, `src/engine/live`, `src/connectors`, `src/ipc`, `src/api`, `src/automation`), the zip reader and writer, `node:crypto`, React 19 (`web/src/features/model`, `connections`, `visuals`, `live`), self-check suites, Vitest, Playwright, the warehouse nightly.

**Spec:** [docs/semantic-layer/07-portability.md](../../semantic-layer/07-portability.md) (approved 2026-11-03; the owner took every recommended answer: JSON model files with no new dependency; restricted viewers refused on every external layer, lifted per backend once a binary comparison is pinned; no dbt Cloud account yet, so Cube before dbt and dbt beta).

**Precondition:** all of part 1 is merged (both releases, through `feat/semantic-p1-10-data-model-section`): a1 exports the kinds part 1 adds, and b0/b2 build on part 1 D16 (`planMetricMeasures`, step 03), the additivity rule (step 02) and the Data model page (step 10).

## The PR chain

Two tracks on different files (model files in `src/app`; layers in `src/engine/live` and `src/connectors`), each chained in order. The owner merges fast, so push them as one ordered chain.

| # | PR branch | Plan | Needs merged first | Release |
|---|---|---|---|---|
| 1 | `feat/semantic-p7-a1-model-export` | [a1](2026-11-04-semantic-layer-p7-a1-model-export.md) | part 1 complete | 1 |
| 2 | `feat/semantic-p7-a2-import-plan` | [a2](2026-11-04-semantic-layer-p7-a2-import-plan.md) | a1 | 1 |
| 3 | `feat/semantic-p7-a3-import-apply` | [a3](2026-11-04-semantic-layer-p7-a3-import-apply.md) | a2 | 1 |
| 4 | `feat/semantic-p7-a4-model-mcp` | [a4](2026-11-04-semantic-layer-p7-a4-model-mcp.md) | a3 | 1 |
| 5 | `feat/semantic-p7-b0-external-reader` | [b0](2026-11-04-semantic-layer-p7-b0-external-reader.md) | part 1 complete | 1 (the reader) |
| 6 | `feat/semantic-p7-b1-semantic-engine` | [b1](2026-11-04-semantic-layer-p7-b1-semantic-engine.md) | b0 | 1 |
| | **owner cuts release 1, and it rolls out on every pod** | | | |
| 7 | `feat/semantic-p7-b2-semantic-datasets` | [b2](2026-11-04-semantic-layer-p7-b2-semantic-datasets.md) | b1, a3 (it edits a2/a3's files), **b0 released** (merge gate) | 2 |
| 8 | `feat/semantic-p7-b3-semantic-web` | [b3](2026-11-04-semantic-layer-p7-b3-semantic-web.md) | b2 | 2 |
| 9 | `feat/semantic-p7-c1-snowflake-semantic` | [c1](2026-11-04-semantic-layer-p7-c1-snowflake-semantic.md) | b3 | 2 |
| 10 | `feat/semantic-p7-e1-cube` | [e1](2026-11-04-semantic-layer-p7-e1-cube.md) | c1 | 2 |
| 11 | `feat/semantic-p7-d1-dbt-semantic-layer` | [d1](2026-11-04-semantic-layer-p7-d1-dbt-semantic-layer.md) | e1 | 2 (beta) |
| 12 | `feat/semantic-p7-f1-dbt-import` | [f1](2026-11-04-semantic-layer-p7-f1-dbt-import.md) | a4, **b0 released** (merge gate) | 2 |
| 13 | `feat/semantic-p7-g1-ossie-export` | [g1](2026-11-04-semantic-layer-p7-g1-ossie-export.md) | f1 (shared files) | any (stores nothing) |

13 PRs. Release 1 is a1–a4, b0 and b1 (only b0 is required there; the others store nothing and are ready). Release 2 is b2 through g1. The merge gates in b2 and f1 are 05b's: `git tag -l 'v*' --no-contains <b0 merge sha>` prints nothing, or a `v*` tag contains b0.

## Rolling deploys (what an older pod does)

| Stored | Written by | A pod before b0 | A b0 pod |
|---|---|---|---|
| Metric `definition: { external, additive?, layer? }` | b2's sync | **erases it on the next re-save** (→ `{ column: '', aggregation: 'sum' }`) | keeps it, refuses every figure |
| Metric `importedFrom` | f1 | drops it on re-save | keeps it |
| Dataset top-level `semantic` | b2 | untouched by every Live writer; origin has no table or SQL, so every question refuses `badSource` | refuses `semanticPending` at every door |
| dbt and Cube connection records | e1, d1 | unknown connector: "Unknown connection kind", nothing written | same |
| Model files, plans, Ossie | a1–a4, g1 | nothing stored; a missing contract is a 404 | — |

## Global Constraints

- No push, `gh` command or release on weekdays 08:00–18:00 local time (the owner's global rule, enforced by a hook). No `v*` tag, GitHub release or image push without the owner.
- One worktree per PR off `origin/develop` (`feature-branch-workflow` skill); never commit to `develop`; never `git checkout` or `git switch` in the shared clone. No `Co-Authored-By` or any AI trailer on a commit.
- **No new runtime dependency:** JSON (no YAML parser), the repo's zip reader and writer, `node:crypto` for Cube's HS256 token, plain JSON POSTs for GraphQL. A step that finds it needs one (an Arrow reader for dbt, a JSON Schema validator for Ossie) stops and asks the owner.
- **No migration:** records and top-level keys only, sanitized, every one read by an earlier release (b0) before it is written.
- **Contracts:** `model:export`, `model:importPlan`, `model:importApply`, `model:exportOssie`, `connection:semanticModels`, `connection:addSemanticDataset`: each `write`, project scope, zod input. `src/api/index.ts`, `web/src/app/routes.tsx` and `nav.ts` are append-only. No new `read` contract, so nothing new in `scripts/rowPolicyReaders.ts`. `node scripts/check-contracts.js` reports 0.
- **Live:** every figure on a semantic dataset goes through `vizDataFor`, `computeCardMetric` or `computeCard`, and every layer question through `warehouse()` (`test-liveUsage`). Semantic datasets join `test-liveSafetyNet`. No JS fallback: per-backend parity against an extract (`Object.is`), golden requests never re-recorded, real engines nightly.
- **Security:** every socket through the SSRF guard (`SSRF_ALLOW` for a private Cube); layer tokens are `secret: true` connection fields with a `test-secrets` canary; no `eval`, no child process; no model name, view, environment id, URL, table name or SQL in any dataset reply or plan.
- **Restricted callers:** refused model export and import (`restrictedOn`), and refused on every external layer (`layerRowPolicy`) until a backend's binary comparison is pinned (c1 may lift Snowflake).
- **Anti-goals held by tests:** no mirrored math (mirrors hold a name), no silent overwrite or delete (dry run, hash, "only here"), no Ordinate arithmetic on a layer's figures ("Other" is a second question), no AI in any mapping.
- Sentences through `t()` and `node scripts/i18n-extract.js`. File caps 500/800; near the cap: `src/data/datasets.ts` 799, `src/ipc/metrics.ts` 563, `src/server/app.ts` 652, `src/engine/live/liveSpec.ts` 457, `compile.ts` 455, `snowflake.ts` 443, `liveQuery.ts` 406. New logic goes in new files.
- Required checks on every PR: `smoke (all shards)` and `oxlint (blocking)`; `npm run lint` 0.

## Review Focus

1. **An older pod erasing a mirror or an import tag** (b0's re-save tests, b2/f1's merge gates).
2. **A layer's figure combined by Ordinate:** "Other", totals, running totals, formulas over mirrors (b1 Task 3, b2 Task 4).
3. **An import that overwrites newer work or deletes** (a2 Task 3, a3 Task 1: stale hash, `newerHere`, `moved`, never a delete).
4. **Leaks:** secrets, origins and row-rule values in files, plans, Ossie, dataset replies and layer errors (a1 Task 2, a2 Task 3, b2 Task 3, e1/d1 canaries).
5. **"To verify" stays verified:** c1, e1, d1 and g1 each start with a spike that records the vendor's real behaviour before any adapter code; d1 and its fixtures stay labelled beta.

## Calls made while planning (deliberate; a reviewer should know)

- **A reader release, b0**, ahead of the spec's 7b. `sanitizeDefinition` would rewrite an external definition into `sum of ''` on any older pod's next save, and `normalize` drops `importedFrom`. b0 keeps both, refuses every figure, and types the external `layer` as an open backend id so a later backend needs no reader release of its own.
- **A semantic dataset's origin holds no table or SQL**, and its block sits at the record's top level (08a's place for `baseFilters`): pods older than b0 already refuse it as `badSource`.
- **Model files key nothing by user text** (fields, labels, relationships are sorted arrays): JS orders integer-like keys first. The zip is written with the DOS-epoch timestamp, so the zip, not only its files, is byte-identical within a release.
- **Not exported:** derived values (`keyCheck`, a relationship's `verified` and `warning`), stamps, and metric trees (not in formatVersion 1; updates never touch them). Mirrors stay with their layer.
- **Three-way only for objects matched by id** (a `base` includes the id). Matched by name, across projects, every difference is an update. File unchanged but project edited: unchanged, "newer here", nothing written.
- **Sensitivity:** only `none → a mark` applies; any change away from a mark is skipped.
- **Write order** table and field docs → base filters → relationships → terms → metrics (the spec had relationships last, but a filter step's `via` names a relationship).
- **Undo:** the catalog and relationships keep no versions, so an apply first offers a download of the model as it was. New objects get fresh ids (the bundle import keeps ids unique across a pod).
- **Import is refused for a restricted caller too**, not only export: the dry run shows the project's term values and labels.
- **`export_model` needs an editor though it writes nothing:** `Command.needs: 'editor'`.
- **One neutral `SemanticQuery`** with per-backend encoders; each backend's per-PR fake decodes our own request back to it. Snowflake's request is SQL but still crosses `semantic.run`, so all layers share one door. A split chart asks up to four counted questions.
- **Mirrors are written after the dataset's one sync write**, each through the metric save; a name clash appends the connection name; `additive` is stored on the definition by the sync.
- **New picker group "Semantic layers"** for Cube and dbt.
- **A dbt dataset** is a saved query if the API lists them, else one semantic model (d1's spike decides). **dbt import** reads `semantic_manifest.json` (a full `manifest.json` past the value budget is refused), with a `datasetMap` choice so the person confirms each model's dataset.

## Execution

Implement in the table's order. For each PR: create its worktree off `origin/develop`, implement the plan's tasks with their tests, run the listed suites, push and open the PR outside work hours, wait for CI and the owner's merge, then start the next. A spike task that cannot get its answers (no account, no published spec) stops its PR and tells the owner.
