# Semantic layer part 6, step 06: The Assistant's "By <next level>" chip — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Assistant answer grouped by a hierarchy level, or by a date at a set grain, offers one more follow-up chip, "By state" or "By day": a complete spec that the app re-runs with no model involved.
**Architecture:** `answerChips` (`src/ai/answerSpec.ts:580-622`) is pure and builds every chip from the spec and a context. The context gains the dataset's usable hierarchies and the calendar's date ladder (step 01), read by the two callers (`src/ipc/answers.ts:211`, `src/ipc/liveAnswers.ts:199`) from metadata only. A chip is then re-asked through `answer:rerun` → `computeCard`, the existing door.
**Tech Stack:** `src/ai`, `src/ipc`, `src/app/hierarchies.ts`, self-checks.
**Spec:** docs/semantic-layer/06-navigation.md (D6 Assistant row, D13) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p6-00-index.md
**Branch and PR:** `feat/semantic-p6-06-next-level-chip` off `origin/develop` after step 05 merges (chain order; it needs only step 01), one PR.

## Global Constraints

- No model call and no figure in a chip: it is a spec. The figures come when it is clicked, through `answer:rerun` → `computeCard` (Live: `liveAnswer`), counted like any answer.
- With no hierarchy and no grain, the chip list is byte-identical to today's, so answer turns and `test-answerSpec` stay unchanged.
- A text chip regroups the whole answer by the next level ("break it down further"); it adds no filter. A date chip keeps the category and sets `grain` to `nextGrain(ladder, spec.grain)`, and only when `spec.grain` is set: an auto grain is the server's choice, with no level to step from.
- `src/ai/answerSpec.ts` (639) grows by at most 12 lines; `src/ipc/answers.ts` (510) and `src/ipc/liveAnswers.ts` (211) by 2 each.
- The chip label is words the React UI shows as they come ("By state", "By day"; a week calendar's month reads "By period"). It is not a server sentence for `t()`: `answerChips`' existing labels ("Split by …", "Same for last year") are literals of the same kind.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A chip that names a missing level.** A hierarchy with `missing` levels offers nothing. → Task 1's negative control.
- **The cost of a chip on Live.** Building it reads metadata only (no warehouse statement); clicking it is one answer. → Task 1 counts `fake.calls`.
- **Old turns.** Turns stored before this change keep their chips as stored; only new answers carry the new chip.

## Rolling deploys

No stored field and no new contract. A chip is part of an answer turn, as every chip is; a turn written by a newer pod and read by an older one shows the chip, and clicking it re-runs a plain spec that every release can run.

---

### Task 1: `answerChips` offers the next level

**Files:** Modify `src/ai/answerSpec.ts:580-622` (the ctx gains `hierarchies?`, `ladder?`; one chip after "Split by"), `src/app/hierarchies.ts` (+`hierarchiesFor`), `src/ipc/answers.ts:211`, `src/ipc/liveAnswers.ts:199`. Test: extend `scripts/test-answerSpec.ts`, `scripts/test-liveRouteAnswers.ts`.
**Interfaces:** Consumes `nextLevel`, `nextGrain`, `grainWord`, `dateLadder`, `navHierarchies` (step 01), `activeWeekCal`, part 1's `getTableDoc`. Produces
- `answerChips(spec, ctx: { columns; splitCandidates; hierarchies?: readonly NavHierarchy[]; ladder?: readonly DateGrain[] })`.
- The chip `{ label: \`By ${next}\`, spec: { ...spec, category: next, title: cleanTitle(\`${spec.title} by ${next}\`) } }` for a text level; for a date, `{ label: \`By ${grainWord(g, ladder)}\`, spec: { ...spec, grain: g } }`.
- `hierarchiesFor(projectId: string, datasetId: string): Promise<NavHierarchy[]>` — one catalog read and one `getDatasetMeta`; `[]` on any failure.
- [ ] **Step 1: Write the failing test** — `scripts/test-answerSpec.ts`:
  ```ts
  const CTX = { columns: COLS, splitCandidates: [] };
  const chips = answerChips({ ...SPEC, category: 'region' }, { ...CTX, hierarchies: [GEO], ladder: G });
  ok('By state: the whole answer by the next level', ((c) => !!c && c.spec.category === 'state' && stableStringify(c.spec.filters) === stableStringify(SPEC.filters))(chips.find((c) => c.label === 'By state')));
  ok('no chip at the last level', !answerChips({ ...SPEC, category: 'state' }, { ...CTX, hierarchies: [GEO], ladder: G }).some((c) => c.label.startsWith('By ')));
  ok('a month answer offers days', answerChips({ ...SPEC, category: 'order_date', grain: 'month' }, { ...CTX, ladder: G }).find((c) => c.label === 'By day')?.spec.grain === 'day');
  ok('a 4-5-4 month offers weeks', answerChips({ ...SPEC, category: 'order_date', grain: 'month' }, { ...CTX, ladder: W }).some((c) => c.label === 'By week'));
  ok('an auto grain offers nothing', !answerChips({ ...SPEC, category: 'order_date' }, { ...CTX, ladder: G }).some((c) => c.label.startsWith('By ')));
  ok('NEGATIVE CONTROL: a missing level, and no hierarchies at all, give today\'s chips', stableStringify(answerChips(SPEC, { ...CTX, hierarchies: [{ ...GEO, missing: ['state'] }], ladder: G })) === stableStringify(answerChips(SPEC, CTX)));
  ```
  `scripts/test-liveRouteAnswers.ts`: with Geography saved on the Live dataset, `answer:card` by `region` carries the `By <next>` chip and `fake.calls` grows by the answer's own statement only; `answer:rerun` with the chip's spec answers from the warehouse, and `getDataset` is never called.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-answerSpec.js` → `FAIL By state: the whole answer by the next level`.
- [ ] **Step 3: Implement** — the callers pass `hierarchies: await hierarchiesFor(projectId, spec.datasetId), ladder: dateLadder(!!activeWeekCal())`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-answerSpec.js`, `node scripts/test-answerRefine.js`, `node scripts/test-liveRouteAnswers.js`, `node scripts/test-copilot.js`, `node scripts/test-file-size.js`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add src/ai/answerSpec.ts src/app/hierarchies.ts src/ipc/answers.ts src/ipc/liveAnswers.ts scripts/test-answerSpec.ts scripts/test-liveRouteAnswers.ts` · "Offer the next level of a hierarchy, or of the date ladder, as an answer's follow-up"

### Task 2: The dock shows the chip

**Files:** Test only: extend `web/src/features/assistant/assistant.test.tsx` (an answer card reply carrying the chip); modify `web/src/features/assistant/AnswerCard.tsx` only if the test shows chips are filtered by label.
**Interfaces:** Consumes the answer card's existing chip row.
- [ ] **Step 1: Write the failing test** — an `answer:card` reply with chips `['Split by segment', 'By state', 'Show as table']` renders three chip buttons; pressing "By state" sends `answer:rerun` with `spec.category === 'state'` and the label "By state".
- [ ] **Step 2: Run it** — `npm run test:web -- assistant`. If it passes at once, the row already draws any chip: keep the test as the guard.
- [ ] **Step 3: Implement** — nothing, or the one filter the test exposes.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web -- assistant dockScreens`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/assistant` · "Pin the dock's chip row to whatever chips an answer carries"

## Existing tests that must stay green

`test-answerSpec`, `test-answerRefine`, `test-answerFacts`, `test-answerSaveVisual`, `test-copilot`, `test-liveRouteAnswers`, `test-numberAudit`, `test-file-size`; web `assistant.test.tsx`, `dockScreens.test.tsx`.
