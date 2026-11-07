// Measuring the Assistant on verified questions (semantic layer part 3 D13): one judge of a model's SPEC — never
// its prose — against a verified question, by spec first and, on a copy, by the engine's figures.
//
//   §1 judgeSpec over the seeded sample (and a Live dataset: specs only, no warehouse query)
//   §2 CI replay: each recorded reply in ./verified-eval-cases.ts through the real path — `splitAction`, the
//      validator, the judge — against the sample's verified questions; and leave-one-out holds
//   §3 LIVE MODE (ORDINATE_LIVE_MODEL=1 and a configured model; never in CI): asks every sample question and
//      phrasing three ways — no guidance, the instructions, the instructions and verified examples (leave-one-out)
//      — judges each spec, prints the match rates and every reply as a ready-to-paste recorded case. It asserts a
//      model and a parsed action line per reply, never a match rate.
//
// A model is reached only through this machine's desktop config, in a local (not server-mode) process
// (./liveModel.ts), so live mode runs §1 and §2 there too, without the Live-dataset checks: those need the
// server-mode harness (a Live dataset over the fake warehouse), which is fixture mode's.
//
//   npm run build:ts && node scripts/test-verifiedEval.js
//   ORDINATE_LIVE_MODEL=1 [ORDINATE_LIVE_CLI=claude] node scripts/test-verifiedEval.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { EVAL_CASES, type EvalCase } from './verified-eval-cases';
import { useLiveModel } from './liveModel';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const LIVE = process.env.ORDINATE_LIVE_MODEL === '1';
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-verifiedeval-'));
if (LIVE) {
  useLiveModel(tmpUserData);
  process.env.ORDINATE_LOCAL_DIR = tmpUserData;
}
// Server mode (and the fake warehouse) for fixture mode; loaded BEFORE anything that reads app paths.
const H: typeof import('./liveQueryHarness') | null = LIVE ? null : require('./liveQueryHarness');

const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const verified: typeof import('../src/ipc/verified') = require('../src/ipc/verified');
const store: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const J: typeof import('../src/ipc/verifiedJudge') = require('../src/ipc/verifiedJudge');
const { splitAction }: typeof import('../src/ai/suggestedAction') = require('../src/ai/suggestedAction');
const { askGuidance }: typeof import('../src/ipc/guidance') = require('../src/ipc/guidance');
const { exactHit }: typeof import('../src/ai/verifiedPick') = require('../src/ai/verifiedPick');
const { verifiedStates }: typeof import('../src/ipc/verifiedState') = require('../src/ipc/verifiedState');
const { SAMPLE_VERIFIED }: typeof import('../src/app/sampleGuidance') = require('../src/app/sampleGuidance');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
type VerifiedQuestion = import('../src/analysis/verifiedRules').VerifiedQuestion;
type Outcome = import('../src/ipc/verifiedJudge').Outcome;
type Spec = import('../src/ai/answerSpec').AnswerSpec;

const REV = [{ column: 'revenue', aggregation: 'sum' as const }];
const RAW = { dataset: 'Retail orders', category: 'region', measures: REV };
const RAW_WEST = { dataset: 'Retail orders', category: 'state', measures: REV };

async function save(projectId: string, question: string, spec: Spec): Promise<VerifiedQuestion> {
  const r = await verified.saveVerifiedQuestion(projectId, { question, spec: { ...spec } as Spec & Record<string, unknown> });
  if (!r.ok) throw new Error(`fixture "${question}": ${r.error}`);
  return r.q;
}

/** Whether `fn` sent the warehouse no statement. */
async function noStatements(h: NonNullable<typeof H>, fn: () => Promise<unknown>): Promise<boolean> {
  const before = h.fake.calls.length;
  await fn();
  return h.fake.calls.length === before;
}

// ── §3 Live mode ─────────────────────────────────────────────────────────────

type Way = 'none' | 'instructions' | 'full';
const WAYS: Way[] = ['none', 'instructions', 'full'];

async function runLive(P: string): Promise<void> {
  const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
  const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
  const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
  ok('LIVE: a model is configured', await execConfig.executionReady(), 'set one up, or run without ORDINATE_LIVE_MODEL=1');
  if (!(await execConfig.executionReady())) return;

  const facts = await ipcCopilot.buildFacts(P, {}); // the project inventory, as the in-app check builds it
  const instructions = await askGuidance(P, { kind: '' }, 'project'); // 03's block: no question, so no examples
  const matched: Record<Way, number> = { none: 0, instructions: 0, full: 0 };
  const recorded: EvalCase[] = [];
  let asked = 0;
  let parsed = 0;
  for (const s of await verifiedStates(P)) {
    for (const question of [s.q.question, ...s.q.phrasings]) {
      for (const way of WAYS) {
        const block = way === 'none' ? '' : way === 'instructions' ? instructions.text
          : (await askGuidance(P, { kind: '' }, 'project', question, { exclude: s.q.id })).text; // leave-one-out
        const res = await analyze.askCopilot([], [facts.text, block].filter(Boolean).join('\n\n'), question);
        asked++;
        if (!res.ok) {
          console.log(`[${way}] ${question}: model error ${res.errorType}`);
          continue;
        }
        const action = res.suggestedAction;
        if (action.kind !== 'none') parsed++;
        const judged: Outcome = action.kind === 'answer' ? (await J.judgeSpec(P, s.q, action.spec)).outcome : 'refused';
        if (judged === 'match') matched[way]++;
        // The reply as the app read it: its prose, then its action line re-serialised.
        const line = action.kind === 'none' ? res.text : `${res.text}\n@@ACTION ${JSON.stringify(action)}`;
        recorded.push({ name: `${s.q.question} (${way}): "${question}"`, recorded: true, question, verified: s.q.question, line, expect: judged });
      }
    }
  }
  const per = asked / WAYS.length;
  console.log(`\nLIVE match rates: ${WAYS.map((w) => `${w} ${matched[w]}/${per}`).join(' · ')}\n`);
  console.log('Every reply, as recorded cases:');
  for (const c of recorded) console.log(`  ${JSON.stringify(c)},`);
  ok('LIVE: every reply carries an action line', parsed === asked, `${parsed} of ${asked}`);
}

async function main(): Promise<void> {
  const live = H ? await H.setupOrg(H.ORG_A) : null;
  if (!H) await projects.init();
  const inOrg = (fn: () => Promise<void>): Promise<void> => (H ? H.as(H.ORG_A, fn) : fn());
  await inOrg(async () => {
    const P = String((await sample.seedSampleProject({ again: true })).projectId);
    const dsId = (await datasets.listDatasets(P))[0].id;
    const base: Spec = { datasetId: dsId, category: 'region', measures: REV, filters: [], chartType: 'column', title: 'Revenue by region' };
    const verifiedNamed = async (q: string): Promise<VerifiedQuestion> => (await store.listVerified(P)).find((v) => v.question === q)!;

    // ── §1 judgeSpec ────────────────────────────────────────────────────────
    const q = await verifiedNamed('Revenue by region');
    const westEq = await save(P, 'West revenue by state', { ...base, category: 'state', filters: [{ column: 'region', op: '=', value: 'West' }], title: 'West revenue by state' });
    const same = await J.judgeSpec(P, q, RAW);
    ok('the same spec matches by spec', same.outcome === 'match' && same.by === 'spec', JSON.stringify(same));
    ok('another chart type still matches', (await J.judgeSpec(P, q, { ...RAW, chartType: 'bar' })).outcome === 'match');
    const west = await J.judgeSpec(P, westEq, { ...RAW_WEST, filters: [{ column: 'region', op: 'in', values: ['West'] }] });
    ok('in [West] and = West agree by figures', west.outcome === 'match' && west.by === 'figures', JSON.stringify(west));
    const wrong = await J.judgeSpec(P, q, { ...RAW, measures: [{ column: 'profit', aggregation: 'sum' }] });
    ok('NEGATIVE CONTROL: a wrong measure differs', wrong.outcome === 'differs' && wrong.by === 'figures', JSON.stringify(wrong));
    ok('NEGATIVE CONTROL: another filter value differs by figures', (await J.judgeSpec(P, westEq, { ...RAW_WEST, filters: [{ column: 'region', op: 'in', values: ['East'] }] })).outcome === 'differs');
    const unknown = await J.judgeSpec(P, q, { ...RAW, category: 'nope' });
    ok('an unknown column is refused, with the reason', unknown.outcome === 'refused' && /nope/.test(unknown.reason ?? ''), JSON.stringify(unknown));
    ok('no spec at all is refused', (await J.judgeSpec(P, q, undefined)).outcome === 'refused');
    ok('specOnly: a different spec differs without drawing', (await J.judgeSpec(P, westEq, { ...RAW_WEST, filters: [{ column: 'region', op: 'in', values: ['West'] }] }, { specOnly: true })).outcome === 'differs');
    await trash.trashRecord(P, 'verified', westEq.id); // the sample's own set again, for §2 and §3

    // ── §2 CI replay ────────────────────────────────────────────────────────
    for (const c of EVAL_CASES) {
      const { action } = splitAction(c.line);
      const got = action.kind === 'answer' ? (await J.judgeSpec(P, await verifiedNamed(c.verified), action.spec)).outcome : 'refused';
      ok(`${c.recorded ? '[recorded] ' : '[written] '}${c.name}`, got === c.expect, `expected ${c.expect}, got ${got}`);
    }
    ok('the corpus is a corpus', EVAL_CASES.length >= 12, String(EVAL_CASES.length));
    const SAMPLE_QUESTIONS = SAMPLE_VERIFIED.map((v) => v.question);
    ok('every sample question is covered', SAMPLE_QUESTIONS.every((sq) => EVAL_CASES.some((c) => c.verified === sq && c.expect === 'match')));
    ok('every case is scored against a sample question', EVAL_CASES.every((c) => SAMPLE_QUESTIONS.includes(c.verified)));
    const own = (await verifiedNamed('Revenue by region')).id;
    const g = await askGuidance(P, { kind: '' }, 'project', 'Revenue by region', { exclude: own });
    ok('leave-one-out: its own entry is no example', !g.text.includes('"Revenue by region" →') && g.used.examples.length > 0 && !g.used.examples.includes(own), g.text);
    ok('NEGATIVE CONTROL: without exclude it is one', (await askGuidance(P, { kind: '' }, 'project', 'Revenue by region')).text.includes('"Revenue by region" →'));
    const states = await verifiedStates(P);
    ok('leave-one-out: and no exact hit', exactHit(states, 'Revenue by region', own) === null);
    ok('NEGATIVE CONTROL: without exclude it is the exact hit', exactHit(states, 'Revenue by region')?.id === own);

    // ── Live: compared on specs only, and the warehouse is never asked ─────
    if (H && live) {
      const P2 = live.projectId;
      const liveQ = await save(P2, 'Amount by region', { datasetId: live.liveId, category: 'region', measures: [{ column: 'amt', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Amount by region' });
      const LIVE_SAME = { dataset: 'Live', category: 'region', measures: [{ column: 'amt', aggregation: 'sum' }] };
      const LIVE_OTHER = { ...LIVE_SAME, filters: [{ column: 'region', op: 'in', values: ['West'] }] };
      let other: import('../src/ipc/verifiedJudge').Judged | undefined;
      ok('Live: spec only, no warehouse query', (await noStatements(H, async () => { other = await J.judgeSpec(P2, liveQ, LIVE_OTHER); })) && other?.outcome === 'differs', JSON.stringify(other));
      let hit: import('../src/ipc/verifiedJudge').Judged | undefined;
      ok('Live: the same spec matches, no warehouse query', (await noStatements(H, async () => { hit = await J.judgeSpec(P2, liveQ, LIVE_SAME); })) && hit?.outcome === 'match', JSON.stringify(hit));
    }

    // ── §3 ──────────────────────────────────────────────────────────────────
    if (LIVE) await runLive(P);
    else console.log('\n(live mode off — set ORDINATE_LIVE_MODEL=1 with a configured model to run it)');
  });
  H?.cleanup();
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* temp dir */ }
  finish();
}

main().catch((err) => { console.error(err); process.exitCode = 1; finish(); });
