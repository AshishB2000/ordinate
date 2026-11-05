# Semantic layer part 3, step 07: Measuring the Assistant — CI replay, live mode, and the sample set — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Know whether guidance helps, measured on specs and engine figures rather than model prose. CI replays recorded action lines for the sample project's verified questions through the real resolve, validate and compare path. A live-model run asks every question and phrasing three ways and prints match rates. The bundled sample project ships the instructions and verified questions both runs use.
**Architecture:**
- **One judge.** `judgeSpec` (`src/ipc/verifiedJudge.ts`) decides `match`, `differs` or `refused` for a model's spec against a verified question.
  - It validates with `validateAnswerSpec`.
  - The spec matches when `sameChart` holds with `chartType` ignored. That is D9's own rule.
  - For copies only, when the specs differ, it draws both cards through `computeCard` and compares their figures with `Object.is`. So `in ['West']` and `= 'West'` agree.
  - Live is compared on specs only, with no warehouse query.
- **Three users.** 07's CI replay and live mode use it, and so does 10's in-app check.
- **The sample.** `src/app/sampleGuidance.ts` seeds the sample, called with one line from `seedSampleProject`.

**Tech Stack:** `src/ipc`, `src/app/sampleProject.ts`, self-checks (`scripts/test-verifiedEval.ts`, recorded cases in `scripts/verified-eval-cases.ts`, as `scripts/number-fidelity-cases.ts` holds the fidelity gate's).
**Spec:** docs/semantic-layer/03-ai.md D13 (1 and 2), "The bundled sample project ships a few instructions and verified questions" · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p3-00-index.md
**Branch and PR:** `feat/semantic-p3-07-eval` off `origin/develop` after 06 merges, one PR to `develop`.

## Global Constraints

- **The judge scores the spec, never prose.** Prose figures stay the number-fidelity gate's (`scripts/test-number-fidelity.ts`).
- **Outcomes:**
  - `refused`: the validator's reason.
  - `match`: the same chart ignoring `chartType`, or, on a copy, the same labels and the same series values position by position with `Object.is`. Series names are not compared: "sum of revenue" and "sum of Revenue (metric)" chart the same numbers.
  - `differs`: anything else. On Live it is always `differs` once the specs differ (`specOnly`).
- **Leave-one-out:** the question under test is passed as `exclude`. It is then neither an exact hit (`exactHit`, 06) nor an example (`askGuidance(…, { exclude })`, 06).
- **The sample set** (Retail orders, `src/app/sampleProject.ts:61`). It is digit-free apart from the "5" in a question.
  - Instructions:
    1. "When someone says sales, they mean the revenue column."
    2. "Profit is already net of discount; never subtract the discount again."
    3. "Use order_date for any period."
  - Verified questions:
    1. **Revenue by region**: sum of revenue by region. Phrasings "Sales by region", "Which region sells the most".
    2. **Profit by category**: sum of profit by category. Phrasing "Profit per category".
    3. **Top 5 states by revenue**: sum of revenue by state, top 5. Phrasing "Best states by revenue".
    4. **Revenue by month last year**: sum of revenue by order_date, month grain, filtered to the period `last_year`. Phrasing "Monthly revenue last year".

  They are seeded through `changeInstructions` (03) and `saveVerifiedQuestion` (05), so each is drawn once.
- **Live mode** runs only with `ORDINATE_LIVE_MODEL=1` and is never in `npm test`'s default path. It reuses `test-number-fidelity`'s model setup (`:44-62`, the desktop config copy), moved to `scripts/liveModel.ts`, which both suites import.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A wrong spec that scores "match".** A planted wrong measure must report `differs`. → Task 1, the negative control.
- **The replay must go through the real path.** `splitAction`, then `validateAnswerSpec`, then `judgeSpec`. A hand-built spec is not enough. → Task 3.
- **Leave-one-out leaks.** No prompt for a question carries its own text as an example. → Task 3.
- **The sample seed changes other suites.** `test-sampleProject`, `test-pluginSkills`, `test-automationTools` and `test-bundle` seed it. → Task 2 runs them.

## Rolling deploys

The sample seed writes catalog `instructions` and `verified/` records, which every P3-A pod keeps (02). Only new orgs seed a sample, and only while the org has no project.

---

### Task 1: `judgeSpec`

**Files:** Create `src/ipc/verifiedJudge.ts` and `scripts/test-verifiedEval.ts` §1.

**Interfaces:** Consumes `specDatasets`, `specMetrics`, `validateAnswerSpec`, `sameChart`, `computeCard`, `isLive`. Produces:
```ts
export type Outcome = 'match' | 'differs' | 'refused';
export interface Judged { outcome: Outcome; reason?: string; by?: 'spec' | 'figures' }
export async function judgeSpec(projectId: string, q: VerifiedQuestion, raw: unknown, opts?: { specOnly?: boolean }): Promise<Judged>;
```
Both cards are drawn with `computeCard`: the verified one as stored, the model's loose, as `answerFromAction` does (`src/ipc/answers.ts:357`). If either card fails, the outcome is `differs` with that card's reason.

- [ ] **Step 1: Write the failing test** — §1, over the seeded sample (`seedSampleProject`):
  ```ts
  const q = verifiedNamed('Revenue by region');
  ok('the same spec matches by spec', ((j) => j.outcome === 'match' && j.by === 'spec')(await J.judgeSpec(P, q, { dataset: 'Retail orders', category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }] })));
  ok('another chart type still matches', (await J.judgeSpec(P, q, { ...RAW, chartType: 'bar' })).outcome === 'match');
  ok('in [West] and = West agree by figures', ((j) => j.outcome === 'match' && j.by === 'figures')(await J.judgeSpec(P, westEq, { ...RAW_WEST, filters: [{ column: 'region', op: 'in', values: ['West'] }] })));
  ok('NEGATIVE CONTROL: a wrong measure differs', (await J.judgeSpec(P, q, { ...RAW, measures: [{ column: 'profit', aggregation: 'sum' }] })).outcome === 'differs');
  ok('an unknown column is refused, with the reason', ((j) => j.outcome === 'refused' && /nope/.test(j.reason!))(await J.judgeSpec(P, q, { ...RAW, category: 'nope' })));
  ok('Live: spec only, no warehouse query', await noStatements(() => J.judgeSpec(P2, liveQ, LIVE_OTHER)) && (await J.judgeSpec(P2, liveQ, LIVE_OTHER)).outcome === 'differs');
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-verifiedEval.js` → module missing.
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verifiedEval.js`, `node scripts/test-asyncReach.js`.
- [ ] **Step 5: Commit** — `git add src/ipc/verifiedJudge.ts scripts/test-verifiedEval.ts` · "Judge a model's spec against a verified question by spec, then by engine figures"

### Task 2: The sample project's instructions and verified questions

**Files:**
- Create `src/app/sampleGuidance.ts`.
- Modify `src/app/sampleProject.ts:292`: after `await seedSampleMetrics(project.id, ds.id);`, add `await seedSampleGuidance(project.id, ds.id);`.
- Test: extend `scripts/test-sampleProject.ts`.

**Interfaces:** Produces `seedSampleGuidance(projectId: string, datasetId: string): Promise<void>`. It never throws: a failure is logged as `[sample]`, as the metric seed does.

- [ ] **Step 1: Write the failing test** — `test-sampleProject.ts`:
  - the seeded project has 3 instructions and 4 verified questions, and every one `runs`;
  - "Top 5 states by revenue"'s spec has `top: 5`;
  - "Revenue by month last year"'s spec keeps `{ column: 'order_date', period: 'last_year' }`, relative and never dates;
  - a second seed (`again: true`) into a new project makes its own set.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-sampleProject.js` → `FAIL the sample ships verified questions`.
- [ ] **Step 3: Implement** — the set listed in Global Constraints.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-sampleProject.js`, `node scripts/test-pluginSkills.js`, `node scripts/test-automationTools.js`, `node scripts/test-bundle.js`, `node scripts/test-backups.js`, `node scripts/test-onboarding.js`, `DATABASE_URL=… node scripts/test-sampleSeed-db.js`.
- [ ] **Step 5: Commit** — `git add src/app/sampleGuidance.ts src/app/sampleProject.ts scripts/test-sampleProject.ts` · "Ship the sample project with instructions and verified questions"

### Task 3: The CI replay

**Files:** Create `scripts/verified-eval-cases.ts`. Extend `scripts/test-verifiedEval.ts` §2.

**Interfaces:** Produces:
```ts
export interface EvalCase { name: string; recorded: boolean; question: string; verified: string /* the sample question it is scored against */; line: string /* the model's whole reply, ending in its @@ACTION line */; expect: Outcome }
export const EVAL_CASES: EvalCase[];
```
There are at least 12 cases. They include, for each sample question:
- one exact spec (`match`);
- one with only `chartType` changed (`match`).

Across the set they also include:
- an `in` versus `=` pair (`match` by figures);
- a "sales" that resolved to `revenue` (`match`);
- a wrong measure and a wrong period (`differs`);
- an unknown column and a reply with no action line (`refused`).

At least one case is `recorded: true`, a real model reply pasted from live mode (Task 4).

- [ ] **Step 1: Write the failing test** — §2:
  ```ts
  for (const c of EVAL_CASES) {
    const { action } = splitAction(c.line);
    const got = action.kind === 'answer' ? (await J.judgeSpec(P, verifiedNamed(c.verified), action.spec)).outcome : 'refused';
    ok(`${c.recorded ? '[recorded] ' : '[written] '}${c.name}`, got === c.expect, `expected ${c.expect}, got ${got}`);
  }
  ok('the corpus is a corpus', EVAL_CASES.length >= 12 && EVAL_CASES.some((c) => c.recorded));
  ok('every sample question is covered', SAMPLE_QUESTIONS.every((q) => EVAL_CASES.some((c) => c.verified === q && c.expect === 'match')));
  const g = await askGuidance(P, { kind: '' }, 'project', 'Revenue by region', { exclude: idOf('Revenue by region') });
  ok('leave-one-out: its own entry is no example', !g.text.includes('"Revenue by region" →') && g.used.examples.length > 0);
  ok('leave-one-out: and no exact hit', exactHit(await verifiedStates(P), 'Revenue by region', idOf('Revenue by region')) === null);
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-verifiedEval.js` → "Cannot find module './verified-eval-cases'".
- [ ] **Step 3: Implement** — write the cases. The recorded one is added in Task 4.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verifiedEval.js`, `npm test`.
- [ ] **Step 5: Commit** — `git add scripts/verified-eval-cases.ts scripts/test-verifiedEval.ts` · "Replay recorded Assistant replies against the sample's verified questions in CI"

### Task 4: Live mode

**Files:**
- Create `scripts/liveModel.ts`. It holds `useLiveModel(tmpDir)`, which is `scripts/test-number-fidelity.ts:44-62` moved out.
- Modify `scripts/test-number-fidelity.ts` (import it) and `scripts/test-verifiedEval.ts` (§3, live).

**Interfaces:**
- **What is asked.** With `ORDINATE_LIVE_MODEL=1` and a ready model, live mode asks each sample question and each phrasing. Facts come from `ipcCopilot.buildFacts(P, {})`. The guidance comes three ways:
  - `none`;
  - `instructions`: 03's block with `examples` empty;
  - `full`: `askGuidance(…, question, { exclude })`.

  The call is `analyze.askCopilot([], [facts, block].filter(Boolean).join('\n\n'), question)`, and its spec is judged with `judgeSpec`.
- **What it prints.**
  - Match rates per way: `none 4/11 · instructions 6/11 · full 9/11`.
  - Every reply as a ready-to-paste `EvalCase` with `recorded: true`.
- **What it asserts.** A ready model and a 100% parse of action lines, the way the fidelity gate's live mode asserts prose. It does not assert a match rate.

- [ ] **Step 1: Write the failing test** — §3, live only: `ok('LIVE: a model is configured', await execConfig.executionReady())` and `ok('LIVE: every reply carries an action line', parsed === asked)`. Without the env var, §3 is skipped with a one-line note, as `test-number-fidelity` does.
- [ ] **Step 2: Run it to see it fail** — `ORDINATE_LIVE_MODEL=1 node scripts/test-verifiedEval.js`. With no desktop config this is `FAIL LIVE: a model is configured`, which is expected on CI.
- [ ] **Step 3: Implement** — as above. Paste one recorded reply into `verified-eval-cases.ts`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verifiedEval.js` (fixture mode), `node scripts/test-number-fidelity.js`. Locally with a model: `ORDINATE_LIVE_MODEL=1 node scripts/test-verifiedEval.js`, and keep its printout in the PR description.
- [ ] **Step 5: Commit** — `git add scripts/liveModel.ts scripts/test-number-fidelity.ts scripts/test-verifiedEval.ts scripts/verified-eval-cases.ts` · "Measure the Assistant on the sample's verified questions with a live model, three ways"

## Existing tests that must stay green

`test-verifiedEval`, `test-verified`, `test-verifiedAsk`, `test-verifiedPick`, `test-number-fidelity`, `test-sampleProject`, `test-sampleSeed-db` (with `DATABASE_URL`), `test-pluginSkills`, `test-automationTools`, `test-bundle`, `test-backups`, `test-onboarding`, `test-lineage`, `test-summaryCard`, `test-analyticsServer`, `test-asyncReach`, `test-file-size`; every `__golden__` fixture (never re-recorded).
