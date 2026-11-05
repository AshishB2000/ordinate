// Measuring the Assistant on verified questions (semantic layer part 3 D13): one judge of a model's SPEC — never
// its prose — against a verified question, by spec first and, on a copy, by the engine's figures.
//
//   §1 judgeSpec over the seeded sample (and a Live dataset: specs only, no warehouse query)
//   §2 CI replay: each recorded reply in ./verified-eval-cases.ts through the real path — `splitAction`, the
//      validator, the judge — against the sample's verified questions; and leave-one-out holds
//
//   npm run build:ts && node scripts/test-verifiedEval.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './liveQueryHarness';
import { EVAL_CASES } from './verified-eval-cases';

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
type VerifiedQuestion = import('../src/analysis/verifiedRules').VerifiedQuestion;
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
async function noStatements(fn: () => Promise<unknown>): Promise<boolean> {
  const before = H.fake.calls.length;
  await fn();
  return H.fake.calls.length === before;
}

async function main(): Promise<void> {
  const live = await H.setupOrg(H.ORG_A);
  await H.as(H.ORG_A, async () => {
    const P = String((await sample.seedSampleProject({ again: true })).projectId);
    const dsId = (await H.datasets.listDatasets(P))[0].id;
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
    const P2 = live.projectId;
    const liveQ = await save(P2, 'Amount by region', { datasetId: live.liveId, category: 'region', measures: [{ column: 'amt', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Amount by region' });
    const LIVE_SAME = { dataset: 'Live', category: 'region', measures: [{ column: 'amt', aggregation: 'sum' }] };
    const LIVE_OTHER = { ...LIVE_SAME, filters: [{ column: 'region', op: 'in', values: ['West'] }] };
    let other: import('../src/ipc/verifiedJudge').Judged | undefined;
    ok('Live: spec only, no warehouse query', (await noStatements(async () => { other = await J.judgeSpec(P2, liveQ, LIVE_OTHER); })) && other?.outcome === 'differs', JSON.stringify(other));
    let hit: import('../src/ipc/verifiedJudge').Judged | undefined;
    ok('Live: the same spec matches, no warehouse query', (await noStatements(async () => { hit = await J.judgeSpec(P2, liveQ, LIVE_SAME); })) && hit?.outcome === 'match', JSON.stringify(hit));
  });
  H.cleanup();
  finish();
}

main().catch((err) => { console.error(err); process.exitCode = 1; finish(); });
