# Semantic layer part 3 — AI guidance: implementation plan index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan below task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implement the plans in the order of the table below, one PR each.

**Goal:** Make the Assistant use what part 1 writes down. Every cell in a prompt is quoted. Each project gets editor-written instructions. Copies get sample values. Value labels map filter values. Verified questions are stored as specs and answered exactly, with no model. They also serve as examples, chips and a "✓ Verified" mark. A test chat on the Data model page saves good answers. MCP agents can read all of this. An eval runs in CI, live, and in the app.

**Architecture:** Guidance is data around the existing spec pipeline (approach A). The guidance block, sample values and examples go into the **user turn**. They never go into the system prompt. A pure builder (`src/ai/guidanceFacts.ts`) writes them, and one loader (`src/ipc/guidance.ts`) reads the stores. `copilot:ask`, `narrate` and the dashboard draft each call the loader through a one-line hook. A verified question is a new record kind that holds an `AnswerSpec` and never a figure. Every figure still comes from `computeCard`, under the row lock and through the Live door. `validateAnswerSpec`, `sameChart` and `computeCard` are reused unchanged. The only step with no model is an exact match on a squashed question key, and it cannot pick the wrong question.

**Tech Stack:** TypeScript server (`src/ai`, `src/ipc`, `src/api`, `src/app`, `src/analysis`, `src/automation`), DuckDB value index (`src/engine/dataSearchResident.ts`), the in-process job queue (`src/app/jobs.ts`), React 19 (`web/src/features/model/assistant/`, the dock, Home), self-check suites, Vitest, Playwright.

**Spec:** [docs/semantic-layer/03-ai.md](../../semantic-layer/03-ai.md), approved 2026-11-03. Every Owner's answer took the recommended option: an Assistant tab, verified questions that work with no model, and the in-app check, built last. It builds on [part 1](2026-11-03-semantic-layer-p1-00-index.md).

## The PR chain

There are two releases. **Release P3-A** holds the security fix and the readers. Once every pod runs it, any pod keeps the catalog's `instructions` and a turn's `guidance` verbatim, and its bundles and backups carry `verified/` records. **Release P3-B** holds the features. The owner cuts both. P3-A's PRs need nothing from part 1's release 2, so they may merge before it is cut and ride in it. P3-B needs part 1's release 2 merged (steps 01, 05b, 06, 10) **and** P3-A deployed on every pod.

| # | PR branch | Plan | Needs merged first | Release |
|---|---|---|---|---|
| 1 | `feat/semantic-p3-01-quote-cells` | [01](2026-11-04-semantic-layer-p3-01-quote-cells.md) | — | P3-A |
| 2 | `feat/semantic-p3-02-readers` | [02](2026-11-04-semantic-layer-p3-02-readers.md) | — | P3-A |
| | **owner cuts P3-A (or it rides in part 1's release 2), and it rolls out everywhere** | | | |
| 3 | `feat/semantic-p3-03-instructions` | [03](2026-11-04-semantic-layer-p3-03-instructions.md) | 02 released, part 1 step 10 (and 01) | P3-B |
| 4 | `feat/semantic-p3-04-sample-values` | [04](2026-11-04-semantic-layer-p3-04-sample-values.md) | 01, 03, part 1 step 06 | P3-B |
| 5 | `feat/semantic-p3-05-verified` | [05](2026-11-04-semantic-layer-p3-05-verified.md) | 04, part 1 step 05b | P3-B |
| 6 | `feat/semantic-p3-06-exact-match` | [06](2026-11-04-semantic-layer-p3-06-exact-match.md) | 05 | P3-B |
| 7 | `feat/semantic-p3-07-eval` | [07](2026-11-04-semantic-layer-p3-07-eval.md) | 06 | P3-B |
| 8 | `feat/semantic-p3-08-test-chat` | [08](2026-11-04-semantic-layer-p3-08-test-chat.md) | 07 | P3-B |
| 9 | `feat/semantic-p3-09-mcp` | [09](2026-11-04-semantic-layer-p3-09-mcp.md) | 08 (the sample set from 07) | P3-B |
| 10 | `feat/semantic-p3-10-check` | [10](2026-11-04-semantic-layer-p3-10-check.md) | 09 | P3-B |

**Merge gate for #3:** `git tag -l 'v*' --no-contains <02's merge sha>` must print nothing. In other words, no released server that lacks 02 may roll straight into P3-B. `docs/server/upgrade.md` says so (02 Task 4).

## Rolling deploys (what a pod of the previous release does)

| New stored thing | Written by | A pre-P3-A pod reads and re-saves it | Plan |
|---|---|---|---|
| `CatalogFile.instructions` | 03 | **Dropped** on its next catalog write. `sanitizeCatalog`, `src/app/catalog.ts:198-228`, whitelists sections | Reader in 02 |
| `CopilotTurn.guidance` | 06, 08 | **Dropped** on its next append to the project's shared `copilot.json`. `normalizeTurns`, `src/ai/copilot.ts:204` | Reader in 02 |
| `verified/<id>.json` | 05 | Never read, but its bundle export and backups **drop** it, and its import refuses a bundle holding it (`bundleRules.ts:31-61`, `bundle.ts:203`) | Bundle rule in 02 |
| `trash/verified/` | 05 | Hidden from its Trash list and never purged (`trashStore.ts:119`). Harmless | — |
| `projects/<id>/assistant-check.json` | 10 | Never read. It is in no bundle (not whitelisted), so no pod exports it | — |
| `model:overview` item `verified_broken` | 05 | A reply field. An old browser draws an unlabelled chip until it reloads | Accepted |
| Job kind `assistant-check` | 10 | In-process queue (`src/app/jobs.ts`); it never crosses pods | — |

A P3-A pod given a P3-B browser answers `catalog:setInstructions`, `verified:*` and `catalog:instructions` with 404. The new screens show their error state with Retry, and Retry reaches a new pod.

## Global Constraints

- No remote work at all on weekdays 08:00–18:00 local time. That means no `git push`, `pull`, `fetch` or `clone`, and no `gh` command of any kind; a hook enforces this. Creating a worktree off `origin/develop` needs a fresh fetch, so do it outside that window. No `v*` tag, release or image push without the owner.
- One worktree per PR off `origin/develop`. Never commit to `develop`, and never `git checkout` or `git switch` in the shared clone.
- No `Co-Authored-By` or AI trailer on any commit.
- No new runtime dependency, no migration, no telemetry. New stored data is catalog JSON, a record kind or one record file, each with additive optional fields.
- **The system prompt is closed.** `CHAT_SYSTEM_PROMPT` and `buildSystemPrompt` are not changed. `src/ai/analyze.ts` is at 851 lines on the file-size allowlist, so not one line is added to it.
- **File caps (500 soft / 800 hard).** Near the cap: `src/ai/answerSpec.ts` 639, `src/ipc/copilot.ts` 605, `src/ai/copilotFacts.ts` 577, `src/ai/copilot.ts` 554, `src/ipc/answers.ts` 510, `src/app/catalog.ts` 428, `src/automation/registry.ts` 394, `web/src/features/assistant/Dock.tsx` 412, `web/src/features/settings/WorkspaceTab.tsx` 412. Each of these takes hooks of at most a few lines; the work goes in new files.
- `src/api/index.ts`, `web/src/app/routes.tsx` and `web/src/app/nav.ts` are append-only. Part 3 adds no route and no nav entry: the Assistant tab is an entry appended to part 1's `TABS`.
- Every new channel has a zod contract with the narrowest access and project scope, and `node scripts/check-contracts.js` reports 0. New `read` contracts are classified in `scripts/rowPolicyReaders.ts`. `verified:save` draws a card, so it joins `scripts/test-liveSafetyNet.ts`.
- Sentences go through `t()` in new `*Messages.ts` files added to `MAIN_FILES`, then `node scripts/i18n-extract.js`. The React UI is English-only.
- A project that fills in nothing behaves as today, except for 01's quoting. Golden fixtures are never re-recorded.
- `npm run lint` must report zero. Required checks: `smoke (all shards)` and `oxlint (blocking)`.

## Review Focus

1. **A restricted viewer** gets no index value, label mapping outside their rows, value-filter example, chip, match or MCP spec on a dataset with rules. Owners: 04, 05, 06, 09.
2. **Nothing reaches a figure but the engine.** A verified record holds a spec. The mark is computed per draw and never stored or read from model output. Owners: 05, 06.
3. **Near misses never match.** Matching is exact on the squashed key only. "…last year" goes to the model. Owner: 06.
4. **No prompt can be steered by a cell.** Every cell is `quoted()`, editor text is one line, and the fence marker is refused. Owners: 01, 03.
5. **Mixed versions.** A P3-A pod keeps `instructions`, `guidance` and `verified/` through every re-save, backup and import. Owner: 02.

## Interfaces other parts consume

- **Part 4 (governance):** `VerifiedQuestion` and `listVerified`/`getVerified` from `src/analysis/verifiedQuestions.ts`. `verifiedProblem(projectId, q, env)` (`src/ipc/verifiedState.ts`) is where a retired metric becomes "no longer runs".
- **Part 6 (views):** `askGuidance(projectId, context, factsKind, question, opts)` (`src/ipc/guidance.ts`) is the one place guidance is assembled, so a view can scope it there.
- **Part 7 (portability):**
  - `Instruction`, `sanitizeInstructions` and `CatalogFile.instructions` (`src/app/instructions.ts`).
  - `sanitizeVerified` and `RECORD_DIR.verified = 'verified'`.
  - The bundle rule `verified/<uuid>.json`, counted as `verified`.
- **Part 2:** nothing. A source-table note must never enter `askGuidance`.

## Calls made while planning (deliberate; the approved design differs from the code in these places)

1. **"The check is a Postgres job" (D13.3, Constraints).** `src/server/jobs/` runs recurring per-org schedules only. It has no enqueue, no payload and no result column, and adding them needs a migration, which the spec forbids. So the check runs on the in-process queue (`src/app/jobs.ts`), the same one `quality:run` uses. Its progress and result live in a project record that any pod reads, and a stale heartbeat marks a run whose pod died (10).
2. **"It spends the org's model budget" (Q3).** No model budget or usage counter exists (`docs/ai-models/00-plan.md:46`: "Not now"). The bounds are the 50-question cap and one live run per project.
3. **D3 named too few printers.** Besides `datasetFacts` and `captureFacts`, these also print cells raw:
   - `visualFacts`' labels and series names;
   - `answerFacts`' chart, extreme, share and latest lines (narration);
   - `driversFacts`' members;
   - `statsFacts`' groups and levels;
   - insight sentences and filter labels that embed values.

   01 covers all of them, and a canary sweep pins it.
4. **The guide moves (D15 vs part 1 step 01 Task 6).** Part 1 prints the guide under "Table notes", cut at 1,200 characters. 03 moves it into the guidance block with D15's caps of 2,000 and 200, and updates part 1's test on purpose.
5. **Value labels already print (D6 vs part 1 step 06 Task 6).** Part 1 prints them as `codes "EU" = Europe`: 20 per column, none for a closed caller or a personal/financial column. 04 keeps that format, quotes it per D3, and adds only the filter-value mapping.
6. **D4 on S3.** `<id>.search.json` sits beside a pod's local cached Parquet. `readIndex` of an `s3://` URL returns null, and `scheduleIndex` then writes nothing. So on S3 a copy gets sample values only once that pod has the table cached. The index is already per pod, so no extra cache is needed. It is also sorted by value, not by frequency, so 04 re-sorts it by row count.
7. **No model, and the composer.** The dock disables its composer without a model (`Dock.tsx:92-94`). For Owner's answer 2, 06 enables it whenever the project has a working verified question.
8. **The test thread is a thread like any other (D11).** Threads have no purpose field, and `normalize` whitelists thread fields. "Data model test" is found by its title, and it shows in the dock's thread list.
9. **No `verified:update` channel.** `verified:save` with `id` and `base` (the edit-conflict tag) edits a question in place.
10. **"Assistant rules" is in Admin, not Settings (D14).** It lives under Admin → Workspace (`/admin?tab=workspace`, `WorkspaceTab.tsx:347-382`). 03 relabels it there.
11. **The fence marker is `<<<GUIDANCE` … `GUIDANCE`.** Editor text holding `<<<` or the capitalised word `GUIDANCE` is refused. A stored text holding it is left out of the block, not erased.
12. **The figure-token warning** matches a currency sign before a digit, a decimal, a thousands separator, or a percent. So "90 days" gets no warning and "12%" does.
13. **No word lists or caches beyond what exists.** Ranking reuses `answerSuggest`'s `words` (now exported), and the 100-distinct cut is `COPY_VALUES_MAX_DISTINCT`. Each read re-validates against metadata, with no per-pod cache.
14. **`guidance` is stored on the assistant turn**, so a reloaded test chat still says how it answered. The cost is the reader in 02.
15. **Check the Assistant asks each question's main text once,** not its phrasings: one call per question, as Q3 costs it. Live mode in CI asks the phrasings too.

## Execution

Implement in the table's order. For each PR:
1. Create its worktree off `origin/develop`.
2. Run the plan's tasks with their tests, then the suites the plan lists.
3. Push and open the PR outside work hours.
4. Wait for CI and the owner's merge, then start the next PR.
